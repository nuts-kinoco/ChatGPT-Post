import type { BridgeRequest } from "../contracts/types.js";

export const DOT_QUIET_MS = 25_000;
export const DOT_NO_TYPING_MS = 3_000;
export const DOT_POLL_MS = 450;
export const DOT_CONFLICT_MS = 2_000;
export const DOT_HISTORY_SETTLE_MS = 2_000;
export const DOT_HISTORY_POLL_MS = 300;
export const DOT_HISTORY_CAP_MS = 12_000;

export function isHistorySettled(samples: readonly { count: number; at: number }[]): boolean {
  const last = samples.at(-1);
  if (!last) return false;
  let since = last.at;
  for (let i = samples.length - 2; i >= 0; i--) {
    const sample = samples[i];
    if (!sample || sample.count !== last.count) break;
    since = sample.at;
  }
  return last.at - since >= DOT_HISTORY_SETTLE_MS;
}
export const DOT_ACCEPTANCE_MS = 15_000;
export const DOT_FILE_TIMEOUT_MS = 30_000;
export const DOT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const DOT_MAX_FILES = 10;
export const DOT_EXTRACTION_BUDGET_MS = DOT_MAX_FILES * (DOT_FILE_TIMEOUT_MS + 5_000) + 5_000;

export function dotPrefix(requestId: string): string {
  return `【chatgpt-bridge からの自動送信 / requestId: ${requestId}】これはブリッジ（自動操作）から送っています。PO 本人の入力ではありません。`;
}
export function dotPrompt(requestId: string, prompt: string): string {
  return `${dotPrefix(requestId)}\n\n${prompt.replace(/\r\n?/g, "\n")}`;
}
export function dotWarnings(request: BridgeRequest): string[] {
  return ["newChat", "preset", "model", "project", "conversationUrl"]
    .filter((field) => Object.hasOwn(request, field))
    .map((field) => `dot_ignores_${field}`);
}
export function hasTypingIndicator(text: string): boolean {
  return /typing|入力中/i.test(text);
}
export interface DotRow {
  id: string;
  self: boolean;
  text: string;
  html: string;
  files: string[];
}
export interface DotSnapshot {
  rows: DotRow[];
  typing: boolean;
}
export interface DotProgress {
  fingerprint: string;
  changedAt: number;
  noTypingSince: number | null;
  conflictSince: number | null;
}
export interface DotDecision {
  progress: DotProgress;
  done: boolean;
  ownRow: DotRow | null;
  replies: DotRow[];
  conflict: boolean;
  conflictPersistent: boolean;
}
/** Uses monotonic timestamps; quiet time begins at the first snapshot, never at submission. */
export function decideDotCompletion(
  snapshot: DotSnapshot,
  prefix: string,
  now: number,
  previous?: DotProgress,
  marker?: string,
  quietMs = DOT_QUIET_MS,
): DotDecision {
  const matches = snapshot.rows.filter((row) => row.self && row.text.startsWith(prefix));
  const ownRow = matches.length === 1 ? (matches[0] ?? null) : null;
  const after = ownRow ? snapshot.rows.slice(snapshot.rows.indexOf(ownRow) + 1) : [];
  const replies = after.filter((row) => !row.self);
  const conflict = matches.length > 1 || after.some((row) => row.self);
  const fingerprint = JSON.stringify(snapshot.rows);
  const progress: DotProgress = {
    fingerprint,
    conflictSince: conflict ? (previous?.conflictSince ?? now) : null,
    changedAt: previous?.fingerprint === fingerprint ? previous.changedAt : now,
    noTypingSince: snapshot.typing ? null : (previous?.noTypingSince ?? now),
  };
  const last = replies.at(-1);
  const done = Boolean(
    ownRow &&
      last &&
      !conflict &&
      !snapshot.typing &&
      progress.noTypingSince !== null &&
      now - progress.noTypingSince >= DOT_NO_TYPING_MS &&
      ((marker !== undefined && last.text.includes(marker)) || now - progress.changedAt >= quietMs),
  );
  const conflictPersistent =
    progress.conflictSince !== null && now - progress.conflictSince >= DOT_CONFLICT_MS;
  return { progress, done, ownRow, replies, conflict, conflictPersistent };
}

export function sanitizeDotFilename(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: downloaded filenames must strip control characters
    .replace(/[\x00-\x1f\x7f/\\<>:"|?*]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 160)
    .replace(/[. ]+$/g, "");
  if (!cleaned) return "file";
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}
