/**
 * A-068 / SEC-*: attachment guard. Files leave the machine, so anything that looks like a secret is
 * refused before the browser starts (INVALID_REQUEST). Names only appear in errors, never contents.
 */
import { lstat, open, readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { containsSecret } from "../diagnostics/redact.js";

export const MAX_ATTACHMENTS = 20;
/** ChatGPT's own per-file limit as answered 2026-09-15 (unverified); the bridge is stricter by default. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
/** Text files (by bytes) larger than this are refused rather than sent unscanned. */
const LARGE_TEXT_SCAN_MAX_BYTES = 20 * 1024 * 1024;
const HEAD_SNIFF_BYTES = 8000;

/** Reads only the first `n` bytes, regardless of total file size — used to classify a file as
 * text-like without reading a large file fully into memory just to check its head. */
async function readHead(path: string, n: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

const DENY_NAMES = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pypirc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^credentials(\..*)?$/i,
  /^secrets?(\..*)?$/i,
  /^token(s)?(\..*)?$/i,
];
const DENY_EXT = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".kdbx",
  ".keystore",
  ".jks",
  ".ppk",
  ".secret",
]);
const DENY_DIR_SEGMENTS = new Set([".git", "node_modules", ".ssh", ".aws", ".gnupg"]);

export interface AttachmentCheck {
  ok: boolean;
  /** Absolute paths in request order (only when ok). */
  paths: string[];
  totalBytes: number;
  errors: string[];
}

export async function checkAttachments(
  list: unknown,
  requestDir: string,
): Promise<AttachmentCheck> {
  if (list === undefined) return { ok: true, paths: [], totalBytes: 0, errors: [] };
  const errors: string[] = [];
  if (!Array.isArray(list) || !list.every((x) => typeof x === "string" && x.length > 0)) {
    return {
      ok: false,
      paths: [],
      totalBytes: 0,
      errors: ["/attachments must be an array of non-empty strings"],
    };
  }
  if (list.length > MAX_ATTACHMENTS) {
    errors.push(`/attachments: at most ${MAX_ATTACHMENTS} files`);
  }
  const paths: string[] = [];
  let totalBytes = 0;
  const seenBase = new Set<string>();
  for (const [i, item] of (list as string[]).entries()) {
    const abs = isAbsolute(item) ? item : resolve(requestDir, item);
    const base = basename(abs);
    const ext = extname(base).toLowerCase();
    const label = `/attachments/${i} (${base})`;
    if (abs.split(sep).some((seg) => DENY_DIR_SEGMENTS.has(seg.toLowerCase()))) {
      errors.push(`${label}: inside a denied directory (.git, node_modules, .ssh, .aws, .gnupg)`);
      continue;
    }
    if (DENY_NAMES.some((re) => re.test(base)) || DENY_EXT.has(ext)) {
      errors.push(`${label}: file name matches the secret deny-list`);
      continue;
    }
    if (seenBase.has(base.toLowerCase())) {
      errors.push(`${label}: duplicate file name (ChatGPT chips are matched by name)`);
      continue;
    }
    seenBase.add(base.toLowerCase());
    let size: number;
    try {
      // lstat: a symlink / junction pointing at a secret must not pass as its target (Codex P5-1)
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        errors.push(`${label}: symbolic links are not attached`);
        continue;
      }
      if (!st.isFile()) {
        errors.push(`${label}: not a regular file`);
        continue;
      }
      size = st.size;
    } catch {
      errors.push(`${label}: cannot be read`);
      continue;
    }
    if (size === 0) {
      errors.push(`${label}: empty file`);
      continue;
    }
    if (size > MAX_ATTACHMENT_BYTES) {
      errors.push(`${label}: larger than ${MAX_ATTACHMENT_BYTES} bytes`);
      continue;
    }
    // Content scan is decided by the bytes, not the extension (a .pdf may be plain text, Codex
    // P5-1). A-125 (Phase 0-C-4, ChatGPT Pro redesign review §2.14): this used to only read the
    // file at all when it was small (<= 2 MiB) or had a known text extension — a large file with a
    // non-text extension (e.g. a 5 MiB "notes.dat" or "secret.pdf") skipped straight past with zero
    // content inspection, contradicting the comment's own stated policy. The head-byte "is this
    // text-like" classification is now always performed (cheap: a fixed small read regardless of
    // total file size), so extension mislabeling can no longer bypass it; only the *full* scan of a
    // text-like file is size-bounded.
    try {
      const head = await readHead(abs, HEAD_SNIFF_BYTES);
      const looksText = !head.includes(0);
      if (looksText) {
        if (size > LARGE_TEXT_SCAN_MAX_BYTES) {
          errors.push(
            `${label}: text file too large to scan for secrets (> ${LARGE_TEXT_SCAN_MAX_BYTES} bytes)`,
          );
          continue;
        }
        const buf = await readFile(abs);
        if (containsSecret(buf.toString("utf8"))) {
          errors.push(`${label}: content matches a secret pattern (token / cookie / key)`);
          continue;
        }
      }
      // not text-like (binary): allowed through unscanned regardless of size, same as before.
    } catch {
      errors.push(`${label}: cannot be read`);
      continue;
    }
    paths.push(abs);
    totalBytes += size;
  }
  const ok = errors.length === 0;
  return { ok, paths: ok ? paths : [], totalBytes: ok ? totalBytes : 0, errors };
}

/** Rough upload budget: base + per-MB allowance (3 MB took >10 s on 2026-09-15). */
export function uploadBudgetMs(totalBytes: number): number {
  return 60_000 + Math.ceil(totalBytes / (1024 * 1024)) * 15_000;
}
