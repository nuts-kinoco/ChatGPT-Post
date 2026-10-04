/**
 * Test-only: bounded, secret-safe diagnosis of a child CLI that failed before or instead of its marker.
 * The output is built only from structured fields. Raw stdout/stderr are never echoed; callers keep them
 * unchanged for their own leak assertions. Unknown error codes are omitted, never printed.
 */
import { readFile } from "node:fs/promises";

export const DIAGNOSTIC_LIMIT = 2048;
// Finite codes the compiled CLIs emit on stderr (src/cli/bus.ts, src/cli/sdk-text.ts, deployment loader).
export const ALLOWED_ERROR_CODES = Object.freeze([
  "bus_operation_failed",
  "lane_tick_failed",
  "sdk_text_operation_failed",
  "sdk_text_drain_pending",
  "deployment_startup_aborted",
  "deployment_windows_acl_verifier_unavailable",
  "registry_windows_acl_verifier_unavailable",
  "text_host_profile_invalid",
]);
const allowed = new Set(ALLOWED_ERROR_CODES);

/** Final marker read: call only after the child has closed. */
export async function readMarker(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { state: error?.code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    return { state: "ok", value: JSON.parse(text) };
  } catch {
    return { state: "invalid" };
  }
}

function stderrCodes(stderr) {
  const known = [];
  let unknown = 0;
  let unstructured = 0;
  for (const line of String(stderr ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      unstructured++;
      continue;
    }
    const code = parsed && typeof parsed === "object" ? parsed.error : undefined;
    if (typeof code === "string" && allowed.has(code)) {
      if (!known.includes(code)) known.push(code);
    } else unknown++;
  }
  return { known: known.slice(0, 4), unknown, unstructured };
}

const safe = (value, pattern, fallback) =>
  typeof value === "string" && pattern.test(value) ? value : fallback;

/** Short structured diagnosis, at most DIAGNOSTIC_LIMIT characters. */
export function describeChild({ label, spawnError, code, signal, timedOut, marker, stderr }) {
  const codes = stderrCodes(stderr);
  const parts = [
    `child_diagnostic label=${safe(label, /^[A-Za-z0-9_./:-]{1,80}$/, "omitted")}`,
    `spawn=${spawnError === undefined || spawnError === null ? "none" : safe(spawnError?.code, /^E[A-Z0-9]{2,15}$/, "other")}`,
    `exit=${Number.isInteger(code) ? code : "none"}`,
    `signal=${signal ? safe(signal, /^SIG[A-Z0-9]{2,10}$/, "other") : "none"}`,
    `timeout=${timedOut === true}`,
    `marker=${safe(marker?.state, /^(ok|missing|invalid|unreadable)$/, "unknown")}`,
    `stderr_codes=${codes.known.length ? codes.known.join(",") : "none"}`,
    `stderr_unknown_omitted=${codes.unknown}`,
    `stderr_unstructured_omitted=${codes.unstructured}`,
    `stderr_bytes=${Buffer.byteLength(String(stderr ?? ""))}`,
  ];
  const text = parts.join(" ");
  return text.length <= DIAGNOSTIC_LIMIT ? text : `${text.slice(0, DIAGNOSTIC_LIMIT - 1)}…`;
}

/**
 * Wait for a spawned child. The outcome is settled only after `close` (stdio drained, process ended), so a
 * final marker read can never race a still-running child. A spawn `error` is kept, not thrown, and never
 * replaces the close wait; only when no process was ever created (pid undefined) is `close` given a short
 * grace before the kept error is reported. `failed()` is a non-blocking early-failure probe for readiness loops.
 */
export function waitForChild(child, { timeoutMs = 8000, spawnFailureGraceMs = 2000 } = {}) {
  let spawnError;
  let timedOut = false;
  let ended = false;
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null && !ended) {
      timedOut = true;
      child.kill("SIGKILL");
    }
  }, timeoutMs);
  child.once("exit", () => {
    ended = true;
  });
  const settled = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      if (child.pid === undefined) {
        ended = true;
        setTimeout(() => resolve({ code: null, signal: null }), spawnFailureGraceMs);
      }
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    result: settled.then((r) => {
      clearTimeout(timer);
      return { ...r, spawnError, timedOut };
    }),
    failed: () => ended || spawnError !== undefined,
    dispose: () => clearTimeout(timer),
  };
}
