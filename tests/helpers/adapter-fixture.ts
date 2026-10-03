import { randomUUID } from "node:crypto";
import { sha256Bytes } from "../../src/contracts/task.js";
import type { TaskSpec } from "../../src/contracts/task-types.js";
import type { TaskPolicy } from "../../src/state/task-policy.js";
export const adapterTaskBytes = Buffer.from("Inspect synthetic source. No live inference.\n");
export function adapterTask(): TaskSpec {
  return {
    protocol_version: "2.0",
    request_id: randomUUID(),
    agent: "fake-agent",
    requested_model: "fake-model",
    repo: "fixture-repo",
    base_commit: "b".repeat(40),
    mode: "read_only",
    policy_snapshot_sha256: "c".repeat(64),
    allowed_paths: [{ path: "src", scope: "subtree", permissions: ["read"] }],
    allowed_commands: [],
    task_file: "task.md",
    task_file_hash: sha256Bytes(adapterTaskBytes),
    approval: {
      required: true,
      binding: "sha256-raw-task-spec",
      source: "detached-authoritative-record",
      max_age_seconds: 60,
      max_starts: 1,
      tier: "manual",
      preauthorization: null,
    },
    timeout: { run_seconds: 10, cancel_grace_seconds: 1 },
    success_criteria: [
      { criterion_id: "inspect", description: "Synthetic inspection", evaluator_id: "fake-check" },
    ],
    task_network: "deny",
    environment: {},
    retry_policy: "no-automatic-reexecution",
  };
}
export function adapterPolicy(root: string, now: Date): TaskPolicy {
  const task = adapterTask();
  return {
    bridgeId: "recipient",
    executorId: "fake-executor",
    repoId: task.repo,
    repoRoot: root,
    baseCommit: task.base_commit,
    policyHash: task.policy_snapshot_sha256,
    policyId: "fixture-policy",
    policyVersion: 1,
    revoked: false,
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
    sessionId: randomUUID(),
    confirmation: "manual",
    agents: { "fake-agent": ["fake-model"] },
    modes: ["read_only"],
    paths: task.allowed_paths,
    commands: [],
    evaluators: ["fake-check"],
    maxStarts: 20,
    sessionDeadline: new Date(now.getTime() + 3600000).toISOString(),
    budget: null,
    requiresActionConfirmation: false,
  };
}
