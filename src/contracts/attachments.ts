/**
 * A-068 / SEC-*: attachment guard. Files leave the machine, so anything that looks like a secret is
 * refused before the browser starts (INVALID_REQUEST). Names only appear in errors, never contents.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { containsSecret } from "../diagnostics/redact.js";

export const MAX_ATTACHMENTS = 20;
/** ChatGPT's own per-file limit as answered 2026-09-15 (unverified); the bridge is stricter by default. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const CONTENT_SCAN_MAX_BYTES = 2 * 1024 * 1024;

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
const TEXT_EXT = new Set([
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".sh",
  ".ps1",
  ".bat",
  ".cmd",
  ".sql",
  ".xml",
  ".html",
  ".css",
  ".csv",
  ".log",
  ".env",
]);

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
      const st = await stat(abs);
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
    if (TEXT_EXT.has(ext) && size <= CONTENT_SCAN_MAX_BYTES) {
      try {
        const text = await readFile(abs, "utf8");
        if (containsSecret(text)) {
          errors.push(`${label}: content matches a secret pattern (token / cookie / key)`);
          continue;
        }
      } catch {
        errors.push(`${label}: cannot be read`);
        continue;
      }
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
