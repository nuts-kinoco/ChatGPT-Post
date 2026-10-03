/** Immutable local publication: exclusive staging, byte readback, file + directory fsync. */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sha256Bytes } from "../contracts/task.js";
import {
  archivePath,
  checkedDirectory,
  ensureOwnedDirectory,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_FILE_BYTES,
  MAX_ARCHIVE_TOTAL_BYTES,
  type PathPolicy,
  readOwnedFile,
  writeNewFile,
} from "./paths.js";
import { ArchiveError } from "./types.js";
export interface OwnedRootIdentity {
  device: string;
  inode: string;
}
export interface DurableFile {
  relativePath: string;
  bytes: Uint8Array;
}
export function rootIdentity(root: string, policy: PathPolicy = {}): OwnedRootIdentity {
  checkedDirectory(root, policy);
  const stat = lstatSync(root, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino) };
}
export function assertRootIdentity(
  root: string,
  expected: OwnedRootIdentity,
  policy: PathPolicy = {},
): void {
  const current = rootIdentity(root, policy);
  if (current.device !== expected.device || current.inode !== expected.inode)
    throw new ArchiveError("archive_root_identity_changed");
}
export function syncDirectory(path: string, policy: PathPolicy = {}): void {
  checkedDirectory(path, policy);
  if (process.platform === "win32" || policy.platform === "win32")
    throw new ArchiveError("archive_windows_storage_unimplemented");
  policy.beforeSyncDirectory?.(path);
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function verifyImmutableFiles(
  root: string,
  directory: string,
  files: readonly DurableFile[],
  identity: OwnedRootIdentity,
  policy: PathPolicy = {},
): void {
  assertRootIdentity(root, identity, policy);
  const target = archivePath(root, directory);
  for (const file of files) {
    const bytes = readOwnedFile(
      archivePath(target, file.relativePath),
      MAX_ARCHIVE_FILE_BYTES,
      policy,
    );
    if (bytes.length !== file.bytes.byteLength || sha256Bytes(bytes) !== sha256Bytes(file.bytes))
      throw new ArchiveError("archive_content_hash_mismatch");
  }
}
function durableBarrier(
  root: string,
  destination: string,
  files: readonly DurableFile[],
  policy: PathPolicy,
): void {
  const directories = new Set<string>([destination]);
  for (const file of files) {
    const path = archivePath(destination, file.relativePath);
    readOwnedFile(path, MAX_ARCHIVE_FILE_BYTES, policy);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    let parent = dirname(path);
    while (parent !== destination) {
      directories.add(parent);
      const next = dirname(parent);
      if (next === parent) throw new ArchiveError("archive_path_escape");
      parent = next;
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length))
    syncDirectory(directory, policy);
  let parent = dirname(destination);
  while (true) {
    syncDirectory(parent, policy);
    if (parent === root) break;
    const next = dirname(parent);
    if (next === parent) throw new ArchiveError("archive_path_escape");
    parent = next;
  }
}
export function publishImmutableFiles(
  root: string,
  directory: string,
  input: readonly DurableFile[],
  identity: OwnedRootIdentity,
  policy: PathPolicy = {},
): void {
  const files = input.map((f) => ({
    relativePath: f.relativePath,
    bytes: Uint8Array.from(f.bytes),
  }));
  if (
    !files.length ||
    files.length > MAX_ARCHIVE_ENTRIES ||
    files.some((f) => f.bytes.byteLength > MAX_ARCHIVE_FILE_BYTES) ||
    files.reduce((n, f) => n + f.bytes.byteLength, 0) > MAX_ARCHIVE_TOTAL_BYTES
  )
    throw new ArchiveError("archive_size_limit");
  const seen = new Set<string>();
  for (const file of files) {
    archivePath(root, file.relativePath);
    if (seen.has(file.relativePath.toLowerCase()))
      throw new ArchiveError("archive_filename_collision");
    seen.add(file.relativePath.toLowerCase());
  }
  assertRootIdentity(root, identity, policy);
  const destination = archivePath(root, directory);
  if (existsSync(destination)) {
    verifyImmutableFiles(root, directory, files, identity, policy);
    durableBarrier(root, destination, files, policy);
    assertRootIdentity(root, identity, policy);
    return;
  }
  const parent = ensureOwnedDirectory(root, directory.split("/").slice(0, -1).join("/"), policy);
  const stageName = `staging-${randomUUID()}`;
  const stage = join(parent, stageName);
  mkdirSync(stage, { mode: 0o700 });
  const created: string[] = [],
    dirs = new Set<string>();
  try {
    for (const file of files) {
      const parts = file.relativePath.split("/").slice(0, -1);
      let cursor = stage;
      for (const part of parts) {
        cursor = join(cursor, part);
        if (!dirs.has(cursor)) {
          mkdirSync(cursor, { mode: 0o700 });
          dirs.add(cursor);
        }
      }
      const path = archivePath(stage, file.relativePath);
      writeNewFile(path, file.bytes, policy);
      created.push(path);
      const bytes = readOwnedFile(path, MAX_ARCHIVE_FILE_BYTES, policy);
      if (sha256Bytes(bytes) !== sha256Bytes(file.bytes))
        throw new ArchiveError("archive_write_verification_failed");
    }
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) syncDirectory(dir, policy);
    syncDirectory(stage, policy);
    assertRootIdentity(root, identity, policy);
    checkedDirectory(parent, policy, true);
    // Cooperating writers are serialized by the authoritative SQLite transaction of the caller.
    if (existsSync(destination)) throw new ArchiveError("archive_publish_conflict", true);
    renameSync(stage, destination);
    durableBarrier(root, destination, files, policy);
    verifyImmutableFiles(root, directory, files, identity, policy);
  } finally {
    if (existsSync(stage)) {
      try {
        assertRootIdentity(root, identity, policy);
        checkedDirectory(stage, policy, true);
        for (const path of created.reverse()) {
          checkedDirectory(dirname(path), policy, true);
          if (existsSync(path)) unlinkSync(path);
        }
        for (const dir of [...dirs].sort((a, b) => b.length - a.length)) rmdirSync(dir);
        rmdirSync(stage);
        syncDirectory(parent, policy);
      } catch {
        /* Preserve uncertain staging. Never recurse or follow changed parent paths. */
      }
    }
  }
}
