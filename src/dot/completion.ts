import type { BridgeRequest } from "../contracts/types.js";

export const DOT_QUIET_MS = 25_000;
export const DOT_MARKER_SETTLE_MS = 5_000;
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
export function dotCompletionToken(requestId: string): string {
  return `完了: ${requestId}`;
}
export function dotMarkerSeen(text: string, marker: string): boolean {
  return /^完了: [A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]$/.test(marker)
    ? text.split(/\r?\n/).some((line) => line === marker)
    : text.includes(marker);
}
/** Every reply must carry the requestId so the shared thread can be filtered (A-200). */
export function dotReplyTagInstruction(requestId: string): string {
  return `この依頼への返信はすべて、先頭の行に「requestId: ${requestId}」と書いてください（添付を付ける返信にも）。`;
}
export function dotPrompt(
  requestId: string,
  prompt: string,
  marker = dotCompletionToken(requestId),
): string {
  const normalized = prompt.replace(/\r\n?/g, "\n");
  const instructions: string[] = [];
  if (!normalized.includes(`先頭の行に「requestId: ${requestId}」`))
    instructions.push(dotReplyTagInstruction(requestId));
  if (!normalized.includes(marker))
    instructions.push(
      `すべての作業が完了した時点でのみ、FINAL返信の最終行に「${marker}」をそのまま書いてください。完了前には書かないでください。`,
    );
  const suffix = instructions.length ? `\n\n${instructions.join("\n")}` : "";
  return `${dotPrefix(requestId)}\n\n${normalized}${suffix}`;
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
export interface DotReplySelection {
  /** Rows attributed to this request, in thread order; only these are read or downloaded. */
  replies: DotRow[];
  /** Non-self rows after the own row that were not attributed; counts only, never content. */
  excludedRows: number;
  excludedFiles: number;
  /**
   * Subset of the excluded rows: untagged rows inside the own block after the first attributed
   * row (continuations or attachment-only rows that may belong to this request). Still excluded.
   */
  untaggedRows: number;
  untaggedFiles: number;
}
const OTHER_REQUEST_ID =
  /\b\d{8}T\d{6}Z-[A-Za-z0-9]{8}\b|requestId[:：]\s*([A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9])/g;
function mentionsOtherRequest(text: string, requestId: string): boolean {
  for (const match of text.matchAll(OTHER_REQUEST_ID)) {
    const found = match[1] ?? match[0];
    // Our own id may contain a timestamp-shaped part, or be followed by ASCII text.
    if (!requestId.includes(found) && !found.startsWith(requestId)) return true;
  }
  return false;
}
/**
 * The dot thread is shared with the PO, so "every row after the own row" leaks unrelated
 * replies and attachments (A-200). A non-self row after the own row is attributed only when:
 * - it contains this requestId (anywhere after the own row), or
 * - it contains the completion marker and lies in the own block (before the next self row),
 *   because a custom marker may be a generic phrase;
 * and it never names another requestId. Files come only from attributed rows. Everything else,
 * including untagged continuations, is excluded and reported as counts only.
 */
export function selectDotReplies(
  rows: readonly DotRow[],
  ownIndex: number,
  requestId: string,
  marker?: string,
): DotReplySelection {
  const after = rows.slice(ownIndex + 1);
  const nextSelf = after.findIndex((row) => row.self);
  const blockEnd = nextSelf === -1 ? after.length : nextSelf;
  const selection: DotReplySelection = {
    replies: [],
    excludedRows: 0,
    excludedFiles: 0,
    untaggedRows: 0,
    untaggedFiles: 0,
  };
  let attributedInBlock = false;
  for (const [index, row] of after.entries()) {
    if (row.self) continue;
    const foreign = mentionsOtherRequest(row.text, requestId);
    const inBlock = index < blockEnd;
    const attributed =
      !foreign &&
      (row.text.includes(requestId) ||
        (inBlock && marker !== undefined && dotMarkerSeen(row.text, marker)));
    if (attributed) {
      selection.replies.push(row);
      if (inBlock) attributedInBlock = true;
      continue;
    }
    selection.excludedRows++;
    selection.excludedFiles += row.files.length;
    if (inBlock && attributedInBlock && !foreign) {
      selection.untaggedRows++;
      selection.untaggedFiles += row.files.length;
    }
  }
  return selection;
}
export function dotSelectionWarnings(selection: DotReplySelection): string[] {
  const warnings: string[] = [];
  if (selection.excludedRows)
    warnings.push(
      `dot_unrelated_rows_excluded: ${selection.excludedRows} rows, ${selection.excludedFiles} files`,
    );
  if (selection.untaggedRows)
    warnings.push(
      `dot_untagged_rows_after_own_reply: ${selection.untaggedRows} rows, ${selection.untaggedFiles} files`,
    );
  return warnings;
}
export interface DotDecision {
  progress: DotProgress;
  done: boolean;
  ownRow: DotRow | null;
  replies: DotRow[];
  selection: DotReplySelection;
  conflict: boolean;
  conflictPersistent: boolean;
}
/** Uses monotonic timestamps; quiet time begins at the first snapshot, never at submission. */
export function decideDotCompletion(
  snapshot: DotSnapshot,
  requestId: string,
  now: number,
  previous?: DotProgress,
  marker?: string,
  quietMs = DOT_QUIET_MS,
): DotDecision {
  const prefix = dotPrefix(requestId);
  const matches = snapshot.rows.filter((row) => row.self && row.text.startsWith(prefix));
  const ownRow = matches.length === 1 ? (matches[0] ?? null) : null;
  const after = ownRow ? snapshot.rows.slice(snapshot.rows.indexOf(ownRow) + 1) : [];
  const selection = ownRow
    ? selectDotReplies(snapshot.rows, snapshot.rows.indexOf(ownRow), requestId, marker)
    : { replies: [], excludedRows: 0, excludedFiles: 0, untaggedRows: 0, untaggedFiles: 0 };
  const replies = selection.replies;
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
      (marker !== undefined
        ? replies.some((row) => dotMarkerSeen(row.text, marker)) &&
          now - progress.changedAt >= DOT_MARKER_SETTLE_MS
        : now - progress.changedAt >= quietMs),
  );
  const conflictPersistent =
    progress.conflictSince !== null && now - progress.conflictSince >= DOT_CONFLICT_MS;
  return { progress, done, ownRow, replies, selection, conflict, conflictPersistent };
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
