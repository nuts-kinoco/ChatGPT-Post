import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { aggregateState, scanRequests } from "../dist/main/state.js";

function request(requestId, requestMtimeMs) {
  return {
    requestId, caller: "—", project: "—", title: requestId,
    startedAt: "2026-09-25T00:00:00.000Z", completedAt: undefined, requestMtimeMs,
    terminalSortMs: undefined, hasResult: false, result: undefined,
  };
}

function heldDoctor(lock) {
  return { ok: false, items: [{ name: "lock", ok: false, detail: "held", ...(lock ? { lock } : {}) }] };
}

test("aggregateState keeps missing, malformed and unrecognized result statuses Unknown", () => {
  for (const result of [{}, { status: null }, { status: 42 }, { status: {} }, { status: "" }, { status: "running" }, { status: "future_status" }, { error: { code: "AUTH_REQUIRED" } }]) {
    const scanned = { ...request("request-unknown", 10), hasResult: true, result };
    const state = aggregateState(heldDoctor({ requestId: "request-unknown" }), [scanned]);
    assert.equal(state.requests[0].status, "Unknown", JSON.stringify(result));
  }
});

test("aggregateState preserves recognized terminal results and blocked failures", () => {
  const cases = [
    [{ status: "completed" }, "Completed"],
    [{ status: "manual_intervention_required" }, "Blocked"],
    [{ status: "failed" }, "Failed"],
    [{ status: "failed", error: { code: "INTERNAL_ERROR" } }, "Failed"],
    [{ status: "failed", error: { code: "INVALID_REQUEST" } }, "Failed"],
    ...["AUTH_REQUIRED", "CAPTCHA_OR_CHALLENGE", "RATE_LIMITED"].map(code => [{ status: "failed", error: { code } }, "Blocked"]),
  ];
  for (const [result, expected] of cases) {
    const state = aggregateState(heldDoctor({ requestId: "request-terminal" }), [
      { ...request("request-terminal", 10), hasResult: true, result },
    ]);
    assert.equal(state.requests[0].status, expected, JSON.stringify(result));
  }
});

test("scanRequests and aggregateState do not invent failure from an incomplete result object", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-gui-result-status-"));
  try {
    const directory = path.join(root, "request-result");
    await mkdir(directory);
    await writeFile(path.join(directory, "request.json"), JSON.stringify({ requestId: "request-result" }));
    await writeFile(path.join(directory, "result.json"), "{}");
    const scanned = await scanRequests(root);
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].hasResult, true);
    assert.equal(aggregateState(heldDoctor({ requestId: "request-result" }), scanned).requests[0].status, "Unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aggregateState prefers a matching structured lock requestId over newest result-less request", () => {
  const state = aggregateState(heldDoctor({ requestId: "request-old" }), [
    request("request-old", 10), request("request-new", 20),
  ]);
  assert.deepEqual(state.requests.map(({ requestId, status }) => ({ requestId, status })), [
    { requestId: "request-old", status: "Running" },
    { requestId: "request-new", status: "Unknown" },
  ]);
});

test("aggregateState falls back to newest result-less request for absent or unmatched lock requestId", () => {
  for (const lock of [undefined, { requestId: "not-scanned" }]) {
    const state = aggregateState(heldDoctor(lock), [request("request-old", 10), request("request-new", 20)]);
    assert.deepEqual(state.requests.map((item) => item.status), ["Unknown", "Running"]);
  }
});

test("scanRequests uses a valid request.json requestId rather than its directory name", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-gui-state-"));
  try {
    const directory = path.join(root, "directory-id");
    await mkdir(directory);
    await writeFile(path.join(directory, "request.json"), JSON.stringify({ requestId: "canonical-id" }));
    const malformedDirectory = path.join(root, "malformed-id");
    await mkdir(malformedDirectory);
    await writeFile(path.join(malformedDirectory, "request.json"), "{");
    const scanned = await scanRequests(root);
    assert.deepEqual(scanned.map((request) => request.requestId).sort(), ["canonical-id", "malformed-id"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
