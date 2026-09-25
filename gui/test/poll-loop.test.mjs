import assert from "node:assert/strict";
import test from "node:test";
import { startPollLoop } from "../dist/main/poll-loop.js";

test("startPollLoop never overlaps a slow task and schedules only after it settles", async () => {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  let release;
  const scheduled = [];
  const stop = startPollLoop(async () => {
    active++; runs++; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => { release = resolve; });
    active--;
  }, 3_000, (fn) => { scheduled.push(fn); return 0; });
  assert.equal(runs, 1);
  assert.equal(scheduled.length, 0, "next tick must not be scheduled while the task is in flight");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  assert.equal(runs, 2);
  assert.equal(maxActive, 1);
  stop();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1, "a stopped loop schedules nothing further");
});

test("startPollLoop keeps polling after a rejected task", async () => {
  const scheduled = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    startPollLoop(async () => { throw new Error("boom"); }, 10, (fn) => { scheduled.push(fn); return 0; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduled.length, 1);
  } finally { console.warn = warn; }
});
