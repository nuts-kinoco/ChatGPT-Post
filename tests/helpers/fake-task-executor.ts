/** Synthetic, in-memory executor. Never import from production CLI or spawn a process. */
import { randomUUID } from "node:crypto";
import { sha256Bytes } from "../../src/contracts/task.js";
import type { ArtifactRef, ResultSpec, TaskSpec } from "../../src/contracts/task-types.js";
import type {
  ExecutionIdentity,
  ExecutorObservation,
  TaskExecutor,
} from "../../src/state/task-executor.js";
import type { RunIntent } from "../../src/state/task-store.js";

export class FakeTaskExecutor implements TaskExecutor {
  readonly executorId = "fake-executor";
  readonly synthetic = true;
  starts = 0;
  cancels = 0;
  disconnected = false;
  cancelDisconnect = false;
  corruptArtifact = false;
  startHook: (() => Promise<void>) | null = null;
  tasks = new Map<string, { task: TaskSpec; observation: ExecutorObservation }>();
  private readonly evidence = Buffer.from("synthetic test evidence, no process or model call");
  readonly evidenceRef: ArtifactRef = {
    artifact_id: "fake-evidence",
    sha256: sha256Bytes(this.evidence),
    size_bytes: this.evidence.byteLength,
    media_type: "text/plain",
  };
  constructor(readonly now: () => Date) {}
  async checkCapabilities(): Promise<void> {}
  async start(
    task: TaskSpec,
    _taskBytes: Uint8Array,
    id: ExecutionIdentity,
    _intent: RunIntent,
  ): Promise<ExecutorObservation> {
    const prior = this.tasks.get(id.runId);
    if (prior) return prior.observation;
    this.starts++;
    if (this.startHook) await this.startHook();
    const observation: ExecutorObservation = {
      kind: "running",
      identity: id,
      startedAt: this.now().toISOString(),
      actualAgent: task.agent,
      actualModel: task.requested_model,
      process: {
        host_id: "fake-host",
        boot_id: randomUUID(),
        pid: 42,
        creation_time: this.now().toISOString(),
        executable_sha256: "a".repeat(64),
        process_group_id: `fake-${id.runId}`,
      },
    };
    this.tasks.set(id.runId, { task, observation });
    if (this.disconnected) throw new Error("fake_disconnect_after_start");
    return observation;
  }
  async status(id: ExecutionIdentity): Promise<ExecutorObservation> {
    if (this.disconnected) throw new Error("fake_disconnect");
    return (
      this.tasks.get(id.runId)?.observation ?? {
        kind: "unknown",
        identity: id,
        reason: "no_confirmed_run",
      }
    );
  }
  async collect(id: ExecutionIdentity): Promise<ExecutorObservation> {
    return this.status(id);
  }
  async cancel(id: ExecutionIdentity, reason: "user" | "timeout"): Promise<ExecutorObservation> {
    this.cancels++;
    if (this.cancelDisconnect || this.disconnected) throw new Error("fake_cancel_disconnect");
    if (!this.tasks.has(id.runId))
      return { kind: "unknown", identity: id, reason: "start_registration_pending" };
    const prior = this.tasks.get(id.runId);
    if (!prior) throw new Error("fake_run_missing");
    if (prior.observation.kind === "terminal") return prior.observation;
    return this.finish(
      id.runId,
      reason === "timeout" ? "failed" : "cancelled",
      reason === "timeout" ? "run_timeout" : reason,
    );
  }
  finish(
    runId: string,
    status: "succeeded" | "failed" | "cancelled",
    errorCode = "fake_failure",
  ): ExecutorObservation {
    const entry = this.tasks.get(runId);
    if (entry?.observation.kind !== "running") throw new Error("fake_run_missing");
    const old = entry.observation;
    const result: ResultSpec = {
      protocol_version: "2.0",
      request_id: old.identity.requestId,
      task_spec_hash: old.identity.taskSpecHash,
      task_file_hash: entry.task.task_file_hash,
      synthetic: true,
      status,
      last_confirmed_status: status,
      observation_seq: 10,
      observed_at: this.now().toISOString(),
      outcome_known: true,
      started_at: old.startedAt,
      finished_at: this.now().toISOString(),
      actual_agent: old.actualAgent,
      actual_model: old.actualModel,
      base_commit: entry.task.base_commit,
      resulting_commit: entry.task.base_commit,
      run_id: runId,
      fencing_token: old.identity.fencingToken,
      process_identity: old.process,
      commands_run: [],
      tests:
        status === "succeeded"
          ? entry.task.success_criteria.map((c) => ({
              test_id: c.criterion_id,
              criterion_id: c.criterion_id,
              outcome: "passed" as const,
              command_invocation_ids: [],
              evidence_ref: this.evidenceRef,
            }))
          : [],
      exit_codes: [],
      changed_files: [],
      diff: { kind: "none", complete: true, artifact_ref: null },
      stdout_ref: this.evidenceRef,
      stderr_ref: this.evidenceRef,
      error:
        status === "succeeded"
          ? null
          : { code: errorCode, message: "Synthetic termination", retryable: false },
      receipt: null,
      verification: { state: "synthetic", checked_at: null, evidence_ref: null },
    };
    const observation: ExecutorObservation = {
      kind: "terminal",
      identity: old.identity,
      result,
      allTerminated: true,
    };
    entry.observation = observation;
    return observation;
  }
  async readArtifact(): Promise<Uint8Array> {
    return this.corruptArtifact ? Buffer.from("bad") : this.evidence;
  }
}
