/** One host/profile scoped projection for direct and hosted ordinary-Chat sources. */
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { mkdir, opendir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { slugMatches } from "../chatgpt/selectors.js";
import type { BridgeConfig } from "../cli/config.js";
import { atomicWriteFile } from "../contracts/atomic-write.js";
import { validateResult } from "../contracts/schema.js";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import type { BridgeResult } from "../contracts/types.js";
import { UiError } from "../contracts/ui.js";
import type { DirectUsagePort } from "../state/direct-usage.js";
import {
  markerPath,
  readMarker,
  type SubmissionBinding,
  type SubmitMarker,
  writeMarker,
} from "../state/marker.js";
import {
  type BridgeUsageEvent,
  type UsageConsumer,
  UsageLifecycleJournal,
  type UsageLifecycleSource,
} from "../state/usage-lifecycle.js";
import {
  readBoundedUsageText,
  USAGE_BINDING_MAX_BYTES,
  USAGE_MARKER_MAX_BYTES,
  USAGE_RESULT_MAX_BYTES,
} from "../state/usage-read.js";
import { ProObservationStore } from "./pro-counter.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]$/;
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
export function bridgeProScopeId(
  config: Pick<BridgeConfig, "runtimeDir" | "profileDir">,
  synthetic = false,
): string {
  return sha256Bytes(
    Buffer.from(
      JSON.stringify({
        version: 1,
        principal: process.getuid?.() ?? "unsupported",
        runtimeDir: resolve(config.runtimeDir),
        profileDir: resolve(config.profileDir),
        synthetic,
      }),
    ),
  );
}
/** Pro describes observed UI semantics only, never equivalence of provider quota buckets. */
export function qualifiedProPreset(result: BridgeResult): "pro" | "other" | "unknown" {
  if (result.observedPreset !== null && result.observedPreset !== "pro") return "other";
  if (
    result.observedPreset !== "pro" ||
    !["gpt-5.5", "gpt-5.6-sol"].includes(result.observedModel ?? "") ||
    (result.requestedModel !== "current" &&
      result.requestedModel !== "latest" &&
      result.requestedModel !== result.observedModel) ||
    result.warnings.some((warning) => warning.startsWith("model_slug_mismatch:")) ||
    (result.observedModelSlug !== null &&
      !slugMatches(result.observedModel, result.observedPreset, result.observedModelSlug).ok)
  )
    return "unknown";
  return "pro";
}
export function projectUsageEvent(store: ProObservationStore, event: BridgeUsageEvent): void {
  if (event.kind === "coverage_gap") {
    store.recordCoverageGap(`${event.sourceId}:${event.eventId}`, event.attemptedAt);
    return;
  }
  if (!event.attemptId || !event.attemptedAt) return;
  const base = {
    requestId: event.requestId,
    attemptId: event.attemptId,
    revision: event.revision,
    attemptedAt: event.attemptedAt,
    observedAt: event.observedAt,
    synthetic: store.synthetic,
  };
  if (event.kind === "start") {
    store.observeStartIntent({
      ...base,
      submitted: "unknown",
      observedPreset: "unknown",
      source:
        event.origin === "direct" ? "trusted-direct-start-intent" : "trusted-hosted-start-intent",
    });
    return;
  }
  const result = event.result;
  if (
    !result ||
    !validateResult(result).valid ||
    result.requestId !== event.requestId ||
    result.target === "dot" ||
    result.completedAt !== event.observedAt ||
    Date.parse(result.startedAt) > Date.parse(result.completedAt)
  )
    throw new Error("counter_source_result_mismatch");
  store.observe({
    ...base,
    submitted: result.submitted,
    observedPreset: qualifiedProPreset(result),
    source: "trusted-ordinary-chat-observer",
  });
}
interface RunBinding {
  version: 1;
  runId: string;
  requestId: string;
  requestPath: string;
  startedAt: string;
  scopeId: string;
  submission?: SubmissionBinding;
}
function validSubmission(
  value: SubmissionBinding | undefined,
  scopeId: string,
  requestId: string,
): value is SubmissionBinding {
  return (
    !!value &&
    value.version === 1 &&
    value.requestId === requestId &&
    UUID.test(value.attemptId) &&
    instant(value.attemptedAt) &&
    value.scopeId === scopeId &&
    (value.owner === "direct" || value.owner === "hosted")
  );
}
async function privateFile(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    realpathSync(directory) !== directory ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new UiError("counter_storage_untrusted", "Private counter directory required", 409);
  const path = join(directory, name);
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const file = lstatSync(path);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1 ||
    file.uid !== process.getuid?.() ||
    (file.mode & 0o077) !== 0
  )
    throw new UiError("counter_storage_untrusted", "Private counter file required", 409);
  return path;
}
export class BridgeProCounterRuntime implements DirectUsagePort, UsageLifecycleSource {
  readonly scopeId: string;
  readonly sourceId: string;
  private readonly journal: UsageLifecycleJournal;
  private readonly hosted = new Map<string, UsageLifecycleSource>();
  private scanning: Awaited<ReturnType<typeof opendir>> | null = null;
  private refreshing: Promise<void> | null = null;
  private closed = false;
  constructor(
    readonly store: ProObservationStore,
    private readonly db: DatabaseSync,
    private readonly config: BridgeConfig,
  ) {
    this.scopeId = bridgeProScopeId(config, store.synthetic);
    if (store.scopeId !== this.scopeId) throw new Error("counter_scope_unavailable");
    this.journal = new UsageLifecycleJournal(db);
    this.sourceId = this.journal.sourceId;
    store.setSourcePending(`direct:${this.sourceId}`, true);
  }
  private bindingPath(id: string) {
    if (!ID.test(id)) throw new Error("usage_request_invalid");
    return join(this.config.stateDir, id, "run.binding.json");
  }
  private async readBinding(id: string): Promise<RunBinding | null> {
    try {
      const value = parseStrictJsonBytes(
        Buffer.from(await readBoundedUsageText(this.bindingPath(id), USAGE_BINDING_MAX_BYTES)),
      ) as RunBinding;
      if (
        value.version !== 1 ||
        value.requestId !== id ||
        !UUID.test(value.runId) ||
        value.scopeId !== this.scopeId ||
        !instant(value.startedAt) ||
        resolve(value.requestPath) !== value.requestPath ||
        (value.submission && !validSubmission(value.submission, this.scopeId, id))
      )
        throw new Error("usage_binding_invalid");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private append(input: Parameters<UsageLifecycleJournal["append"]>[0], raw?: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = this.journal.append(input, raw);
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async beginRun(requestId: string, requestPath: string, startedAt: string): Promise<void> {
    const prior = await this.readBinding(requestId);
    if (prior) {
      if (prior.requestPath !== resolve(requestPath)) throw new Error("usage_run_binding_conflict");
      return;
    }
    const binding: RunBinding = {
      version: 1,
      runId: randomUUID(),
      requestId,
      requestPath: resolve(requestPath),
      startedAt,
      scopeId: this.scopeId,
    };
    await atomicWriteFile(this.bindingPath(requestId), JSON.stringify(binding));
  }
  async markerWritten(marker: SubmitMarker): Promise<void> {
    const binding = marker.submissionBinding;
    if (!validSubmission(binding, this.scopeId, marker.requestId))
      throw new Error("usage_submission_binding_invalid");
    if (binding.owner === "hosted") return;
    const run = await this.readBinding(marker.requestId);
    if (!run) throw new Error("usage_run_binding_missing");
    if (run.submission && JSON.stringify(run.submission) !== JSON.stringify(binding))
      throw new Error("usage_submission_binding_conflict");
    if (!run.submission)
      await atomicWriteFile(
        this.bindingPath(marker.requestId),
        JSON.stringify({ ...run, submission: binding }),
      );
    this.store.setSourcePending(`journal:${this.sourceId}`, true);
    this.append(
      {
        origin: "direct",
        kind: "start",
        requestId: marker.requestId,
        requesterActorId: null,
        runId: run.runId,
        attemptId: binding.attemptId,
        attemptedAt: binding.attemptedAt,
        observedAt: binding.attemptedAt,
      },
      JSON.stringify(binding),
    );
  }
  private async observeRaw(run: RunBinding, raw: string): Promise<void> {
    if (Buffer.byteLength(raw) > USAGE_RESULT_MAX_BYTES) throw new Error("usage_result_oversized");
    const result = parseStrictJsonBytes(Buffer.from(raw)) as BridgeResult;
    if (
      !validateResult(result).valid ||
      result.requestId !== run.requestId ||
      result.target === "dot" ||
      result.startedAt === null ||
      Date.parse(result.startedAt) < Date.parse(run.startedAt)
    )
      throw new Error("usage_result_binding_invalid");
    if (run.submission?.owner === "hosted") return;
    this.append(
      {
        origin: "direct",
        kind: "result",
        requestId: run.requestId,
        requesterActorId: null,
        runId: run.runId,
        attemptId: run.submission?.attemptId ?? null,
        attemptedAt: run.submission?.attemptedAt ?? null,
        observedAt: result.completedAt,
        result,
      },
      raw,
    );
  }
  async resolveNotSent(binding: SubmissionBinding, result: BridgeResult): Promise<void> {
    if (binding.owner === "hosted") return;
    const run = await this.readBinding(binding.requestId);
    if (
      !run?.submission ||
      JSON.stringify(run.submission) !== JSON.stringify(binding) ||
      result.submitted !== "no"
    )
      throw new Error("usage_unsent_identity_invalid");
    await this.observeRaw(run, JSON.stringify(result));
    await this.project();
  }
  async resultWritten(result: BridgeResult): Promise<void> {
    if (!result.requestId) return;
    const run = await this.readBinding(result.requestId);
    if (!run) return;
    const raw = await readBoundedUsageText(
      join(dirname(run.requestPath), "result.json"),
      USAGE_RESULT_MAX_BYTES,
    );
    await this.observeRaw(run, raw);
    await this.project();
  }
  async recordCollected(requestId: string, result: BridgeResult): Promise<void> {
    const path = markerPath(this.config.stateDir, requestId),
      marker = await readMarker(path);
    if (!marker || !validSubmission(marker.submissionBinding, this.scopeId, requestId)) {
      this.store.recordCoverageGap(
        `legacy:${requestId}`,
        marker && instant(marker.writtenAt) ? marker.writtenAt : null,
      );
      return;
    }
    const raw = JSON.stringify(result);
    await writeMarker(path, { ...marker, recoveredUsage: { raw } });
    if (marker.submissionBinding.owner === "hosted") return; // Outer hosted reconciliation owns this stream.
    await this.markerWritten(marker);
    const run = await this.readBinding(requestId);
    if (!run) throw new Error("usage_run_binding_missing");
    await this.observeRaw(run, raw);
    await this.project();
  }
  attachHosted(source: UsageLifecycleSource): void {
    if (source.scopeId !== this.scopeId) throw new Error("counter_source_scope_mismatch");
    this.hosted.set(source.sourceId, source);
    this.store.setSourcePending(`hosted:${source.sourceId}`, true);
  }
  registerLifecycleSink(
    namespace: string,
    binding: import("../state/usage-lifecycle.js").LifecycleSinkBinding,
  ): void {
    this.journal.registerLifecycleSink(namespace, binding);
  }
  cursorPosition(consumerId: string): number {
    return this.journal.cursorPosition(consumerId);
  }
  async drainLifecycle(id: string, consumer: UsageConsumer, limit = 32) {
    return this.journal.drainLifecycle(id, consumer, limit);
  }
  private async project(): Promise<void> {
    this.store.setSourcePending(`journal:${this.sourceId}`, true);
    const r = await this.drainProjection(this.journal);
    this.store.setSourcePending(`journal:${this.sourceId}`, r.pending);
  }
  private async drainProjection(
    source: UsageLifecycleSource,
  ): Promise<{ processed: number; pending: boolean }> {
    // Cursor identity belongs to this projection generation, not merely to the observer role.
    const consumerId = `pro_counter_${this.store.generationId.replaceAll("-", "")}`;
    // Read source first: a concurrent worker advances the target receipt BEFORE this cursor.
    const sourcePosition = source.cursorPosition?.(consumerId);
    const targetPosition = this.store.projectionPosition(source.sourceId);
    if (sourcePosition === undefined || sourcePosition > targetPosition)
      this.store.recordCoverageGap(`projection_restoration:${source.sourceId}`, null);
    return source.drainLifecycle(
      consumerId,
      (event) => {
        projectUsageEvent(this.store, event);
        this.store.recordProjectionPosition(source.sourceId, event.sequence);
      },
      100,
    );
  }
  private async scanOne(id: string): Promise<void> {
    const marker = await readMarker(markerPath(this.config.stateDir, id));
    const run = await this.readBinding(id);
    if (marker?.target === "dot") return;
    if (marker) {
      if (!validSubmission(marker.submissionBinding, this.scopeId, id)) {
        this.store.recordCoverageGap(
          `legacy:${id}`,
          instant(marker.writtenAt) ? marker.writtenAt : null,
        );
        return;
      }
      if (marker.submissionBinding.owner === "hosted") return;
      await this.markerWritten(marker);
    } else {
      try {
        await readBoundedUsageText(markerPath(this.config.stateDir, id), USAGE_MARKER_MAX_BYTES);
        this.store.recordCoverageGap(`legacy:${id}`, null);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const current = run ? await this.readBinding(id) : null;
    if (!current) return;
    try {
      await this.observeRaw(
        current,
        await readBoundedUsageText(
          join(dirname(current.requestPath), "result.json"),
          USAGE_RESULT_MAX_BYTES,
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (marker?.recoveredUsage) await this.observeRaw(current, marker.recoveredUsage.raw);
  }
  async refresh(): Promise<void> {
    if (this.closed) throw new Error("counter_runtime_closed");
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshInner().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  private async refreshInner(): Promise<void> {
    this.store.setSourcePending(`direct:${this.sourceId}`, true);
    try {
      if (!this.scanning) {
        await mkdir(this.config.stateDir, { recursive: true });
        this.scanning = await opendir(this.config.stateDir);
      }
      let done = false;
      for (let n = 0; n < 100; n++) {
        const entry = await this.scanning.read();
        if (!entry) {
          done = true;
          await this.scanning.close();
          this.scanning = null;
          break;
        }
        if (ID.test(entry.name) && entry.isDirectory()) await this.scanOne(entry.name);
      }
      await this.project();
      this.store.setSourcePending(`direct:${this.sourceId}`, !done);
      for (const source of this.hosted.values()) {
        this.store.setSourcePending(`hosted:${source.sourceId}`, true);
        const value = await this.drainProjection(source);
        this.store.setSourcePending(`hosted:${source.sourceId}`, value.pending);
      }
    } catch (error) {
      this.store.setSourcePending(`direct:${this.sourceId}`, true);
      throw error;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await this.refreshing;
    if (this.scanning) {
      await this.scanning.close();
      this.scanning = null;
    }
    this.closed = true;
    this.db.close();
    this.store.close();
  }
}
export async function openBridgeProCounter(
  config: BridgeConfig,
  profile: "production" | "demo" = "production",
  now: () => Date = () => new Date(),
): Promise<BridgeProCounterRuntime> {
  if (process.platform === "win32")
    throw new UiError(
      "counter_storage_verifier_unavailable",
      "Native private-state verification unavailable",
      409,
    );
  if (profile !== "production" && profile !== "demo") throw new Error("counter_profile_invalid");
  if (profile === "demo")
    config = { ...config, stateDir: join(config.runtimeDir, "ui-demo", "state") };
  const directory = resolve(config.runtimeDir, "pro-counter", profile);
  const store = new ProObservationStore(
    await privateFile(directory, "counter.db"),
    profile === "demo",
    now,
    bridgeProScopeId(config, profile === "demo"),
  );
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(await privateFile(directory, "lifecycle.db"));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    const runtime = new BridgeProCounterRuntime(store, db, config);
    await runtime.refresh();
    return runtime;
  } catch (error) {
    db?.close();
    store.close();
    throw error;
  }
}
