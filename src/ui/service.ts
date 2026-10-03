/** Product operations compose the v2 controller and persistent ledger, never spawn a CLI. */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serializeMaterializationReceiptV1 } from "../contracts/materialization.js";
import {
  loadTaskSpec,
  serializeTaskResult,
  sha256Bytes,
  validateTaskResult,
  verifyTaskFileBytes,
} from "../contracts/task.js";
import type { ApprovalEnvelope, TaskSpec } from "../contracts/task-types.js";
import {
  type UiAck,
  type UiAction,
  type UiBinding,
  type UiBootstrap,
  type UiCapabilities,
  type UiCapability,
  type UiDemoOutcome,
  type UiDemoTask,
  type UiDiagnostics,
  UiError,
  type UiImport,
  type UiMetadata,
  type UiProfile,
  type UiTaskResponse,
  type UiTaskSummary,
  type UiValidation,
} from "../contracts/ui.js";
import { TaskController } from "../state/task-controller.js";
import { UnavailableTaskExecutor } from "../state/task-executor.js";
import { isTerminalTask } from "../state/task-machine.js";
import type { TaskPolicy } from "../state/task-policy.js";
import {
  type AdapterHealth,
  type QuotaFallback,
  type QuotaObservation,
  taskPreflight,
} from "../state/task-preflight.js";
import { openTaskStore, type TaskRecord, type TaskStore } from "../state/task-store.js";
import { DEMO_LABEL, DemoAuthority, DemoTaskExecutor, demoPolicy, demoTask } from "./demo.js";

