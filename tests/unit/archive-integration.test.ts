import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactArchive } from "../../src/archive/store.js";
import { runArchiveCli } from "../../src/cli/archive.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { TaskController } from "../../src/state/task-controller.js";
import type { DemoTaskExecutor } from "../../src/ui/demo.js";
import { startUiServer } from "../../src/ui/server.js";
import { openUiService, TaskUiService } from "../../src/ui/service.js";

const host = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../src/adapters/deployment-loader.js", () => ({
  openTrustedDeployment: async () => host.current,
}));
const dirs: string[] = [];
function dir() {
  const path = mkdtempSync(join(tmpdir(), "bridge-archive-integration-"));
  dirs.push(path);
  return path;
}
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function setup(beforeWrite?: (path: string) => void) {
  const state = dir(),
    output = dir();
  const source = await openUiService({ profile: "demo", stateDir: state });
  const archive = new ArtifactArchive({
    stateDirectory: state,
    pathPolicy: beforeWrite ? { beforeWrite } : {},
  });
  archive.configure({
    expectedRevision: 0,
    defaultOutputRoot: output,
    project: { repo: "synthetic-demo", displayName: "demo", outputRoot: null },
  });
  const { store, executor, policy } = source.runtime.controller;
  const controller = new TaskController(
    store,
    executor,
    policy,
    undefined,
    undefined,
    5000,
    undefined,
    archive,
  );
  const service = new TaskUiService(
    { ...source.runtime, controller, archive },
    { profile: "demo" },
  );
  return { service, source, archive, state, output, executor: executor as DemoTaskExecutor };
}
async function terminal(service: TaskUiService) {
  let view = service.createDemo({ title: "PRIVATE user prompt sk-sensitive-content" });
  const id = view.task.result.request_id;
  const bound = () => ({
    taskSpecHash: view.task.result.task_spec_hash,
    taskFileHash: view.task.result.task_file_hash,
    sequence: view.task.result.observation_seq,
  });
  view = await service.approve(id, bound());
  await service.start(id, bound());
  return service.demoObservation(id, "succeeded");
}
describe("archive integration: explicit local actions, synthetic execution only", () => {
  it("pins on import and gates ACK on archive integrity; retry never reexecutes", async () => {
    let fail = true;
    const x = await setup(() => {
      if (fail) throw Object.assign(new Error("disk"), { code: "ENOSPC" });
    });
    try {
      const view = await terminal(x.service),
        id = view.task.result.request_id,
        event = view.task.handshakes.terminal_result;
      if (!event) throw new Error("fixture terminal missing");
      const binding = {
        eventId: event.eventId,
        sequence: event.sequence,
        payloadSha256: event.payloadSha256,
      };
      const original = x.service.resultPayload(id);
      expect(x.archive.pin(id).outputRoot).toBe(x.output);
      await expect(x.service.acknowledge(id, binding)).rejects.toThrow("archive_disk_full");
      expect(x.service.task(id).task.delivery.acknowledged).toBe(false);
      expect(x.executor.starts).toBe(1);
      fail = false;
      await x.service.acknowledge(id, binding);
      await x.service.acknowledge(id, binding);
      expect(x.service.task(id).task.delivery.acknowledged).toBe(true);
      expect(x.executor.starts).toBe(1);
      expect(x.service.resultPayload(id)).toBe(original);
      expect(x.service.inspectArchive(id).state).toBe("complete");
      const bundle = Buffer.from(x.service.exportDiagnostics(id).bytes).toString("utf8");
      expect(bundle).not.toContain("PRIVATE user prompt");
      expect(bundle).not.toContain(x.output);
      expect(bundle).not.toContain("sk-sensitive-content");
      expect(JSON.parse(bundle).content.delivery_ack.observation).toBe("reported");
    } finally {
      x.archive.close();
      x.source.close();
    }
  });
  it("explicit authenticated archive and export endpoints preserve task identity", async () => {
    const x = await setup();
    const view = await terminal(x.service);
    const server = await startUiServer({
      stateDir: x.state,
      profile: "demo",
      runtime: x.service.runtime,
    });
    try {
      const id = view.task.result.request_id;
      const headers = {
        Authorization: `Bearer ${server.token}`,
        "Content-Type": "application/json",
      };
      const denied = await fetch(`${server.origin}/api/archive/settings`);
      expect(denied.status).toBe(401);
      const archived = await fetch(`${server.origin}/api/tasks/${id}/archive`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(archived.status).toBe(200);
      expect(((await archived.json()) as { state: string }).state).toBe("complete");
      const inspection = await fetch(`${server.origin}/api/tasks/${id}/archive`, { headers });
      expect(inspection.status).toBe(200);
      const exported = await fetch(`${server.origin}/api/tasks/${id}/diagnostic-export`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(exported.status).toBe(200);
      const text = await exported.text();
      expect(text).not.toContain("PRIVATE user prompt");
      const bad = await fetch(`${server.origin}/api/archive/settings`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          expectedRevision: 1,
          defaultOutputRoot: x.output,
          unknown: "must reject",
        }),
      });
      expect(bad.status).toBe(400);
      expect(x.executor.starts).toBe(1);
    } finally {
      await server.close();
      x.archive.close();
    }
  });
  it("CLI supports explicit configuration/probe/inspection and a new one-file sanitized export", async () => {
    const x = await setup();
    let stdout = "";
    const print = (s: string) => {
      stdout += s;
    };
    try {
      const view = await terminal(x.service),
        id = view.task.result.request_id;
      await x.service.archiveResult(id);
      // Legacy archive read requires its explicit command; no silent v1-to-v2 migration.
      expect(await runArchiveCli(["legacy-inspect", id, "--state-dir", x.state], print)).toBe(0);
      expect(JSON.parse(stdout).state).toBe("complete");
      stdout = "";
      const out = join(dir(), "diagnostic.json");
      // Trusted host loader is isolated here; actual diagnostic builder and file write are exercised.
      host.current = {
        archiveOperations: { exportDiagnostics: () => x.service.exportDiagnostics(id) },
      };
      expect(
        await runArchiveCli(
          ["export", id, "--deployment", "/synthetic/trusted-module.mjs", "--out", out],
          print,
        ),
      ).toBe(0);
      const bytes = readFileSync(out);
      expect(JSON.parse(stdout).fileSha256).toBe(sha256Bytes(bytes));
      expect(bytes.toString()).not.toContain("PRIVATE user prompt");
      stdout = "";
      expect(
        await runArchiveCli(
          ["export", id, "--deployment", "/synthetic/trusted-module.mjs", "--out", out],
          print,
        ),
      ).toBe(4);
      expect(readFileSync(out)).toEqual(bytes);
      const output = dir(),
        state = dir();
      stdout = "";
      expect(
        await runArchiveCli(
          [
            "configure",
            "--state-dir",
            state,
            "--revision",
            "0",
            "--default-root",
            output,
            "--repo",
            "sample",
            "--name",
            "Sample",
            "--storage-slug",
            "sample",
          ],
          print,
        ),
      ).toBe(0);
      expect(readdirSync(output)).toEqual([]);
      stdout = "";
      expect(await runArchiveCli(["settings", "--state-dir", state], print)).toBe(0);
      expect(JSON.parse(stdout).projects[0].repoId).toBe("sample");
      expect(await runArchiveCli(["probe", "--state-dir", state, "--root", output], print)).toBe(0);
      expect(readdirSync(output)).toEqual([]);
    } finally {
      x.archive.close();
      x.source.close();
    }
  });
});
