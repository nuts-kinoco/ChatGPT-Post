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

/** A code-bearing DOM block reduced to the structural facts an extraction must retain. */
export interface CodeBlockShape {
  nonEmptyLines: number;
  indentedLines: number;
}

export interface StructureOutcome {
  ok: boolean;
  reason: string;
}

type ParsedFence = { body: string; closed: boolean };

function decodeHtmlText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:#x([0-9a-f]+)|#(\d+)|amp|lt|gt|quot|#39);/gi, (entity, hex, decimal) => {
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      return (
        (
          { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" } as Record<
            string,
            string
          >
        )[entity.toLowerCase()] ?? entity
      );
    });
}

/**
 * Extract outer <pre><code> bodies from the same HTML used for DOM conversion. The intentionally
 * small parser is sufficient here because each match stops at its first code-bearing nested pre,
 * which is the rendered code block rather than its language/copy controls.
 */
export function codeBlocksFromHtml(html: string): string[] {
  const blocks: string[] = [];
  const pre = /<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi;
  for (const match of html.matchAll(pre)) {
    const code = /<code\b[^>]*>([\s\S]*?)<\/code\s*>/i.exec(match[1] ?? "");
    if (code) blocks.push(decodeHtmlText(code[1] ?? ""));
  }
  return blocks;
}

function parseFences(markdown: string): ParsedFence[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ParsedFence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = /^(?: {0,3})(`{3,}|~{3,})[^`~]*$/.exec(lines[i] ?? "");
    if (!start) continue;
    const opening = start[1] ?? "```";
    const marker = opening[0] ?? "`";
    const minimum = opening.length;
    const body: string[] = [];
    let closed = false;
    for (i++; i < lines.length; i++) {
      if (new RegExp(`^ {0,3}${marker}{${minimum},}\\s*$`).test(lines[i] ?? "")) {
        closed = true;
        break;
      }
      body.push(lines[i] ?? "");
    }
    blocks.push({ body: body.join("\n"), closed });
  }
  return blocks;
}

function shape(text: string): CodeBlockShape {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
  return {
    nonEmptyLines: lines.length,
    indentedLines: lines.filter((line) => /^[\t ]+/.test(line)).length,
  };
}

function nonEmptyLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/**
 * A2b: compare rendered line layout directly with `innerText`, without assuming a particular
 * code-viewer DOM shape. This intentionally detects only large, code-like losses so prose, lists,
 * and correctly fenced code remain full quality.
 */
export function verifyWhitespaceStructure(candidate: string, innerText: string): StructureOutcome {
  const referenceLines = nonEmptyLines(innerText);
  const candidateLines = nonEmptyLines(candidate);
  const referenceIndented = referenceLines.filter((line) => /^[\t ]+/.test(line)).length;
  const candidateIndented = candidateLines.filter((line) => /^[\t ]+/.test(line)).length;
  if (referenceIndented >= 5 && candidateIndented < referenceIndented * 0.5) {
    return {
      ok: false,
      reason: `leading indentation retained on ${candidateIndented}/${referenceIndented} innerText lines`,
    };
  }

  const candidateLongest = candidateLines.reduce(
    (longest, line) => Math.max(longest, line.length),
    0,
  );
  const referenceLongest = referenceLines.reduce(
    (longest, line) => Math.max(longest, line.length),
    0,
  );
  if (candidateLongest > 3_000 && referenceLongest <= 1_000) {
    return {
      ok: false,
      reason: `candidate line length ${candidateLongest} collapsed innerText lines (max ${referenceLongest})`,
    };
  }

  const separatedRatio = (lines: string[]) => {
    if (lines.length === 0) return 0;
    let separated = 0;
    const normalised = lines.map((line) => line.replace(/\r$/, ""));
    for (let i = 0; i < normalised.length; i++) {
      if (normalised[i]?.trim() === "") continue;
      if (normalised[i - 1]?.trim() === "" || normalised[i + 1]?.trim() === "") separated++;
    }
    return separated / lines.filter((line) => line.trim() !== "").length;
  };
  const candidateAllLines = candidate.replace(/\r\n?/g, "\n").split("\n");
  const referenceAllLines = innerText.replace(/\r\n?/g, "\n").split("\n");
  const candidateSeparated = separatedRatio(candidateAllLines);
  const referenceSeparated = separatedRatio(referenceAllLines);
  if (candidateLines.length >= 20 && candidateSeparated > 0.6 && referenceSeparated < 0.5) {
    return {
      ok: false,
      reason: `single-line paragraph inflation (${Math.round(candidateSeparated * 100)}% vs innerText ${Math.round(referenceSeparated * 100)}%)`,
    };
  }
  return { ok: true, reason: "ok" };
}

