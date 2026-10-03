import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import {
  loadTaskSpec,
  sha256Bytes,
  validateApprovalEnvelope,
  validateTaskResult,
  verifyTaskFileBytes,
} from "../contracts/task.js";
import type {
  ApprovalEnvelope,
  ArtifactRef,
  ResultSpec,
  TaskSpec,
} from "../contracts/task-types.js";
import type { ExecutionIdentity, ExecutorObservation, TaskExecutor } from "./task-executor.js";
import { isTerminalTask } from "./task-machine.js";
import { checkFilesystemPath, checkTaskPolicy, type TaskPolicy } from "./task-policy.js";
import { type QuotaFallback, type QuotaObservation, quotaDecision } from "./task-preflight.js";
import {
  type AccountQuotaPort,
  type TaskQuotaSnapshot,
  validateAccountRateLimits,
} from "./task-quota.js";
import type { TaskHandshake, TaskRecord, TaskStore } from "./task-store.js";

function taskOf(record: TaskRecord): TaskSpec {
  return JSON.parse(record.rawSpec) as TaskSpec;
}
function identity(record: TaskRecord): ExecutionIdentity {
  if (!record.intent) throw new Error("run_not_started");
  return {
    requestId: record.result.request_id,
    taskSpecHash: record.result.task_spec_hash,
    runId: record.intent.runId,
    fencingToken: record.intent.fencingToken,
  };
}
function sameIdentity(a: ExecutionIdentity, b: ExecutionIdentity): boolean {
  return (
    a.requestId === b.requestId &&
    a.taskSpecHash === b.taskSpecHash &&
    a.runId === b.runId &&
    a.fencingToken === b.fencingToken
  );
}
function next(record: TaskRecord, now: Date): TaskRecord {
  const copy = structuredClone(record);
  copy.result.observation_seq++;
  copy.result.observed_at = now.toISOString();
  return copy;
}

/** This controller accepts trusted policy/executor ports, never task-provided authority. */
export class TaskController {
  constructor(
    readonly store: TaskStore,
    readonly executor: TaskExecutor,
    readonly policy: TaskPolicy,
    private readonly now: () => Date = () => new Date(),
    private readonly quotaGuard?: {
      observation: QuotaObservation;
      fallback: QuotaFallback | null;
      strictMoneyBudget: boolean;
    },
    private readonly rpcTimeoutMs = 5000,
    private readonly quotaSource?: AccountQuotaPort,
  ) {
    if (!Number.isFinite(rpcTimeoutMs) || rpcTimeoutMs <= 0) throw new Error("invalid_rpc_timeout");
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("executor_rpc_timeout")), this.rpcTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  receive(
    raw: Uint8Array,
    taskBytes: Uint8Array,
    transportRequestId: string | null = null,
    requesterId = "caller",
    context: {
      projectRegistration?:
        | import("../contracts/project-registry.js").ProjectRegistrationReference
        | null;
    } = {},
  ): TaskRecord {
    const parsed = loadTaskSpec(raw);
    if (!parsed.valid) throw new Error(`invalid_task: ${parsed.errors.join("; ")}`);
    const task = parsed.task;
    const file = verifyTaskFileBytes(task, taskBytes);
    if (!file.valid) throw new Error(`task_file_hash_mismatch: ${file.errors.join("; ")}`);
    if (task.mode === "design_fixture") throw new Error("fixture_not_executable");
    const at = this.now().toISOString();
    const result: ResultSpec = {
      protocol_version: "2.0",
      request_id: task.request_id,
      task_spec_hash: parsed.taskSpecHash,
      task_file_hash: task.task_file_hash,
      synthetic: this.executor.synthetic,
      status: "received",
      last_confirmed_status: "received",
      observation_seq: 1,
      observed_at: at,
      outcome_known: false,
      started_at: null,
      finished_at: null,
      actual_agent: null,
      actual_model: null,
      base_commit: task.base_commit,
      resulting_commit: null,
      run_id: null,
      fencing_token: 0,
      process_identity: null,
      commands_run: [],
      tests: [],
      exit_codes: [],
      changed_files: [],
      diff: { kind: "none", complete: false, artifact_ref: null },
      stdout_ref: null,
      stderr_ref: null,
      error: null,
      receipt: null,
      verification: {
        state: this.executor.synthetic ? "synthetic" : "pending",
        checked_at: null,
        evidence_ref: null,
      },
    };
    const received = this.store.receive({
      projectRegistration: context.projectRegistration ?? null,
      rawSpec: Buffer.from(raw).toString("utf8"),
      taskBytesBase64: Buffer.from(taskBytes).toString("base64"),
      result,
      intent: null,
      transportRequestId,
      bridgeId: this.policy.bridgeId,
      requesterId,
      sessionId: this.policy.sessionId,
      workflowId: null,
    });
    if (received.record.result.status !== "received") return received.record;
    const pending = next(received.record, this.now());
    pending.result.status = "awaiting_approval";
    pending.result.last_confirmed_status = "awaiting_approval";
    return this.store.save(pending, received.record.result.observation_seq);
  }

