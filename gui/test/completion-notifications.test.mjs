import assert from "node:assert/strict";
import test from "node:test";
import { terminalTransitionsSinceLastPoll } from "../dist/main/completion-notifications.js";

function request(requestId, status) {
  return { requestId, status, caller: "", project: "", title: requestId, startedAt: "2026-09-25T00:00:00.000Z", completedAt: undefined, requestMtimeMs: 0, terminalSortMs: undefined };
}

test("terminal transitions ignore the initial state snapshot", () => {
  assert.deepEqual(terminalTransitionsSinceLastPoll(undefined, [request("already-done", "Completed")]), []);
});

test("terminal transitions report each observed non-terminal to terminal change", () => {
  const transitions = terminalTransitionsSinceLastPoll(
    [request("complete", "Running"), request("failed", "Unknown"), request("blocked", "Running")],
    [request("complete", "Completed"), request("failed", "Failed"), request("blocked", "Blocked")],
  );
  assert.deepEqual(transitions.map(({ requestId, status }) => ({ requestId, status })), [
    { requestId: "complete", status: "Completed" },
    { requestId: "failed", status: "Failed" },
    { requestId: "blocked", status: "Blocked" },
  ]);
});

test("terminal requests do not repeat and newly discovered terminal requests are not inferred transitions", () => {
  const transitions = terminalTransitionsSinceLastPoll(
    [request("already-done", "Completed"), request("still-running", "Running")],
    [request("already-done", "Completed"), request("newly-discovered", "Completed"), request("still-running", "Running")],
  );
  assert.deepEqual(transitions, []);
});
