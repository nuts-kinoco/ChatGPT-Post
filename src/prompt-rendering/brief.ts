/** Offline task-file codec. This is content inside TaskSpec.task_file_hash, never a TaskSpec. */
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";

export const BRIEF_MARKER = "BRIDGE TASK BRIEF bridge-task-brief-1\n";
export const MAX_BRIEF_BYTES = 256 * 1024;
export const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
export type TaskBriefCodec = "bridge-task-brief-1" | "legacy-verbatim";
export type TaskKind = "answer" | "review" | "change";
export interface ContextManifestEntry {
  id: string;
  revision: string;
  sha256: string;
  sizeBytes: number;
  mediaType: "text/plain" | "text/markdown" | "application/json";
  trust: "untrusted";
  placement: "stable" | "variable";
}
export interface TaskBrief {
  taskKind: TaskKind;
  objective: string;
  constraints: string[];
  deliverables: string[];
  acceptance: string[];
  context: ContextManifestEntry[];
}
export function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    throw new Error("prompt_fields_invalid");
  return value as Record<string, unknown>;
}
export function boundedText(value: unknown, max: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    /[\uD800-\uDFFF]/u.test(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value) > max
  )
    throw new Error("prompt_text_invalid");
  return value;
}
export function strictUtf8(bytes: Uint8Array, max: number): string {
  if (bytes.byteLength > max || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf))
    throw new Error("prompt_bytes_invalid");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return boundedText(text, max, true);
}
function list(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("prompt_list_invalid");
  return value.map((item) => boundedText(item, 8192));
}
function manifest(value: unknown): ContextManifestEntry[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("prompt_context_invalid");
  const ids = new Set<string>();
  let total = 0;
  return value.map((item) => {
    const row = exactObject(item, [
      "id",
      "revision",
      "sha256",
      "sizeBytes",
      "mediaType",
      "trust",
      "placement",
    ]);
    const id = boundedText(row.id, 128);
    const revision = boundedText(row.revision, 256);
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}(?![\s\S])/.test(id) ||
      ids.has(id) ||
      typeof row.sha256 !== "string" ||
      !/^[a-f0-9]{64}(?![\s\S])/.test(row.sha256) ||
      typeof row.sizeBytes !== "number" ||
      !Number.isSafeInteger(row.sizeBytes) ||
      row.sizeBytes < 0 ||
      row.sizeBytes > 1024 * 1024 ||
      typeof row.mediaType !== "string" ||
      !["text/plain", "text/markdown", "application/json"].includes(row.mediaType) ||
      row.trust !== "untrusted" ||
      typeof row.placement !== "string" ||
      !["stable", "variable"].includes(row.placement)
    )
      throw new Error("prompt_context_invalid");
    ids.add(id);
    total += row.sizeBytes;
    if (total > MAX_CONTEXT_BYTES) throw new Error("prompt_context_too_large");
    return {
      id,
      revision,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      mediaType: row.mediaType as ContextManifestEntry["mediaType"],
      trust: "untrusted",
      placement: row.placement as ContextManifestEntry["placement"],
    };
  });
}
function validateBrief(value: unknown): TaskBrief {
  const row = exactObject(value, [
    "taskKind",
    "objective",
    "constraints",
    "deliverables",
    "acceptance",
    "context",
  ]);
  if (typeof row.taskKind !== "string" || !["answer", "review", "change"].includes(row.taskKind))
    throw new Error("prompt_task_kind_invalid");
  return {
    taskKind: row.taskKind as TaskKind,
    objective: boundedText(row.objective, 65536),
    constraints: list(row.constraints),
    deliverables: list(row.deliverables),
    acceptance: list(row.acceptance),
    context: manifest(row.context),
  };
}
/** Fixed key order, compact JSON, one LF. No Unicode or line-ending normalization of values. */
export function encodeTaskBrief(value: unknown): Uint8Array {
  const bytes = Buffer.from(`${BRIEF_MARKER}${JSON.stringify(validateBrief(value))}\n`);
  if (bytes.byteLength > MAX_BRIEF_BYTES) throw new Error("prompt_brief_too_large");
  return bytes;
}
export function decodeTaskBrief(bytes: Uint8Array): TaskBrief {
  const text = strictUtf8(bytes, MAX_BRIEF_BYTES);
  if (!text.startsWith(BRIEF_MARKER) || !text.endsWith("\n"))
    throw new Error("prompt_brief_marker_invalid");
  const brief = validateBrief(
    parseStrictJsonBytes(Buffer.from(text.slice(BRIEF_MARKER.length, -1))),
  );
  if (!Buffer.from(encodeTaskBrief(brief)).equals(bytes))
    throw new Error("prompt_brief_noncanonical");
  return brief;
}
export interface MaterializedContext {
  id: string;
  bytes: Uint8Array;
}
export interface VerifiedContext {
  manifest: ContextManifestEntry;
  text: string;
}
/** Uses only supplied bytes. Never resolves a path, URL, cache ID or source reference. */
export function verifyContext(
  manifestRows: readonly ContextManifestEntry[],
  supplied: readonly MaterializedContext[],
): VerifiedContext[] {
  if (!Array.isArray(supplied) || supplied.length !== manifestRows.length)
    throw new Error("prompt_context_set_mismatch");
  const byId = new Map<string, Uint8Array>();
  for (const item of supplied) {
    exactObject(item, ["id", "bytes"]);
    if (byId.has(item.id) || !(item.bytes instanceof Uint8Array))
      throw new Error("prompt_context_set_mismatch");
    byId.set(item.id, item.bytes);
  }
  return manifestRows.map((row) => {
    const suppliedBytes = byId.get(row.id);
    if (!suppliedBytes || suppliedBytes.byteLength !== row.sizeBytes)
      throw new Error("prompt_context_digest_mismatch");
    const bytes = Uint8Array.from(suppliedBytes);
    if (!bytes || bytes.byteLength !== row.sizeBytes || sha256Bytes(bytes) !== row.sha256)
      throw new Error("prompt_context_digest_mismatch");
    return { manifest: { ...row }, text: strictUtf8(bytes, 1024 * 1024) };
  });
}
