/** Only private, owned local directories. No implicit drive creation or symlink following. */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";
import { ArchiveError } from "./types.js";
export const MAX_ARCHIVE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_ARCHIVE_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 128;
export interface PathPolicy {
  platform?: NodeJS.Platform;
  beforeWrite?: (path: string) => void;
  beforeSyncDirectory?: (path: string) => void;
}
export function portableFilename(value: string): string {
  if (
    !value ||
    value.length > 120 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?![\s\S])/.test(value) ||
    /[. ](?![\s\S])/.test(value) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)
  )
    throw new ArchiveError("archive_filename_invalid");
  return value;
}
export function archivePath(root: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new ArchiveError("archive_path_escape");
  for (const segment of path.split("/")) portableFilename(segment);
  const result = resolve(root, ...path.split("/"));
  if (relative(root, result).startsWith(`..${sep}`) || relative(root, result) === "..")
    throw new ArchiveError("archive_path_escape");
  return result;
}
export function checkedDirectory(
  path: string,
  policy: PathPolicy = {},
  privateDirectory = false,
): string {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    [...path].some((c) => c.charCodeAt(0) < 32) ||
    path.startsWith("\\\\")
  )
    throw new ArchiveError("archive_root_invalid");
  const root = parse(path).root;
  let cursor = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const st = lstatSync(cursor);
    if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(cursor) !== cursor)
      throw new ArchiveError("archive_path_not_owned");
    if (
      process.platform !== "win32" &&
      ((st.uid !== process.getuid?.() && st.uid !== 0) ||
        ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0))
    )
      throw new ArchiveError("archive_ancestor_untrusted");
  }
  const st = lstatSync(path);
  if (process.platform === "win32" || policy.platform === "win32") {
    throw new ArchiveError("archive_windows_storage_unimplemented");
  } else if (st.uid !== process.getuid?.() || (st.mode & (privateDirectory ? 0o077 : 0o022)) !== 0)
    throw new ArchiveError("archive_path_not_owned");
  return path;
}
export function ensureOwnedDirectory(root: string, path: string, policy: PathPolicy = {}): string {
  checkedDirectory(root, policy);
  const target = archivePath(root, path);
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    try {
      mkdirSync(cursor, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    checkedDirectory(cursor, policy, true);
  }
  return target;
}
export function readOwnedFile(path: string, maxBytes: number, policy: PathPolicy = {}): Buffer {
  checkedDirectory(dirname(path), policy, true);
  const st = lstatSync(path);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    st.size > maxBytes ||
    st.size < 0 ||
    ((policy.platform ?? process.platform) !== "win32" &&
      (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0))
  )
    throw new ArchiveError("archive_file_unsafe");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = fstatSync(fd);
    if (current.dev !== st.dev || current.ino !== st.ino || current.size !== st.size)
      throw new ArchiveError("archive_file_changed");
    const bytes = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) throw new ArchiveError("archive_file_partial");
      offset += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 || fstatSync(fd).size !== st.size)
      throw new ArchiveError("archive_file_changed");
    checkedDirectory(dirname(path), policy, true);
    return bytes;
  } finally {
    closeSync(fd);
  }
}
/** A short write may progress; a nonprogressing write must never spin inside a transaction. */
function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    const written = writeSync(fd, bytes, offset, remaining);
    if (!Number.isSafeInteger(written) || written <= 0 || written > remaining)
      throw new ArchiveError("archive_write_verification_failed");
    offset += written;
  }
}
export function writeNewFile(path: string, bytes: Uint8Array, policy: PathPolicy = {}): void {
  if (bytes.byteLength > MAX_ARCHIVE_FILE_BYTES) throw new ArchiveError("archive_size_limit");
  checkedDirectory(dirname(path), policy, true);
  policy.beforeWrite?.(path);
  checkedDirectory(dirname(path), policy, true);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  checkedDirectory(dirname(path), policy, true);
}
/** User-triggered capability probe only. Root configuration and reads never call this. */
export function probeOutputRoot(
  root: string,
  policy: PathPolicy = {},
): { writable: true; cleaned: true } {
  checkedDirectory(root, policy);
  const path = join(root, `bridge-probe-${randomUUID()}.tmp`);
  let created = false;
  try {
    policy.beforeWrite?.(path);
    checkedDirectory(root, policy);
    const fd = openSync(path, "wx+", 0o600);
    created = true;
    try {
      const probe = Buffer.from("probe");
      writeAll(fd, probe);
      fsyncSync(fd);
      const readback = Buffer.alloc(probe.length);
      let offset = 0;
      while (offset < readback.length) {
        const remaining = readback.length - offset;
        const read = readSync(fd, readback, offset, remaining, offset);
        if (!Number.isSafeInteger(read) || read <= 0 || read > remaining)
          throw new ArchiveError("archive_write_verification_failed");
        offset += read;
      }
      if (!readback.equals(probe) || fstatSync(fd).size !== probe.length)
        throw new ArchiveError("archive_write_verification_failed");
    } finally {
      closeSync(fd);
    }
    checkedDirectory(root, policy);
    return { writable: true, cleaned: true };
  } finally {
    if (created) {
      checkedDirectory(root, policy);
      unlinkSync(path);
    }
  }
}