  private checkGrant(grant: ApprovalEnvelope, record: TaskRecord): void {
    const valid = validateApprovalEnvelope(grant);
    if (!valid.valid) throw new Error(`invalid_approval: ${valid.errors.join("; ")}`);
    const task = taskOf(record);
    const expectedTier =
      this.policy.confirmation === "autoapprove" ? "automatic" : this.policy.confirmation;
    if (
      grant.tier !== task.approval.tier ||
      task.approval.tier !== expectedTier ||
      JSON.stringify(grant.preauthorization) !== JSON.stringify(task.approval.preauthorization)
    )
      throw new Error("approval_policy_binding_mismatch");
    if (grant.tier !== "manual") {
      if (this.policy.requiresActionConfirmation) throw new Error("action_confirmation_required");
      const bound = grant.preauthorization;
      if (
        !bound ||
        bound.policy_id !== this.policy.policyId ||
        bound.policy_version !== this.policy.policyVersion ||
        bound.policy_sha256 !== this.policy.policyHash ||
        bound.session_id !== this.policy.sessionId ||
        !grant.usage_reservation_id
      )
        throw new Error("approval_policy_binding_mismatch");
    }
    const now = this.now().getTime();
    if (
      grant.decision !== "approved" ||
      grant.max_starts !== 1 ||
      grant.request_id !== task.request_id ||
      grant.task_spec_sha256 !== record.result.task_spec_hash ||
      grant.task_file_sha256 !== task.task_file_hash ||
      grant.policy_snapshot_sha256 !== this.policy.policyHash ||
      grant.bridge_id !== this.policy.bridgeId ||
      grant.executor_id !== this.executor.executorId ||
      grant.executor_id !== this.policy.executorId ||
      Date.parse(grant.issued_at) > now ||
      Date.parse(grant.expires_at) <= now ||
      Date.parse(grant.expires_at) <= Date.parse(grant.issued_at) ||
      Date.parse(grant.expires_at) - Date.parse(grant.issued_at) >
        task.approval.max_age_seconds * 1000 ||
      now - Date.parse(grant.issued_at) > task.approval.max_age_seconds * 1000
    )
      throw new Error("approval_stale_or_mismatched");
    checkTaskPolicy(task, this.policy, this.now());
    if (this.store.sessionStopped(this.policy.sessionId)) throw new Error("session_stopped");
  }

  /** Only the authenticated approval service may call this; no CLI JSON import is exposed. */
  approve(requestId: string, grant: ApprovalEnvelope): TaskRecord {
    const record = this.required(requestId);
    this.checkGrant(grant, record);
    if (record.result.status !== "awaiting_approval") throw new Error("approval_state_invalid");
    this.store.recordApproval(grant);
    const approved = next(record, this.now());
    approved.result.status = "approved";
    approved.result.last_confirmed_status = "approved";
    return this.store.save(approved, record.result.observation_seq);
  }

