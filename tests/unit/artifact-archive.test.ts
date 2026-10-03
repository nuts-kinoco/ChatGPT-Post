import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archivePath,
  checkedDirectory,
  type PathPolicy,
  portableFilename,
  readOwnedFile,
} from "../../src/archive/paths.js";
import { ArtifactArchive } from "../../src/archive/store.js";
import { sha256Bytes, taskResultArtifactRefs } from "../../src/contracts/task.js";
import type { TaskSpec } from "../../src/contracts/task-types.js";
import type { TaskRecord } from "../../src/state/task-store.js";
import { DemoTaskExecutor } from "../../src/ui/demo.js";
import { openUiService } from "../../src/ui/service.js";

const directories: string[] = [];
const archives: ArtifactArchive[] = [];
const reader = new DemoTaskExecutor();
const readArtifact = reader.readArtifact.bind(reader);
function directory() {
  const p = mkdtempSync(join(tmpdir(), "archive-test-"));
  directories.push(p);
  return p;
}
function create(policy: PathPolicy = {}) {
  const state = directory(),
    output = directory();
  const archive = new ArtifactArchive({ stateDirectory: state, pathPolicy: policy });
  archives.push(archive);
  archive.configure({
    expectedRevision: 0,
    defaultOutputRoot: output,
    project: { repo: "synthetic-demo", displayName: "../../CON: 日本語", outputRoot: null },
  });
  return { archive, state, output };
}
async function record(): Promise<TaskRecord> {
  const state = directory();
  const service = await openUiService({ profile: "demo", stateDir: state });
  try {
    let view = service.createDemo({ title: "PRIVATE PROMPT NEVER EXPORT" });
    const bound = () => ({
      taskSpecHash: view.task.result.task_spec_hash,
      taskFileHash: view.task.result.task_file_hash,
      sequence: view.task.result.observation_seq,
    });
    view = await service.approve(view.task.summary.requestId, bound());
    view = await service.start(view.task.summary.requestId, bound());
    view = await service.demoObservation(view.task.summary.requestId, "succeeded");
    const value = service.runtime.store.get(view.task.summary.requestId);
    if (!value) throw new Error("fixture missing");
    return value;
  } finally {
    service.close();
  }
}
function reserve(archive: ArtifactArchive, value: TaskRecord) {
  return archive.reserve(JSON.parse(value.rawSpec) as TaskSpec, value.result.task_spec_hash);
}
afterEach(() => {
  for (const a of archives.splice(0)) a.close();
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("artifact archive: real private temp storage, no model/provider", () => {
  it("configures without writing output, pins stable project IDs, archives and verifies exact bytes", async () => {
    const { archive, output } = create();
    expect(readdirSync(output)).toEqual([]);
    const value = await record(),
      pin = reserve(archive, value);
    expect(readdirSync(output)).toEqual([]);
    expect(pin.relativeDirectory).not.toContain("CON");
    const result = await archive.archive(value, readArtifact);
    expect(result.state).toBe("complete");
    expect(result.manifest?.entries).toHaveLength(4);
    expect(result.manifest?.synthetic).toBe(true);
    expect(result.manifestSha256).toBe(
      sha256Bytes(readFileSync(join(output, pin.relativeDirectory, "manifest.json"))),
    );
    expect(await archive.archive(value, readArtifact)).toEqual(result);
    expect(archive.inspect(value.result.request_id).state).toBe("complete");
  });
  it("root changes only affect new requests, including per-project overrides", async () => {
    const { archive, output } = create();
    const first = await record();
    const p1 = reserve(archive, first);
    const secondRoot = directory();
    archive.configure({ expectedRevision: 1, defaultOutputRoot: secondRoot });
    expect(reserve(archive, first)).toEqual(p1);
    const second = await record();
    expect(reserve(archive, second).outputRoot).toBe(secondRoot);
    const thirdRoot = directory();
    const project = archive.settings().projects[0];
    if (!project) throw new Error("project missing");
    archive.configure({ expectedRevision: 2, project: { ...project, outputRoot: thirdRoot } });
    expect(reserve(archive, await record()).outputRoot).toBe(thirdRoot);
    await archive.archive(first, readArtifact);
    expect(existsSync(join(output, p1.relativeDirectory))).toBe(true);
    expect(readdirSync(secondRoot)).toEqual([]);
    expect(readdirSync(thirdRoot)).toEqual([]);
  });
  it("rejects stale config and identity collision without changing registry", async () => {
    const { archive } = create(),
      value = await record();
    reserve(archive, value);
    expect(() =>
      archive.configure({ expectedRevision: 0, defaultOutputRoot: directory() }),
    ).toThrow("archive_settings_stale");
    expect(() => archive.reserve(JSON.parse(value.rawSpec) as TaskSpec, "f".repeat(64))).toThrow(
      "archive_request_conflict",
    );
    expect(() =>
      archive.configure({
        expectedRevision: 1,
        project: {
          repo: "synthetic-demo",
          projectId: randomUUID(),
          displayName: "new",
          outputRoot: null,
        },
      }),
    ).toThrow("archive_project_conflict");
  });
  it("missing drives and read-only permission probes fail without marking completion", () => {
    let failure = "";
    const { archive, output } = create({
      beforeWrite: () => {
        if (failure) throw Object.assign(new Error("private path omitted"), { code: failure });
      },
    });
    expect(() =>
      archive.configure({ expectedRevision: 1, defaultOutputRoot: join(output, "missing-drive") }),
    ).toThrow();
    for (const code of ["EACCES", "EPERM", "EROFS", "ENOSPC"]) {
      failure = code;
      expect(() => archive.probe(output, "probe_output_root")).toThrow(
        code === "ENOSPC" ? "archive_disk_full" : "archive_permission_denied",
      );
      expect(readdirSync(output)).toEqual([]);
    }
    failure = "";
    expect(archive.probe(output, "probe_output_root")).toEqual({ writable: true, cleaned: true });
    expect(readdirSync(output)).toEqual([]);
  });
  it("disk-full halfway rolls back staged files and permits archive retry", async () => {
    let writes = 0,
      fail = true;
    const { archive, output } = create({
      beforeWrite: () => {
        if (++writes === 2 && fail) throw Object.assign(new Error("disk"), { code: "ENOSPC" });
      },
    });
    const value = await record(),
      pin = reserve(archive, value);
    await expect(archive.archive(value, readArtifact)).rejects.toThrow("archive_disk_full");
    expect(archive.inspect(value.result.request_id).state).toBe("not_archived");
    expect(existsSync(join(output, pin.relativeDirectory))).toBe(false);
    expect(
      readdirSync(join(output, pin.relativeDirectory, "..")).filter((x) => x.startsWith("staging")),
    ).toEqual([]);
    fail = false;
    expect((await archive.archive(value, readArtifact)).state).toBe("complete");
  });
  it("corrupt, partial and missing archived content never appears complete and is never overwritten", async () => {
    const { archive, output } = create();
    const value = await record(),
      pin = reserve(archive, value);
    await archive.archive(value, readArtifact);
    const task = join(output, pin.relativeDirectory, "instructions/task.md");
    writeFileSync(task, "partial", { mode: 0o600 });
    expect(archive.inspect(value.result.request_id).state).toBe("corrupt");
    await expect(archive.archive(value, readArtifact)).rejects.toThrow(
      "archive_content_hash_mismatch",
    );
    expect(readFileSync(task, "utf8")).toBe("partial");
    rmSync(task);
    expect(archive.inspect(value.result.request_id).state).toBe("unavailable");
  });
  it("root disconnection preserves pinned references and recovers when the same directory returns", async () => {
    const { archive, output } = create();
    const value = await record();
    reserve(archive, value);
    await archive.archive(value, readArtifact);
    const moved = `${output}-offline`;
    renameSync(output, moved);
    try {
      expect(archive.inspect(value.result.request_id).state).toBe("unavailable");
    } finally {
      renameSync(moved, output);
    }
    expect(archive.inspect(value.result.request_id).state).toBe("complete");
  });
  it("rejects existing partial destinations and never overwrites collisions", async () => {
    const { archive, output } = create();
    const value = await record(),
      pin = reserve(archive, value);
    const target = join(output, pin.relativeDirectory);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(join(target, "untouched.txt"), "keep", { mode: 0o600 });
    await expect(archive.archive(value, readArtifact)).rejects.toThrow();
    expect(readFileSync(join(target, "untouched.txt"), "utf8")).toBe("keep");
    expect(archive.inspect(value.result.request_id).state).toBe("not_archived");
  });
  it("rejects symlink roots, ancestor links, artifact links and hard-linked files", async () => {
    const { archive, output } = create();
    const elsewhere = directory();
    const rootLink = join(output, "link");
    symlinkSync(elsewhere, rootLink, "dir");
    expect(() => checkedDirectory(rootLink)).toThrow("archive_path_not_owned");
    expect(() => checkedDirectory(join(rootLink, "nested"))).toThrow();
    const value = await record(),
      pin = reserve(archive, value);
    await archive.archive(value, readArtifact);
    const task = join(output, pin.relativeDirectory, "instructions/task.md");
    rmSync(task);
    symlinkSync(join(elsewhere, "secret"), task);
    expect(archive.inspect(value.result.request_id).state).toBe("corrupt");
  });
  it("rejects unsafe roots and unverified Windows ownership/reparse policy", () => {
    const p = directory();
    chmodSync(p, 0o777);
    expect(() => checkedDirectory(p)).toThrow("archive_ancestor_untrusted");
    chmodSync(p, 0o700);
    expect(() => checkedDirectory(p, { platform: "win32" })).toThrow(
      "archive_windows_storage_unimplemented",
    );
  });
  it.each([
    "CON",
    "con.txt",
    "NUL.log",
    "COM1",
    "lpt9.json",
    "aux",
    "a.",
    "../file",
    "a:b",
    "a\\b",
    "a/..",
    "a ",
    "file.txt\n",
    "CON\n",
    "",
  ])("rejects nonportable filename %s", (name) => expect(() => portableFilename(name)).toThrow());
  it.each(["../file", "/tmp/file", "C:\\file", "a/../b", "a//b", "a\\b", "a/NUL.txt"])(
    "rejects path escape %s",
    (path) => expect(() => archivePath(directory(), path)).toThrow(),
  );
  it("read-only archive open neither creates a missing database nor mutates existing config", () => {
    const missing = directory();
    expect(() => new ArtifactArchive({ stateDirectory: missing, readOnly: true })).toThrow();
    expect(readdirSync(missing)).toEqual([]);
    const { archive, state } = create();
    const reader = new ArtifactArchive({ stateDirectory: state, readOnly: true });
    try {
      expect(reader.settings()).toEqual(archive.settings());
      expect(() =>
        reader.configure({ expectedRevision: 1, defaultOutputRoot: directory() }),
      ).toThrow();
    } finally {
      reader.close();
    }
  });
  it("artifact hash and declared size failures do not publish partial results", async () => {
    const { archive, output } = create();
    const value = await record();
    const pin = reserve(archive, value);
    await expect(archive.archive(value, async () => Buffer.from("tampered"))).rejects.toThrow(
      "archive_artifact_hash_mismatch",
    );
    expect(archive.inspect(value.result.request_id).state).toBe("not_archived");
    expect(existsSync(join(output, pin.relativeDirectory))).toBe(false);
    const ref = taskResultArtifactRefs(value.result)[0];
    if (!ref) throw new Error("fixture evidence missing");
    ref.size_bytes = 128 * 1024 * 1024;
    let reads = 0;
    await expect(
      archive.archive(value, async () => {
        reads++;
        return new Uint8Array();
      }),
    ).rejects.toThrow();
    expect(reads).toBe(0);
    expect(readdirSync(output)).toEqual([]);
  });
  it("hard-linked archive files are rejected even when their bytes match", () => {
    const p = directory(),
      original = join(p, "original"),
      linked = join(p, "linked");
    writeFileSync(original, "same", { mode: 0o600 });
    linkSync(original, linked);
    expect(() => readOwnedFile(linked, 10)).toThrow("archive_file_unsafe");
  });
  it("bounded reads reject large or non-private input without returning bytes", () => {
    const p = directory(),
      f = join(p, "file");
    writeFileSync(f, "1234", { mode: 0o600 });
    expect(() => readOwnedFile(f, 3)).toThrow("archive_file_unsafe");
    chmodSync(f, 0o644);
    expect(() => readOwnedFile(f, 10)).toThrow("archive_file_unsafe");
  });
});
