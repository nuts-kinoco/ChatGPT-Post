/** Host-local approval authority. Construct only behind an authenticated UI/service boundary.
 * No task/imported file can create an AuthoritySession or activate a persistent policy.
 */
import { randomUUID } from "node:crypto";
import type { ApprovalEnvelope, TaskSpec } from "../contracts/task-types.js";
import {
  checkWorkflowGrant,
  parseWorkflowManifest,
  type WorkflowGrant,
} from "../contracts/task-workflow.js";
import type { TaskController } from "../state/task-controller.js";
import { checkTaskPolicy } from "../state/task-policy.js";

export interface AuthoritySession {
  actorId: string;
  bridgeId: string;
  sessionId: string;
  expiresAt: string;
  capabilities: readonly ("approve_task" | "approve_workflow" | "bounded_policy")[];
  /** Established by a local authenticated connection, never the JSON request body. */
  authenticated: true;
}
export class LocalTaskAuthority {
  constructor(
    readonly controller: TaskController,
    private readonly session: () => AuthoritySession,
    private readonly now = () => new Date(),
  ) {}
  private identity(capability: AuthoritySession["capabilities"][number]): AuthoritySession {
    const identity = this.session();
    if (
      identity?.authenticated !== true ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(identity.actorId) ||
      identity.bridgeId !== this.controller.policy.bridgeId ||
      identity.sessionId !== this.controller.policy.sessionId ||
      !identity.capabilities.includes(capability) ||
      !Number.isFinite(Date.parse(identity.expiresAt)) ||
      Date.parse(identity.expiresAt) <= this.now().getTime()
    )
      throw new Error("approval_authority_denied");
    return identity;
  }
  /** Returns a detached grant. The UI persists it through controller.approve after this call. */
  async approve(requestId: string): Promise<ApprovalEnvelope> {
    const identity = this.identity("approve_task");
    const record = this.controller.store.get(requestId);
    if (record?.result.status !== "awaiting_approval") throw new Error("approval_state_invalid");
    const task = JSON.parse(record.rawSpec) as TaskSpec;
    const policy = this.controller.policy;
    checkTaskPolicy(task, policy, this.now());
    if (this.controller.store.sessionStopped(policy.sessionId)) throw new Error("session_stopped");
    if (task.approval.tier !== "manual") this.identity("bounded_policy");
    if (task.approval.tier !== "manual" && policy.requiresActionConfirmation)
      throw new Error("action_confirmation_required");
    const issued = this.now();
    const expiry = Math.min(
      issued.getTime() + task.approval.max_age_seconds * 1000,
      Date.parse(policy.expiresAt),
      Date.parse(policy.sessionDeadline),
      Date.parse(identity.expiresAt),
    );
    if (expiry <= issued.getTime()) throw new Error("approval_expired");
    return {
      protocol_version: "2.0",
      approval_id: randomUUID(),
      nonce: randomUUID(),
      request_id: requestId,
      decision: "approved",
      task_spec_sha256: record.result.task_spec_hash,
      task_file_sha256: task.task_file_hash,
      policy_snapshot_sha256: policy.policyHash,
      bridge_id: policy.bridgeId,
      executor_id: policy.executorId,
      approver_id: identity.actorId,
      issued_at: issued.toISOString(),
      expires_at: new Date(expiry).toISOString(),
      max_starts: 1,
      tier: task.approval.tier,
      preauthorization: task.approval.preauthorization,
      usage_reservation_id: task.approval.tier === "manual" ? null : randomUUID(),
    };
  }
  /** Activation was already approved at host setup. This only evaluates the existing bounds. */
  evaluatePolicy(requestId: string): ApprovalEnvelope {
    this.identity("bounded_policy");
    return this.controller.evaluatePolicy(requestId);
  }
  approveWorkflow(raw: Uint8Array): WorkflowGrant {
    const identity = this.identity("approve_workflow");
    const { manifest, hash } = parseWorkflowManifest(raw);
    const policy = this.controller.policy;
    const now = this.now();
    for (const job of manifest.jobs) {
      const record = this.controller.store.get(job.request_id);
      if (
        !record ||
        record.result.task_spec_hash !== job.task_spec_sha256 ||
        record.intent ||
        record.result.status !== "awaiting_approval"
      )
        throw new Error("workflow_task_not_admissible");
      checkTaskPolicy(JSON.parse(record.rawSpec) as TaskSpec, policy, now);
    }
    const grant: WorkflowGrant = {
      protocol_version: "workflow-grant-1",
      grant_id: randomUUID(),
      nonce: randomUUID(),
      max_starts: Math.min(manifest.jobs.length, policy.maxStarts),
      workflow_id: manifest.workflow_id,
      manifest_sha256: hash,
      policy_snapshot_sha256: policy.policyHash,
      session_id: policy.sessionId,
      bridge_id: policy.bridgeId,
      approver_id: identity.actorId,
      decision: "approved",
      issued_at: now.toISOString(),
      expires_at: new Date(
        Math.min(
          Date.parse(policy.expiresAt),
          Date.parse(policy.sessionDeadline),
          Date.parse(identity.expiresAt),
        ),
      ).toISOString(),
    };
    checkWorkflowGrant(grant, manifest, hash, now);
    this.controller.store.configureWorkflow(raw, grant, now);
    return grant;
  }
}
