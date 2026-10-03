/** Explicit synthetic profile. No process, shell, network, model, or task file access. */
import { randomUUID } from "node:crypto";
import { sha256Bytes } from "../contracts/task.js";
import type {
  ApprovalEnvelope,
  ArtifactRef,
  ResultSpec,
  TaskSpec,
} from "../contracts/task-types.js";
import type { UiDemoOutcome, UiDemoTask } from "../contracts/ui.js";
import type {
  ExecutionIdentity,
  ExecutorObservation,
  TaskExecutor,
} from "../state/task-executor.js";
import type { TaskPolicy } from "../state/task-policy.js";
import type { RunIntent, TaskStore } from "../state/task-store.js";

export const DEMO_LABEL = "SYNTHETIC DEMO — no process, network, model, or repository execution";
export const DEMO_POLICY_HASH = sha256Bytes(Buffer.from("bridge-v2-ui-demo-policy-v1"));
export const DEMO_SESSION = "e7c7de33-fef2-4e32-b113-d3934027565e";
export function demoPolicy(repoRoot: string): TaskPolicy {
  return {
    bridgeId: "ui-demo-bridge",
    executorId: "ui-demo-executor",
    repoId: "synthetic-demo",
    repoRoot,
    baseCommit: "d".repeat(40),
    policyHash: DEMO_POLICY_HASH,
    policyId: "ui-demo-policy",
    policyVersion: 1,
    revoked: false,
    expiresAt: "2099-01-01T00:00:00.000Z",
    sessionId: DEMO_SESSION,
    confirmation: "manual",
    agents: { "synthetic-agent": ["synthetic-model"] },
    modes: ["read_only"],
    paths: [{ path: "demo-evidence.txt", scope: "exact", permissions: ["read"] }],
    commands: [],
    evaluators: ["synthetic-evaluator"],
    maxStarts: 1000,
    sessionDeadline: "2099-01-01T00:00:00.000Z",
    budget: null,
    requiresActionConfirmation: false,
  };
}
export function demoTask(input: UiDemoTask): { rawSpec: string; taskMarkdown: string } {
  const title = input.title ?? "Inspect a synthetic task";
  const taskMarkdown = `# ${title.replace(/[\r\n]/g, " ")}\n\n${DEMO_LABEL}\n\n${input.taskMarkdown ?? "Exercise approval, one start, evidence, cancellation, and delivery acknowledgement."}`;
  const task: TaskSpec = {
    protocol_version: "2.0",
    request_id: randomUUID(),
    agent: "synthetic-agent",
    requested_model: "synthetic-model",
    repo: "synthetic-demo",
    base_commit: "d".repeat(40),
    mode: "read_only",
    policy_snapshot_sha256: DEMO_POLICY_HASH,
    allowed_paths: [{ path: "demo-evidence.txt", scope: "exact", permissions: ["read"] }],
    allowed_commands: [],
    task_file: "task.md",
    task_file_hash: sha256Bytes(Buffer.from(taskMarkdown)),
    approval: {
      required: true,
      binding: "sha256-raw-task-spec",
      source: "detached-authoritative-record",
      max_age_seconds: 900,
      max_starts: 1,
      tier: "manual",
      preauthorization: null,
    },
    timeout: { run_seconds: 3600, cancel_grace_seconds: 0 },
    success_criteria: [
      {
        criterion_id: "synthetic-proof",
        description: "Synthetic evidence only; no real tests were run",
        evaluator_id: "synthetic-evaluator",
      },
    ],
    task_network: "deny",
    environment: {},
    retry_policy: "no-automatic-reexecution",
  };
  return { rawSpec: `${JSON.stringify(task, null, 2)}\n`, taskMarkdown };
}
export class DemoAuthority {
  constructor(
    private readonly store: TaskStore,
    private readonly policy: TaskPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async approve(requestId: string): Promise<ApprovalEnvelope> {
    const record = this.store.get(requestId);
    if (!record?.result.synthetic) throw new Error("demo_task_required");
    const issuedAt = this.now();
    const task = JSON.parse(record.rawSpec) as TaskSpec;
    const lifetimeMs = Math.min(900_000, task.approval.max_age_seconds * 1000);
    return {
      protocol_version: "2.0",
      approval_id: randomUUID(),
      request_id: requestId,
      decision: "approved",
      task_spec_sha256: record.result.task_spec_hash,
      task_file_sha256: record.result.task_file_hash,
      policy_snapshot_sha256: this.policy.policyHash,
      bridge_id: this.policy.bridgeId,
      executor_id: this.policy.executorId,
      approver_id: "synthetic-demo-authority",
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + lifetimeMs).toISOString(),
      nonce: randomUUID(),
      max_starts: 1,
      tier: "manual",
      preauthorization: null,
      usage_reservation_id: null,
    };
  }
}
export class DemoTaskExecutor implements TaskExecutor {
  readonly executorId = "ui-demo-executor";
  readonly synthetic = true;
  starts = 0;
  private readonly runs = new Map<string, { task: TaskSpec; observation: ExecutorObservation }>();
  private readonly uncertain = new Set<string>();
  private readonly evidence = Buffer.from(
    `${DEMO_LABEL}\nSynthetic evaluator confirmed the selected demo outcome. No command or test was executed.\n`,
  );
  private readonly evidenceRef: ArtifactRef = {
    artifact_id: "ui-demo-evidence",
    sha256: sha256Bytes(this.evidence),
    size_bytes: this.evidence.length,
    media_type: "text/plain",
  };
  async checkCapabilities(task: TaskSpec): Promise<void> {
    if (
      task.agent !== "synthetic-agent" ||
      task.requested_model !== "synthetic-model" ||
      task.allowed_commands.length ||
      JSON.stringify(task.allowed_paths) !==
        JSON.stringify([{ path: "demo-evidence.txt", scope: "exact", permissions: ["read"] }]) ||
      task.mode !== "read_only"
    )
      throw new Error("demo_scope_denied");
  }
  async start(
    task: TaskSpec,
    _taskBytes: Uint8Array,
    id: ExecutionIdentity,
    _intent: RunIntent,
  ): Promise<ExecutorObservation> {
    const existing = this.runs.get(id.runId);
    if (existing) return structuredClone(existing.observation);
    this.starts++;
    const at = new Date().toISOString();
    const observation: ExecutorObservation = {
      kind: "running",
      identity: structuredClone(id),
      startedAt: at,
      actualAgent: task.agent,
      actualModel: task.requested_model,
      process: {
        host_id: "synthetic-no-host",
        boot_id: randomUUID(),
        pid: 1,
        creation_time: at,
        executable_sha256: "d".repeat(64),
        process_group_id: `synthetic-${id.runId}`,
      },
    };
    this.runs.set(id.runId, { task: structuredClone(task), observation });
    return structuredClone(observation);
  }
  async status(id: ExecutionIdentity): Promise<ExecutorObservation> {
    const run = this.runs.get(id.runId);
    if (!run || this.uncertain.has(id.runId))
      return {
        kind: "unknown",
        identity: structuredClone(id),
        reason: "Synthetic execution observation unavailable; reconcile the same UUID, never rerun",
      };
    return structuredClone(run.observation);
  }
  async collect(id: ExecutionIdentity): Promise<ExecutorObservation> {
    return this.status(id);
  }
  async cancel(id: ExecutionIdentity, reason: "user" | "timeout"): Promise<ExecutorObservation> {
    const entry = this.runs.get(id.runId);
    if (!entry || this.uncertain.has(id.runId)) return this.status(id);
    if (entry.observation.kind === "terminal") return structuredClone(entry.observation);
    this.finish(id.runId, reason === "timeout" ? "failed" : "cancelled");
    return this.status(id);
  }
  observe(runId: string, outcome: UiDemoOutcome): void {
    if (!this.runs.has(runId)) throw new Error("demo_observation_lost_after_restart");
    if (outcome === "unknown") {
      this.uncertain.add(runId);
      return;
    }
    this.finish(runId, outcome);
    this.uncertain.delete(runId);
  }
  private finish(runId: string, status: "succeeded" | "failed" | "cancelled"): void {
    const entry = this.runs.get(runId);
    if (entry?.observation.kind !== "running") throw new Error("demo_run_not_running");
    const previous = entry.observation;
    const at = new Date().toISOString();
    const result: ResultSpec = {
      protocol_version: "2.0",
      request_id: previous.identity.requestId,
      task_spec_hash: previous.identity.taskSpecHash,
      task_file_hash: entry.task.task_file_hash,
      synthetic: true,
      status,
      last_confirmed_status: status,
      observation_seq: 1,
      observed_at: at,
      outcome_known: true,
      started_at: previous.startedAt,
      finished_at: at,
      actual_agent: previous.actualAgent,
      actual_model: previous.actualModel,
      base_commit: entry.task.base_commit,
      resulting_commit: entry.task.base_commit,
      run_id: runId,
      fencing_token: previous.identity.fencingToken,
      process_identity: previous.process,
      commands_run: [],
      tests:
        status === "succeeded"
          ? entry.task.success_criteria.map((criterion) => ({
              test_id: criterion.criterion_id,
              criterion_id: criterion.criterion_id,
              outcome: "passed" as const,
              command_invocation_ids: [],
              evidence_ref: this.evidenceRef,
            }))
          : [],
      exit_codes: [],
      changed_files: [],
      diff: { kind: "none", complete: true, artifact_ref: null },
      stdout_ref: this.evidenceRef,
      stderr_ref: null,
      error:
        status === "succeeded"
          ? null
          : { code: "synthetic_termination", message: DEMO_LABEL, retryable: false },
      receipt: null,
      verification: { state: "synthetic", checked_at: null, evidence_ref: null },
    };
    entry.observation = {
      kind: "terminal",
      identity: previous.identity,
      result,
      allTerminated: true,
    };
  }
  async readArtifact(ref: ArtifactRef): Promise<Uint8Array> {
    if (JSON.stringify(ref) !== JSON.stringify(this.evidenceRef))
      throw new Error("artifact_not_found");
    return Uint8Array.from(this.evidence);
  }
}