/** Verify code-block boundaries and indentation, which token coverage intentionally ignores. */
export function verifyStructure(candidate: string, html: string): StructureOutcome {
  const expected = codeBlocksFromHtml(html);
  const actual = parseFences(candidate);
  const unclosed = actual.findIndex((block) => !block.closed);
  if (unclosed >= 0) return { ok: false, reason: `unclosed code fence at block ${unclosed + 1}` };
  if (expected.length !== actual.length)
    return {
      ok: false,
      reason: `code block count ${actual.length} does not match DOM ${expected.length}`,
    };
  for (let i = 0; i < expected.length; i++) {
    const source = shape(expected[i] ?? "");
    const candidateShape = shape(actual[i]?.body ?? "");
    const lineTolerance = Math.max(1, Math.floor(source.nonEmptyLines * 0.05));
    const indentTolerance = Math.floor(source.indentedLines * 0.05);
    if (Math.abs(source.nonEmptyLines - candidateShape.nonEmptyLines) > lineTolerance)
      return { ok: false, reason: `code block ${i + 1} line count changed` };
    if (Math.abs(source.indentedLines - candidateShape.indentedLines) > indentTolerance)
      return { ok: false, reason: `code block ${i + 1} leading indentation changed` };
  }
  for (const block of actual) {
    if (/\\[[_=]/.test(block.body))
      return { ok: false, reason: "code fence contains Markdown-escaped code punctuation" };
  }
  return { ok: true, reason: "ok" };
}

/** Conservative A4 signals. Growing-after-completion is not sampled by this extraction path. */
export function verifyCompleteness(candidate: string): StructureOutcome {
  const fences = parseFences(candidate);
  if (fences.some((block) => !block.closed))
    return { ok: false, reason: "unclosed code fence at end" };
  const text = candidate.trimEnd();
  if (text.length < 800) return { ok: true, reason: "ok" };
  const lastLine = text.slice(text.lastIndexOf("\n") + 1).trim();
  // A short final sentinel, row, list item, URL, or heading is a complete answer shape even when
  // the answer overall is long. In particular, requesters frequently require Japanese closers.
  if (
    /(?:以上|完了|終わり|終了|end|EOF|DONE)/i.test(lastLine) ||
    /[.!?\u2026\u3002\uff01\uff1f;:\uff1b\uff1a)}\]>]$/.test(lastLine) ||
    /^(?:`{3,}|~{3,})\s*$/.test(lastLine) ||
    /^(?:[-*+]\s+|\d+[.)]\s+)/.test(lastLine) ||
    /^\|.*\|\s*$/.test(lastLine) ||
    /^#{1,6}\s+/.test(lastLine) ||
    /https?:\/\/\S+$/.test(lastLine)
  )
    return { ok: true, reason: "ok" };
  if (
    lastLine.length >= 40 ||
    /(?:すでに|ただし|また|そして|、|[はがをにでとのもやへ])$/.test(lastLine)
  )
    return {
      ok: false,
      reason: "long answer ends without terminal punctuation or closing structure",
    };
  return { ok: true, reason: "ok" };
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
