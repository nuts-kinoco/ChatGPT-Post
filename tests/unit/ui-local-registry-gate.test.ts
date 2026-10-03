import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalEnvelope } from "../../src/contracts/task-types.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";
import { TaskController } from "../../src/state/task-controller.js";
import { demoTask } from "../../src/ui/demo.js";
import { openUiService, TaskUiService } from "../../src/ui/service.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const state = await mkdtemp(join(tmpdir(), "ui-pin-gate-")),
    base = await openUiService({ stateDir: state, profile: "production" }),
    registry = new ProjectRegistry(join(state, "projects.db"));
  cleanup.push(async () => {
    base.close();
    registry.close();
    await rm(state, { recursive: true, force: true });
  });
  const projectId = randomUUID();
  registry.configure(
    {
      schema: "bridge-project-registry-1",
      revision: 1,
      defaultOutputRoot: null,
      projects: [
        {
          projectId,
          repoId: "synthetic-demo",
          storageSlug: "synthetic",
          displayName: "Fixture",
          githubDestination: null,
          outputRootOverride: null,
        },
      ],
    },
    0,
  );
  const original = base.runtime.controller.executor;
  // Test-only registered wrapper: every execution operation still rejects through UnavailableTaskExecutor.
  const executor = {
    executorId: original.executorId,
    synthetic: false,
    checkCapabilities: original.checkCapabilities.bind(original),
    start: original.start.bind(original),
    status: original.status.bind(original),
    cancel: original.cancel.bind(original),
    collect: original.collect.bind(original),
    readArtifact: original.readArtifact.bind(original),
  };
  const controller = new TaskController(
    base.runtime.store,
    executor,
    base.runtime.controller.policy,
  );
  const authority = { approve: vi.fn(async () => ({}) as ApprovalEnvelope) };
  const service = new TaskUiService(
    {
      ...base.runtime,
      controller,
      authority,
      capabilities: { approve: true, start: true, cancel: true, reconcile: true },
      projectRegistry: registry,
    },
    { profile: "production" },
  );
  const draft = demoTask({}),
    receive = (pinned: boolean) =>
      controller.receive(
        Buffer.from(draft.rawSpec),
        Buffer.from(draft.taskMarkdown),
        null,
        service.authenticatedRequesterId,
        pinned
          ? {
              projectRegistration: {
                projectId,
                registryRevision: 1,
                snapshotSha256: registry.snapshotHash(1),
              },
            }
          : {},
      );
  return { service, authority, registry, draft, receive };
}
const binding = (f: Awaited<ReturnType<typeof fixture>>) => {
  const task = f.service.task(JSON.parse(f.draft.rawSpec).request_id).task;
  return {
    taskSpecHash: task.result.task_spec_hash,
    taskFileHash: task.result.task_file_hash,
    sequence: task.result.observation_seq,
  };
};
describe("legacy local API cannot bypass canonical project gates", () => {
  it("keeps raw non-synthetic imports inspection-only while retaining cancel", async () => {
    const f = await fixture(),
      record = f.receive(false),
      id = record.result.request_id;
    expect(f.service.task(id).task.capabilities.approve.enabled).toBe(false);
    await expect(f.service.approve(id, binding(f))).rejects.toThrow("historical project");
    await expect(f.service.start(id, binding(f))).rejects.toThrow("historical project");
    expect(f.authority.approve).not.toHaveBeenCalled();
    expect(f.service.task(id).task.capabilities.cancel.enabled).toBe(true);
    await f.service.cancel(id);
    expect(f.service.task(id).task.result.status).toBe("cancelled");
  });
  it("validates historical reference rather than substituting current settings", async () => {
    const f = await fixture(),
      record = f.receive(true),
      id = record.result.request_id;
    const before = f.registry.snapshot();
    f.registry.configure(
      {
        ...before,
        revision: 2,
        projects: before.projects.map((p) => ({ ...p, displayName: "Renamed" })),
      },
      1,
    );
    expect(f.service.task(id).task.capabilities.approve.enabled).toBe(true);
    expect(() =>
      f.service.bindProjectRegistry({
        resolve: f.registry.resolve.bind(f.registry),
        snapshotHash: f.registry.snapshotHash.bind(f.registry),
      }),
    ).toThrow("one canonical registry");
    vi.spyOn(f.registry, "snapshotHash").mockReturnValue("f".repeat(64));
    expect(f.service.task(id).task.capabilities.approve.enabled).toBe(false);
  });
  it("rechecks historical registration after an awaited grant", async () => {
    const f = await fixture(),
      record = f.receive(true),
      id = record.result.request_id;
    let release!: (value: ApprovalEnvelope) => void;
    f.authority.approve.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.service.approve(id, binding(f));
    const rejected = expect(pending).rejects.toThrow("historical project");
    await vi.waitFor(() => expect(f.authority.approve).toHaveBeenCalledTimes(1));
    vi.spyOn(f.registry, "snapshotHash").mockReturnValue("f".repeat(64));
    release({} as ApprovalEnvelope);
    await rejected;
    expect(f.service.task(id).task.result.status).toBe("awaiting_approval");
  });
  it("rejects a late grant and new dispatch after UI shutdown begins", async () => {
    const f = await fixture(),
      record = f.receive(true),
      id = record.result.request_id;
    let release!: (value: ApprovalEnvelope) => void;
    f.authority.approve.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.service.approve(id, binding(f));
    const rejected = expect(pending).rejects.toThrow("shutdown");
    await vi.waitFor(() => expect(f.authority.approve).toHaveBeenCalledTimes(1));
    f.service.beginShutdown();
    release({} as ApprovalEnvelope);
    await rejected;
    await expect(f.service.start(id, binding(f))).rejects.toThrow("shutdown");
    expect(f.service.task(id).task.result.status).toBe("awaiting_approval");
  });
});
