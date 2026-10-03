/** Private host-local registry and immutable archive. Never reads model-provided filesystem paths. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  loadTaskSpec,
  parseStrictJsonBytes,
  serializeTaskResult,
  sha256Bytes,
  taskResultArtifactRefs,
  validateTaskResult,
  verifyTaskFileBytes,
} from "../contracts/task.js";
import type { ArtifactRef, TaskSpec } from "../contracts/task-types.js";
import type { TaskRecord } from "../state/task-store.js";
import {
  archivePath,
  checkedDirectory,
  ensureOwnedDirectory,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_FILE_BYTES,
  MAX_ARCHIVE_TOTAL_BYTES,
  type PathPolicy,
  portableFilename,
  probeOutputRoot,
  readOwnedFile,
  writeNewFile,
} from "./paths.js";
import { exact } from "./route-validation.js";
import {
  type ArchiveEntry,
  ArchiveError,
  type ArchiveInspection,
  type ArchiveManifest,
  type ArchivePin,
  type TaskArchivePort,
} from "./types.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
const HASH = /^[a-f0-9]{64}(?![\s\S])/;
export interface ArchiveProject {
  projectId: string;
  repo: string;
  displayName: string;
  outputRoot: string | null;
}
export interface ArchiveSettings {
  revision: number;
  defaultOutputRoot: string | null;
  projects: ArchiveProject[];
}
export interface ArchiveStoreOptions {
  stateDirectory: string;
  pathPolicy?: PathPolicy;
  readOnly?: boolean;
}
function errorCode(error: unknown): string {
  if (error instanceof ArchiveError) return error.code;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT"
    ? "archive_path_missing"
    : code === "ENOSPC"
      ? "archive_disk_full"
      : code === "EACCES" || code === "EPERM" || code === "EROFS"
        ? "archive_permission_denied"
        : "archive_io_failed";
}
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export class ArtifactArchive implements TaskArchivePort {
  private readonly db: DatabaseSync;
  readonly pathPolicy: PathPolicy;
  private readonly pending = new Map<string, Promise<ArchiveInspection>>();
  constructor(options: ArchiveStoreOptions) {
    this.pathPolicy = options.pathPolicy ?? {};
    checkedDirectory(options.stateDirectory, this.pathPolicy, true);
    const path = join(options.stateDirectory, "artifact-archive.db");
    if (!options.readOnly) {
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    readOwnedFile(path, 512 * 1024 * 1024, this.pathPolicy);
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    if (options.readOnly) return;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS archive_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, root TEXT);
      INSERT OR IGNORE INTO archive_settings VALUES (1,0,NULL);
      CREATE TABLE IF NOT EXISTS archive_projects (project_id TEXT PRIMARY KEY, repo TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, root TEXT);
      CREATE TABLE IF NOT EXISTS archive_pins (request_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_manifests (request_id TEXT PRIMARY KEY, body TEXT NOT NULL, hash TEXT NOT NULL);`);
  }
  close(): void {
    this.db.close();
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  settings(): ArchiveSettings {
    const row = this.db.prepare("SELECT revision,root FROM archive_settings WHERE id=1").get();
    return {
      revision: Number(row?.revision),
      defaultOutputRoot: row?.root === null ? null : String(row?.root),
      projects: this.db
        .prepare(
          "SELECT project_id,repo,display_name,root FROM archive_projects ORDER BY project_id",
        )
        .all()
        .map((p) => ({
          projectId: String(p.project_id),
          repo: String(p.repo),
          displayName: String(p.display_name),
          outputRoot: p.root === null ? null : String(p.root),
        })),
    };
  }
  /** Explicit local settings action; validates existence/ownership without writing to that root. */
  configure(input: {
    expectedRevision: number;
    defaultOutputRoot?: string;
    project?: { projectId?: string; repo: string; displayName: string; outputRoot: string | null };
  }): ArchiveSettings {
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      (!input.defaultOutputRoot && !input.project)
    )
      throw new ArchiveError("archive_settings_invalid");
    if (input.defaultOutputRoot) checkedDirectory(input.defaultOutputRoot, this.pathPolicy);
    const p = input.project;
    if (p) {
      if (
        !/^[a-z][a-z0-9_-]{0,63}(?![\s\S])/.test(p.repo) ||
        !p.displayName ||
        p.displayName.length > 120 ||
        [...p.displayName].some((c) => c.charCodeAt(0) < 32) ||
        (p.projectId !== undefined && !UUID.test(p.projectId))
      )
        throw new ArchiveError("archive_project_invalid");
      if (p.outputRoot !== null) checkedDirectory(p.outputRoot, this.pathPolicy);
    }
    return this.transaction(() => {
      if (this.settings().revision !== input.expectedRevision)
        throw new ArchiveError("archive_settings_stale");
      if (input.defaultOutputRoot)
        this.db
          .prepare("UPDATE archive_settings SET root=? WHERE id=1")
          .run(input.defaultOutputRoot);
      if (p) {
        const existing = this.db
          .prepare("SELECT project_id,repo FROM archive_projects WHERE repo=? OR project_id=?")
          .all(p.repo.toLowerCase(), p.projectId ?? "");
        if (
          existing.length > 1 ||
          (existing[0] &&
            (existing[0].repo !== p.repo.toLowerCase() ||
              (p.projectId && p.projectId !== existing[0].project_id)))
        )
          throw new ArchiveError("archive_project_conflict");
        const id = existing[0] ? String(existing[0].project_id) : (p.projectId ?? randomUUID());
        this.db
          .prepare(
            "INSERT INTO archive_projects VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET display_name=excluded.display_name,root=excluded.root",
          )
          .run(id, p.repo.toLowerCase(), p.displayName, p.outputRoot);
      }
      this.db.prepare("UPDATE archive_settings SET revision=revision+1 WHERE id=1").run();
      return this.settings();
    });
  }
  probe(root: string, userAction: "probe_output_root"): { writable: true; cleaned: true } {
    if (userAction !== "probe_output_root")
      throw new ArchiveError("archive_explicit_action_required");
    try {
      return probeOutputRoot(root, this.pathPolicy);
    } catch (error) {
      throw new ArchiveError(errorCode(error), true);
    }
  }
  reserve(
    task: TaskSpec,
    taskSpecHash: string,
    context?: { acceptedPreviously: boolean },
  ): ArchivePin {
    if (!UUID.test(task.request_id) || !HASH.test(taskSpecHash))
      throw new ArchiveError("archive_identity_invalid");
    return this.transaction(() => {
      const old = this.db
        .prepare("SELECT body FROM archive_pins WHERE request_id=?")
        .get(task.request_id);
      if (old) {
        const pin = JSON.parse(String(old.body)) as ArchivePin;
        if (pin.taskSpecHash !== taskSpecHash) throw new ArchiveError("archive_request_conflict");
        return pin;
      }
      if (context?.acceptedPreviously) throw new ArchiveError("archive_legacy_admission_unpinned");
      const p = this.settings().projects.find((p) => p.repo === task.repo.toLowerCase());
      if (!p) throw new ArchiveError("archive_project_unregistered");
      const root = p.outputRoot ?? this.settings().defaultOutputRoot;
      if (!root) throw new ArchiveError("archive_root_unconfigured");
      checkedDirectory(root, this.pathPolicy);
      const pin: ArchivePin = {
        schema: "archive-pin-1",
        requestId: task.request_id,
        taskSpecHash,
        projectId: p.projectId,
        outputRoot: root,
        relativeDirectory: `ChatGPT-Bridge/projects/${p.projectId}/requests/${task.request_id}`,
      };
      this.db
        .prepare("INSERT INTO archive_pins VALUES (?,?)")
        .run(task.request_id, JSON.stringify(pin));
      return pin;
    });
  }
  pin(requestId: string): ArchivePin {
    const row = this.db.prepare("SELECT body FROM archive_pins WHERE request_id=?").get(requestId);
    if (!row) throw new ArchiveError("archive_pin_missing");
    return JSON.parse(String(row.body)) as ArchivePin;
  }
  inspect(requestId: string): ArchiveInspection {
    const pin = this.pin(requestId);
    const row = this.db
      .prepare("SELECT body,hash FROM archive_manifests WHERE request_id=?")
      .get(requestId);
    const base = {
      pin,
      manifest: null,
      manifestSha256: null,
      issue: null,
      reexecute: false as const,
    };
    if (!row) return { ...base, state: "not_archived" };
    try {
      const text = String(row.body),
        digest = String(row.hash);
      if (hash(text) !== digest) throw new ArchiveError("archive_manifest_hash_mismatch");
      const manifest = parseStrictJsonBytes(Buffer.from(text)) as ArchiveManifest;
      this.verify(pin, manifest, text);
      return { ...base, state: "complete", manifest, manifestSha256: digest };
    } catch (error) {
      const code = errorCode(error);
      return {
        ...base,
        state: ["archive_path_missing", "archive_permission_denied", "archive_io_failed"].includes(
          code,
        )
          ? "unavailable"
          : "corrupt",
        issue: code,
      };
    }
  }
  private verify(pin: ArchivePin, manifest: ArchiveManifest, text: string): void {
    exact(manifest, [
      "schema",
      "requestId",
      "taskSpecHash",
      "runId",
      "projectId",
      "localPinnedRoot",
      "relativeDirectory",
      "resultSha256",
      "synthetic",
      "completeness",
      "entries",
    ]);
    if (
      manifest.schema !== "artifact-archive-1" ||
      manifest.requestId !== pin.requestId ||
      manifest.taskSpecHash !== pin.taskSpecHash ||
      manifest.projectId !== pin.projectId ||
      manifest.localPinnedRoot !== pin.outputRoot ||
      manifest.relativeDirectory !== pin.relativeDirectory ||
      manifest.completeness !== "complete" ||
      !Array.isArray(manifest.entries) ||
      manifest.entries.length > MAX_ARCHIVE_ENTRIES
    )
      throw new ArchiveError("archive_manifest_invalid");
    const root = archivePath(pin.outputRoot, pin.relativeDirectory);
    const stored = readOwnedFile(
      join(root, "manifest.json"),
      MAX_ARCHIVE_FILE_BYTES,
      this.pathPolicy,
    );
    if (!stored.equals(Buffer.from(text))) throw new ArchiveError("archive_manifest_hash_mismatch");
    let total = 0;
    const seen = new Set<string>();
    for (const entry of manifest.entries) {
      exact(entry, [
        "logicalName",
        "filename",
        "relativePath",
        "contentSha256",
        "sizeBytes",
        "artifactId",
        "complete",
      ]);
      if (
        !HASH.test(entry.contentSha256) ||
        !Number.isSafeInteger(entry.sizeBytes) ||
        entry.sizeBytes < 0 ||
        entry.sizeBytes > MAX_ARCHIVE_FILE_BYTES ||
        entry.complete !== true ||
        seen.has(entry.relativePath.toLowerCase()) ||
        entry.filename !== entry.relativePath.split("/").at(-1)
      )
        throw new ArchiveError("archive_manifest_invalid");
      seen.add(entry.relativePath.toLowerCase());
      total += entry.sizeBytes;
      if (total > MAX_ARCHIVE_TOTAL_BYTES) throw new ArchiveError("archive_size_limit");
      const bytes = readOwnedFile(
        archivePath(root, entry.relativePath),
        MAX_ARCHIVE_FILE_BYTES,
        this.pathPolicy,
      );
      if (bytes.byteLength !== entry.sizeBytes || sha256Bytes(bytes) !== entry.contentSha256)
        throw new ArchiveError("archive_content_hash_mismatch");
    }
  }
  async archive(
    record: TaskRecord,
    readArtifact: (ref: ArtifactRef) => Promise<Uint8Array>,
  ): Promise<ArchiveInspection> {
    const id = record.result.request_id;
    const old = this.pending.get(id);
    if (old) return old;
    const work = this.writeArchive(structuredClone(record), readArtifact);
    this.pending.set(id, work);
    try {
      return await work;
    } finally {
      if (this.pending.get(id) === work) this.pending.delete(id);
    }
  }
  private async writeArchive(
    record: TaskRecord,
    readArtifact: (ref: ArtifactRef) => Promise<Uint8Array>,
  ): Promise<ArchiveInspection> {
    const pin = this.pin(record.result.request_id);
    const parsed = loadTaskSpec(Buffer.from(record.rawSpec), pin.taskSpecHash);
    const taskBytes = Buffer.from(record.taskBytesBase64, "base64");
    if (
      !parsed.valid ||
      !verifyTaskFileBytes(parsed.task, taskBytes).valid ||
      !validateTaskResult(record.result, { task: parsed.task, taskSpecHash: pin.taskSpecHash })
        .valid ||
      !["succeeded", "failed", "cancelled"].includes(record.result.status)
    )
      throw new ArchiveError("archive_terminal_record_invalid");
    const resultBytes = Buffer.from(serializeTaskResult(record.result));
    const previous = this.inspect(pin.requestId);
    if (previous.state === "complete") {
      if (previous.manifest?.resultSha256 !== sha256Bytes(resultBytes))
        throw new ArchiveError("archive_result_conflict");
      return previous;
    }
    if (previous.state !== "not_archived")
      throw new ArchiveError(previous.issue ?? "archive_corrupt");
    const files: { entry: ArchiveEntry; bytes: Uint8Array }[] = [];
    const add = (
      logicalName: string,
      relativePath: string,
      bytes: Uint8Array,
      artifactId: string | null = null,
    ) => {
      const filename = portableFilename(relativePath.split("/").at(-1) ?? "");
      if (
        bytes.byteLength > MAX_ARCHIVE_FILE_BYTES ||
        files.length >= MAX_ARCHIVE_ENTRIES ||
        files.reduce((n, f) => n + f.bytes.byteLength, 0) + bytes.byteLength >
          MAX_ARCHIVE_TOTAL_BYTES
      )
        throw new ArchiveError("archive_size_limit");
      files.push({
        entry: {
          logicalName,
          filename,
          relativePath,
          contentSha256: sha256Bytes(bytes),
          sizeBytes: bytes.byteLength,
          artifactId,
          complete: true,
        },
        bytes: Uint8Array.from(bytes),
      });
    };
    add("task_spec", "instructions/TaskSpec.json", Buffer.from(record.rawSpec));
    add("task_markdown", "instructions/task.md", taskBytes);
    add("terminal_result", "results/result.json", resultBytes);
    const refsById = new Map<string, ArtifactRef>();
    for (const ref of taskResultArtifactRefs(record.result)) {
      const prior = refsById.get(ref.artifact_id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(ref))
        throw new ArchiveError("archive_artifact_identity_conflict");
      refsById.set(ref.artifact_id, ref);
    }
    const refs = [...refsById.values()];
    if (
      refs.length + files.length > MAX_ARCHIVE_ENTRIES ||
      refs.some((r) => r.size_bytes > MAX_ARCHIVE_FILE_BYTES) ||
      refs.reduce((n, r) => n + r.size_bytes, 0) > MAX_ARCHIVE_TOTAL_BYTES
    )
      throw new ArchiveError("archive_size_limit");
    for (const ref of refs) {
      const bytes = await readArtifact(ref);
      if (bytes.byteLength !== ref.size_bytes || sha256Bytes(bytes) !== ref.sha256)
        throw new ArchiveError("archive_artifact_hash_mismatch", true);
      const isLog =
        ref.artifact_id === record.result.stdout_ref?.artifact_id ||
        ref.artifact_id === record.result.stderr_ref?.artifact_id ||
        record.result.commands_run.some(
          (c) =>
            c.stdout_ref?.artifact_id === ref.artifact_id ||
            c.stderr_ref?.artifact_id === ref.artifact_id,
        );
      add(
        `artifact:${ref.artifact_id}`,
        `${isLog ? "logs" : "artifacts"}/artifact-${hash(ref.artifact_id)}.bin`,
        bytes,
        ref.artifact_id,
      );
    }
    const manifest: ArchiveManifest = {
      schema: "artifact-archive-1",
      requestId: pin.requestId,
      taskSpecHash: pin.taskSpecHash,
      runId: record.result.run_id,
      projectId: pin.projectId,
      localPinnedRoot: pin.outputRoot,
      relativeDirectory: pin.relativeDirectory,
      resultSha256: sha256Bytes(resultBytes),
      synthetic: record.result.synthetic,
      completeness: "complete",
      entries: files.map((f) => f.entry),
    };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    const destination = archivePath(pin.outputRoot, pin.relativeDirectory);
    // Crash after rename but before DB commit: recover only exact, fully verified bytes.
    if (existsSync(destination)) {
      this.verify(pin, manifest, text);
      this.commitManifest(pin.requestId, text);
      return this.inspect(pin.requestId);
    }
    const parentRelative = pin.relativeDirectory.split("/").slice(0, -1).join("/");
    const parent = ensureOwnedDirectory(pin.outputRoot, parentRelative, this.pathPolicy);
    const stage = join(parent, `staging-${pin.requestId}-${randomUUID()}`);
    mkdirSync(stage, { mode: 0o700 });
    const created: string[] = [];
    const directories: string[] = [];
    try {
      for (const name of ["instructions", "results", "artifacts", "logs"]) {
        mkdirSync(join(stage, name), { mode: 0o700 });
        directories.push(join(stage, name));
      }
      for (const { entry, bytes } of files) {
        const path = archivePath(stage, entry.relativePath);
        created.push(path);
        writeNewFile(path, bytes, this.pathPolicy);
      }
      created.push(join(stage, "manifest.json"));
      writeNewFile(join(stage, "manifest.json"), Buffer.from(text), this.pathPolicy);
      checkedDirectory(parent, this.pathPolicy, true);
      // SQLite serializes cooperating publishers. Existing directories are never replaced.
      this.transaction(() => {
        if (existsSync(destination)) throw new ArchiveError("archive_publish_conflict", true);
        renameSync(stage, destination);
        this.verify(pin, manifest, text);
        this.db
          .prepare("INSERT INTO archive_manifests VALUES (?,?,?)")
          .run(pin.requestId, text, hash(text));
      });
      return this.inspect(pin.requestId);
    } catch (error) {
      throw new ArchiveError(errorCode(error), true);
    } finally {
      if (existsSync(stage) && !lstatSync(stage).isSymbolicLink()) {
        for (const file of created.reverse()) {
          try {
            if (existsSync(file) && !lstatSync(file).isDirectory()) unlinkSync(file);
          } catch {
            /* Preserve on unsafe cleanup/failure. */
          }
        }
        for (const directory of directories.reverse()) {
          try {
            rmdirSync(directory);
          } catch {
            /* Never recurse into unknown data. */
          }
        }
        try {
          rmdirSync(stage);
        } catch {
          /* Partial stage never marks completion. */
        }
      }
    }
  }
  private commitManifest(id: string, text: string): void {
    this.transaction(() => {
      const old = this.db.prepare("SELECT body FROM archive_manifests WHERE request_id=?").get(id);
      if (old && old.body !== text) throw new ArchiveError("archive_manifest_conflict");
      this.db
        .prepare("INSERT OR IGNORE INTO archive_manifests VALUES (?,?,?)")
        .run(id, text, hash(text));
    });
  }
}
