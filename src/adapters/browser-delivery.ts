/** Ordinary Chat delivery uses the existing public browser adapter. It never impersonates a
 * local process ResultSpec: hosted-response-1 evidence is explicitly a separate wire contract.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  ExactHostedSourceResolver,
  type HostedSourceProvenanceV1,
  type HostedSourceResolution,
  PlaywrightHostedSourceSnapshotReader,
} from "../archive/hosted-source.js";
import {
  buildHostedSourceProofV2,
  createOutputContractPrompt,
} from "../archive/output-evidence.js";
import type { RouteArtifactArchive } from "../archive/route-store.js";
import type { ArchiveSnapshotV2, JobAdmissionV1 } from "../archive/route-types.js";
import { ArchiveError } from "../archive/types.js";
import { buildPorts } from "../cli/adapters.js";
import type { BridgeConfig } from "../cli/config.js";
import {
  type MaterializationReceiptV1,
  validateMaterializationReceiptV1,
} from "../contracts/materialization.js";
import type { HostedExpectedOutputPolicy } from "../contracts/output-contract.js";
import { parseResponseFrame, type ResponseFrameIdentity } from "../contracts/response-frame.js";
import { validateResult } from "../contracts/schema.js";
import { loadTaskSpec, sha256Bytes, verifyTaskFileBytes } from "../contracts/task.js";
import type {
  BridgeResult,
  ChatRequest,
  RequestedModel,
  RequestedPreset,
} from "../contracts/types.js";
import { createLogger } from "../diagnostics/logger.js";
import { RunController } from "../state/controller.js";
import type { GitHubTaskBus, HostedEvent, IssuedMessage } from "./github-transport.js";
import { assertHostedOutputContract } from "./hosted-output-policy.js";

export interface HostedResponse {
  version: "hosted-response-1";
  requestId: string;
  taskSpecHash: string;
  attemptId: string;
  evidence: "ordinary-chat-browser-dom";
  localExecution: false;
  result: BridgeResult;
  markdown: string | null;
  framing: { identity: ResponseFrameIdentity; rawSha256: string; bodySha256: string } | null;
}
export interface BrowserDeliveryPolicy {
  recipientId: string;
  requesterIds: readonly string[];
  conversationUrl: string;
  model: RequestedModel;
  preset: RequestedPreset;
  maxStarts: number;
  deadlineAt: string;
  maxResponseBytes: number;
  expectedOutputPolicy?: HostedExpectedOutputPolicy;
}
export interface HostedJobRecord {
  revision: number;
  attemptedAt: string | null;
  source: HostedSourceResolution | null;
  issued: IssuedMessage;
  raw: string;
  outputContractRaw: string | null;
  taskBytesBase64: string;
  state: "awaiting_approval" | "approved" | "unknown" | "completed" | "blocked_auth" | "failed";
  approval: { actorId: string; taskSpecHash: string; issuedAt: string; expiresAt: string } | null;
  attempted: boolean;
  attemptId: string | null;
  cancelRequestedAt: string | null;
  deadlineAt: string | null;
  response: HostedResponse | null;
  event: HostedEvent | null;
  acknowledged: boolean;
  payloadAcknowledged: boolean;
  materialization: MaterializationReceiptV1 | null;
}
export interface BrowserRunControl {
  signal: AbortSignal;
  deadlineAt: string;
  shouldCancel(): boolean;
}
export type BrowserRun = (
  requestPath: string,
  control: BrowserRunControl,
) => Promise<BridgeResult | { result: BridgeResult; source: HostedSourceResolution | null } | null>;
export function productionBrowserRun(config: BridgeConfig): BrowserRun {
  config = Object.freeze(structuredClone(config));
  return async (requestPath, control) => {
    const ports = buildPorts(config, createLogger(config.logLevel));
    let interrupted = false;
    const shouldStop = () =>
      control.signal.aborted ||
      control.shouldCancel() ||
      Date.now() >= Date.parse(control.deadlineAt);
    const dispatch = ports.chatgpt.dispatchSubmit.bind(ports.chatgpt);
    ports.chatgpt.dispatchSubmit = async (baseline, options) =>
      shouldStop() ? { kind: "aborted" } : dispatch(baseline, options);
    let capturedSource: HostedSourceResolution | null = null;
    const extract = ports.chatgpt.extractLatest.bind(ports.chatgpt);
    ports.chatgpt.extractLatest = async () => {
      const extracted = await extract();
      if (!("kind" in extracted)) {
        try {
          const requestDirectory = resolve(requestPath, "..");
          const frame = JSON.parse(
            await readFile(join(requestDirectory, "framing.json"), "utf8"),
          ) as ResponseFrameIdentity;
          const parsed = parseResponseFrame(extracted.markdown, frame);
          const prompt = await readFile(join(requestDirectory, "prompt.md"), "utf8");
          const conversationId =
            new URL(ports.session.currentPage.url()).pathname.split("/").at(-1) ?? "";
          capturedSource = await new ExactHostedSourceResolver(
            new PlaywrightHostedSourceSnapshotReader(ports.session.currentPage),
          ).pin({
            conversationId,
            promptText: prompt,
            promptSha256: sha256Bytes(Buffer.from(prompt)),
            frame: { identity: frame, rawSha256: parsed.rawSha256, bodySha256: parsed.bodySha256 },
          });
        } catch {
          capturedSource = { state: "unavailable", reason: "source_read_failed" };
        }
      }
      return extracted;
    };
    const controller = new RunController(ports, {
      requestPath,
      artifactsRoot: config.artifactsDir,
      bridgeVersion: config.bridgeVersion,
      traceOnSuccess: config.traceOnSuccess,
    });
    const stop = () => {
      if (interrupted) return;
      interrupted = true;
      void controller.interrupt("hosted_delivery_cancel_or_deadline").catch(() => undefined);
    };
    const check = () => {
      try {
        if (shouldStop()) stop();
      } catch {
        stop();
      }
    };
    const timer = setInterval(check, 100);
    control.signal.addEventListener("abort", stop, { once: true });
    try {
      check();
      const result = (await controller.run()).result;
      return result ? { result, source: capturedSource } : null;
    } finally {
      clearInterval(timer);
      control.signal.removeEventListener("abort", stop);
    }
  };
}
export class BrowserDeliveryService {
  private readonly db: DatabaseSync;
  private readonly claimantId: string;
  readonly policyHash: string;
  private readonly active = new Map<string, AbortController>();
  constructor(
    readonly bus: GitHubTaskBus,
    readonly config: BridgeConfig,
    readonly policy: BrowserDeliveryPolicy,
    private readonly run: BrowserRun = productionBrowserRun(config),
    private readonly now = () => new Date(),
    readonly archiveIntegration: {
      archive?: RouteArtifactArchive;
      sourceResolver?: ExactHostedSourceResolver;
    } = {},
  ) {
    this.config = Object.freeze(structuredClone(config));
    this.policy = Object.freeze({
      ...structuredClone(policy),
      requesterIds: Object.freeze([...policy.requesterIds]),
    });
    this.policyHash = sha256Bytes(Buffer.from(JSON.stringify(policy)));
    const url = new URL(policy.conversationUrl);
    if (
      url.origin !== "https://chatgpt.com" ||
      !/^\/c\/[a-zA-Z0-9-]+$/.test(url.pathname) ||
      url.search ||
      url.hash ||
      policy.recipientId !== bus.codec.signer.actorId ||
      !Number.isInteger(policy.maxStarts) ||
      policy.maxStarts < 1 ||
      policy.maxStarts > 100 ||
      policy.maxResponseBytes < 1 ||
      policy.maxResponseBytes > 1048576
    )
      throw new Error("browser_delivery_policy_invalid");
    this.db = new DatabaseSync(join(config.runtimeDir, "hosted-delivery.db"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS hosted_jobs (id TEXT PRIMARY KEY, hash TEXT NOT NULL, snapshot TEXT NOT NULL); CREATE TABLE IF NOT EXISTS hosted_observations (request_id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(request_id,revision), UNIQUE(request_id,digest)); CREATE TABLE IF NOT EXISTS hosted_configuration (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS hosted_reconcile_cursor (id INTEGER PRIMARY KEY CHECK(id=1), request_id TEXT NOT NULL); INSERT OR IGNORE INTO hosted_reconcile_cursor VALUES (1,''); CREATE TABLE IF NOT EXISTS hosted_identity (id INTEGER PRIMARY KEY CHECK(id=1), claimant TEXT NOT NULL); CREATE TABLE IF NOT EXISTS hosted_cursor (id INTEGER PRIMARY KEY CHECK(id=1), path TEXT NOT NULL); INSERT OR IGNORE INTO hosted_cursor VALUES (1,''); CREATE TABLE IF NOT EXISTS hosted_budget (id INTEGER PRIMARY KEY CHECK(id=1), starts INTEGER NOT NULL); INSERT OR IGNORE INTO hosted_budget VALUES (1,0);",
    );
    const binding = sha256Bytes(
      Buffer.from(
        JSON.stringify({
          policy,
          profileDir: config.profileDir,
          runtimeDir: config.runtimeDir,
          channel: config.channel,
          maxConcurrency: config.maxConcurrency,
        }),
      ),
    );
    this.db.prepare("INSERT OR IGNORE INTO hosted_configuration VALUES (1,?)").run(binding);
    if (
      this.db.prepare("SELECT digest FROM hosted_configuration WHERE id=1").get()?.digest !==
      binding
    ) {
      this.db.close();
      throw new Error("browser_delivery_configuration_changed");
    }
    this.db.prepare("INSERT OR IGNORE INTO hosted_identity VALUES (1,?)").run(randomUUID());
    this.claimantId = String(
      this.db.prepare("SELECT claimant FROM hosted_identity WHERE id=1").get()?.claimant,
    );
  }
  get(requestId: string): HostedJobRecord | null {
    const row = this.db.prepare("SELECT snapshot FROM hosted_jobs WHERE id=?").get(requestId) as
      | { snapshot: string }
      | undefined;
    if (!row) return null;
    const value = JSON.parse(row.snapshot) as HostedJobRecord;
    const materialization = value.materialization
      ? validateMaterializationReceiptV1(value.materialization)
      : null;
    if (
      materialization &&
      (!value.event ||
        !value.response ||
        materialization.execution.kind !== "hosted_delivery" ||
        materialization.execution.attemptId !== value.attemptId ||
        materialization.requestId !== requestId ||
        materialization.taskSpecHash !== value.issued.taskSpecHash ||
        materialization.terminalEventId !== value.event.eventId ||
        materialization.payloadSha256 !== value.event.payloadSha256 ||
        materialization.requesterActorId !== value.issued.requesterId ||
        materialization.recipientActorId !== value.issued.recipientId)
    )
      throw new Error("browser_delivery_saved_proof_invalid");
    return {
      ...value,
      revision: value.revision ?? 0,
      attemptedAt: value.attemptedAt ?? null,
      source: value.source ?? null,
      outputContractRaw: value.outputContractRaw ?? null,
      payloadAcknowledged: value.payloadAcknowledged ?? value.acknowledged,
      materialization,
      acknowledged: value.acknowledged && !!materialization,
    };
  }
  list(): HostedJobRecord[] {
    return this.db
      .prepare("SELECT id FROM hosted_jobs ORDER BY id")
      .all()
      .map((row) => this.get(String(row.id)))
      .filter((value): value is HostedJobRecord => value !== null);
  }
  listPage(after = "", limit = 32): { requestIds: string[]; next: string | null } {
    if (
      (after !== "" && !/^[a-f0-9-]{36}$/.test(after)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("browser_delivery_page_invalid");
    if (after && !this.db.prepare("SELECT 1 FROM hosted_jobs WHERE id=?").get(after))
      throw new Error("browser_delivery_cursor_missing");
    const rows = this.db
      .prepare("SELECT id FROM hosted_jobs WHERE id>? ORDER BY id LIMIT ?")
      .all(after, limit + 1)
      .map((row) => String(row.id));
    return {
      requestIds: rows.slice(0, limit),
      next: rows.length > limit ? (rows[limit - 1] ?? null) : null,
    };
  }
  recentPage(after = "", limit = 32): { requestIds: string[]; next: string | null } {
    if (
      (after !== "" && !/^[a-f0-9-]{36}$/.test(after)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("browser_delivery_page_invalid");
    let rowid = Number.MAX_SAFE_INTEGER;
    if (after) {
      const cursor = this.db.prepare("SELECT rowid FROM hosted_jobs WHERE id=?").get(after);
      if (!cursor) throw new Error("browser_delivery_cursor_missing");
      rowid = Number(cursor.rowid);
    }
    const ids = this.db
      .prepare("SELECT id FROM hosted_jobs WHERE rowid<? ORDER BY rowid DESC LIMIT ?")
      .all(rowid, limit + 1)
      .map((row) => String(row.id));
    return {
      requestIds: ids.slice(0, limit),
      next: ids.length > limit ? (ids[limit - 1] ?? null) : null,
    };
  }
  latestObservation(requestId: string): { revision: number; result: BridgeResult } | null {
    const job = this.get(requestId);
    if (!job) return null;
    if (job.response)
      return { revision: job.revision, result: structuredClone(job.response.result) };
    const row = this.db
      .prepare(
        "SELECT revision,body FROM hosted_observations WHERE request_id=? ORDER BY revision DESC LIMIT 1",
      )
      .get(requestId);
    return row
      ? { revision: Number(row.revision), result: JSON.parse(String(row.body)) as BridgeResult }
      : null;
  }
  observations(requestId: string): { revision: number; result: BridgeResult }[] {
    return this.db
      .prepare("SELECT revision,body FROM hosted_observations WHERE request_id=? ORDER BY revision")
      .all(requestId)
      .map((row) => ({
        revision: Number(row.revision),
        result: JSON.parse(String(row.body)) as BridgeResult,
      }));
  }
  private save(job: HostedJobRecord) {
    const revision = job.revision;
    const next = { ...job, revision: revision + 1 };
    const saved = this.db
      .prepare(
        "UPDATE hosted_jobs SET snapshot=? WHERE id=? AND COALESCE(json_extract(snapshot,'$.revision'),0)=?",
      )
      .run(JSON.stringify(next), job.issued.requestId, revision);
    if (saved.changes !== 1) throw new Error("browser_delivery_stale_revision");
    job.revision = next.revision;
  }
  private checkOutputContract(
    issued: IssuedMessage,
    task: import("../contracts/task-types.js").TaskSpec,
    raw: Uint8Array | null,
  ): void {
    assertHostedOutputContract({
      issued,
      task,
      raw,
      registry: this.archiveIntegration.archive?.registry ?? this.bus.registry,
      policyHash: this.policyHash,
      conversationUrl: this.policy.conversationUrl,
      expectedOutputPolicy: this.policy.expectedOutputPolicy,
    });
  }
  private promptFor(job: HostedJobRecord, identity: ResponseFrameIdentity): Uint8Array {
    if (!job.outputContractRaw) throw new ArchiveError("output_contract_required");
    return createOutputContractPrompt(
      Buffer.from(job.taskBytesBase64, "base64"),
      identity,
      Buffer.from(job.outputContractRaw, "base64"),
    );
  }
  private reserveArchive(
    issued: IssuedMessage,
    task: import("../contracts/task-types.js").TaskSpec,
    acceptedPreviously: boolean,
  ): void {
    const archive = this.archiveIntegration.archive;
    if (!archive) return;
    if (archive.hasPin(issued.requestId)) {
      const old = archive.admission(issued.requestId);
      if (
        old.taskSpecHash !== issued.taskSpecHash ||
        old.taskFileHash !== issued.taskFileHash ||
        old.requesterActorId !== issued.requesterId ||
        old.recipientActorId !== issued.recipientId
      )
        throw new ArchiveError("archive_admission_conflict");
      archive.reserve(old, acceptedPreviously);
      return;
    }
    if (acceptedPreviously) throw new ArchiveError("archive_legacy_admission_unpinned");
    const binding = (
      issued as IssuedMessage & {
        projectRegistration?: {
          projectId: string;
          registryRevision: number;
          snapshotSha256: string;
        } | null;
      }
    ).projectRegistration;
    if (!binding) throw new ArchiveError("archive_legacy_registry_unbound");
    const project = archive.registry.resolve(binding.registryRevision, task.repo);
    if (
      binding.projectId !== project.projectId ||
      binding.snapshotSha256 !== archive.registry.snapshotHash(binding.registryRevision) ||
      project.storageSlug !== issued.projectSlug
    )
      throw new ArchiveError("archive_registry_binding_mismatch");
    const admission: JobAdmissionV1 = {
      schema: "job-admission-1",
      requestId: issued.requestId,
      taskSpecHash: issued.taskSpecHash,
      taskFileHash: issued.taskFileHash,
      outputContractSha256:
        (issued as IssuedMessage & { outputContractSha256?: string | null }).outputContractSha256 ??
        null,
      registryRevision: binding.registryRevision,
      registrySnapshotHash: binding.snapshotSha256,
      projectId: project.projectId,
      repoId: task.repo,
      storageSlug: project.storageSlug,
      requesterActorId: issued.requesterId,
      recipientActorId: issued.recipientId,
      route: {
        kind: "hosted_delivery",
        policyHash: this.policyHash,
        conversationId: new URL(this.policy.conversationUrl).pathname.split("/").at(-1) ?? "",
        destinationId: "ordinary-chat-browser",
      },
    };
    archive.reserve(admission);
  }
  receive(
    issued: IssuedMessage,
    raw: Uint8Array,
    taskBytes: Uint8Array,
    outputContractRaw: Uint8Array | null = null,
  ): void {
    const parsed = loadTaskSpec(raw);
    if (
      !parsed.valid ||
      !verifyTaskFileBytes(parsed.task, taskBytes).valid ||
      issued.route !== "ordinary_chat_browser" ||
      issued.recipientId !== this.policy.recipientId ||
      !this.policy.requesterIds.includes(issued.requesterId) ||
      issued.taskSpecHash !== parsed.taskSpecHash ||
      issued.requestId !== parsed.task.request_id ||
      issued.taskFileHash !== parsed.task.task_file_hash ||
      parsed.task.policy_snapshot_sha256 !== this.policyHash ||
      parsed.task.agent !== "chatgpt-browser" ||
      parsed.task.requested_model !== this.policy.model ||
      parsed.task.mode !== "read_only" ||
      parsed.task.allowed_commands.length !== 0 ||
      parsed.task.timeout.run_seconds < 10
    )
      throw new Error("browser_delivery_request_denied");
    const prior = this.get(issued.requestId);
    const contractRaw =
      outputContractRaw ??
      (prior?.outputContractRaw ? Buffer.from(prior.outputContractRaw, "base64") : null);
    this.checkOutputContract(issued, parsed.task, contractRaw);
    if (
      prior &&
      contractRaw &&
      prior.outputContractRaw !== Buffer.from(contractRaw).toString("base64")
    )
      throw new ArchiveError("output_contract_replacement_denied");
    this.reserveArchive(issued, parsed.task, !!prior);
    if (prior) {
      if (JSON.stringify(prior.issued) !== JSON.stringify(issued))
        throw new Error("browser_delivery_replay_conflict");
      return;
    }
    const job: HostedJobRecord = {
      revision: 1,
      attemptedAt: null,
      source: null,
      issued,
      raw: Buffer.from(raw).toString("utf8"),
      outputContractRaw: contractRaw ? Buffer.from(contractRaw).toString("base64") : null,
      taskBytesBase64: Buffer.from(taskBytes).toString("base64"),
      state: "awaiting_approval",
      approval: null,
      attempted: false,
      attemptId: null,
      cancelRequestedAt: null,
      deadlineAt: null,
      response: null,
      event: null,
      acknowledged: false,
      payloadAcknowledged: false,
      materialization: null,
    };
    this.db
      .prepare("INSERT INTO hosted_jobs VALUES (?,?,?)")
      .run(issued.requestId, issued.taskSpecHash, JSON.stringify(job));
  }
  /** Call only from the host's authenticated approval endpoint, never a transport document. */
  approve(
    requestId: string,
    authorization: {
      actorId: string;
      taskSpecHash: string;
      expiresAt: string;
      authenticated: true;
    },
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.get(requestId);
      if (
        job?.state !== "awaiting_approval" ||
        authorization.authenticated !== true ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(authorization.actorId) ||
        authorization.taskSpecHash !== job.issued.taskSpecHash ||
        Date.parse(authorization.expiresAt) <= this.now().getTime() ||
        !Number.isFinite(Date.parse(authorization.expiresAt))
      )
        throw new Error("browser_delivery_approval_denied");
      const task = JSON.parse(job.raw) as import("../contracts/task-types.js").TaskSpec;
      const issuedAt = this.now();
      const expires = Math.min(
        Date.parse(authorization.expiresAt),
        issuedAt.getTime() + task.approval.max_age_seconds * 1000,
        Date.parse(this.policy.deadlineAt),
      );
      if (!Number.isFinite(expires) || expires <= issuedAt.getTime())
        throw new Error("browser_delivery_approval_denied");
      job.approval = {
        actorId: authorization.actorId,
        taskSpecHash: authorization.taskSpecHash,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(expires).toISOString(),
      };
      job.state = "approved";
      this.save(job);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async start(requestId: string): Promise<HostedJobRecord> {
    this.db.exec("BEGIN IMMEDIATE");
    let job: HostedJobRecord;
    try {
      const current = this.get(requestId);
      if (current)
        this.checkOutputContract(
          current.issued,
          JSON.parse(current.raw),
          current.outputContractRaw ? Buffer.from(current.outputContractRaw, "base64") : null,
        );
      if (
        current?.state !== "approved" ||
        current.attempted ||
        current.cancelRequestedAt ||
        !current.approval ||
        Date.parse(current.approval.expiresAt) <= this.now().getTime() ||
        !Number.isFinite(Date.parse(this.policy.deadlineAt)) ||
        Date.parse(this.policy.deadlineAt) <= this.now().getTime()
      )
        throw new Error("browser_delivery_start_denied");
      if (Date.parse(this.policy.deadlineAt) - this.now().getTime() < 10000)
        throw new Error("browser_delivery_deadline_too_close");
      const budget = this.db.prepare("SELECT starts FROM hosted_budget WHERE id=1").get() as {
        starts: number;
      };
      if (budget.starts >= this.policy.maxStarts) throw new Error("browser_delivery_session_limit");
      const task = JSON.parse(current.raw) as import("../contracts/task-types.js").TaskSpec;
      current.deadlineAt = new Date(
        Math.min(
          Date.parse(this.policy.deadlineAt),
          this.now().getTime() + task.timeout.run_seconds * 1000,
        ),
      ).toISOString();
      current.attemptId = randomUUID();
      current.attemptedAt = this.now().toISOString();
      current.attempted = true;
      current.state = "unknown";
      this.save(current);
      this.db.exec("UPDATE hosted_budget SET starts=starts+1 WHERE id=1; COMMIT");
      job = current;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    // The durable intent comes before all filesystem and browser effects. A crash never retries.
    const dir = join(this.config.runtimeDir, "hosted-requests", requestId);
    await mkdir(dir, { recursive: true });
    if (!job.attemptId) throw new Error("browser_delivery_attempt_missing");
    const frame: ResponseFrameIdentity = {
      requestId,
      taskSpecHash: job.issued.taskSpecHash,
      attemptId: job.attemptId,
    };
    const prompt = this.promptFor(job, frame);
    await writeFile(join(dir, "framing.json"), JSON.stringify(frame), { flag: "wx", mode: 0o600 });
    await writeFile(join(dir, "prompt.md"), prompt, { flag: "wx", mode: 0o600 });
    const request: ChatRequest = {
      schemaVersion: "1.3",
      requestId,
      target: "chat",
      promptFile: "prompt.md",
      preset: this.policy.preset,
      model: this.policy.model,
      attachments: [],
      newChat: false,
      conversationUrl: this.policy.conversationUrl,
      timeoutMs: Math.min(
        (JSON.parse(job.raw) as import("../contracts/task-types.js").TaskSpec).timeout.run_seconds *
          1000,
        Date.parse(this.policy.deadlineAt) - this.now().getTime(),
      ),
      responseFormat: "markdown",
    };
    const path = join(dir, "request.json");
    await writeFile(path, JSON.stringify(request), { flag: "wx", mode: 0o600 });
    const deadlineAt = job.deadlineAt;
    if (
      !deadlineAt ||
      Date.parse(deadlineAt) <= this.now().getTime() ||
      this.get(requestId)?.cancelRequestedAt
    )
      return this.get(requestId) ?? job;
    const control = new AbortController();
    this.active.set(requestId, control);
    try {
      const result = await this.run(path, {
        signal: control.signal,
        deadlineAt,
        shouldCancel: () => !!this.get(requestId)?.cancelRequestedAt,
      });
      if (result)
        await this.capture(
          job,
          "result" in result ? result.result : result,
          dir,
          "result" in result ? result.source : null,
        );
      return this.get(requestId) ?? job;
    } finally {
      this.active.delete(requestId);
    }
  }
  private async capture(
    job: HostedJobRecord,
    result: BridgeResult,
    dir: string,
    source: HostedSourceResolution | null = null,
    useExactSourceBytes = false,
  ) {
    if (
      !validateResult(result).valid ||
      result.requestId !== job.issued.requestId ||
      result.target === "dot"
    )
      throw new Error("browser_delivery_result_invalid");
    if (result.status !== "completed" && result.submitted !== "no") {
      const body = JSON.stringify(result),
        digest = sha256Bytes(Buffer.from(body));
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const current = this.get(job.issued.requestId);
        if (!current || current.attemptId !== job.attemptId || current.response)
          throw new Error("browser_delivery_observation_conflict");
        if (
          !this.db
            .prepare("SELECT 1 FROM hosted_observations WHERE request_id=? AND digest=?")
            .get(job.issued.requestId, digest)
        ) {
          current.state = ["AUTH_REQUIRED", "CAPTCHA_OR_CHALLENGE"].includes(
            result.error?.code ?? "",
          )
            ? "blocked_auth"
            : "unknown";
          this.save(current);
          this.db
            .prepare("INSERT INTO hosted_observations VALUES (?,?,?,?)")
            .run(job.issued.requestId, current.revision, digest, body);
        }
        this.db.exec("COMMIT");
        return;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    let markdown: string | null = null;
    let framing: HostedResponse["framing"] = null;
    if (result.status === "completed") {
      if (
        !result.responseFile ||
        resolve(dir, result.responseFile) !== join(dir, "response.md") ||
        result.conversationUrl !== this.policy.conversationUrl
      )
        throw new Error("browser_delivery_result_identity_mismatch");
      const raw =
        useExactSourceBytes && source?.state === "available"
          ? Buffer.from(source.rawMarkdown)
          : await readFile(join(dir, "response.md"));
      if (raw.length > this.policy.maxResponseBytes) throw new Error("browser_response_too_large");
      if (!job.attemptId) throw new Error("browser_delivery_attempt_missing");
      const identity = {
        requestId: job.issued.requestId,
        taskSpecHash: job.issued.taskSpecHash,
        attemptId: job.attemptId,
      };
      const parsed = parseResponseFrame(
        new TextDecoder("utf8", { fatal: true }).decode(raw),
        identity,
      );
      markdown = parsed.markdown;
      framing = { identity, rawSha256: parsed.rawSha256, bodySha256: parsed.bodySha256 };
    }
    if (!job.attemptId) throw new Error("browser_delivery_attempt_missing");
    if (source?.state === "available") {
      const expectedPrompt = this.promptFor(job, {
        requestId: job.issued.requestId,
        taskSpecHash: job.issued.taskSpecHash,
        attemptId: job.attemptId,
      });
      if (
        !framing ||
        !isDeepStrictEqual(source.provenance.frame, framing) ||
        source.provenance.promptSha256 !== sha256Bytes(expectedPrompt) ||
        source.provenance.identity.conversationId !==
          new URL(this.policy.conversationUrl).pathname.split("/").at(-1) ||
        source.provenance.contentSha256 !== sha256Bytes(Buffer.from(source.rawMarkdown))
      )
        throw new Error("browser_delivery_source_binding_mismatch");
    }
    const response: HostedResponse = {
      version: "hosted-response-1",
      attemptId: job.attemptId,
      requestId: job.issued.requestId,
      taskSpecHash: job.issued.taskSpecHash,
      evidence: "ordinary-chat-browser-dom",
      localExecution: false,
      result,
      markdown,
      framing,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(job.issued.requestId);
      if (!current?.attempted || current.attemptId !== job.attemptId)
        throw new Error("browser_delivery_intent_missing");
      if (current.response) {
        if (!isDeepStrictEqual(current.response, response))
          throw new Error("browser_delivery_result_conflict");
        this.db.exec("COMMIT");
        return;
      }
      current.state =
        result.status === "completed"
          ? "completed"
          : ["AUTH_REQUIRED", "CAPTCHA_OR_CHALLENGE"].includes(result.error?.code ?? "")
            ? "blocked_auth"
            : result.submitted !== "no"
              ? "unknown"
              : "failed";
      current.response = response;
      current.source = source;
      const bytes = Buffer.from(`${JSON.stringify(response)}\n`);
      current.event = {
        version: "hosted-response-1",
        requestId: current.issued.requestId,
        taskSpecHash: current.issued.taskSpecHash,
        actorId: this.policy.recipientId,
        eventId: randomUUID(),
        payloadSha256: sha256Bytes(bytes),
        stage: "hosted_result",
      };
      this.save(current);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async cancel(requestId: string): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.get(requestId);
      if (!job || job.response) throw new Error("browser_delivery_not_running");
      job.cancelRequestedAt ??= this.now().toISOString();
      this.save(job);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.active.get(requestId)?.abort();
    // Closing a page cannot prove hosted generation stopped. Preserve unknown, never resend.
  }
  async reconcile(requestId: string): Promise<HostedJobRecord> {
    let job = this.get(requestId);
    if (!job) throw new Error("browser_delivery_missing");
    if (job.attempted && !job.response) {
      const dir = join(this.config.runtimeDir, "hosted-requests", requestId);
      try {
        await this.capture(
          job,
          JSON.parse(await readFile(join(dir, "result.json"), "utf8")) as BridgeResult,
          dir,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    job = this.get(requestId) ?? job;
    if (
      !job.response &&
      job.attempted &&
      job.attemptId &&
      job.attemptedAt &&
      this.archiveIntegration.sourceResolver
    ) {
      const identity = {
        requestId,
        taskSpecHash: job.issued.taskSpecHash,
        attemptId: job.attemptId,
      };
      const prompt = this.promptFor(job, identity);
      const recovered = await this.archiveIntegration.sourceResolver.recover({
        conversationId: new URL(this.policy.conversationUrl).pathname.split("/").at(-1) ?? "",
        promptText: Buffer.from(prompt).toString("utf8"),
        promptSha256: sha256Bytes(prompt),
        identity,
      });
      if (recovered.state === "available") {
        const now = this.now().toISOString();
        const result: BridgeResult = {
          schemaVersion: "1.2",
          bridgeVersion: this.config.bridgeVersion,
          requestId,
          status: "completed",
          requestedPreset: this.policy.preset,
          observedPreset: null,
          requestedModel: this.policy.model,
          observedModel: null,
          observedModelSlug: null,
          submitted: "yes",
          conversationUrl: this.policy.conversationUrl,
          responseFile: "response.md",
          extractionMethod: "dom",
          extractionQuality: "degraded",
          startedAt: job.attemptedAt,
          completedAt: now,
          durationMs: Math.max(0, Date.parse(now) - Date.parse(job.attemptedAt)),
          artifacts: [],
          images: [],
          warnings: [
            "recovered_exact_message_identity",
            "provider_model_not_verified_during_recovery",
          ],
          error: null,
          recoveredBy: "collect",
        };
        await this.capture(
          job,
          result,
          join(this.config.runtimeDir, "hosted-requests", requestId),
          recovered,
          true,
        );
        job = this.get(requestId) ?? job;
      }
    }
    if (
      job.response?.result.status === "completed" &&
      job.source?.state !== "available" &&
      this.archiveIntegration.sourceResolver &&
      job.response.framing
    ) {
      const prompt = this.promptFor(job, job.response.framing.identity);
      const source = await this.archiveIntegration.sourceResolver.pin({
        conversationId: new URL(this.policy.conversationUrl).pathname.split("/").at(-1) ?? "",
        promptText: Buffer.from(prompt).toString("utf8"),
        promptSha256: sha256Bytes(prompt),
        frame: job.response.framing,
      });
      const current = this.get(requestId);
      if (current && current.revision === job.revision) {
        current.source = source;
        this.save(current);
        job = current;
      }
    }
    if (job.event && job.response && !job.acknowledged) {
      if (this.archiveIntegration.archive) await this.archiveResult(requestId);
      await this.bus.publishHosted(job.event, Buffer.from(`${JSON.stringify(job.response)}\n`));
      const snapshot = await this.bus.git.snapshot();
      const ack = await this.bus.readHosted(snapshot, requestId, "hosted_ack");
      if (ack) {
        if (
          !isDeepStrictEqual(ack, {
            ...job.event,
            actorId: job.issued.requesterId,
            stage: "hosted_ack",
          })
        )
          throw new Error("browser_delivery_ack_mismatch");
        if (!job.payloadAcknowledged) {
          job.payloadAcknowledged = true;
          this.save(job);
        }
        const proof = await this.bus.readMaterialization(snapshot, requestId);
        const fresh = this.get(requestId);
        if (!fresh || fresh.revision !== job.revision)
          throw new Error("browser_delivery_stale_revision");
        fresh.materialization = proof;
        fresh.acknowledged = true;
        this.save(fresh);
      }
    }
    return this.get(requestId) ?? job;
  }
  async archiveResult(requestId: string) {
    const archive = this.archiveIntegration.archive;
    if (!archive) throw new ArchiveError("archive_unconfigured");
    const job = this.get(requestId);
    if (!job?.response || !job.event || !job.attemptId)
      throw new ArchiveError("archive_hosted_not_terminal");
    const pin = archive.pin(requestId),
      source = job.source?.state === "available" ? job.source : null;
    const sourceIdentity = source?.provenance.identity;
    archive.appendProvenance(requestId, {
      schema: "job-provenance-1",
      admissionHash: pin.admissionHash,
      source: "hosted_ledger",
      sourceRevision: job.revision,
      observedAt: job.response.result.completedAt,
      observation: {
        kind: "hosted_delivery",
        attemptId: job.attemptId,
        conversationId: new URL(this.policy.conversationUrl).pathname.split("/").at(-1) ?? "",
        userTurnId: sourceIdentity?.userTurnId ?? null,
        assistantTurnId: sourceIdentity?.assistantTurnId ?? null,
        rawSha256: job.response.framing?.rawSha256 ?? null,
        bodySha256: job.response.framing?.bodySha256 ?? null,
        resultSha256: job.event.payloadSha256,
      },
    });
    const responseBytes = Buffer.from(`${JSON.stringify(job.response)}\n`);
    if (sha256Bytes(responseBytes) !== job.event.payloadSha256)
      throw new ArchiveError("archive_hosted_payload_mismatch");
    const knownNoSend = job.response.result.submitted === "no";
    const inventory = source?.artifactInventory;
    const hasUnmappedArtifacts =
      (job.response.result.images.length > 0 || !!job.response.result.files?.length) &&
      !inventory?.artifacts.length;
    const contractRaw = job.outputContractRaw ? Buffer.from(job.outputContractRaw, "base64") : null;
    if (
      !contractRaw ||
      sha256Bytes(contractRaw) !== archive.admission(requestId).outputContractSha256
    )
      throw new ArchiveError("archive_materialization_contract_mismatch");
    let outputProof: ReturnType<typeof buildHostedSourceProofV2> | null = null;
    let proofIssue = "output_observation_unsupported";
    if (source && contractRaw) {
      try {
        outputProof = buildHostedSourceProofV2(job.response, source, contractRaw);
      } catch (error) {
        const candidate = error instanceof Error ? error.message : "";
        if (/^[a-z][a-z0-9_]{0,63}$/.test(candidate)) proofIssue = candidate;
      }
    }
    const snapshot: ArchiveSnapshotV2 = {
      requestId,
      taskSpecBytes: Buffer.from(job.raw),
      taskFileBytes: Buffer.from(job.taskBytesBase64, "base64"),
      payloadBytes: responseBytes,
      synthetic: false,
      requiredSetKnown: knownNoSend || (!!outputProof && !hasUnmappedArtifacts),
      items: knownNoSend
        ? []
        : [
            {
              artifactId: "hosted-response-body",
              logicalName: "exact_framed_response",
              required: true,
              source: sourceIdentity
                ? {
                    kind: "hosted_response",
                    conversationId: sourceIdentity.conversationId,
                    userTurnId: sourceIdentity.userTurnId,
                    assistantTurnId: sourceIdentity.assistantTurnId,
                  }
                : null,
              contentSha256: source?.provenance.contentSha256 ?? null,
              sizeBytes: source?.provenance.sizeBytes ?? null,
              unavailableReason:
                job.source?.state === "unavailable"
                  ? `hosted_${job.source.reason}`
                  : "hosted_source_unavailable",
            },
          ],
    };
    if (!knownNoSend) {
      snapshot.items.push({
        artifactId: "hosted-source-proof",
        logicalName: "bound_output_source_proof",
        required: true,
        source:
          outputProof && sourceIdentity
            ? {
                kind: "hosted_response",
                conversationId: sourceIdentity.conversationId,
                userTurnId: sourceIdentity.userTurnId,
                assistantTurnId: sourceIdentity.assistantTurnId,
              }
            : null,
        contentSha256: outputProof ? sha256Bytes(outputProof.bytes) : null,
        sizeBytes: outputProof?.bytes.length ?? null,
        unavailableReason: proofIssue,
      });
    }
    snapshot.items.push({
      artifactId: "hosted-output-contract",
      logicalName: "admitted_output_contract",
      required: true,
      source: { kind: "hosted_admission_evidence", artifactId: "hosted-output-contract" },
      contentSha256: sha256Bytes(contractRaw),
      sizeBytes: contractRaw.length,
      unavailableReason: "output_contract_required",
    });
    for (const [index, item] of (inventory?.artifacts ?? []).entries())
      snapshot.items.push({
        artifactId: item.artifactId ?? `unidentified-hosted-artifact-${index}`,
        logicalName: "hosted_message_artifact",
        required: true,
        source:
          item.artifactId && sourceIdentity
            ? {
                kind: "hosted_message_artifact",
                conversationId: sourceIdentity.conversationId,
                userTurnId: sourceIdentity.userTurnId,
                assistantTurnId: sourceIdentity.assistantTurnId,
                artifactId: item.artifactId,
              }
            : null,
        contentSha256: item.contentSha256,
        sizeBytes: item.sizeBytes,
        unavailableReason: `hosted_${item.reason ?? "artifact_unavailable"}`,
      });
    const result = await archive.archive(snapshot, {
      read: async (input, expected) => {
        if (input.kind === "hosted_admission_evidence") {
          if (
            input.artifactId !== "hosted-output-contract" ||
            sha256Bytes(contractRaw) !== expected.contentSha256
          )
            throw new ArchiveError("archive_source_identity_mismatch");
          return contractRaw;
        }
        if (
          input.kind === "hosted_message_artifact" &&
          source &&
          this.archiveIntegration.sourceResolver
        ) {
          const item = inventory?.artifacts.find((item) => item.artifactId === input.artifactId);
          if (!item?.contentSha256 || item.sizeBytes === null)
            throw new ArchiveError("archive_source_unavailable");
          const provenance: HostedSourceProvenanceV1 = {
            ...source.provenance,
            identity: { ...source.provenance.identity, artifactId: input.artifactId },
            representation: "artifact_bytes",
            contentSha256: item.contentSha256,
            sizeBytes: item.sizeBytes,
          };
          const resolved = await this.archiveIntegration.sourceResolver.resolve(provenance);
          if (resolved.state !== "available") throw new ArchiveError(`hosted_${resolved.reason}`);
          return resolved.bytes;
        }
        if (
          input.kind !== "hosted_response" ||
          !source ||
          !sourceIdentity ||
          input.conversationId !== sourceIdentity.conversationId ||
          input.userTurnId !== sourceIdentity.userTurnId ||
          input.assistantTurnId !== sourceIdentity.assistantTurnId
        )
          throw new ArchiveError("archive_source_identity_mismatch");
        if (outputProof && sha256Bytes(outputProof.bytes) === expected.contentSha256)
          return outputProof.bytes;
        if (contractRaw && sha256Bytes(contractRaw) === expected.contentSha256) return contractRaw;
        const bytes = Buffer.from(source.rawMarkdown);
        if (sha256Bytes(bytes) !== source.provenance.contentSha256)
          throw new ArchiveError("archive_source_hash_mismatch");
        return bytes;
      },
    });
    if (result.state !== "complete")
      throw new ArchiveError(result.issue ?? "archive_hosted_incomplete", true);
    return result;
  }
  async poll(
    max = 32,
  ): Promise<{ received: string[]; blocked: { path: string; reason: string }[] }> {
    if (!Number.isInteger(max) || max < 1 || max > 256)
      throw new Error("browser_poll_limit_invalid");
    const snapshot = await this.bus.git.snapshot();
    const received: string[] = [];
    const blocked: { path: string; reason: string }[] = [];
    const cursor = String(
      this.db.prepare("SELECT path FROM hosted_cursor WHERE id=1").get()?.path ?? "",
    );
    const paths = [...snapshot.files.keys()]
      .filter((p) => p.startsWith(`${this.bus.prefix}/request-index/`) && p.endsWith(".json"))
      .sort();
    for (const path of [
      ...paths.filter((p) => p > cursor),
      ...paths.filter((p) => p <= cursor),
    ].slice(0, max)) {
      try {
        const incoming = await this.bus.readIssued(snapshot, path);
        const { issued, raw, taskBytes } = incoming;
        const outputContractRaw =
          (incoming as typeof incoming & { outputContractRaw?: Uint8Array | null })
            .outputContractRaw ?? null;
        if (
          issued.route !== "ordinary_chat_browser" ||
          issued.recipientId !== this.policy.recipientId ||
          this.get(issued.requestId)
        )
          continue;
        const parsed = loadTaskSpec(raw);
        if (!parsed.valid) throw new Error("browser_delivery_request_denied");
        this.checkOutputContract(issued, parsed.task, outputContractRaw);
        await this.bus.claim(issued, this.claimantId);
        this.receive(issued, raw, taskBytes, outputContractRaw);
        received.push(issued.requestId);
      } catch (error) {
        blocked.push({
          path,
          reason:
            error instanceof Error && /^[a-z_0-9]+$/.test(error.message)
              ? error.message
              : "browser_poll_failed",
        });
      } finally {
        this.db.prepare("UPDATE hosted_cursor SET path=? WHERE id=1").run(path);
      }
    }
    return { received, blocked };
  }
  async tick(): Promise<{
    received: string[];
    blocked: { path: string; reason: string }[];
    reconciled: string[];
  }> {
    const result = { ...(await this.poll()), reconciled: [] as string[] };
    const rows = this.db.prepare("SELECT snapshot FROM hosted_jobs ORDER BY id").all() as {
      snapshot: string;
    }[];
    const cursor = String(
      this.db.prepare("SELECT request_id FROM hosted_reconcile_cursor WHERE id=1").get()
        ?.request_id ?? "",
    );
    const jobs = rows
      .map((row) => JSON.parse(row.snapshot) as HostedJobRecord)
      .filter((job) => job.attempted && !job.acknowledged);
    const ordered = [
      ...jobs.filter((job) => job.issued.requestId > cursor),
      ...jobs.filter((job) => job.issued.requestId <= cursor),
    ].slice(0, 32);
    for (const job of ordered) {
      try {
        await this.reconcile(job.issued.requestId);
        result.reconciled.push(job.issued.requestId);
      } catch (error) {
        result.blocked.push({
          path: job.issued.requestId,
          reason:
            error instanceof Error && /^[a-z_0-9]+$/.test(error.message)
              ? error.message
              : "browser_reconcile_failed",
        });
      } finally {
        this.db
          .prepare("UPDATE hosted_reconcile_cursor SET request_id=? WHERE id=1")
          .run(job.issued.requestId);
      }
    }
    return result;
  }
  close() {
    this.db.close();
  }
}
