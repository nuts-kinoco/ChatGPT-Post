/**
 * 10-ARCHITECTURE §7 verify(): guards against capturing another message or a lossy conversion.
 * Token coverage tolerates UI-only text in innerText (code-block language labels, button captions)
 * while still rejecting a different message or a truncated conversion.
 */

export function normaliseForCompare(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/`{3,}/g, " ")
    .replace(/[`*_~>#|\\[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const UI_NOISE = new Set(["コピーする", "copy", "code", "コードをコピー", "copy code"]);

/**
 * A-129 (Phase 0-D-2, ChatGPT Pro self-review §2.4): `normaliseForCompare()`'s word-splitting
 * treats every operator character purely as a token separator, so `count != limit` and
 * `count == limit` tokenized identically (both just "count", "limit") — an operator change
 * couldn't lower coverage no matter how code-semantically different the two texts were. Extracted
 * separately (from the *raw* text, before symbol-stripping) as their own tokens so a mismatched
 * operator now shows up as a missing/extra token in the coverage count, without touching the
 * existing word-level tolerance for markdown-vs-rendered-text noise.
 */
const OPERATOR_RE = /(===|!==|==|!=|<=|>=|&&|\|\||\+=|-=|\*=|\/=|->|=>|::|\+\+|--)/g;

function operatorTokens(text: string): string[] {
  return (text.match(OPERATOR_RE) ?? []).map((m) => `op:${m}`);
}

export function tokens(text: string): string[] {
  const words = normaliseForCompare(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !UI_NOISE.has(t));
  return [...words, ...operatorTokens(text)];
}

export interface VerifyOutcome {
  ok: boolean;
  reason: string;
  coverage?: number;
}

export const MIN_COVERAGE = 0.85;

export function verifyCandidate(candidate: string, innerText: string): VerifyOutcome {
  const ref = tokens(innerText);
  if (ref.length === 0) return { ok: false, reason: "innerText is empty" };
  const cand = tokens(candidate);
  if (cand.length === 0) return { ok: false, reason: "candidate is empty" };
  const ratio = cand.length / ref.length;
  if (ratio < 0.5 || ratio > 3.0) {
    return { ok: false, reason: `token ratio ${ratio.toFixed(2)} out of range` };
  }
  const pool = new Map<string, number>();
  for (const t of cand) pool.set(t, (pool.get(t) ?? 0) + 1);
  let hit = 0;
  for (const t of ref) {
    const n = pool.get(t) ?? 0;
    if (n > 0) {
      hit++;
      pool.set(t, n - 1);
    }
  }
  const coverage = hit / ref.length;
  if (coverage < MIN_COVERAGE) {
    return {
      ok: false,
      reason: `token coverage ${coverage.toFixed(2)} below ${MIN_COVERAGE}`,
      coverage,
    };
  }
  return { ok: true, reason: "ok", coverage };
}
