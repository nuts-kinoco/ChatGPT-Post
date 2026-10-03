import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sha256Bytes } from "../../src/contracts/task.js";
import { UiArchiveApi } from "../../src/ui/archive-api.js";
import { buildUiOperationsSources } from "../../src/ui/deployment-operations.js";
import { UiOperationsService } from "../../src/ui/operations.js";
import { openUiService, type TaskUiService } from "../../src/ui/service.js";

const resources: { path: string; service: TaskUiService }[] = [];
afterEach(async () => {
  for (const r of resources.splice(0)) {
    r.service.close();
    await rm(r.path, { recursive: true, force: true });
  }
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "bridge-archive-ui-")),
    service = await openUiService({ stateDir: path, profile: "demo" });
  resources.push({ path, service });
  const task = service.createDemo({});
  const operationService = new UiOperationsService(buildUiOperationsSources(service));
  const id = task.task.summary.requestId;
  const binding = {
    kind: "local_execution" as const,
    requestId: id,
    taskSpecHash: task.task.result.task_spec_hash,
    taskFileHash: task.task.result.task_file_hash,
    sequence: task.task.result.observation_seq,
  };
  const content = { synthetic: true },
    contentSha256 = sha256Bytes(Buffer.from(JSON.stringify(content)));
  const bytes = Buffer.from(
    JSON.stringify({ schema: "bridge-diagnostic-2", content_sha256: contentSha256, content }) +
      "\n",
  );
  const inspect = vi.fn(() => ({
    schema: "archive-inspection-2",
    state: "not_archived",
    pin: {
      requestId: id,
      localPinnedRoot: "/synthetic/private-root",
      relativeDirectory: "projects/synthetic/requests/id",
      registryRevision: 1,
      projectId: "synthetic",
    },
    manifest: null,
    manifestSha256: null,
    issue: null,
    reexecute: false,
  }));
  const port = {
    inspect,
    collect: vi.fn(async () => {}),
    exportDiagnostics: vi.fn(() => ({ bytes, sha256: sha256Bytes(bytes), contentSha256 })),
    probe: vi.fn(() => ({ writable: true, cleaned: true })),
  };
  return {
    api: new UiArchiveApi(operationService, port),
    port,
    binding,
    input: { version: "bridge-operations-1", binding },
  };
}
it("projects only bound archive metadata and keeps private root out of sanitized export", async () => {
  const f = await fixture();
  expect(await f.api.inspect(f.input)).toMatchObject({
    state: "not_archived",
    pinnedRoot: "/synthetic/private-root",
    reexecute: false,
  });
  const exported = await f.api.export(f.input);
  expect(exported.content).not.toContain("private-root");
  expect(exported.sha256).toBe(sha256Bytes(Buffer.from(exported.content)));
  expect(f.port.collect).not.toHaveBeenCalled();
});
it("rejects stale job hashes/sequences before archive reads or writes", async () => {
  const f = await fixture();
  await expect(
    f.api.inspect({ ...f.input, binding: { ...f.binding, sequence: f.binding.sequence + 1 } }),
  ).rejects.toThrow("binding changed");
  await expect(
    f.api.export({ ...f.input, binding: { ...f.binding, taskSpecHash: "f".repeat(64) } }),
  ).rejects.toThrow("binding changed");
  expect(f.port.inspect).not.toHaveBeenCalled();
  expect(f.port.exportDiagnostics).not.toHaveBeenCalled();
});
it("probes only explicit absolute roots and never implicitly while viewing", async () => {
  const f = await fixture();
  await f.api.inspect(f.input);
  expect(f.port.probe).not.toHaveBeenCalled();
  for (const value of [{ root: "relative" }, { root: "/synthetic", command: "invalid" }])
    await expect(f.api.probe(value)).rejects.toThrow();
  expect(await f.api.probe({ root: "/synthetic" })).toMatchObject({
    writable: true,
    cleaned: true,
    executionAuthority: false,
  });
  expect(f.port.probe).toHaveBeenCalledTimes(1);
});
it("rejects corrupt diagnostic bytes and unknown export schemas", async () => {
  const f = await fixture();
  f.port.exportDiagnostics = vi.fn(() => ({
    bytes: Buffer.from("{}"),
    sha256: "a".repeat(64),
    contentSha256: "b".repeat(64),
  }));
  const fresh = await fixture();
  fresh.port.exportDiagnostics.mockImplementation(() => ({
    bytes: Buffer.from("{}"),
    sha256: sha256Bytes(Buffer.from("{}")),
    contentSha256: "b".repeat(64),
  }));
  await expect(f.api.export(f.input)).rejects.toThrow("integrity");
  await expect(fresh.api.export(fresh.input)).rejects.toThrow("digest");
});
