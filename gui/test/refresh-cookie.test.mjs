import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRefreshCookiePreflight } from "../dist/main/refresh-cookie.js";

const doctor = (lock, profileFree = true, extra = []) => `${JSON.stringify({ ok: lock.ok, items: [lock, { name: "profile.free", ok: profileFree, detail: profileFree ? "free" : "busy" }, ...extra] })}\n`;

test("refresh cookie refuses a live held lock", () => {
  assert.deepEqual(
    evaluateRefreshCookiePreflight(doctor({ name: "lock", ok: false, detail: "held: pid=123" })),
    { ok: false, reason: "A request is currently running; wait for it to finish before refreshing cookies" },
  );
});

test("refresh cookie permits an explicit no-lock result", () => {
  assert.deepEqual(evaluateRefreshCookiePreflight(doctor({ name: "lock", ok: true, detail: "no lock file" })), { ok: true });
});

test("refresh cookie permits only a reclaimable stale lock", () => {
  assert.deepEqual(evaluateRefreshCookiePreflight(doctor({ name: "lock", ok: true, warn: true, detail: "abandoned lock", lock: { stale: true, reclaimable: true } })), { ok: true });
  assert.equal(evaluateRefreshCookiePreflight(doctor({ name: "lock", ok: true, warn: true, detail: "owner alive", lock: { stale: true, reclaimable: false } })).ok, false);
});

test("refresh cookie refuses a busy profile even when no lock exists", () => {
  assert.equal(evaluateRefreshCookiePreflight(doctor({ name: "lock", ok: true, detail: "no lock file" }, false)).ok, false);
});

test("refresh cookie includes the process detail when doctor printed no JSON", () => {
  assert.deepEqual(
    evaluateRefreshCookiePreflight("", "exit 1: Error: Cannot find module 'C:\\bridge\\dist\\cli\\main.js'"),
    { ok: false, reason: "Could not verify the request lock: doctor --json returned no JSON (exit 1: Error: Cannot find module 'C:\\bridge\\dist\\cli\\main.js')" },
  );
});
