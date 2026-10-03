/** Ordinary Chat delivery uses the existing public browser adapter. It never impersonates a
 * local process ResultSpec: hosted-response-1 evidence is explicitly a separate wire contract.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { buildPorts } from "../cli/adapters.js";
import type { BridgeConfig } from "../cli/config.js";
import type { HostedExpectedOutputPolicy } from "../contracts/output-contract.js";
import { createOutputContractPrompt } from "../contracts/output-contract-prompt.js";
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
  expectedOutputPolicy?: HostedExpectedOutputPolicy;
  recipientId: string;
  requesterIds: readonly string[];
  conversationUrl: string;
  model: RequestedModel;
  preset: RequestedPreset;
  maxStarts: number;
  deadlineAt: string;
  maxResponseBytes: number;
}
export interface HostedJobRecord {
  issued: IssuedMessage;
  raw: string;
  taskBytesBase64: string;
  outputContractRaw: string | null;
  state: "awaiting_approval" | "approved" | "unknown" | "completed" | "blocked_auth" | "failed";
  approval: { actorId: string; taskSpecHash: string; issuedAt: string; expiresAt: string } | null;
  attempted: boolean;
  attemptId: string | null;
  cancelRequestedAt: string | null;
  deadlineAt: string | null;
  response: HostedResponse | null;
  event: HostedEvent | null;
  acknowledged: boolean;
}
export interface BrowserRunControl {
  signal: AbortSignal;
  deadlineAt: string;
  shouldCancel(): boolean;
}
export type BrowserRun = (
  requestPath: string,
  control: BrowserRunControl,
) => Promise<BridgeResult | null>;
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
      return (await controller.run()).result;
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
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS hosted_jobs (id TEXT PRIMARY KEY, hash TEXT NOT NULL, snapshot TEXT NOT NULL); CREATE TABLE IF NOT EXISTS hosted_configuration (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS hosted_reconcile_cursor (id INTEGER PRIMARY KEY CHECK(id=1), request_id TEXT NOT NULL); INSERT OR IGNORE INTO hosted_reconcile_cursor VALUES (1,''); CREATE TABLE IF NOT EXISTS hosted_identity (id INTEGER PRIMARY KEY CHECK(id=1), claimant TEXT NOT NULL); CREATE TABLE IF NOT EXISTS hosted_cursor (id INTEGER PRIMARY KEY CHECK(id=1), path TEXT NOT NULL); INSERT OR IGNORE INTO hosted_cursor VALUES (1,''); CREATE TABLE IF NOT EXISTS hosted_budget (id INTEGER PRIMARY KEY CHECK(id=1), starts INTEGER NOT NULL); INSERT OR IGNORE INTO hosted_budget VALUES (1,0);",
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
    return row ? (JSON.parse(row.snapshot) as HostedJobRecord) : null;
  }
  private save(job: HostedJobRecord) {
    this.db
      .prepare("UPDATE hosted_jobs SET snapshot=? WHERE id=?")
      .run(JSON.stringify(job), job.issued.requestId);
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
      registry: this.bus.registry,
      policyHash: this.policyHash,
      conversationUrl: this.policy.conversationUrl,
      expectedOutputPolicy: this.policy.expectedOutputPolicy,
    });
  }
  private promptFor(job: HostedJobRecord, frame: ResponseFrameIdentity): Uint8Array {
    if (!job.outputContractRaw) throw new Error("output_contract_required");
    return createOutputContractPrompt(
      Buffer.from(job.taskBytesBase64, "base64"),
      frame,
      Buffer.from(job.outputContractRaw, "base64"),
    );
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
      throw new Error("output_contract_replacement_denied");
    if (prior) {
      if (JSON.stringify(prior.issued) !== JSON.stringify(issued))
        throw new Error("browser_delivery_replay_conflict");
      return;
    }
    const job: HostedJobRecord = {
      issued,
      raw: Buffer.from(raw).toString("utf8"),
      taskBytesBase64: Buffer.from(taskBytes).toString("base64"),
      outputContractRaw: contractRaw ? Buffer.from(contractRaw).toString("base64") : null,
      state: "awaiting_approval",
      approval: null,
      attempted: false,
      attemptId: null,
      cancelRequestedAt: null,
      deadlineAt: null,
      response: null,
      event: null,
      acknowledged: false,
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
      if (result) await this.capture(job, result, dir);
      return this.get(requestId) ?? job;
    } finally {
      this.active.delete(requestId);
    }
  }
  private async capture(job: HostedJobRecord, result: BridgeResult, dir: string) {
    if (
      !validateResult(result).valid ||
      result.requestId !== job.issued.requestId ||
      result.target === "dot"
    )
      throw new Error("browser_delivery_result_invalid");
    let markdown: string | null = null;
    let framing: HostedResponse["framing"] = null;
    if (result.status === "completed") {
      if (
        !result.responseFile ||
        resolve(dir, result.responseFile) !== join(dir, "response.md") ||
        result.conversationUrl !== this.policy.conversationUrl
      )
        throw new Error("browser_delivery_result_identity_mismatch");
      const raw = await readFile(join(dir, "response.md"));
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
      if (!current?.attempted) throw new Error("browser_delivery_intent_missing");
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
    if (job.event && job.response && !job.acknowledged) {
      await this.bus.publishHosted(job.event, Buffer.from(`${JSON.stringify(job.response)}\n`));
      const ack = await this.bus.readHosted(await this.bus.git.snapshot(), requestId, "hosted_ack");
      if (ack) {
        if (
          !isDeepStrictEqual(ack, {
            ...job.event,
            actorId: job.issued.requesterId,
            stage: "hosted_ack",
          })
        )
          throw new Error("browser_delivery_ack_mismatch");
        job.acknowledged = true;
        this.save(job);
      }
    }
    return this.get(requestId) ?? job;
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
        const { issued, raw, taskBytes, outputContractRaw } = await this.bus.readIssued(
          snapshot,
          path,
        );
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