  /** Produces a detached grant for an already configured bounded policy. Does not activate policy. */
  evaluatePolicy(requestId: string): ApprovalEnvelope {
    const record = this.required(requestId);
    const task = taskOf(record);
    checkTaskPolicy(task, this.policy, this.now());
    if (this.policy.confirmation === "manual" || this.policy.requiresActionConfirmation)
      throw new Error("action_confirmation_required");
    const at = this.now();
    const expires = new Date(
      Math.min(
        at.getTime() + task.approval.max_age_seconds * 1000,
        Date.parse(this.policy.expiresAt),
        Date.parse(this.policy.sessionDeadline),
      ),
    );
    const grant: ApprovalEnvelope = {
      protocol_version: "2.0",
      approval_id: randomUUID(),
      request_id: task.request_id,
      decision: "approved",
      task_spec_sha256: record.result.task_spec_hash,
      task_file_sha256: task.task_file_hash,
      policy_snapshot_sha256: this.policy.policyHash,
      bridge_id: this.policy.bridgeId,
      executor_id: this.policy.executorId,
      approver_id: "bounded-policy",
      issued_at: at.toISOString(),
      expires_at: expires.toISOString(),
      nonce: randomUUID(),
      max_starts: 1,
      tier: this.policy.confirmation === "autoapprove" ? "automatic" : "bypass",
      preauthorization: task.approval.preauthorization,
      usage_reservation_id: randomUUID(),
    };
    this.approve(requestId, grant);
    return grant;
  }

