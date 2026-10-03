/** Parse named runner summaries only; never confuse skipped files with skipped tests. */
import { stripVTControlCharacters } from "node:util";
const count = (value) =>
  /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
export function parseTestSummary(output) {
  const lines = stripVTControlCharacters(output).split(/\r?\n/);
  const vitest = lines.filter((line) => /^\s*Tests(?:\s|$)/.test(line)).at(-1);
  if (vitest) {
    let body = vitest.trim().replace(/^Tests\s+/, "");
    const totalMatch = body.match(/\s+\((\d+)\)$/);
    let declared = null;
    if (totalMatch) {
      declared = count(totalMatch[1]);
      body = body.slice(0, totalMatch.index);
      if (declared === null) return null;
    }
    const result = {
        format: "vitest",
        passed: 0,
        failed: 0,
        skipped: 0,
        cancelled: 0,
        todo: 0,
        total: 0,
      },
      seen = new Set();
    for (const part of body.split(/\s*\|\s*/)) {
      const m = part.match(/^(\d+) (passed|failed|skipped|todo)$/);
      if (!m || seen.has(m[2])) return null;
      const n = count(m[1]);
      if (n === null) return null;
      seen.add(m[2]);
      result[m[2]] = n;
    }
    result.total = result.passed + result.failed + result.skipped + result.todo;
    return Number.isSafeInteger(result.total) && (declared === null || declared === result.total)
      ? result
      : null;
  }
  let node = {},
    nodeStarted = false,
    nodeInvalid = false;
  for (const line of lines) {
    if (/^\s*(?:#|ℹ)?\s*tests(?:\s|$)/.test(line)) {
      node = {};
      nodeStarted = true;
      nodeInvalid = false;
    }
    const m = line.match(/^\s*(?:#|ℹ)?\s*(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/);
    if (m && nodeStarted) {
      if (Object.hasOwn(node, m[1])) nodeInvalid = true;
      node[m[1]] = count(m[2]);
    }
  }
  if (nodeInvalid) return null;
  if (
    ["tests", "pass", "fail", "cancelled", "skipped", "todo"].every(
      (k) => node[k] !== undefined && node[k] !== null,
    )
  ) {
    const total = node.pass + node.fail + node.cancelled + node.skipped + node.todo;
    return Number.isSafeInteger(total) && total === node.tests
      ? {
          format: "node-test",
          passed: node.pass,
          failed: node.fail,
          skipped: node.skipped,
          cancelled: node.cancelled,
          todo: node.todo,
          total,
        }
      : null;
  }
  if (nodeStarted) return null;
  const compiled = lines
    .filter((line) =>
      /^\d+ compiled (?:issuer CLI|CLI lifecycle) cases passed; (?:inert ports|fake deployment) only$/.test(
        line,
      ),
    )
    .at(-1);
  if (compiled) {
    const n = count(compiled.split(" ")[0]);
    if (n !== null)
      return {
        format: "compiled-fixture",
        passed: n,
        failed: 0,
        skipped: 0,
        cancelled: 0,
        todo: 0,
        total: n,
      };
  }
  return null;
}
export function repositoryRootIdentity(expectedRoot, topLevel, canonicalize) {
  if (topLevel.status !== 0 || typeof topLevel.stdout !== "string" || !topLevel.stdout.trim())
    return "unavailable";
  try {
    return canonicalize(expectedRoot) === canonicalize(topLevel.stdout.trim())
      ? "matched"
      : "mismatch";
  } catch {
    return "unavailable";
  }
}
export function sourceMetadata(head, status, rootIdentity = "unavailable") {
  if (rootIdentity !== "matched")
    return {
      sourceHead: null,
      dirty: null,
      sourceState: rootIdentity === "mismatch" ? "root_mismatch" : "unavailable",
    };
  const sha = head.status === 0 && typeof head.stdout === "string" ? head.stdout.trim() : "";
  const sourceHead = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : null;
  const dirty =
    sourceHead !== null && status.status === 0 && typeof status.stdout === "string"
      ? Boolean(status.stdout.trim())
      : null;
  return {
    sourceHead,
    dirty,
    sourceState:
      sourceHead === null
        ? "unavailable"
        : dirty === null
          ? "head_only"
          : dirty
            ? "dirty"
            : "clean",
  };
}
export function phaseOutcome(status, errorCode, expectsTests, summary) {
  const invalid = expectsTests && (!summary || summary.total === 0);
  const failed = status !== 0 || (summary && (summary.failed > 0 || summary.cancelled > 0));
  return {
    state:
      errorCode || invalid
        ? "blocked"
        : failed
          ? "failed"
          : summary && (summary.skipped > 0 || summary.todo > 0)
            ? "passed_with_skips"
            : "passed",
    passed: summary?.passed ?? null,
    skipped: expectsTests ? (summary?.skipped ?? null) : 0,
    failed: summary?.failed ?? null,
    cancelled: summary?.cancelled ?? null,
    todo: summary?.todo ?? null,
    summaryFormat: summary?.format ?? null,
    error: errorCode ?? (invalid ? "test_summary_unavailable" : null),
  };
}
export const OFFLINE_VERIFICATION_ENV = Object.freeze({
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  BRIDGE_LIVE: "0",
});
