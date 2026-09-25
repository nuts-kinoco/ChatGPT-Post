import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRefreshCookiePreflight } from "../dist/main/refresh-cookie.js";

const doctor = (lock) => `${JSON.stringify({ ok: lock.ok, items: [lock] })}\n`;

test("refresh cookie refuses a live held lock", () => {
  assert.deepEqual(
    evaluateRefreshCookiePreflight(doctor({ name: "lock", ok: false, detail: "held: pid=123" })),
    { ok: false, reason: "A request is currently running; wait for it to finish before refreshing cookies" },
  );
});

test("refresh cookie permits a free or stale-warning lock", () => {
  assert.deepEqual(evaluateRefreshCookiePreflight(doctor({ name: "lock", ok: true, detail: "no lock file" })), { ok: true });
  assert.deepEqual(evaluateRefreshCookiePreflight(doctor({ name: "lock", ok: true, warn: true, detail: "abandoned lock" })), { ok: true });
});