export interface UiRuntime {
  store: TaskStore;
  controller: TaskController;
  materialize?(
    requestId: string,
  ): Promise<import("../contracts/materialization.js").MaterializationReceiptV1>;
  authority?: { approve(requestId: string): Promise<ApprovalEnvelope> };
  /** Authenticated local caller identity, fixed by trusted host wiring, never by request JSON. */
  authenticatedRequesterId?: string;
  /** Bounded local authority RPC; host configuration only, at most 5 seconds. */
  authorityTimeoutMs?: number;
  /** Explicit trusted deployment wiring, never request JSON. Missing entries deny. */
  capabilities?: Partial<Record<"approve" | "start" | "cancel" | "reconcile", boolean>>;
  capabilityReasons?: Partial<Record<UiAction, string>>;
  preflight?: { health: AdapterHealth; quota: QuotaObservation; fallback?: QuotaFallback };
}
export interface UiServiceOptions {
  profile?: UiProfile;
  stateDir: string;
  runtime?: UiRuntime;
}
const cap = (enabled: boolean, reason: string): UiCapability => ({ enabled, reason });
const unavailableReason =
  "Production execution and approval authority are unconfigured; validation and inspection remain available";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class TaskUiService {
  readonly profile: UiProfile;
  readonly authenticatedRequesterId: string;
  private readonly authorityTimeoutMs: number;
  private readonly mutations = new Map<string, Promise<unknown>>();
  constructor(
    readonly runtime: UiRuntime,
    options: { profile?: UiProfile } = {},
  ) {
    this.profile = options.profile ?? "production";
    this.authenticatedRequesterId = runtime.authenticatedRequesterId ?? "local-ui-requester";
    this.authorityTimeoutMs = runtime.authorityTimeoutMs ?? 5000;
    if (
      !Number.isFinite(this.authorityTimeoutMs) ||
      this.authorityTimeoutMs <= 0 ||
      this.authorityTimeoutMs > 5000
    )
      throw new UiError(
        "invalid_authority_timeout",
        "Authority timeout must be positive and at most 5000 ms",
        500,
      );
    if (runtime.store !== runtime.controller.store)
      throw new UiError("runtime_mismatch", "Runtime controller and ledger must match", 500);
    if ((this.profile === "demo") !== runtime.controller.executor.synthetic)
      throw new UiError(
        "profile_mismatch",
        "Synthetic runtime must use the explicit isolated demo profile",
        500,
      );
  }
  metadata(): UiMetadata {
    return {
      profile: this.profile,
      synthetic: this.profile === "demo",
      label:
        this.profile === "demo"
          ? DEMO_LABEL
          : "Production ledger — execution requires configured trusted authority and confinement",
    };
  }
  capabilities(record?: TaskRecord): UiCapabilities {
    const { controller, authority } = this.runtime;
    const configured = !(controller.executor instanceof UnavailableTaskExecutor);
    const sameSession =
      !record ||
      (record.sessionId === controller.policy.sessionId &&
        record.bridgeId === controller.policy.bridgeId);
    const supported = (action: "approve" | "start" | "cancel" | "reconcile") =>
      configured &&
      sameSession &&
      this.runtime.capabilities?.[action] === true &&
      (action !== "approve" || !!authority);
    const reason = (action: UiAction) =>
      this.runtime.capabilityReasons?.[action] ??
      (sameSession
        ? unavailableReason
        : "This task belongs to another configured runtime session; read-only inspection is available");
    const answer: UiCapabilities = {
      validate: cap(true, "Schema and exact raw UTF-8 hashes are checked without execution"),
      import: cap(
        true,
        "Persist an immutable TaskSpec and Markdown for inspection; import grants no authority",
      ),
      approve: cap(
        supported("approve"),
        supported("approve")
          ? "Explicit detached approval for the inspected hashes"
          : reason("approve"),
      ),
      start: cap(
        supported("start"),
        supported("start") ? "One authorized start per immutable request UUID" : reason("start"),
      ),
      cancel: cap(
        supported("cancel"),
        supported("cancel")
          ? "Persist cancellation and reconcile the same execution identity"
          : reason("cancel"),
      ),
      reconcile: cap(
        supported("reconcile"),
        supported("reconcile")
          ? "Observe the existing run only; never reexecute"
          : reason("reconcile"),
      ),
      ack: cap(
        this.profile === "demo" || !!this.runtime.materialize,
        "Requester materialization of verified result, receipt and required artifact bytes is required",
      ),
      demo: cap(
        this.profile === "demo",
        this.profile === "demo"
          ? DEMO_LABEL
          : "Restart with --profile demo to use isolated synthetic tasks",
      ),
    };
    if (record) {
      if (answer.approve.enabled && record.result.status !== "awaiting_approval")
        answer.approve = cap(false, "Only tasks awaiting approval may receive a grant");
      if (answer.start.enabled && record.intent)
        answer.start = cap(
          false,
          "A start intent is already consumed; reconcile this UUID and never reexecute it",
        );
      else if (answer.start.enabled && record.result.status !== "approved")
        answer.start = cap(false, "An unconsumed detached approval is required before start");
      if (answer.cancel.enabled && isTerminalTask(record.result.status))
        answer.cancel = cap(false, "Terminal result is immutable");
      if (answer.reconcile.enabled && !record.intent)
        answer.reconcile = cap(false, "No dispatch intent exists to reconcile");
      answer.ack = cap(
        (record.result.synthetic || !!this.runtime.materialize) &&
          record.requesterId === this.authenticatedRequesterId &&
          !!this.runtime.store.handshake(record.result.request_id, "terminal_result"),
        record.requesterId !== this.authenticatedRequesterId
          ? "This delivery belongs to another authenticated requester; its recipient adapter must acknowledge it"
          : !record.result.synthetic && !this.runtime.materialize
            ? "Requester-side materialization adapter is not configured"
            : "A persisted terminal event and its exact payload hash are required",
      );
    }
    return answer;
  }
  diagnostics(): UiDiagnostics {
    const capabilities = this.capabilities();
    return {
      checks: [
        {
          id: "ledger",
          status: "ok",
          message:
            "Host-local SQLite persistence; task snapshots, receipt events, and result ACKs survive restart",
        },
        {
          id: "executor",
          status: capabilities.start.enabled ? "ok" : "blocked",
          message: capabilities.start.reason,
        },
        {
          id: "authority",
          status: capabilities.approve.enabled ? "ok" : "blocked",
          message: capabilities.approve.reason,
        },
        {
          id: "quota",
          status: "unknown",
          message: "No live provider quota or billing estimate was fetched",
        },
        { id: "profile", status: "ok", message: this.metadata().label },
      ],
      executionEnabled: capabilities.start.enabled,
      approvalConfigured: !!this.runtime.authority,
      quota: { state: "unknown", source: "unknown", billingEstimate: null },
      automaticReexecution: false,
    };
  }
  private required(requestId: string): TaskRecord {
    if (!UUID.test(requestId))
      throw new UiError("invalid_request_id", "A canonical request UUID is required");
    const record = this.runtime.store.get(requestId);
    if (!record) throw new UiError("task_not_found", "No task exists for this UUID", 404);
    const parsed = loadTaskSpec(Buffer.from(record.rawSpec), record.result.task_spec_hash);
    if (
      !parsed.valid ||
      !verifyTaskFileBytes(parsed.task, Buffer.from(record.taskBytesBase64, "base64")).valid
    )
      throw new UiError(
        "stored_task_integrity_mismatch",
        "Stored task integrity validation failed",
        409,
      );
    const result = validateTaskResult(record.result, {
      task: parsed.task,
      taskSpecHash: parsed.taskSpecHash,
    });
    if (!result.valid)
      throw new UiError("stored_result_invalid", "Stored result failed contract validation", 409);
    const receipt = this.runtime.store.receipt(requestId);
    if (receipt || isTerminalTask(record.result.status)) {
      let matches = false;
      try {
        matches =
          !!receipt &&
          JSON.stringify(record) === JSON.stringify(receipt) &&
          Buffer.from(serializeTaskResult(record.result)).equals(
            Buffer.from(this.runtime.store.deliveryPayload(requestId)),
          );
      } catch {
        /* Missing or mismatched immutable evidence must fail closed. */
      }
      if (!matches)
        throw new UiError(
          "terminal_snapshot_mismatch",
          "Terminal record does not match its immutable delivery evidence",
          409,
        );
    }
    return record;
  }
  private summary(record: TaskRecord): UiTaskSummary {
    const markdown = Buffer.from(record.taskBytesBase64, "base64").toString("utf8");
    const title =
      markdown
        .split(/\r?\n/)
        .find((line) => line.trim())
        ?.replace(/^#+\s*/, "")
        .slice(0, 120) || "Untitled task";
    return {
      requestId: record.result.request_id,
      title,
      status: record.result.status,
      sequence: record.result.observation_seq,
      synthetic: record.result.synthetic,
      updatedAt: record.result.observed_at,
      runId: record.result.run_id,
      outcomeKnown: record.result.outcome_known,
      deliveryAcknowledged: this.runtime.store.deliveryVerified(record.result.request_id),
    };
  }
  bootstrap(): UiBootstrap {
    return {
      ...this.metadata(),
      capabilities: this.capabilities(),
      tasks: this.runtime.store
        .listAll()
        .map((record) => this.summary(this.required(record.result.request_id))),
      diagnostics: this.diagnostics(),
    };
  }
  task(requestId: string): UiTaskResponse {
    const record = this.required(requestId);
    const spec = JSON.parse(record.rawSpec) as TaskSpec;
    const now = new Date();
    const demo = this.profile === "demo";
    const preflight = taskPreflight(
      spec,
      this.runtime.controller.policy,
      this.runtime.preflight?.health ?? {
        adapterId: this.runtime.controller.executor.executorId,
        route: this.profile === "demo" ? "fake" : "cli_subscription",
        state: demo ? "verified" : "unconfigured",
        source: this.profile === "demo" ? "synthetic-local-demo" : "trusted-runtime-configuration",
        observedAt: now.toISOString(),
        maxAgeSeconds: 30,
        models: demo ? ["synthetic-model"] : [],
        efforts: [],
      },
      this.runtime.preflight?.quota ?? {
        source: "unknown",
        observedAt: null,
        windowEndsAt: null,
        remainingPercent: null,
        maxAgeSeconds: 30,
      },
      this.runtime.preflight?.fallback ??
        (demo ? { preauthorized: true, maxStarts: 1000, maxRunSeconds: 3600 } : null),
      now,
    );
    const store = this.runtime.store;
    const materialization = store.materialization(requestId);
    const handshakes = {
      receipt_ack: store.handshake(requestId, "receipt_ack"),
      start_receipt: store.handshake(requestId, "start_receipt"),
      terminal_result: store.handshake(requestId, "terminal_result"),
      result_ack: store.handshake(requestId, "result_ack"),
    };
    return {
      ...this.metadata(),
      task: {
        summary: this.summary(record),
        spec,
        rawSpec: record.rawSpec,
        taskMarkdown: Buffer.from(record.taskBytesBase64, "base64").toString("utf8"),
        result: record.result,
        intent: record.intent,
        events: store.events(requestId).map((event) => event.result),
        approvals: store.approvalsForRequest(requestId),
        handshakes,
        delivery: {
          acknowledged: store.deliveryVerified(requestId),
          materialization: record.result.synthetic
            ? "synthetic_demo"
            : materialization
              ? "verified"
              : "pending",
          materializationSha256: materialization
            ? sha256Bytes(Buffer.from(serializeMaterializationReceiptV1(materialization)))
            : null,
          payloadAckObserved: !!handshakes.result_ack,
          payloadSha256: handshakes.terminal_result?.payloadSha256 ?? null,
        },
        preflight,
        capabilities: this.capabilities(record),
      },
    };
  }
  validate(input: UiImport): UiValidation {
    const raw = Buffer.from(input.rawSpec, "utf8");
    const markdown = Buffer.from(input.taskMarkdown, "utf8");
    const parsed = loadTaskSpec(raw);
    const errors = parsed.valid ? verifyTaskFileBytes(parsed.task, markdown).errors : parsed.errors;
    return {
      ...this.metadata(),
      valid: errors.length === 0,
      errors,
      taskSpecHash: parsed.valid ? parsed.taskSpecHash : null,
      taskFileHash: sha256Bytes(markdown),
      requestId: parsed.valid ? parsed.task.request_id : null,
    };
  }
  import(input: UiImport): UiTaskResponse {
    const checked = this.validate(input);
    if (!checked.valid)
      throw new UiError(
        "invalid_task",
        "TaskSpec or Markdown failed schema and exact-byte hash validation",
      );
    const record = this.runtime.controller.receive(
      Buffer.from(input.rawSpec),
      Buffer.from(input.taskMarkdown),
      null,
      this.authenticatedRequesterId,
    );
    return this.task(record.result.request_id);
  }
  createDemo(input: UiDemoTask): UiTaskResponse {
    if (this.profile !== "demo")
      throw new UiError(
        "demo_disabled",
        "Synthetic task creation requires the explicit demo profile",
        403,
      );
    return this.import(demoTask(input));
  }
  private requireCapability(action: UiAction, record: TaskRecord): void {
    const capability = this.capabilities(record)[action];
    if (!capability.enabled) throw new UiError(`${action}_unavailable`, capability.reason, 409);
  }
  private checkBinding(record: TaskRecord, binding: UiBinding): void {
    if (
      record.result.task_spec_hash !== binding.taskSpecHash ||
      record.result.task_file_hash !== binding.taskFileHash ||
      record.result.observation_seq !== binding.sequence
    )
      throw new UiError(
        "stale_task_snapshot",
        "The inspected task has changed; refresh and review its current hashes and sequence",
        409,
      );
  }
  private async serial<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.mutations.get(requestId) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    this.mutations.set(requestId, current);
    try {
      return await current;
    } finally {
      if (this.mutations.get(requestId) === current) this.mutations.delete(requestId);
    }
  }
  async approve(requestId: string, binding: UiBinding): Promise<UiTaskResponse> {
    return this.serial(requestId, async () => {
      const record = this.required(requestId);
      this.requireCapability("approve", record);
      this.checkBinding(record, binding);
      const authority = this.runtime.authority;
      if (!authority) throw new UiError("approval_authority_unconfigured", unavailableReason, 409);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let grant: ApprovalEnvelope;
      try {
        grant = await Promise.race([
          authority.approve(requestId),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new UiError(
                    "approval_authority_timeout",
                    "Approval authority did not respond; no approval was persisted",
                    504,
                  ),
                ),
              this.authorityTimeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      // Cancel and reconcile bypass the mutation queue. Never apply a late grant to a changed task.
      this.checkBinding(this.required(requestId), binding);
      this.runtime.controller.approve(requestId, grant);
      return this.task(requestId);
    });
  }
  async start(requestId: string, binding: UiBinding): Promise<UiTaskResponse> {
    return this.serial(requestId, async () => {
      const record = this.required(requestId);
      // A repeat can return the existing snapshot, but is never offered as an enabled UI action.
      if (record.intent) {
        this.checkBinding(record, binding);
        if (
          !this.capabilities().start.enabled ||
          record.sessionId !== this.runtime.controller.policy.sessionId
        )
          throw new UiError(
            "start_unavailable",
            "This runtime cannot operate the existing task",
            409,
          );
        return this.task(requestId);
      }
      this.requireCapability("start", record);
      this.checkBinding(record, binding);
      const grant = this.runtime.store
        .approvalsForRequest(requestId)
        .find((item) => !item.consumed && item.envelope.decision === "approved");
      const approvalId = grant?.envelope.approval_id;
      if (!approvalId)
        throw new UiError("approval_required", "A detached unconsumed approval is required", 409);
      await this.runtime.controller.start(requestId, approvalId);
      return this.task(requestId);
    });
  }
  async cancel(requestId: string): Promise<UiTaskResponse> {
    // Never queue a stop behind an authority or executor response. Core persists cancel intent
    // synchronously before its bounded broker await, and CAS fences late start observations.
    const record = this.required(requestId);
    this.requireCapability("cancel", record);
    await this.runtime.controller.cancel(requestId);
    return this.task(requestId);
  }
  async reconcile(requestId: string): Promise<UiTaskResponse> {
    const record = this.required(requestId);
    this.requireCapability("reconcile", record);
    await this.runtime.controller.status(requestId);
    return this.task(requestId);
  }
  async acknowledge(requestId: string, binding: UiAck): Promise<UiTaskResponse> {
    return this.serial(requestId, async () => {
      const record = this.required(requestId);
      this.requireCapability("ack", record);
      const terminal = this.runtime.store.handshake(requestId, "terminal_result");
      if (
        !terminal ||
        terminal.eventId !== binding.eventId ||
        terminal.payloadSha256 !== binding.payloadSha256 ||
        terminal.sequence !== binding.sequence
      )
        throw new UiError(
          "delivery_identity_mismatch",
          "ACK must bind the exact terminal event, sequence and payload hash",
          409,
        );
      this.runtime.store.deliveryPayload(requestId); // Recheck immutable bytes before accepting delivery.
      const ack = {
        ...terminal,
        stage: "result_ack" as const,
        actorId: this.authenticatedRequesterId,
      };
      const proof = this.runtime.materialize
        ? await this.runtime.materialize(requestId)
        : undefined;
      if (
        record.sessionId === this.runtime.controller.policy.sessionId &&
        record.bridgeId === this.runtime.controller.policy.bridgeId
      )
        await this.runtime.controller.acknowledgeResult(ack, proof);
      else this.runtime.store.acknowledgeDelivery(ack, proof);
      return this.task(requestId);
    });
  }
  async demoObservation(requestId: string, outcome: UiDemoOutcome): Promise<UiTaskResponse> {
    return this.serial(requestId, async () => {
      const record = this.required(requestId);
      if (
        this.profile !== "demo" ||
        !(this.runtime.controller.executor instanceof DemoTaskExecutor)
      )
        throw new UiError("demo_disabled", "Synthetic observations require demo profile", 403);
      if (!record.intent || isTerminalTask(record.result.status))
        throw new UiError(
          "demo_run_not_running",
          "Start a demo run before selecting its observation",
          409,
        );
      this.runtime.controller.executor.observe(record.intent.runId, outcome);
      await this.runtime.controller.status(requestId);
      if (
        outcome !== "unknown" &&
        !this.runtime.store
          .listSession(record.sessionId)
          .some((task) => task.result.status === "unknown")
      )
        this.runtime.controller.resumeSession();
      return this.task(requestId);
    });
  }
  resultPayload(requestId: string): string {
    this.required(requestId);
    return Buffer.from(this.runtime.store.deliveryPayload(requestId)).toString("utf8");
  }
  close(): void {
    this.runtime.store.close();
  }
}

export async function openUiService(options: UiServiceOptions): Promise<TaskUiService> {
  const profile = options.profile ?? "production";
  if (options.runtime) return new TaskUiService(options.runtime, { profile });
  const directory = profile === "demo" ? join(options.stateDir, "ui-demo") : options.stateDir;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const store = await openTaskStore(join(directory, "jobs.db"));
  try {
    if (profile === "demo") {
      const workspace = join(directory, "workspace");
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      const executor = new DemoTaskExecutor();
      const policy = demoPolicy(workspace);
      const controller = new TaskController(store, executor, policy);
      const service = new TaskUiService(
        {
          store,
          controller,
          authority: new DemoAuthority(store, policy),
          capabilities: { approve: true, start: true, cancel: true, reconcile: true },
        },
        { profile },
      );
      // A restart loses synthetic executor observations, never the ledger or consumed start.
      for (const record of store.listSession(policy.sessionId))
        if (record.intent && !isTerminalTask(record.result.status))
          await controller.status(record.result.request_id);
      return service;
    }
    const executor = new UnavailableTaskExecutor();
    const policy: TaskPolicy = {
      ...demoPolicy(directory),
      bridgeId: "ui-production-inspection",
      executorId: executor.executorId,
      sessionId: "34f2a228-f837-4b83-bc16-06bef58eb27b",
      policyId: "unconfigured",
      revoked: true,
      agents: {},
      modes: [],
      maxStarts: 0,
    };
    return new TaskUiService(
      { store, controller: new TaskController(store, executor, policy) },
      { profile },
    );
  } catch (error) {
    store.close();
    throw error;
  }
}
