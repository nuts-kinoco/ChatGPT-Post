/** Private host storage. A checksum detects corruption; it is not a signature or execution grant. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import type { AntigravityProbeInstallation } from "./antigravity-probe.js";

export interface AntigravityMetadataConfiguration {
  version: "bridge-antigravity-metadata-config-1";
  enabled: boolean;
  backgroundRefresh: boolean;
  contextId: string;
  installation: AntigravityProbeInstallation;
}
export function validateMetadataConfiguration(
  value: unknown,
): asserts value is AntigravityMetadataConfiguration {
  const c = value as AntigravityMetadataConfiguration;
  if (
    !c ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    Object.keys(c).sort().join() !== "backgroundRefresh,contextId,enabled,installation,version" ||
    c.version !== "bridge-antigravity-metadata-config-1" ||
    typeof c.enabled !== "boolean" ||
    typeof c.backgroundRefresh !== "boolean" ||
    typeof c.contextId !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(c.contextId) ||
    !c.installation ||
    Object.keys(c.installation).sort().join() !== "executable,expectedSha256,ownerUid" ||
    typeof c.installation.executable !== "string" ||
    c.installation.executable.length > 4096 ||
    !isAbsolute(c.installation.executable) ||
    [...c.installation.executable].some((v) => v.charCodeAt(0) < 32 || v.charCodeAt(0) === 127) ||
    typeof c.installation.expectedSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(c.installation.expectedSha256) ||
    !Number.isSafeInteger(c.installation.ownerUid) ||
    c.installation.ownerUid < 0
  )
    throw new Error("metadata_configuration_invalid");
}
export function metadataConfigurationHash(c: AntigravityMetadataConfiguration): string {
  validateMetadataConfiguration(c);
  return sha256Bytes(
    Buffer.from(
      JSON.stringify([
        c.version,
        c.enabled,
        c.backgroundRefresh,
        c.contextId,
        c.installation.executable,
        c.installation.expectedSha256,
        c.installation.ownerUid,
      ]),
    ),
  );
}
export async function readMetadataConfiguration(
  path: string,
): Promise<AntigravityMetadataConfiguration> {
  if (!isAbsolute(path) || process.platform !== "linux" || (await realpath(path)) !== path)
    throw new Error("metadata_configuration_untrusted");
  let parent = dirname(path);
  for (;;) {
    const d = await lstat(parent);
    if (
      !d.isDirectory() ||
      d.isSymbolicLink() ||
      (d.mode & 0o022) !== 0 ||
      (d.uid !== 0 && d.uid !== process.getuid?.())
    )
      throw new Error("metadata_configuration_untrusted");
    if (parent === dirname(parent)) break;
    parent = dirname(parent);
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > 8192
    )
      throw new Error("metadata_configuration_untrusted");
    const bytes = Buffer.alloc(8193);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > 8192) throw new Error("metadata_configuration_untrusted");
    const result = parseStrictJsonBytes(bytes.subarray(0, read.bytesRead));
    validateMetadataConfiguration(result);
    return result;
  } finally {
    await file.close();
  }
}
const LIMIT = 512 * 1024;
/** Fixed production database. Same-user host code and private directory ownership are trusted. */
export class AntigravityMetadataStore {
  private readonly owner = randomUUID();
  private closed = false;
  readonly initial: unknown;
  constructor(
    private readonly db: DatabaseSync,
    private readonly configHash: string,
  ) {
    db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS metadata_host (singleton INTEGER PRIMARY KEY CHECK(singleton=1), config_hash TEXT NOT NULL, owner TEXT, digest TEXT, body TEXT);",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT OR IGNORE INTO metadata_host VALUES(1,?,NULL,NULL,NULL)").run(configHash);
      const row = db.prepare("SELECT * FROM metadata_host WHERE singleton=1").get() as {
        config_hash: string;
        owner: string | null;
        digest: string | null;
        body: string | null;
      };
      if (row.config_hash !== configHash) throw new Error("metadata_context_changed");
      if (row.owner !== null) throw new Error("metadata_ownership_unknown");
      if ((row.body === null) !== (row.digest === null))
        throw new Error("metadata_storage_invalid");
      if (row.body !== null) {
        if (
          Buffer.byteLength(row.body) > LIMIT ||
          sha256Bytes(Buffer.from(row.body)) !== row.digest
        )
          throw new Error("metadata_storage_invalid");
        this.initial = parseStrictJsonBytes(Buffer.from(row.body));
      } else this.initial = null;
      db.prepare("UPDATE metadata_host SET owner=? WHERE singleton=1").run(this.owner);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  save(record: unknown): void {
    const body = JSON.stringify(record);
    if (this.closed || Buffer.byteLength(body) > LIMIT) throw new Error("metadata_storage_invalid");
    const result = this.db
      .prepare(
        "UPDATE metadata_host SET body=?,digest=? WHERE singleton=1 AND owner=? AND config_hash=?",
      )
      .run(body, sha256Bytes(Buffer.from(body)), this.owner, this.configHash);
    if (result.changes !== 1) throw new Error("metadata_ownership_unknown");
  }
  /** Caller proves every stage drained and final state committed before invoking this. */
  release(): void {
    if (this.closed) return;
    const result = this.db
      .prepare(
        "UPDATE metadata_host SET owner=NULL WHERE singleton=1 AND owner=? AND config_hash=?",
      )
      .run(this.owner, this.configHash);
    if (result.changes !== 1) throw new Error("metadata_ownership_unknown");
    this.closed = true;
    this.db.close();
  }
  /** Close without clearing the durable marker on unverified/corrupt initialization. */
  abandon(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
export async function openAntigravityMetadataStore(
  stateDir: string,
  configHash: string,
): Promise<AntigravityMetadataStore> {
  if (process.platform !== "linux") throw new Error("metadata_platform_unsupported");
  const directory = resolve(stateDir, "antigravity-metadata", "production");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(directory)) !== directory ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("metadata_storage_untrusted");
  let parent = dirname(directory);
  const systemTemp = await realpath(tmpdir());
  for (;;) {
    const d = await lstat(parent);
    // A root-owned sticky system temp directory cannot replace another user's private child.
    const stickyTemp = parent === systemTemp && d.uid === 0 && (d.mode & 0o1000) !== 0;
    if (
      !d.isDirectory() ||
      d.isSymbolicLink() ||
      (d.uid !== 0 && d.uid !== process.getuid?.()) ||
      ((d.mode & 0o022) !== 0 && !stickyTemp)
    )
      throw new Error("metadata_storage_untrusted");
    if (parent === dirname(parent)) break;
    parent = dirname(parent);
  }
  const path = join(directory, "catalog.db");
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await file?.close();
  file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("metadata_storage_untrusted");
  } finally {
    await file.close();
  }
  return new AntigravityMetadataStore(new DatabaseSync(path), configHash);
}