  async start(requestId: string, approvalId: string): Promise<TaskRecord> {
    const record = this.required(requestId);
    if (record.intent || isTerminalTask(record.result.status)) return record; // Idempotent, no restart.
    if (record.result.status !== "approved") throw new Error("approval_required");
    const task = taskOf(record);
    checkTaskPolicy(task, this.policy, this.now());
    await this.bounded(this.executor.checkCapabilities(structuredClone(task)));
    for (const rule of task.allowed_paths)
      await checkFilesystemPath(this.policy.repoRoot, rule.path);
    for (const command of task.allowed_commands)
      if (command.cwd !== ".") await checkFilesystemPath(this.policy.repoRoot, command.cwd);
    await this.captureQuota(requestId, "pre_dispatch");
    const root = await realpath(this.policy.repoRoot);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory() || rootStat.ino === 0)
      throw new Error("worktree_identity_unavailable");
    const writeLockKey = `${rootStat.dev}:${rootStat.ino}`;
    const quotaLimits = this.quotaLimits();
    const claimed = next(record, this.now());
    claimed.intent = {
      runId: randomUUID(),
      startSequence: claimed.result.observation_seq,
      fencingToken: 1,
      approvalId,
      executorId: this.executor.executorId,
      resourceKeys: [],
      sessionId: this.policy.sessionId,
      deadlineAt: new Date(
        Math.min(
          this.now().getTime() +
            Math.min(task.timeout.run_seconds, quotaLimits.maxRunSeconds) * 1000,
          Date.parse(this.policy.sessionDeadline),
          Date.parse(this.policy.expiresAt),
        ),
      ).toISOString(),
      cancelAt: null,
      cancelReason: null,
    };
    claimed.result.status = "unknown"; // Durable intent; start outcome is not yet observed.
    claimed.result.last_confirmed_status = "approved";
    claimed.result.error = {
      code: "dispatch_unconfirmed",
      message: "Start intent persisted; reconcile this run only",
      retryable: false,
    };
    this.store.claimStart(
      claimed,
      record.result.observation_seq,
      (grant) => {
        this.checkGrant(grant, record);
        const finalLimits = this.quotaLimits();
        if (
          finalLimits.maxStarts < quotaLimits.maxStarts ||
          finalLimits.maxRunSeconds < quotaLimits.maxRunSeconds
        )
          throw new Error("quota_constraints_changed");
      },
      {
        id: this.policy.sessionId,
        maxStarts: Math.min(this.policy.maxStarts, quotaLimits.maxStarts),
        reservation: this.policy.budget?.perStartReservation ?? 0,
        budgetLimit: this.policy.budget?.limit ?? Number.MAX_SAFE_INTEGER,
        resourceKeys: [`repo:${this.policy.repoId}`, `worktree:${writeLockKey}`],
        workflowHash: this.policy.workflowHash ?? null,
        runSeconds: Math.min(task.timeout.run_seconds, quotaLimits.maxRunSeconds),
        maxTotalRunSeconds: this.policy.maxTotalRunSeconds ?? Number.MAX_SAFE_INTEGER,
        now: this.now,
      },
    );
    try {
      const observation = await this.bounded(
        this.executor.start(
          structuredClone(task),
          Buffer.from(record.taskBytesBase64, "base64"),
          identity(claimed),
          structuredClone(claimed.intent),
        ),
      );
      return await this.observe(claimed, observation);
    } catch (error) {
      return this.markUnknown(claimed, error);
    }
  }

  async status(requestId: string): Promise<TaskRecord> {
    const record = this.required(requestId);
    if (record.intent && record.result.status === "unknown")
      this.store.pauseSession(record.sessionId);
    if (!record.intent || isTerminalTask(record.result.status)) return record;
    if (record.intent.cancelAt) return this.cancel(requestId, record.intent.cancelReason ?? "user");
    if (
      !record.intent.cancelAt &&
      (this.store.approval(record.intent.approvalId)?.decision !== "approved" ||
        this.store.workflowStopped(requestId, this.now()) ||
        this.policy.revoked ||
        this.store.sessionStopped(this.policy.sessionId) ||
        Date.parse(this.policy.expiresAt) <= this.now().getTime())
    )
      return this.cancel(requestId, "user");
    if (!record.intent.cancelAt && Date.parse(record.intent.deadlineAt) <= this.now().getTime())
      return this.cancel(requestId, "timeout");
    try {
      return await this.observe(record, await this.bounded(this.executor.status(identity(record))));
    } catch (error) {
      return this.markUnknown(record, error);
    }
  }

  async collect(requestId: string): Promise<TaskRecord> {
    const record = this.required(requestId);
    if (record.intent && record.result.status === "unknown")
      this.store.pauseSession(record.sessionId);
    if (!record.intent || isTerminalTask(record.result.status)) return record;
    if (
      record.intent.cancelAt ||
      Date.parse(record.intent.deadlineAt) <= this.now().getTime() ||
      this.policy.revoked ||
      this.store.sessionStopped(this.policy.sessionId) ||
      this.store.approval(record.intent.approvalId)?.decision !== "approved" ||
      this.store.workflowStopped(requestId, this.now()) ||
      Date.parse(this.policy.expiresAt) <= this.now().getTime()
    )
      return this.status(requestId);
    try {
      return await this.observe(
        record,
        await this.bounded(this.executor.collect(identity(record))),
      );
    } catch (error) {
      return this.markUnknown(record, error);
    }
  }

  async cancel(requestId: string, reason: "user" | "timeout" = "user"): Promise<TaskRecord> {
    const record = this.required(requestId);
    if (record.intent && record.result.status === "unknown")
      this.store.pauseSession(record.sessionId);
    if (isTerminalTask(record.result.status)) return record;
    if (!record.intent) {
      const cancelled = next(record, this.now());
      cancelled.result.status = "cancelled";
      cancelled.result.last_confirmed_status = "cancelled";
      cancelled.result.finished_at = cancelled.result.observed_at;
      cancelled.result.outcome_known = true;
      cancelled.result.diff.complete = true;
      cancelled.result.error = {
        code: "cancelled_before_start",
        message: "Cancelled before any dispatch intent",
        retryable: false,
      };
      if (!this.executor.synthetic) {
        const evidence = this.store.localEvidence({
          requestId,
          sequence: cancelled.result.observation_seq,
          processState: "never_started",
        });
        cancelled.result.receipt = {
          receipt_id: randomUUID(),
          request_id: requestId,
          task_spec_sha256: record.result.task_spec_hash,
          run_id: null,
          fencing_token: 0,
          ledger_sequence: cancelled.result.observation_seq,
          terminal_status: "cancelled",
          process_state: "never_started",
          recorded_at: cancelled.result.observed_at,
          evidence_ref: evidence,
        };
        cancelled.result.verification = {
          state: "verified",
          checked_at: cancelled.result.observed_at,
          evidence_ref: evidence,
        };
      }
      this.validateSnapshot(cancelled);
      return this.store.save(cancelled, record.result.observation_seq, true);
    }
    // Persist before the broker call. Disconnect during cancellation stays UNKNOWN.
    let requested = record;
    if (!record.intent.cancelAt) {
      requested = next(record, this.now());
      if (!requested.intent) throw new Error("run_not_started");
      requested.intent.cancelAt = this.now().toISOString();
      requested.intent.cancelReason = reason;
      requested.result.status = record.result.process_identity ? "cancel_requested" : "unknown";
      requested.result.last_confirmed_status =
        requested.result.status === "unknown"
          ? record.result.last_confirmed_status
          : "cancel_requested";
      this.store.save(requested, record.result.observation_seq);
    }
    try {
      return await this.observe(
        requested,
        await this.bounded(
          this.executor.cancel(
            identity(requested),
            requested.intent?.cancelReason ?? reason,
            taskOf(requested).timeout.cancel_grace_seconds,
          ),
        ),
      );
    } catch (error) {
      return this.markUnknown(requested, error);
    }
  }

  resumeSession(): void {
    if (
      this.policy.revoked ||
      Date.parse(this.policy.expiresAt) <= this.now().getTime() ||
      Date.parse(this.policy.sessionDeadline) <= this.now().getTime()
    )
      throw new Error("session_resume_denied");
    this.store.resumeSession(this.policy.sessionId);
  }

  async revokeWorkflow(workflowId: string): Promise<TaskRecord[]> {
    const ids = this.store.workflowJobs(workflowId);
    for (const id of ids) this.required(id);
    this.store.revokeWorkflow(workflowId);
    return Promise.all(ids.map((id) => this.cancel(id)));
  }

  async emergencyStop(): Promise<TaskRecord[]> {
    this.store.stopSession(this.policy.sessionId); // Stops future starts even if broker disconnects.
    // Each cancel persists intent synchronously before its first broker await. Start all calls
    // before awaiting any: one unavailable adapter cannot strand the other session jobs.
    return Promise.all(
      this.store
        .listSession(this.policy.sessionId)
        .filter((record) => !isTerminalTask(record.result.status))
        .map((record) => this.cancel(record.result.request_id)),
    );
  }

  async acknowledgeResult(
    ack: TaskHandshake,
    proof?: import("../contracts/materialization.js").MaterializationReceiptV1,
  ): Promise<void> {
    this.required(ack.requestId);
    const prior = this.store.deliveryVerified(ack.requestId);
    this.store.acknowledgeDelivery(ack, proof);
    if (!prior) await this.captureQuota(ack.requestId, "post_result_ack");
  }
  private async captureQuota(requestId: string, phase: TaskQuotaSnapshot["phase"]): Promise<void> {
    if (!this.quotaSource) return;
    const snapshot: TaskQuotaSnapshot = {
      requestId,
      phase,
      requestStartedAt: this.now().toISOString(),
      fetchedAt: this.now().toISOString(),
      state: "unknown",
      observation: null,
      error: null,
    };
    try {
      const result = structuredClone(await this.bounded(this.quotaSource.readRateLimits()));
      validateAccountRateLimits(result);
      snapshot.observation = result;
      snapshot.state = "observed";
    } catch (error) {
      snapshot.error = error instanceof Error ? error.message : String(error);
    }
    snapshot.fetchedAt = this.now().toISOString();
    this.store.appendQuotaObservation(snapshot); // separate row; never mutates acknowledged Result bytes
  }

  private quotaLimits(): { maxStarts: number; maxRunSeconds: number } {
    if (!this.quotaGuard) return { maxStarts: this.policy.maxStarts, maxRunSeconds: 86400 };
    const guard = this.quotaGuard;
    const decision = quotaDecision(
      guard.observation,
      guard.fallback,
      guard.strictMoneyBudget,
      this.now(),
    );
    if (!decision.mayContinue) throw new Error(decision.reason);
    if (decision.state === "unknown" && guard.fallback) return guard.fallback;
    return { maxStarts: this.policy.maxStarts, maxRunSeconds: 86400 };
  }
  private required(id: string): TaskRecord {
    const record = this.store.get(id);
    if (!record) throw new Error("task_not_found");
    const parsed = loadTaskSpec(Buffer.from(record.rawSpec), record.result.task_spec_hash);
    if (
      !parsed.valid ||
      !verifyTaskFileBytes(parsed.task, Buffer.from(record.taskBytesBase64, "base64")).valid
    )
      throw new Error("stored_task_integrity_mismatch");
    if (record.sessionId !== this.policy.sessionId || record.bridgeId !== this.policy.bridgeId)
      throw new Error("executor_or_session_mismatch");
    if (
      record.intent &&
      (record.intent.executorId !== this.executor.executorId ||
        record.intent.sessionId !== this.policy.sessionId)
    )
      throw new Error("executor_or_session_mismatch");
    return record;
  }
  private markUnknown(record: TaskRecord, error: unknown): TaskRecord {
    const latest = this.required(record.result.request_id);
    if (
      latest.result.observation_seq !== record.result.observation_seq ||
      isTerminalTask(latest.result.status)
    )
      return latest;
    const unknown = next(record, this.now());
    if (record.result.status !== "unknown")
      unknown.result.last_confirmed_status = record.result.status;
    unknown.result.status = "unknown";
    unknown.result.finished_at = null;
    unknown.result.outcome_known = false;
    unknown.result.receipt = null;
    unknown.result.error = {
      code: "reconciliation_required",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
    unknown.result.verification = {
      state: this.executor.synthetic ? "synthetic" : "pending",
      checked_at: null,
      evidence_ref: null,
    };
    this.validateSnapshot(unknown);
    return this.store.save(unknown, record.result.observation_seq);
  }
  private validateSnapshot(record: TaskRecord): void {
    const checked = validateTaskResult(record.result, {
      task: taskOf(record),
      taskSpecHash: record.result.task_spec_hash,
    });
    if (!checked.valid) throw new Error(`snapshot_invalid: ${checked.errors.join("; ")}`);
  }
  private async verifyArtifacts(result: ResultSpec): Promise<void> {
    const refs = new Map<string, ArtifactRef>();
    function visit(value: unknown): void {
      if (!value || typeof value !== "object") return;
      if ("artifact_id" in value && "sha256" in value && "size_bytes" in value) {
        const ref = value as ArtifactRef;
        const prior = refs.get(ref.artifact_id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(ref))
          throw new Error("artifact_identity_conflict");
        refs.set(ref.artifact_id, ref);
      } else for (const nested of Object.values(value)) visit(nested);
    }
    visit(result);
    for (const ref of refs.values()) {
      const bytes = await this.bounded(this.executor.readArtifact(ref));
      if (bytes.byteLength !== ref.size_bytes || sha256Bytes(bytes) !== ref.sha256)
        throw new Error("artifact_hash_mismatch");
    }
  }
  private async observe(record: TaskRecord, input: ExecutorObservation): Promise<TaskRecord> {
    const observation = structuredClone(input);
    if (!sameIdentity(identity(record), observation.identity))
      throw new Error("executor_identity_mismatch");
    if (observation.kind === "unknown")
      return this.markUnknown(record, new Error(observation.reason));
    const updated = next(record, this.now());
    if (observation.kind === "running") {
      if (record.result.started_at && record.result.started_at !== observation.startedAt)
        throw new Error("start_time_mismatch");
      if (
        record.result.process_identity &&
        JSON.stringify(record.result.process_identity) !== JSON.stringify(observation.process)
      )
        throw new Error("process_identity_mismatch");
      if (
        observation.actualAgent !== taskOf(record).agent ||
        observation.actualModel !== taskOf(record).requested_model
      )
        throw new Error("actual_model_mismatch");
      updated.result.status = record.intent?.cancelAt ? "cancel_requested" : "running";
      updated.result.last_confirmed_status = updated.result.status;
      updated.result.run_id = identity(record).runId;
      updated.result.fencing_token = identity(record).fencingToken;
      updated.result.started_at = observation.startedAt;
      updated.result.process_identity = observation.process;
      updated.result.actual_agent = observation.actualAgent;
      updated.result.actual_model = observation.actualModel;
      updated.result.error = null;
    } else {
      if (!observation.allTerminated) throw new Error("process_tree_not_terminated");
      if (
        !isTerminalTask(observation.result.status) ||
        observation.result.synthetic !== this.executor.synthetic
      )
        throw new Error("terminal_evidence_invalid");
      if (
        observation.result.run_id !== null &&
        observation.result.run_id !== identity(record).runId
      )
        throw new Error("terminal_run_identity_mismatch");
      const checked = validateTaskResult(observation.result, {
        task: taskOf(record),
        taskSpecHash: record.result.task_spec_hash,
        expectedRunId: identity(record).runId,
        expectedFencingToken: identity(record).fencingToken,
        ...(record.result.process_identity
          ? { expectedProcessIdentity: record.result.process_identity }
          : {}),
      });
      if (!checked.valid) throw new Error(`result_evidence_invalid: ${checked.errors.join("; ")}`);
      await this.verifyArtifacts(observation.result);
      updated.result = structuredClone(observation.result);
      if (record.intent?.cancelAt) {
        updated.result.status = record.intent.cancelReason === "timeout" ? "failed" : "cancelled";
        updated.result.last_confirmed_status = updated.result.status;
        updated.result.error = {
          code:
            record.intent.cancelReason === "timeout"
              ? "run_timeout"
              : "cancellation_committed_first",
          message:
            "Persisted stop intent won before terminal result commit; process termination is verified",
          retryable: false,
        };
        if (updated.result.receipt) updated.result.receipt.terminal_status = updated.result.status;
      }
      updated.result.observation_seq = record.result.observation_seq + 1;
      updated.result.observed_at = this.now().toISOString();
      if (updated.result.receipt) {
        updated.result.receipt.receipt_id = randomUUID(); // local authoritative receipt projection
        updated.result.receipt.ledger_sequence = updated.result.observation_seq;
        updated.result.receipt.recorded_at = updated.result.observed_at;
        updated.result.verification.checked_at = updated.result.observed_at;
      }
    }
    const finalCheck = validateTaskResult(updated.result, {
      task: taskOf(record),
      taskSpecHash: record.result.task_spec_hash,
    });
    if (!finalCheck.valid)
      throw new Error(`projected_result_invalid: ${finalCheck.errors.join("; ")}`);
    // CAS failure means a newer cancellation/observation won. Never overwrite it.
    try {
      return this.store.save(
        updated,
        record.result.observation_seq,
        observation.kind === "terminal",
      );
    } catch (error) {
      if (error instanceof Error && error.message === "stale_observation")
        return this.required(record.result.request_id);
      throw error;
    }
  }
}
