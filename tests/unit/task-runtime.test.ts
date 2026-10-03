import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MaterializationReceiptV1 } from "../../src/contracts/materialization.js";
import {
  serializeTaskResult,
  sha256Bytes,
  taskResultArtifactRefs,
  validateTaskResult,
} from "../../src/contracts/task.js";
import type { ApprovalEnvelope, TaskSpec } from "../../src/contracts/task-types.js";
import {
  checkWorkflowGrant,
  parseWorkflowManifest,
  type WorkflowGrant,
  type WorkflowManifest,
} from "../../src/contracts/task-workflow.js";
import { TaskController } from "../../src/state/task-controller.js";
import { UnavailableTaskExecutor } from "../../src/state/task-executor.js";
import { assertTaskTransition } from "../../src/state/task-machine.js";
import {
  checkFilesystemPath,
  checkRelativePath,
  checkTaskPolicy,
  type TaskPolicy,
} from "../../src/state/task-policy.js";
import { openTaskStore, type TaskStore } from "../../src/state/task-store.js";
import { FakeTaskExecutor } from "../helpers/fake-task-executor.js";

const taskBytes = Buffer.from("Inspect synthetic source. Do not run a real agent.\n");
function task(): TaskSpec {
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
    task_file_hash: sha256Bytes(taskBytes),
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

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("required test fixture missing");
  return value;
}

