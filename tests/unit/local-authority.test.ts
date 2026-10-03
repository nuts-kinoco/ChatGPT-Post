import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthoritySession, LocalTaskAuthority } from "../../src/adapters/local-authority.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { TaskController } from "../../src/state/task-controller.js";
import { openTaskStore, type TaskStore } from "../../src/state/task-store.js";
import { adapterPolicy, adapterTask, adapterTaskBytes } from "../helpers/adapter-fixture.js";
import { FakeTaskExecutor } from "../helpers/fake-task-executor.js";

describe("authenticated bounded local approval authority", () => {
  let root: string;
  let store: TaskStore;
  let controller: TaskController;
  let authority: LocalTaskAuthority;
  let session: AuthoritySession;
  const now = new Date("2026-10-03T05:00:00Z");
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "authority-"));
    await mkdir(join(root, "src"));
    store = await openTaskStore(join(root, "jobs.db"));
    const policy = adapterPolicy(root, now);
    controller = new TaskController(store, new FakeTaskExecutor(() => now), policy, () => now);
    session = {
      actorId: "operator",
      bridgeId: policy.bridgeId,
      sessionId: policy.sessionId,
      authenticated: true,
      expiresAt: policy.expiresAt,
      capabilities: ["approve_task", "approve_workflow"],
    };
    authority = new LocalTaskAuthority(
      controller,
      () => session,
      () => now,
    );
  });
  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  function receive() {
    const task = adapterTask();
    controller.receive(Buffer.from(JSON.stringify(task)), adapterTaskBytes);
    return task;
  }
  it("binds exact bytes, agent executor, policy, identity, nonce and expiry without activating permissions", async () => {
    const task = receive();
    const grant = await authority.approve(task.request_id);
    expect(grant.task_spec_sha256).toBe(sha256Bytes(Buffer.from(JSON.stringify(task))));
    expect(grant.approver_id).toBe("operator");
    expect(grant.executor_id).toBe(controller.executor.executorId);
    expect(grant.expires_at).toBe("2026-10-03T05:01:00.000Z");
    expect(store.approval(grant.approval_id)).toBeNull();
    controller.approve(task.request_id, grant);
    expect(store.get(task.request_id)?.result.status).toBe("approved");
  });
  it.each(["expiresAt", "bridgeId", "sessionId", "actorId", "capabilities"] as const)(
    "rejects invalid local session %s",
    async (field) => {
      const task = receive();
      if (field === "capabilities") session.capabilities = [];
      else
        session[field] =
          field === "expiresAt"
            ? now.toISOString()
            : field === "actorId"
              ? "not an actor"
              : "invalid";
      await expect(authority.approve(task.request_id)).rejects.toThrow("denied");
    },
  );
  it("does not convert manual approval to persistent policy", () => {
    const task = receive();
    expect(() => authority.evaluatePolicy(task.request_id)).toThrow();
  });
  it("binds workflow only after all exact members are present", () => {
    const task = receive();
    const raw = Buffer.from(
      JSON.stringify({
        protocol_version: "workflow-1",
        workflow_id: randomUUID(),
        jobs: [
          {
            request_id: task.request_id,
            task_spec_sha256: sha256Bytes(Buffer.from(JSON.stringify(task))),
            depends_on: [],
          },
        ],
      }),
    );
    const grant = authority.approveWorkflow(raw);
    expect(grant.manifest_sha256).toBe(sha256Bytes(raw));
    expect(store.workflowJobs(grant.workflow_id)).toEqual([task.request_id]);
  });
  it("rejects revoked deployment policy before grant issuance", async () => {
    const task = receive();
    controller.policy.revoked = true;
    await expect(authority.approve(task.request_id)).rejects.toThrow("revoked");
  });
});
