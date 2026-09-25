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