describe("Bridge v2 task runtime (fake executor only)", () => {
  let dir: string;
  let store: TaskStore;
  let clock: number;
  let fake: FakeTaskExecutor;
  let policy: TaskPolicy;
  let controller: TaskController;
  const now = () => new Date(clock);
  const raw = (t: TaskSpec) => Buffer.from(JSON.stringify(t));
  function grant(t: TaskSpec): ApprovalEnvelope {
    return {
      protocol_version: "2.0",
      approval_id: randomUUID(),
      request_id: t.request_id,
      decision: "approved",
      task_spec_sha256: sha256Bytes(raw(t)),
      task_file_sha256: t.task_file_hash,
      policy_snapshot_sha256: policy.policyHash,
      bridge_id: policy.bridgeId,
      executor_id: policy.executorId,
      approver_id: "fixture-human",
      issued_at: now().toISOString(),
      expires_at: new Date(clock + 60000).toISOString(),
      nonce: randomUUID(),
      max_starts: 1,
      tier: t.approval.tier,
      preauthorization: t.approval.preauthorization,
      usage_reservation_id: t.approval.tier === "manual" ? null : randomUUID(),
    };
  }
  function approve(t: TaskSpec) {
    controller.receive(raw(t), taskBytes);
    const g = grant(t);
    controller.approve(t.request_id, g);
    return g;
  }
  function workflow(tasks: TaskSpec[]): {
    rawManifest: Buffer;
    manifest: WorkflowManifest;
    authority: WorkflowGrant;
  } {
    const manifest: WorkflowManifest = {
      protocol_version: "workflow-1",
      workflow_id: randomUUID(),
      jobs: tasks.map((t, index) => ({
        request_id: t.request_id,
        task_spec_sha256: sha256Bytes(raw(t)),
        depends_on:
          index === 0
            ? []
            : [
                {
                  request_id: required(tasks[index - 1]).request_id,
                  expected_commit: required(tasks[index - 1]).base_commit,
                  require_result_ack: true,
                },
              ],
      })),
    };
    const rawManifest = Buffer.from(JSON.stringify(manifest));
    const authority: WorkflowGrant = {
      protocol_version: "workflow-grant-1",
      grant_id: randomUUID(),
      nonce: randomUUID(),
      max_starts: tasks.length,
      workflow_id: manifest.workflow_id,
      manifest_sha256: sha256Bytes(rawManifest),
      policy_snapshot_sha256: policy.policyHash,
      session_id: policy.sessionId,
      bridge_id: policy.bridgeId,
      approver_id: "fixture-authority",
      decision: "approved",
      issued_at: now().toISOString(),
      expires_at: new Date(clock + 60000).toISOString(),
    };
    return { rawManifest, manifest, authority };
  }
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-v2-"));
    await mkdir(join(dir, "src"));
    store = await openTaskStore(join(dir, "jobs.db"));
    clock = Date.parse("2026-10-03T00:00:00Z");
    fake = new FakeTaskExecutor(now);
    policy = {
      bridgeId: "test-bridge",
      executorId: fake.executorId,
      repoId: "fixture-repo",
      repoRoot: dir,
      baseCommit: "b".repeat(40),
      policyHash: "c".repeat(64),
      policyId: "fixture-policy",
      policyVersion: 1,
      revoked: false,
      expiresAt: new Date(clock + 3600000).toISOString(),
      sessionId: randomUUID(),
      confirmation: "manual",
      agents: { "fake-agent": ["fake-model"] },
      modes: ["read_only", "edit"],
      paths: [{ path: "src", scope: "subtree", permissions: ["read", "write"] }],
      commands: [],
      evaluators: ["fake-check"],
      maxStarts: 10,
      sessionDeadline: new Date(clock + 3600000).toISOString(),
      budget: null,
      requiresActionConfirmation: false,
    };
    controller = new TaskController(store, fake, policy, now);
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("bounds lexical task discovery without skipping IDs or mutating session counters", () => {
    const tasks = [task(), task(), task()];
    for (const item of tasks) controller.receive(raw(item), taskBytes);
    const ids = tasks.map((item) => item.request_id).sort();
    const first = store.listPage("", 2);
    expect(first.requestIds).toEqual(ids.slice(0, 2));
    expect(store.listPage(first.next ?? "", 2)).toEqual({ requestIds: ids.slice(2), next: null });
    expect(() => store.listPage("", 257)).toThrow("page_invalid");
    expect(() => store.listPage("../", 1)).toThrow("page_invalid");
    expect(store.sessionSnapshot(policy.sessionId)).toMatchObject({
      starts: 0,
      paused: false,
      stopped: false,
      reservedSeconds: 0,
    });
    expect(store.activeLocks(policy.sessionId)).toEqual([]);
    expect(store.dependencies(ids[0] ?? "")).toBeNull();
  });
  it("runs and collects verifiable synthetic success, with no model or process invocation", async () => {
    const t = task();
    const g = approve(t);
    const running = await controller.start(t.request_id, g.approval_id);
    expect(running.result.status).toBe("running");
    clock += 1000;
    fake.finish(required(running.intent).runId, "succeeded");
    const done = await controller.collect(t.request_id);
    expect(done.result.status).toBe("succeeded");
    expect(done.result.synthetic).toBe(true);
    expect(done.result.receipt).toBeNull();
    expect(store.receipt(t.request_id)?.result).toEqual(done.result);
    expect(validateTaskResult(done.result, { task: t, taskSpecHash: sha256Bytes(raw(t)) })).toEqual(
      { valid: true, errors: [] },
    );
    expect(store.pendingDeliveries()).toEqual([
      { requestId: t.request_id, sequence: done.result.observation_seq },
    ]);
    const ack = {
      ...required(store.handshake(t.request_id, "terminal_result")),
      stage: "result_ack" as const,
      actorId: "caller",
    };
    expect(sha256Bytes(store.deliveryPayload(t.request_id))).toBe(ack.payloadSha256);
    expect(Buffer.from(store.deliveryPayload(t.request_id)).toString("utf8")).toBe(
      serializeTaskResult(done.result),
    );
    store.acknowledgeDelivery(ack);
    store.acknowledgeDelivery(ack);
    expect(store.pendingDeliveries()).toEqual([]);
    for (const invalid of [
      { ...ack, sequence: 999 },
      { ...ack, actorId: "wrong" },
      { ...ack, taskSpecHash: "0".repeat(64) },
      { ...ack, runId: randomUUID() },
      { ...ack, payloadSha256: "f".repeat(64) },
    ])
      expect(() => store.acknowledgeDelivery(invalid)).toThrow("delivery_identity_mismatch");
    expect(store.handshake(t.request_id, "receipt_ack")?.taskSpecHash).toBe(sha256Bytes(raw(t)));
    expect(store.handshake(t.request_id, "start_receipt")?.runId).toBe(done.result.run_id);
  });
  it("deduplicates the same ID twice, rejects different bytes, never restarts a running job", async () => {
    const t = task();
    const g = approve(t);
    await controller.start(t.request_id, g.approval_id);
    expect(controller.receive(raw(t), taskBytes).result.status).toBe("running");
    await controller.start(t.request_id, g.approval_id);
    expect(fake.starts).toBe(1);
    expect(() => controller.receive(Buffer.from(JSON.stringify(t, null, 2)), taskBytes)).toThrow(
      "request_id_conflict",
    );
    expect(() => controller.receive(raw({ ...t, requested_model: "other" }), taskBytes)).toThrow(
      "request_id_conflict",
    );
  });
  it("rejects stale, changed-task, revoked and reused approvals before dispatch", async () => {
    const t = task();
    const g = approve(t);
    clock += 60001;
    await expect(controller.start(t.request_id, g.approval_id)).rejects.toThrow("approval_stale");
    expect(fake.starts).toBe(0);
    clock -= 60001;
    store.revokeApproval(g.approval_id);
    await expect(controller.start(t.request_id, g.approval_id)).rejects.toThrow("approval_stale");
    const second = task();
    controller.receive(raw(second), taskBytes);
    expect(() => controller.approve(second.request_id, g)).toThrow("approval_stale");
  });
  it("keeps disconnect unknown, reacquires existing run, and never calls start twice", async () => {
    const t = task();
    const g = approve(t);
    fake.disconnected = true;
    const lost = await controller.start(t.request_id, g.approval_id);
    expect(lost.result.status).toBe("unknown");
    await controller.start(t.request_id, g.approval_id);
    expect(fake.starts).toBe(1);
    fake.disconnected = false;
    const recovered = await controller.status(t.request_id);
    expect(recovered.result.status).toBe("running");
    expect(fake.starts).toBe(1);
  });
  it("unknown outcome pauses the session's next job without consuming another start", async () => {
    const first = task();
    const one = approve(first);
    fake.disconnected = true;
    await controller.start(first.request_id, one.approval_id);
    const second = task();
    const two = approve(second);
    await expect(controller.start(second.request_id, two.approval_id)).rejects.toThrow(
      "session_unknown_pause",
    );
    expect(fake.starts).toBe(1);
  });
  it("recovers an unknown terminal outcome only from matching collected evidence", async () => {
    const t = task();
    const g = approve(t);
    fake.disconnected = true;
    const lost = await controller.start(t.request_id, g.approval_id);
    clock += 1000;
    fake.finish(required(lost.intent).runId, "succeeded");
    fake.disconnected = false;
    expect((await controller.collect(t.request_id)).result.status).toBe("succeeded");
    expect(fake.starts).toBe(1);
  });
  it("rejects mismatched execution identity and bad evidence as unknown", async () => {
    const t = task();
    const g = approve(t);
    const started = await controller.start(t.request_id, g.approval_id);
    clock += 1000;
    const obs = fake.finish(required(started.intent).runId, "succeeded");
    obs.identity.fencingToken = 99;
    expect((await controller.collect(t.request_id)).result.status).toBe("unknown");
    obs.identity.fencingToken = 1;
    fake.corruptArtifact = true;
    expect((await controller.collect(t.request_id)).result.status).toBe("unknown");
    expect(store.receipt(t.request_id)).toBeNull();
  });
  it("requires cancellation termination proof and reissues after a disconnect", async () => {
    const t = task();
    const g = approve(t);
    await controller.start(t.request_id, g.approval_id);
    fake.cancelDisconnect = true;
    expect((await controller.cancel(t.request_id)).result.status).toBe("unknown");
    expect(store.receipt(t.request_id)).toBeNull();
    fake.cancelDisconnect = false;
    clock += 1000;
    expect((await controller.status(t.request_id)).result.status).toBe("cancelled");
    expect(fake.cancels).toBe(2);
    expect(fake.starts).toBe(1);
  });
  it("handles cancellation during pending start without accepting the late running response", async () => {
    const t = task();
    const g = approve(t);
    let unblock!: () => void;
    fake.startHook = () =>
      new Promise<void>((resolve) => {
        unblock = resolve;
      });
    const starting = controller.start(t.request_id, g.approval_id);
    for (let i = 0; i < 30 && !unblock; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(unblock).toBeTypeOf("function");
    expect((await controller.cancel(t.request_id)).result.status).toBe("unknown");
    unblock();
    expect((await starting).result.status).toBe("unknown");
    clock += 1000;
    expect((await controller.status(t.request_id)).result.status).toBe("cancelled");
    expect(fake.starts).toBe(1);
    expect(fake.cancels).toBe(2);
  });
  it("times out through cancel with evidence and supports ordinary failure", async () => {
    const t = task();
    const g = approve(t);
    await controller.start(t.request_id, g.approval_id);
    clock += 11000;
    const timed = await controller.status(t.request_id);
    expect(timed.result.status).toBe("failed");
    expect(timed.result.error?.code).toBe("run_timeout");
    const second = task();
    const g2 = approve(second);
    const started = await controller.start(second.request_id, g2.approval_id);
    clock += 1000;
    fake.finish(required(started.intent).runId, "failed");
    expect((await controller.collect(second.request_id)).result.status).toBe("failed");
  });
  it("cancels pre-start without inventing process evidence", async () => {
    const t = task();
    controller.receive(raw(t), taskBytes);
    const cancelled = await controller.cancel(t.request_id);
    expect(cancelled.result.status).toBe("cancelled");
    expect(cancelled.result.started_at).toBeNull();
    expect(fake.starts).toBe(0);
  });
  it("stops a session and revokes running work, preserving proof requirement", async () => {
    const t = task();
    const g = approve(t);
    await controller.start(t.request_id, g.approval_id);
    store.revokeApproval(g.approval_id);
    expect((await controller.status(t.request_id)).result.status).toBe("cancelled");
    await controller.emergencyStop();
    const second = task();
    controller.receive(raw(second), taskBytes);
    expect(() => controller.approve(second.request_id, grant(second))).toThrow("session_stopped");
  });
  it("applies atomic start count and budget reservations plus mandatory confirmation", async () => {
    policy.confirmation = "autoapprove";
    policy.maxStarts = 1;
    policy.budget = { limit: 2, perStartReservation: 2 };
    const t = task();
    t.approval.tier = "automatic";
    t.approval.preauthorization = {
      policy_id: policy.policyId,
      policy_version: policy.policyVersion,
      policy_sha256: policy.policyHash,
      session_id: policy.sessionId,
    };
    controller.receive(raw(t), taskBytes);
    const g = controller.evaluatePolicy(t.request_id);
    await controller.start(t.request_id, g.approval_id);
    const second = task();
    second.approval = structuredClone(t.approval);
    controller.receive(raw(second), taskBytes);
    const two = controller.evaluatePolicy(second.request_id);
    await expect(controller.start(second.request_id, two.approval_id)).rejects.toThrow(
      "session_limit",
    );
    policy.requiresActionConfirmation = true;
    const third = task();
    controller.receive(raw(third), taskBytes);
    expect(() => controller.evaluatePolicy(third.request_id)).toThrow(
      "action_confirmation_required",
    );
  });
  it("fails closed without an enforcing executor, even with a structurally valid grant", async () => {
    const unavailable = new UnavailableTaskExecutor();
    policy.executorId = unavailable.executorId;
    const blocked = new TaskController(store, unavailable, policy, now);
    const t = task();
    blocked.receive(raw(t), taskBytes);
    const g = grant(t);
    blocked.approve(t.request_id, g);
    await expect(blocked.start(t.request_id, g.approval_id)).rejects.toThrow(
      "sandbox_capability_unavailable",
    );
    expect(store.get(t.request_id)?.intent).toBeNull();
  });
  it("rejects invalid transitions, fixture starts, repo/base/model/path/command/mode violations", async () => {
    expect(() => assertTaskTransition("succeeded", "running")).toThrow("invalid_task_transition");
    expect(() => assertTaskTransition("unknown", "approved")).toThrow("invalid_task_transition");
    const t = task();
    const variants = [
      { ...t, repo: "elsewhere" },
      { ...t, base_commit: "d".repeat(40) },
      { ...t, requested_model: "unapproved" },
      {
        ...t,
        mode: "edit" as const,
        allowed_paths: [
          { path: "outside", scope: "subtree" as const, permissions: ["write" as const] },
        ],
      },
    ];
    for (const invalid of variants) expect(() => checkTaskPolicy(invalid, policy, now())).toThrow();
    policy.modes = ["read_only"];
    expect(() => checkTaskPolicy({ ...t, mode: "edit" }, policy, now())).toThrow("mode_denied");
    for (const path of [
      "src/file\n",
      "src/file\r\n",
      "../outside",
      "C:/outside",
      "src/../a",
      "src/CON.txt",
      "src/a:",
      "src/a ",
      "src\\a",
      ".git/config",
    ])
      expect(() => checkRelativePath(path)).toThrow();
    policy.budget = { limit: 1, perStartReservation: null };
    expect(() => checkTaskPolicy(t, policy, now())).toThrow("budget_unknown");
    await writeFile(join(dir, "src", "a"), "a");
    await symlink(join(dir, "src", "a"), join(dir, "src", "linked"));
    await expect(checkFilesystemPath(dir, "src/linked")).rejects.toThrow("path_link_denied");
    await link(join(dir, "src", "a"), join(dir, "src", "hard"));
    await expect(checkFilesystemPath(dir, "src/hard")).rejects.toThrow("path_hardlink_denied");
  });
  it("reopens durable running state and only reconciles, without another dispatch", async () => {
    const t = task();
    const g = approve(t);
    await controller.start(t.request_id, g.approval_id);
    store.close();
    store = await openTaskStore(join(dir, "jobs.db"));
    controller = new TaskController(store, fake, policy, now);
    expect((await controller.status(t.request_id)).result.status).toBe("running");
    await controller.start(t.request_id, g.approval_id);
    expect(fake.starts).toBe(1);
  });
  it("rolls back a start intent on before-COMMIT crash and permits the same approved first start", async () => {
    const t = task();
    const g = approve(t);
    let fail = true;
    store.close();
    store = await openTaskStore(join(dir, "jobs.db"), {
      beforeCommit: () => {
        if (fail) throw new Error("crash_before_commit");
      },
    });
    controller = new TaskController(store, fake, policy, now);
    await expect(controller.start(t.request_id, g.approval_id)).rejects.toThrow(
      "crash_before_commit",
    );
    expect(store.get(t.request_id)?.intent).toBeNull();
    expect(fake.starts).toBe(0);
    fail = false;
    expect((await controller.start(t.request_id, g.approval_id)).result.status).toBe("running");
    expect(fake.starts).toBe(1);
  });
  it("keeps a committed intent unknown after after-COMMIT crash and never dispatches again", async () => {
    const t = task();
    const g = approve(t);
    let fail = true;
    store.close();
    store = await openTaskStore(join(dir, "jobs.db"), {
      afterCommit: () => {
        if (fail) throw new Error("crash_after_commit");
      },
    });
    controller = new TaskController(store, fake, policy, now);
    await expect(controller.start(t.request_id, g.approval_id)).rejects.toThrow(
      "crash_after_commit",
    );
    expect(store.get(t.request_id)?.intent).not.toBeNull();
    expect(fake.starts).toBe(0);
    fail = false;
    expect((await controller.start(t.request_id, g.approval_id)).result.status).toBe("unknown");
    expect((await controller.status(t.request_id)).result.status).toBe("unknown");
    expect(fake.starts).toBe(0);
  });
  it("two store connections race the same ID and only one starts", async () => {
    const t = task();
    const g = approve(t);
    const second = await openTaskStore(join(dir, "jobs.db"));
    try {
      const other = new TaskController(second, fake, policy, now);
      const outcomes = await Promise.allSettled([
        controller.start(t.request_id, g.approval_id),
        other.start(t.request_id, g.approval_id),
      ]);
      expect(outcomes.some((r) => r.status === "fulfilled")).toBe(true);
      expect(fake.starts).toBe(1);
      expect((await other.status(t.request_id)).result.status).toBe("running");
    } finally {
      second.close();
    }
  });
  it("two connections cannot exceed a shared session ceiling across different requests", async () => {
    policy.maxStarts = 1;
    const one = task();
    const two = task();
    const g1 = approve(one);
    const g2 = approve(two);
    const second = await openTaskStore(join(dir, "jobs.db"));
    try {
      const other = new TaskController(second, fake, policy, now);
      const outcomes = await Promise.allSettled([
        controller.start(one.request_id, g1.approval_id),
        other.start(two.request_id, g2.approval_id),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(fake.starts).toBe(1);
    } finally {
      second.close();
    }
  });
  it("real prestart delivery requires requester proof and historical payload ACK cannot satisfy delivery", async () => {
    const real = new TaskController(store, new UnavailableTaskExecutor(), policy, now);
    const t = task();
    real.receive(raw(t), taskBytes);
    await real.cancel(t.request_id);
    const record = required(store.get(t.request_id)),
      terminal = required(store.handshake(t.request_id, "terminal_result"));
    const ack = { ...terminal, stage: "result_ack" as const, actorId: "caller" };
    expect(() => store.acknowledgeDelivery(ack)).toThrow("delivery_materialization_required");
    expect(store.deliveryVerified(t.request_id)).toBe(false);
    const proof: MaterializationReceiptV1 = {
      schema: "materialization-receipt-1",
      requesterActorId: "caller",
      recipientActorId: policy.bridgeId,
      requestId: t.request_id,
      taskSpecHash: terminal.taskSpecHash,
      execution: { kind: "local_execution", runId: null },
      terminalEventId: terminal.eventId,
      payloadSha256: terminal.payloadSha256,
      deliveryManifestSha256: "d".repeat(64),
      requiredArtifactsVerified: true,
      payloadVerification: "local_result_and_receipt",
      synthetic: false,
      verifiedArtifacts: [
        ...new Map(
          taskResultArtifactRefs(record.result).map((ref) => [ref.artifact_id, ref]),
        ).values(),
      ].map((ref) => ({
        artifactId: ref.artifact_id,
        contentSha256: ref.sha256,
        sizeBytes: ref.size_bytes,
        required: true,
      })),
    };
    expect(() => store.acknowledgeDelivery(ack, { ...proof, verifiedArtifacts: [] })).toThrow(
      "artifact_missing",
    );
    expect(() => store.acknowledgeDelivery(ack, { ...proof, synthetic: true })).toThrow(
      "scope_mismatch",
    );
    store.acknowledgeDelivery(ack, proof);
    expect(store.deliveryVerified(t.request_id)).toBe(true);
    store.acknowledgeDelivery(ack, proof);
    expect(store.pendingDeliveries()).toEqual([]);
    expect(store.materialization(t.request_id)).toEqual(proof);
  });
  it("non-synthetic prestart cancellation produces valid local proof with an advancing clock", async () => {
    const unavailable = new UnavailableTaskExecutor();
    policy.executorId = unavailable.executorId;
    const realNow = () => {
      clock += 1;
      return new Date(clock);
    };
    const blocked = new TaskController(store, unavailable, policy, realNow);
    const t = task();
    blocked.receive(raw(t), taskBytes);
    const cancelled = await blocked.cancel(t.request_id);
    expect(cancelled.result.receipt?.process_state).toBe("never_started");
    expect(
      validateTaskResult(cancelled.result, { task: t, taskSpecHash: sha256Bytes(raw(t)) }),
    ).toEqual({ valid: true, errors: [] });
  });
  it("rechecks mandatory confirmation after automatic approval before atomic start consumption", async () => {
    policy.confirmation = "autoapprove";
    const t = task();
    t.approval.tier = "automatic";
    t.approval.preauthorization = {
      policy_id: policy.policyId,
      policy_version: policy.policyVersion,
      policy_sha256: policy.policyHash,
      session_id: policy.sessionId,
    };
    controller.receive(raw(t), taskBytes);
    const g = controller.evaluatePolicy(t.request_id);
    policy.requiresActionConfirmation = true;
    await expect(controller.start(t.request_id, g.approval_id)).rejects.toThrow(
      "action_confirmation_required",
    );
    expect(fake.starts).toBe(0);
  });
  it("binds dependency graph, task hashes, commits and accepted/executed conditions before approval", async () => {
    const one = task();
    const two = task();
    controller.receive(raw(one), taskBytes);
    controller.receive(raw(two), taskBytes);
    const dep = (t: TaskSpec) => ({
      requestId: t.request_id,
      taskSpecHash: sha256Bytes(raw(t)),
      expectedCommit: t.base_commit,
      requireAck: true,
    });
    const cycle = { [one.request_id]: [dep(two)], [two.request_id]: [dep(one)] };
    expect(() =>
      store.configureDependencies(cycle, sha256Bytes(Buffer.from(JSON.stringify(cycle)))),
    ).toThrow("dependency_cycle");
    const graph = { [one.request_id]: [], [two.request_id]: [dep(one)] };
    policy.workflowHash = sha256Bytes(Buffer.from(JSON.stringify(graph)));
    store.configureDependencies(graph, policy.workflowHash);
    const g1 = grant(one);
    const g2 = grant(two);
    controller.approve(one.request_id, g1);
    controller.approve(two.request_id, g2);
    expect(() => store.configureDependencies(graph, required(policy.workflowHash))).toThrow(
      "workflow_requires_unapproved_nodes",
    );
    await expect(controller.start(two.request_id, g2.approval_id)).rejects.toThrow(
      "dependency_not_succeeded",
    );
    const started = await controller.start(one.request_id, g1.approval_id);
    clock += 1000;
    fake.finish(required(started.intent).runId, "succeeded");
    await controller.collect(one.request_id);
    await expect(controller.start(two.request_id, g2.approval_id)).rejects.toThrow(
      "dependency_not_succeeded",
    );
    store.acknowledgeDelivery({
      ...required(store.handshake(one.request_id, "terminal_result")),
      stage: "result_ack",
      actorId: "caller",
    });
    const second = await controller.start(two.request_id, g2.approval_id);
    expect(second.result.status).toBe("running");
    expect(second.result.fencing_token).toBeGreaterThan(started.result.fencing_token);
  });
  it("holds a worktree write lock until termination, including disconnect/unknown", async () => {
    const one = task();
    const two = task();
    one.mode = two.mode = "edit";
    const g1 = approve(one);
    const g2 = approve(two);
    const started = await controller.start(one.request_id, g1.approval_id);
    await expect(controller.start(two.request_id, g2.approval_id)).rejects.toThrow(
      "worktree_write_locked",
    );
    fake.disconnected = true;
    await controller.status(one.request_id);
    await expect(controller.start(two.request_id, g2.approval_id)).rejects.toThrow(
      "session_unknown_pause",
    );
    fake.disconnected = false;
    clock += 1000;
    fake.finish(required(started.intent).runId, "failed");
    await controller.collect(one.request_id);
    controller.resumeSession();
    expect((await controller.start(two.request_id, g2.approval_id)).result.status).toBe("running");
  });
  it("rejects reattachment through the wrong executor or session", async () => {
    const t = task();
    const g = approve(t);
    await controller.start(t.request_id, g.approval_id);
    const other = new TaskController(store, fake, { ...policy, sessionId: randomUUID() }, now);
    await expect(other.status(t.request_id)).rejects.toThrow("executor_or_session_mismatch");
  });
  it("recovers temporarily rejected cancellation evidence without repeating execution", async () => {
    const t = task();
    const g = approve(t);
    await controller.start(t.request_id, g.approval_id);
    fake.corruptArtifact = true;
    expect((await controller.cancel(t.request_id)).result.status).toBe("unknown");
    fake.corruptArtifact = false;
    expect((await controller.status(t.request_id)).result.status).toBe("cancelled");
    expect(fake.starts).toBe(1);
  });
  it("enforces an unanswered-quota fallback's actual start/time ceilings", async () => {
    controller = new TaskController(store, fake, policy, now, {
      observation: {
        source: "unknown",
        observedAt: null,
        windowEndsAt: null,
        remainingPercent: null,
        maxAgeSeconds: 300,
      },
      fallback: { preauthorized: true, maxStarts: 1, maxRunSeconds: 2 },
      strictMoneyBudget: false,
    });
    const one = task();
    const two = task();
    const g1 = approve(one);
    const g2 = approve(two);
    const started = await controller.start(one.request_id, g1.approval_id);
    expect(Date.parse(required(started.intent).deadlineAt) - clock).toBe(2000);
    await expect(controller.start(two.request_id, g2.approval_id)).rejects.toThrow("session_limit");
    clock += 2100;
    expect((await controller.status(one.request_id)).result.error?.code).toBe("run_timeout");
  });
  it("rejects unknown quota without explicit fallback and strict cost budgets even with quota %", async () => {
    const observation = {
      source: "unknown" as const,
      observedAt: null,
      windowEndsAt: null,
      remainingPercent: null,
      maxAgeSeconds: 300,
    };
    controller = new TaskController(store, fake, policy, now, {
      observation,
      fallback: null,
      strictMoneyBudget: false,
    });
    const t = task();
    const g = approve(t);
    await expect(controller.start(t.request_id, g.approval_id)).rejects.toThrow(
      "quota_observation",
    );
    controller = new TaskController(store, fake, policy, now, {
      observation: {
        source: "provider",
        observedAt: now().toISOString(),
        windowEndsAt: new Date(clock + 60000).toISOString(),
        remainingPercent: 90,
        maxAgeSeconds: 300,
      },
      fallback: null,
      strictMoneyBudget: true,
    });
    await expect(controller.start(t.request_id, g.approval_id)).rejects.toThrow(
      "strict_cost_bound_not_established",
    );
    expect(fake.starts).toBe(0);
  });
  it("canonical worktree identity prevents alternate root spellings from bypassing edit locks", async () => {
    const one = task();
    one.mode = "edit";
    const two = task();
    two.mode = "edit";
    const g1 = approve(one);
    const g2 = approve(two);
    await controller.start(one.request_id, g1.approval_id);
    const alias = new TaskController(store, fake, { ...policy, repoRoot: `${dir}/src/..` }, now);
    await expect(alias.start(two.request_id, g2.approval_id)).rejects.toThrow(
      "worktree_write_locked",
    );
  });
  it("cancels an allocated-but-never-started run only on identity-bound proof", async () => {
    const t = task();
    const g = approve(t);
    let fail = true;
    store.close();
    store = await openTaskStore(join(dir, "jobs.db"), {
      afterCommit: () => {
        if (fail) throw new Error("crash_after_commit");
      },
    });
    controller = new TaskController(store, fake, policy, now);
    await expect(controller.start(t.request_id, g.approval_id)).rejects.toThrow(
      "crash_after_commit",
    );
    fail = false;
    const pending = required(store.get(t.request_id));
    fake.status = async (id) => ({
      kind: "terminal",
      identity: id,
      allTerminated: true,
      result: {
        ...pending.result,
        status: "cancelled",
        last_confirmed_status: "cancelled",
        outcome_known: true,
        finished_at: now().toISOString(),
        observed_at: now().toISOString(),
        diff: { kind: "none", complete: true, artifact_ref: null },
        error: {
          code: "never_started",
          message: "Synthetic broker proves no child was created",
          retryable: false,
        },
      },
    });
    expect((await controller.status(t.request_id)).result.status).toBe("cancelled");
    expect(fake.starts).toBe(0);
  });
  it("emergency stop persists every cancel intent despite one broker RPC hanging", async () => {
    controller = new TaskController(store, fake, policy, now, undefined, 10);
    const one = task();
    const g1 = approve(one);
    const first = await controller.start(one.request_id, g1.approval_id);
    await mkdir(join(dir, "other", "src"), { recursive: true });
    // Different registered repo for the second concurrently active session job.
    const secondPolicy = { ...policy, repoId: "second-repo", repoRoot: join(dir, "other") };
    const other = new TaskController(store, fake, secondPolicy, now, undefined, 10);
    const secondTask = task();
    secondTask.repo = "second-repo";
    other.receive(raw(secondTask), taskBytes);
    const secondGrant = grant(secondTask);
    other.approve(secondTask.request_id, secondGrant);
    await other.start(secondTask.request_id, secondGrant.approval_id);
    const cancel = fake.cancel.bind(fake);
    fake.cancel = async (id, reason) =>
      id.runId === first.intent?.runId ? new Promise(() => {}) : cancel(id, reason);
    const results = await controller.emergencyStop();
    expect(results.map((r) => r.result.status).sort()).toEqual(["cancelled", "unknown"]);
    expect(store.get(one.request_id)?.intent?.cancelAt).not.toBeNull();
    expect(store.get(secondTask.request_id)?.intent?.cancelAt).not.toBeNull();
    expect(store.sessionStopped(policy.sessionId)).toBe(true);
  });
  it("a durable cancellation wins a later successful executor result", async () => {
    const t = task();
    const g = approve(t);
    const started = await controller.start(t.request_id, g.approval_id);
    fake.cancel = async () => {
      clock += 1000;
      return fake.finish(required(started.intent).runId, "succeeded");
    };
    const cancelled = await controller.cancel(t.request_id);
    expect(cancelled.result.status).toBe("cancelled");
    expect(cancelled.result.error?.code).toBe("cancellation_committed_first");
    expect(() => assertTaskTransition("cancel_requested", "succeeded")).toThrow();
  });
  it("retains the winning timeout reason during a later user cancel", async () => {
    const t = task();
    const g = approve(t);
    await controller.start(t.request_id, g.approval_id);
    fake.cancelDisconnect = true;
    clock += 11000;
    await controller.status(t.request_id);
    fake.cancelDisconnect = false;
    const observed: string[] = [];
    const cancel = fake.cancel.bind(fake);
    fake.cancel = async (id, reason) => {
      observed.push(reason);
      return cancel(id, reason);
    };
    const failed = await controller.cancel(t.request_id, "user");
    expect(observed).toEqual(["timeout"]);
    expect(failed.result.status).toBe("failed");
    expect(failed.result.error?.code).toBe("run_timeout");
  });
  it("aborts when quota bounds become stricter under the start transaction", async () => {
    let reads = 0;
    const observation = {
      source: "provider" as const,
      observedAt: now().toISOString(),
      windowEndsAt: new Date(clock + 60000).toISOString(),
      remainingPercent: 80,
      maxAgeSeconds: 1,
    };
    Object.defineProperty(observation, "observedAt", {
      get: () => (++reads <= 2 ? now().toISOString() : new Date(clock - 2000).toISOString()),
    });
    controller = new TaskController(store, fake, policy, now, {
      observation,
      fallback: { preauthorized: true, maxStarts: 1, maxRunSeconds: 1 },
      strictMoneyBudget: false,
    });
    const t = task();
    const g = approve(t);
    await expect(controller.start(t.request_id, g.approval_id)).rejects.toThrow(
      "quota_constraints_changed",
    );
    expect(fake.starts).toBe(0);
    expect(store.get(t.request_id)?.intent).toBeNull();
  });
  it("rechecks stored task bytes before dispatch instead of trusting prior hash metadata", async () => {
    const t = task();
    const g = approve(t);
    const row = required(store.get(t.request_id));
    row.rawSpec += " ";
    const db = new DatabaseSync(join(dir, "jobs.db"));
    try {
      db.prepare("UPDATE task_jobs SET snapshot=? WHERE request_id=?").run(
        JSON.stringify(row),
        t.request_id,
      );
    } finally {
      db.close();
    }
    await expect(controller.start(t.request_id, g.approval_id)).rejects.toThrow(
      "stored_task_integrity_mismatch",
    );
    expect(fake.starts).toBe(0);
  });
  it("a reconciled unknown session stays paused until explicit trusted resume", async () => {
    const first = task();
    const g1 = approve(first);
    fake.disconnected = true;
    const pending = await controller.start(first.request_id, g1.approval_id);
    fake.disconnected = false;
    clock += 1000;
    fake.finish(required(pending.intent).runId, "succeeded");
    await controller.collect(first.request_id);
    const second = task();
    const g2 = approve(second);
    await expect(controller.start(second.request_id, g2.approval_id)).rejects.toThrow(
      "session_unknown_pause",
    );
    controller.resumeSession();
    expect((await controller.start(second.request_id, g2.approval_id)).result.status).toBe(
      "running",
    );
  });
  it("read-only and edit jobs share repo exclusion, and release advances durable fencing", async () => {
    const first = task();
    const second = task();
    second.mode = "edit";
    const g1 = approve(first);
    const g2 = approve(second);
    const started = await controller.start(first.request_id, g1.approval_id);
    await expect(controller.start(second.request_id, g2.approval_id)).rejects.toThrow(
      "worktree_write_locked",
    );
    clock += 1000;
    fake.finish(required(started.intent).runId, "succeeded");
    await controller.collect(first.request_id);
    const nextRun = await controller.start(second.request_id, g2.approval_id);
    expect(nextRun.result.fencing_token).toBe(started.result.fencing_token + 1);
  });
  it("emergency stop cancels unstarted session jobs and revokes unused grants", async () => {
    const t = task();
    const g = approve(t);
    const stopped = await controller.emergencyStop();
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.result.status).toBe("cancelled");
    expect(store.approval(g.approval_id)?.decision).toBe("revoked");
    expect(fake.starts).toBe(0);
  });
  it("rejects a manual job moved into another session before approval", () => {
    const t = task();
    controller.receive(raw(t), taskBytes);
    const another = new TaskController(store, fake, { ...policy, sessionId: randomUUID() }, now);
    expect(() => another.approve(t.request_id, grant(t))).toThrow("executor_or_session_mismatch");
  });
  it("rejects overlong approval lifetime even before its expiry", () => {
    const t = task();
    controller.receive(raw(t), taskBytes);
    const g = grant(t);
    g.expires_at = new Date(clock + 61000).toISOString();
    expect(() => controller.approve(t.request_id, g)).toThrow("approval_stale");
  });
  it("workflow rejects missing nodes and mismatched graph digest before approval", () => {
    const t = task();
    controller.receive(raw(t), taskBytes);
    const graph = {
      [t.request_id]: [
        {
          requestId: randomUUID(),
          taskSpecHash: "a".repeat(64),
          expectedCommit: null,
          requireAck: false,
        },
      ],
    };
    expect(() => store.configureDependencies(graph, "0".repeat(64))).toThrow(
      "workflow_binding_mismatch",
    );
    expect(() =>
      store.configureDependencies(graph, sha256Bytes(Buffer.from(JSON.stringify(graph)))),
    ).toThrow("workflow_missing_reference");
  });
  it("recovery of a committed unconfirmed dispatch latches pause before reconciliation", async () => {
    const one = task();
    const g = approve(one);
    let fault = true;
    store.close();
    store = await openTaskStore(join(dir, "jobs.db"), {
      afterCommit: () => {
        if (fault) throw new Error("after_commit");
      },
    });
    controller = new TaskController(store, fake, policy, now);
    await expect(controller.start(one.request_id, g.approval_id)).rejects.toThrow("after_commit");
    fault = false;
    const row = required(store.get(one.request_id));
    const intent = required(row.intent);
    await fake.start(
      one,
      taskBytes,
      {
        requestId: one.request_id,
        taskSpecHash: row.result.task_spec_hash,
        runId: intent.runId,
        fencingToken: intent.fencingToken,
      },
      intent,
    );
    expect((await controller.status(one.request_id)).result.status).toBe("running");
    clock += 1000;
    fake.finish(intent.runId, "succeeded");
    await controller.collect(one.request_id);
    const two = task();
    const g2 = approve(two);
    await expect(controller.start(two.request_id, g2.approval_id)).rejects.toThrow(
      "session_unknown_pause",
    );
    controller.resumeSession();
    expect((await controller.start(two.request_id, g2.approval_id)).result.status).toBe("running");
  });
  it("denies nonsynthetic workflow admission until a versioned authority contract exists", () => {
    const unavailable = new UnavailableTaskExecutor();
    policy.executorId = unavailable.executorId;
    const live = new TaskController(store, unavailable, policy, now);
    const t = task();
    live.receive(raw(t), taskBytes);
    const graph = { [t.request_id]: [] };
    expect(() =>
      store.configureDependencies(graph, sha256Bytes(Buffer.from(JSON.stringify(graph)))),
    ).toThrow("workflow_authority_unconfigured");
  });
  it("atomically reserves cumulative run time, retaining unknown reservations", async () => {
    policy.maxTotalRunSeconds = 10;
    const one = task();
    const two = task();
    const g1 = approve(one);
    const g2 = approve(two);
    const first = await controller.start(one.request_id, g1.approval_id);
    clock += 1000;
    fake.finish(required(first.intent).runId, "succeeded");
    await controller.collect(one.request_id);
    await expect(controller.start(two.request_id, g2.approval_id)).rejects.toThrow("session_limit");
    expect(fake.starts).toBe(1);
  });
  it("enrolls a non-circular detached manifest without creating task approval", async () => {
    const one = task();
    const two = task();
    controller.receive(raw(one), taskBytes);
    controller.receive(raw(two), taskBytes);
    const w = workflow([one, two]);
    store.configureWorkflow(w.rawManifest, w.authority, now());
    store.configureWorkflow(w.rawManifest, w.authority, now());
    expect(store.get(one.request_id)?.result.status).toBe("awaiting_approval");
    await expect(controller.start(one.request_id, randomUUID())).rejects.toThrow(
      "approval_required",
    );
    const g1 = grant(one);
    const g2 = grant(two);
    controller.approve(one.request_id, g1);
    controller.approve(two.request_id, g2);
    await expect(controller.start(two.request_id, g2.approval_id)).rejects.toThrow(
      "dependency_not_succeeded",
    );
    const first = await controller.start(one.request_id, g1.approval_id);
    clock += 1000;
    fake.finish(required(first.intent).runId, "succeeded");
    await controller.collect(one.request_id);
    await expect(controller.start(two.request_id, g2.approval_id)).rejects.toThrow(
      "dependency_not_succeeded",
    );
    store.acknowledgeDelivery({
      ...required(store.handshake(one.request_id, "terminal_result")),
      stage: "result_ack",
      actorId: "caller",
    });
    expect((await controller.start(two.request_id, g2.approval_id)).result.status).toBe("running");
  });
  it("accepts detached enrollment for nonsynthetic tasks while real execution remains unavailable", async () => {
    const adapter = new UnavailableTaskExecutor();
    policy.executorId = adapter.executorId;
    const live = new TaskController(store, adapter, policy, now);
    const t = task();
    live.receive(raw(t), taskBytes);
    const w = workflow([t]);
    store.configureWorkflow(w.rawManifest, w.authority, now());
    const g = grant(t);
    live.approve(t.request_id, g);
    await expect(live.start(t.request_id, g.approval_id)).rejects.toThrow(
      "sandbox_capability_unavailable",
    );
  });
  it("invalidates workflow authority when even manifest whitespace changes", () => {
    const t = task();
    controller.receive(raw(t), taskBytes);
    const w = workflow([t]);
    expect(() =>
      store.configureWorkflow(Buffer.from(`${w.rawManifest.toString()} `), w.authority, now()),
    ).toThrow("workflow_grant_mismatch");
    expect(() =>
      store.configureWorkflow(w.rawManifest, { ...w.authority, session_id: randomUUID() }, now()),
    ).toThrow("workflow_binding_mismatch");
    expect(() =>
      store.configureWorkflow(
        w.rawManifest,
        { ...w.authority, policy_snapshot_sha256: "f".repeat(64) },
        now(),
      ),
    ).toThrow("workflow_binding_mismatch");
    const changed = structuredClone(w.manifest);
    required(changed.jobs[0]).task_spec_sha256 = "f".repeat(64);
    const bytes = Buffer.from(JSON.stringify(changed));
    expect(() =>
      store.configureWorkflow(
        bytes,
        { ...w.authority, manifest_sha256: sha256Bytes(bytes) },
        now(),
      ),
    ).toThrow("workflow_binding_mismatch");
  });
  it("rechecks workflow expiry/revocation/start ceiling atomically with task grant consumption", async () => {
    const t = task();
    controller.receive(raw(t), taskBytes);
    const w = workflow([t]);
    w.authority.expires_at = new Date(clock + 1000).toISOString();
    store.configureWorkflow(w.rawManifest, w.authority, now());
    const g = grant(t);
    controller.approve(t.request_id, g);
    clock += 1001;
    await expect(controller.start(t.request_id, g.approval_id)).rejects.toThrow(
      "workflow_grant_expired",
    );
    expect(fake.starts).toBe(0);
    clock -= 1001;
    store.revokeWorkflow(w.manifest.workflow_id);
    await expect(controller.start(t.request_id, g.approval_id)).rejects.toThrow(
      "workflow_grant_mismatch",
    );
  });
  it("workflow revocation cancels active nodes and preserves unknown on lost stop proof", async () => {
    const t = task();
    controller.receive(raw(t), taskBytes);
    const w = workflow([t]);
    store.configureWorkflow(w.rawManifest, w.authority, now());
    const g = grant(t);
    controller.approve(t.request_id, g);
    await controller.start(t.request_id, g.approval_id);
    fake.cancelDisconnect = true;
    expect((await controller.revokeWorkflow(w.manifest.workflow_id))[0]?.result.status).toBe(
      "unknown",
    );
    fake.cancelDisconnect = false;
    expect((await controller.status(t.request_id)).result.status).toBe("cancelled");
    expect(fake.starts).toBe(1);
  });
  it("rejects workflow cycles, missing nodes, duplicate nonce and postapproval enrollment", () => {
    const one = task();
    const two = task();
    controller.receive(raw(one), taskBytes);
    controller.receive(raw(two), taskBytes);
    const w = workflow([one, two]);
    const cycle = structuredClone(w.manifest);
    required(cycle.jobs[0]).depends_on = [
      { request_id: two.request_id, expected_commit: null, require_result_ack: false },
    ];
    expect(() => parseWorkflowManifest(Buffer.from(JSON.stringify(cycle)))).toThrow(
      "dependency_cycle",
    );
    const missing = structuredClone(w.manifest);
    required(required(missing.jobs[1]).depends_on[0]).request_id = randomUUID();
    expect(() => parseWorkflowManifest(Buffer.from(JSON.stringify(missing)))).toThrow(
      "workflow_missing_reference",
    );
    controller.approve(one.request_id, grant(one));
    expect(() => store.configureWorkflow(w.rawManifest, w.authority, now())).toThrow(
      "workflow_requires_unapproved_nodes",
    );
  });
  it("workflow nonce uniqueness and usage ceiling survive replay attempts", async () => {
    const one = task();
    const two = task();
    const third = task();
    for (const t of [one, two, third]) controller.receive(raw(t), taskBytes);
    const w = workflow([one, two]);
    w.authority.max_starts = 1;
    store.configureWorkflow(w.rawManifest, w.authority, now());
    const duplicate = workflow([third]);
    duplicate.authority.nonce = w.authority.nonce;
    expect(() =>
      store.configureWorkflow(duplicate.rawManifest, duplicate.authority, now()),
    ).toThrow();
    const g1 = grant(one);
    const g2 = grant(two);
    controller.approve(one.request_id, g1);
    controller.approve(two.request_id, g2);
    const first = await controller.start(one.request_id, g1.approval_id);
    clock += 1000;
    fake.finish(required(first.intent).runId, "succeeded");
    await controller.collect(one.request_id);
    store.acknowledgeDelivery({
      ...required(store.handshake(one.request_id, "terminal_result")),
      stage: "result_ack",
      actorId: "caller",
    });
    await expect(controller.start(two.request_id, g2.approval_id)).rejects.toThrow(
      "workflow_start_limit",
    );
    await controller.start(one.request_id, g1.approval_id);
    expect(fake.starts).toBe(1);
  });
  it("rejects impossible workflow grant calendar dates rather than normalizing them", () => {
    const t = task();
    const w = workflow([t]);
    const at = new Date("2026-03-01T23:00:00Z");
    expect(() =>
      checkWorkflowGrant(
        { ...w.authority, issued_at: "2026-03-01T22:00:00Z", expires_at: "2026-02-30T00:00:00Z" },
        w.manifest,
        w.authority.manifest_sha256,
        at,
      ),
    ).toThrow("workflow_grant_expired");
  });
  it("rejects corrupted derived workflow edges while the sealed manifest remains unchanged", async () => {
    const one = task();
    const two = task();
    controller.receive(raw(one), taskBytes);
    controller.receive(raw(two), taskBytes);
    const w = workflow([one, two]);
    store.configureWorkflow(w.rawManifest, w.authority, now());
    const g = grant(two);
    controller.approve(two.request_id, g);
    const db = new DatabaseSync(join(dir, "jobs.db"));
    try {
      const row = db
        .prepare("SELECT dependencies FROM task_dependencies WHERE request_id=?")
        .get(two.request_id) as { dependencies: string };
      const derived = JSON.parse(row.dependencies);
      derived.dependencies = [];
      db.prepare("UPDATE task_dependencies SET dependencies=? WHERE request_id=?").run(
        JSON.stringify(derived),
        two.request_id,
      );
    } finally {
      db.close();
    }
    await expect(controller.start(two.request_id, g.approval_id)).rejects.toThrow(
      "workflow_dependency_corrupt",
    );
    expect(fake.starts).toBe(0);
  });
  it("a missing dependency row cannot downgrade an enrolled workflow job to standalone", async () => {
    const t = task();
    controller.receive(raw(t), taskBytes);
    const w = workflow([t]);
    store.configureWorkflow(w.rawManifest, w.authority, now());
    const g = grant(t);
    controller.approve(t.request_id, g);
    const db = new DatabaseSync(join(dir, "jobs.db"));
    try {
      db.prepare("DELETE FROM task_dependencies WHERE request_id=?").run(t.request_id);
    } finally {
      db.close();
    }
    await expect(controller.start(t.request_id, g.approval_id)).rejects.toThrow(
      "workflow_enrollment_missing_or_mismatched",
    );
    expect(fake.starts).toBe(0);
  });
  it("host quota snapshots surround dispatch/ACK and a failed post-ACK read never changes success", async () => {
    let calls = 0;
    controller = new TaskController(store, fake, policy, now, undefined, 20, {
      readRateLimits: async () => {
        calls++;
        if (calls > 1) throw new Error("quota_rpc_unavailable");
        return {
          source: "account/rateLimits/read",
          cliVersion: "fake-1",
          protocolVersion: "fake-1",
          limits: [
            {
              limitId: "fake-model",
              primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1790980000 },
              secondary: null,
            },
          ],
        };
      },
    });
    const t = task();
    const g = approve(t);
    const running = await controller.start(t.request_id, g.approval_id);
    clock += 1000;
    fake.finish(required(running.intent).runId, "succeeded");
    const result = await controller.collect(t.request_id);
    const bytes = store.deliveryPayload(t.request_id);
    const event = required(store.handshake(t.request_id, "terminal_result"));
    const ack = { ...event, stage: "result_ack" as const, actorId: "caller" };
    await controller.acknowledgeResult(ack);
    await controller.acknowledgeResult(ack);
    expect(calls).toBe(2);
    expect(store.quotaObservations(t.request_id).map((q) => q.state)).toEqual([
      "observed",
      "unknown",
    ]);
    expect(store.get(t.request_id)?.result).toEqual(result.result);
    expect(store.deliveryPayload(t.request_id)).toEqual(bytes);
    expect(store.pendingDeliveries()).toEqual([]);
  });
});
