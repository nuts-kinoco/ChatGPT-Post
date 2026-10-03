/** Real canonical registry + archive + controller + localhost API; synthetic executor only. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LocalRouteArchive } from "../../src/archive/local-route.js";
import { createArchiveOperations } from "../../src/archive/operations.js";
import { RouteArtifactArchive } from "../../src/archive/route-store.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";
import { TaskController } from "../../src/state/task-controller.js";
import { demoTask } from "../../src/ui/demo.js";
import { startUiServer } from "../../src/ui/server.js";
import { openUiService, TaskUiService } from "../../src/ui/service.js";

it("uses one canonical registry, preserves historical pins, and exports only bound sanitized diagnostics", async () => {
  const state = await mkdtemp(join(tmpdir(), "bridge-ui-archive2-"));
  const root = await mkdtemp(join(tmpdir(), "bridge-ui-output-"));
  const nextRoot = await mkdtemp(join(tmpdir(), "bridge-ui-next-output-"));
  const registry = new ProjectRegistry(join(state, "projects.db"));
  const projectId = randomUUID();
  registry.configure(
    {
      schema: "bridge-project-registry-1",
      revision: 1,
      defaultOutputRoot: root,
      projects: [
        {
          projectId,
          repoId: "synthetic-demo",
          displayName: "Synthetic UI fixture",
          storageSlug: "synthetic-ui",
          githubDestination: null,
          outputRootOverride: null,
        },
      ],
    },
    0,
  );
  const source = await openUiService({ profile: "demo", stateDir: state });
  const archive = new RouteArtifactArchive({ stateDirectory: state, registry });
  const { store, executor, policy } = source.runtime.controller;
  const localArchive = new LocalRouteArchive(archive, store, {
    recipientActorId: policy.bridgeId,
    sessionId: policy.sessionId,
    executorId: executor.executorId,
  });
  const controller = new TaskController(
    store,
    executor,
    policy,
    undefined,
    undefined,
    5000,
    undefined,
    localArchive,
  );
  const service = new TaskUiService({ ...source.runtime, controller }, { profile: "demo" });
  const draft = demoTask({ title: "PRIVATE synthetic content never exported" });
  const record = controller.receive(
    Buffer.from(draft.rawSpec),
    Buffer.from(draft.taskMarkdown),
    null,
    service.authenticatedRequesterId,
    {
      projectRegistration: {
        projectId,
        registryRevision: 1,
        snapshotSha256: registry.snapshotHash(1),
      },
    },
  );
  const id = record.result.request_id;
  let task = service.task(id).task;
  const bound = () => ({
    taskSpecHash: task.result.task_spec_hash,
    taskFileHash: task.result.task_file_hash,
    sequence: task.result.observation_seq,
  });
  task = (await service.approve(id, bound())).task;
  task = (await service.start(id, bound())).task;
  task = (await service.demoObservation(id, "succeeded")).task;
  const server = await startUiServer({
    stateDir: state,
    profile: "demo",
    runtime: service.runtime,
    operationsSources: { registry },
    archiveOperations: createArchiveOperations({ archive, local: controller }),
  });
  const headers = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
  const request = (path: string, value?: unknown) =>
    fetch(`${server.origin}${path}`, {
      headers,
      ...(value === undefined ? {} : { method: "POST", body: JSON.stringify(value) }),
    });
  try {
    expect(await readdir(root)).toEqual([]);
    const update = await request("/api/settings/projects", {
      expectedRevision: 1,
      snapshot: { ...registry.snapshot(), revision: 2, defaultOutputRoot: nextRoot },
    });
    expect({ status: update.status, body: await update.json() }).toMatchObject({ status: 200 });
    expect(registry.currentRevision()).toBe(2);
    expect(archive.pin(id).localPinnedRoot).toBe(root);
    expect(await readdir(nextRoot)).toEqual([]);
    const input = {
      version: "bridge-operations-1",
      binding: { kind: "local_execution", requestId: id, ...bound() },
    };
    const inspected = await request("/api/archive/inspect", input);
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({
      archive: { state: "not_archived", pinnedRoot: root, registryRevision: 1 },
    });
    const bad = await request("/api/archive/collect", {
      ...input,
      binding: { ...input.binding, sequence: input.binding.sequence + 1 },
    });
    expect(bad.status).toBe(409);
    expect(await readdir(root)).toEqual([]);
    const collected = await request("/api/archive/collect", input);
    expect(collected.status).toBe(200);
    expect(await collected.json()).toMatchObject({ archive: { state: "complete" } });
    const exported = await request("/api/archive/export", input);
    expect(exported.status).toBe(200);
    const body = await exported.text();
    expect(body).not.toContain(root);
    expect(body).not.toContain("PRIVATE synthetic content");
    expect(JSON.parse(body).diagnostic.content).toContain("bridge-diagnostic-2");
    expect(service.task(id).task.delivery.acknowledged).toBe(false);
    expect((await request("/api/archive/settings", {})).status).toBe(404);
    expect((await request(`/api/tasks/${id}/archive`, {})).status).toBe(404);
  } finally {
    await server.close();
    archive.close();
    registry.close();
    for (const path of [state, root, nextRoot]) await rm(path, { recursive: true, force: true });
  }
});
