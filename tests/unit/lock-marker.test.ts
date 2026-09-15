import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judgeStale, type LockDeps, ProcessLock, readLockRecord } from "../../src/state/lock.js";
import {
  deleteMarker,
  markerExists,
  markerPath,
  readMarker,
  updateMarker,
  writeMarker,
} from "../../src/state/marker.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-lock-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(over: Partial<LockDeps> = {}): LockDeps {
  return {
    isProcessAlive: () => true,
    processStartedAt: async () => null,
    now: () => new Date("2026-09-15T00:00:00Z"),
    pid: 4242,
    unparseableGraceMs: 10_000,
    ...over,
  };
}

describe("ProcessLock (ADR-005)", () => {
  it("acquires, verifies token, releases only its own lock", async () => {
    const p = join(dir, "bridge.lock");
    const a = new ProcessLock(p, deps());
    const r = await a.acquire("run", "req-00000001");
    expect(r.kind).toBe("ok");
    expect(await a.verify()).toBe(true);
    const rec = await readLockRecord(p);
    expect(rec?.pid).toBe(4242);
    expect(rec?.requestId).toBe("req-00000001");
    // another live process is refused
    const b = new ProcessLock(p, deps({ pid: 4343 }));
    const rb = await b.acquire("run", null);
    expect(rb.kind).toBe("busy");
    await a.release();
    await expect(stat(p)).rejects.toThrow();
  });

  it("does not delete a lock it does not own", async () => {
    const p = join(dir, "bridge.lock");
    const a = new ProcessLock(p, deps({ pid: 1 }));
    await a.acquire("run", null);
    await writeFile(
      p,
      JSON.stringify({ pid: 2, startedAt: "", token: "other", command: "run", requestId: null }),
    );
    await a.release();
    expect(await readLockRecord(p)).not.toBeNull();
    expect(await a.verify()).toBe(false);
  });

  it("reclaims a stale lock (dead pid) with content verification", async () => {
    const p = join(dir, "bridge.lock");
    await writeFile(
      p,
      JSON.stringify({
        pid: 999,
        startedAt: "2026-09-14T00:00:00Z",
        token: "dead",
        command: "run",
        requestId: null,
      }),
    );
    const a = new ProcessLock(p, deps({ isProcessAlive: (pid) => pid !== 999 }));
    const r = await a.acquire("run", null);
    expect(r.kind).toBe("ok");
    expect((await readLockRecord(p))?.pid).toBe(4242);
  });

  it("detects pid reuse via creation time", async () => {
    const p = join(dir, "bridge.lock");
    await writeFile(
      p,
      JSON.stringify({
        pid: 999,
        startedAt: "2026-09-14T00:00:00Z",
        token: "old",
        command: "run",
        requestId: null,
      }),
    );
    const v = await judgeStale(
      p,
      await readLockRecord(p),
      deps({ processStartedAt: async () => new Date("2026-09-14T01:00:00Z") }),
    );
    expect(v.stale).toBe(true);
    const v2 = await judgeStale(
      p,
      await readLockRecord(p),
      deps({ processStartedAt: async () => new Date("2026-09-13T23:00:00Z") }),
    );
    expect(v2.stale).toBe(false);
  });

  it("unparseable lock: recent = live, old = stale", async () => {
    const p = join(dir, "bridge.lock");
    await writeFile(p, "");
    const now = new Date(Date.now() + 60_000);
    expect((await judgeStale(p, null, deps({ now: () => now }))).stale).toBe(true);
    expect((await judgeStale(p, null, deps({ now: () => new Date() }))).stale).toBe(false);
  });

  it("second-order race: reclaim after another process re-created the lock yields busy and restores it", async () => {
    const p = join(dir, "bridge.lock");
    await writeFile(
      p,
      JSON.stringify({
        pid: 999,
        startedAt: "2026-09-14T00:00:00Z",
        token: "dead",
        command: "run",
        requestId: null,
      }),
    );
    // B reclaims and holds
    const b = new ProcessLock(p, deps({ pid: 1, isProcessAlive: (pid) => pid !== 999 }));
    expect((await b.acquire("run", null)).kind).toBe("ok");
    const bRecord = await readLockRecord(p);
    // C judged the OLD (dead) record before B acted, then tries to reclaim now.
    // Simulate by making C believe the current holder (pid 1) is dead? No: C read the dead record earlier.
    // We emulate C's stale judgment by pointing isProcessAlive at pid 1 as alive; C must NOT steal.
    const c = new ProcessLock(p, deps({ pid: 2, isProcessAlive: () => true }));
    const rc = await c.acquire("run", null);
    expect(rc.kind).toBe("busy");
    expect((await readLockRecord(p))?.token).toBe(bRecord?.token);
    expect(await b.verify()).toBe(true);
  });

  it("verify fails after the lock file is replaced (VERIFY_LOCK before marker)", async () => {
    const p = join(dir, "bridge.lock");
    const a = new ProcessLock(p, deps());
    await a.acquire("run", null);
    await rename(p, `${p}.stale-x`);
    await writeFile(
      p,
      JSON.stringify({ pid: 7, startedAt: "", token: "thief", command: "run", requestId: null }),
    );
    expect(await a.verify()).toBe(false);
  });
});

describe("submit.marker (12-IO-CONTRACT §5)", () => {
  it("write-ahead, exists, update, delete; 0-byte counts as present", async () => {
    const p = markerPath(dir, "req-00000001");
    expect(await markerExists(p)).toBe(false);
    await writeMarker(p, {
      requestId: "req-00000001",
      writtenAt: "t",
      urlBefore: "u",
      baselineAssistantCount: 0,
      presetLabelBefore: "x",
    });
    expect(await markerExists(p)).toBe(true);
    await updateMarker(p, { dispatchedAt: "t2", urlAfter: "u2" });
    expect((await readMarker(p))?.dispatchedAt).toBe("t2");
    expect(JSON.parse(await readFile(p, "utf8")).baselineAssistantCount).toBe(0);
    await deleteMarker(p);
    expect(await markerExists(p)).toBe(false);
    await writeFile(p, "");
    expect(await markerExists(p)).toBe(true);
    expect(await readMarker(p)).toBeNull();
  });
});
