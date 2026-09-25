import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  judgeStale,
  type LockDeps,
  ProcessLock,
  readLockRecord,
  unlockReclaimableStale,
} from "../../src/state/lock.js";
import {
  deleteMarker,
  markerExists,
  markerPath,
  readMarker,
  updateMarker,
  writeMarker,
} from "../../src/state/marker.js";
import { stopRequestPath, writeStopRequest } from "../../src/state/stop-request.js";

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
    hostname: "test-host",
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

  it("hard-watchdog synchronous release deletes only its exact token and PID", async () => {
    const p = join(dir, "bridge.lock");
    const a = new ProcessLock(p, deps({ pid: 1 }));
    expect((await a.acquire("run", null)).kind).toBe("ok");
    expect(a.releaseSync()).toBe(true);
    await expect(stat(p)).rejects.toThrow();

    expect((await a.acquire("run", null)).kind).toBe("ok");
    await writeFile(
      p,
      JSON.stringify({
        pid: 1,
        startedAt: "",
        token: "replacement",
        command: "run",
        requestId: null,
      }),
    );
    expect(a.releaseSync()).toBe(false);
    expect((await readLockRecord(p))?.token).toBe("replacement");
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

  it("classifies a live owner with an expired lease as abandoned but never auto-reclaims it", async () => {
    const p = join(dir, "bridge.lock");
    await writeFile(
      p,
      JSON.stringify({
        pid: 999,
        startedAt: "2026-09-14T00:00:00Z",
        heartbeatAt: "2026-09-14T00:00:00Z",
        token: "hung",
        command: "run",
        requestId: null,
        hostname: "test-host",
      }),
    );
    const d = deps({ staleHeartbeatMs: 1, isProcessAlive: () => true });
    const verdict = await judgeStale(p, await readLockRecord(p), d);
    expect(verdict).toMatchObject({ stale: true, reclaimable: false });
    const contender = await new ProcessLock(p, d).acquire("run", null);
    expect(contender.kind).toBe("busy");
    const explicit = await unlockReclaimableStale(p, d);
    expect(explicit.ok).toBe(false);
    expect(await readLockRecord(p)).toMatchObject({ token: "hung" });
  });

  it("renews its lease and stops its unref'ed heartbeat when released", async () => {
    let tick = 0;
    const p = join(dir, "bridge.lock");
    const lock = new ProcessLock(
      p,
      deps({ now: () => new Date(`2026-09-15T00:00:0${tick++}Z`), heartbeatMs: 0 }),
    );
    expect((await lock.acquire("run", null)).kind).toBe("ok");
    const before = (await readLockRecord(p))?.heartbeatAt;
    expect(await lock.heartbeat()).toBe(true);
    expect((await readLockRecord(p))?.heartbeatAt).not.toBe(before);
    await lock.release();
    expect(await lock.heartbeat()).toBe(false);
  });

  it("keeps renewing after one transient unreadable lock read", async () => {
    const p = join(dir, "bridge.lock");
    const lock = new ProcessLock(p, deps({ heartbeatMs: 60_000 }));
    expect((await lock.acquire("run", null)).kind).toBe("ok");
    const owned = await readLockRecord(p);
    await unlink(p); // Windows sharing/read failure is represented as null by readLockRecord
    expect(await lock.heartbeat()).toBe(false);
    expect((lock as unknown as { heartbeatTimer: unknown }).heartbeatTimer).not.toBeNull();
    await writeFile(p, JSON.stringify(owned));
    expect(await lock.heartbeat()).toBe(true);
    await lock.release();
  });

  it("harness: killing a detached submit parent does not kill its child, which completes and releases its lock", async () => {
    const lock = join(dir, "child.lock");
    const done = join(dir, "child.done");
    const childCode = `const fs=require('node:fs'); const lock=${JSON.stringify(lock)}; const done=${JSON.stringify(done)}; fs.writeFileSync(lock, JSON.stringify({pid:process.pid,token:'child',startedAt:new Date().toISOString(),heartbeatAt:new Date().toISOString()})); const t=setInterval(()=>fs.writeFileSync(lock, JSON.stringify({pid:process.pid,token:'child',startedAt:new Date().toISOString(),heartbeatAt:new Date().toISOString()})),20); setTimeout(()=>{clearInterval(t); fs.unlinkSync(lock); fs.writeFileSync(done,'done');},120);`;
    const parentCode = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'}); c.unref(); process.stdout.write(String(c.pid)); setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ["-e", parentCode], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let childPid: number | undefined;
    try {
      const childPidText = await new Promise<string>((resolve, reject) => {
        parent.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString()));
        parent.once("error", reject);
      });
      childPid = Number.parseInt(childPidText, 10);
      parent.kill("SIGKILL");

      let childDone = false;
      let lockReleased = false;
      for (let i = 0; i < 250 && !(childDone && lockReleased); i++) {
        try {
          childDone = (await readFile(done, "utf8")) === "done";
        } catch {
          childDone = false;
        }
        try {
          await stat(lock);
          lockReleased = false;
        } catch {
          lockReleased = true;
        }
        if (!(childDone && lockReleased)) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(await readFile(done, "utf8")).toBe("done");
      await expect(stat(lock)).rejects.toThrow();
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The detached child normally exits before cleanup reaches this point.
        }
      }
    }
  });

  it("harness: a hard-killed child leaves a dead-PID lock that doctor policy can reclaim", async () => {
    const p = join(dir, "hard-killed.lock");
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(p)}, JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),heartbeatAt:new Date().toISOString(),token:'hard-killed',command:'run',requestId:null,hostname:'test-host'})); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", childCode], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        await stat(p);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const d = deps({ isProcessAlive: () => false });
    // On Windows a just-exited child's closed file can briefly be unreadable.  The production
    // policy intentionally treats an unreadable *recent* lock as live; wait for the fixture's
    // already-written JSON rather than accidentally testing that conservative fallback.
    let record = await readLockRecord(p);
    for (let i = 0; record === null && i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      record = await readLockRecord(p);
    }
    expect(record).not.toBeNull();
    if (!record) throw new Error("hard-killed child lock never became readable");
    const verdict = await judgeStale(p, record, d);
    expect(verdict).toMatchObject({ stale: true, reclaimable: true });
    expect((await unlockReclaimableStale(p, d)).ok).toBe(true);
    await expect(stat(p)).rejects.toThrow();
  });

  it("removes the reclaimed owner's stop.request as best-effort stale-lock hygiene", async () => {
    const runtimeDir = join(dir, "runtime");
    const stateDir = join(runtimeDir, "state");
    const p = join(runtimeDir, "locks", "bridge.lock");
    const requestId = "req-stale-reclaim";
    await mkdir(join(runtimeDir, "locks"), { recursive: true });
    await writeFile(
      p,
      JSON.stringify({
        pid: 999,
        startedAt: "2026-09-14T00:00:00Z",
        token: "dead-owner-token",
        command: "run",
        requestId,
        hostname: "test-host",
      }),
    );
    const requestPath = stopRequestPath(stateDir, requestId);
    await writeStopRequest(requestPath, {
      token: "dead-owner-token",
      requestedAt: "2026-09-15T00:00:00.000Z",
    });

    const result = await unlockReclaimableStale(p, deps({ isProcessAlive: () => false }), stateDir);
    expect(result.ok).toBe(true);
    await expect(stat(requestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("A-108: a lock held by another hostname is never treated as stale, even if the pid doesn't exist here", async () => {
    const p = join(dir, "bridge.lock");
    await writeFile(
      p,
      JSON.stringify({
        pid: 117856,
        startedAt: "2026-09-16T00:00:00Z",
        token: "win-host",
        command: "run",
        requestId: null,
        hostname: "NAT-PC",
      }),
    );
    // this machine has no pid 117856 at all — a naive same-host check would call it dead
    const v = await judgeStale(
      p,
      await readLockRecord(p),
      deps({ hostname: "mac-mini.local", isProcessAlive: () => false }),
    );
    expect(v.stale).toBe(false);
    expect(v.reason).toContain("NAT-PC");
    // a record with no hostname (pre-A-108 lock file) keeps the old same-machine behavior
    const legacy = { pid: 999, startedAt: "", token: "t", command: "run", requestId: null };
    await writeFile(p, JSON.stringify(legacy));
    const v2 = await judgeStale(
      p,
      await readLockRecord(p),
      deps({ hostname: "mac-mini.local", isProcessAlive: () => false }),
    );
    expect(v2.stale).toBe(true);
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

  it("A-119 (Phase 0-B-3, ChatGPT Pro redesign review §3): a lock acquired by a fourth process during the reclaim window is never clobbered by the restore-on-mismatch step", async () => {
    const p = join(dir, "bridge.lock");
    const oldRecord = {
      pid: 999,
      startedAt: "2026-09-14T00:00:00Z",
      token: "dead",
      command: "run",
      requestId: null,
    };
    await writeFile(p, JSON.stringify(oldRecord));
    const cRecord = JSON.stringify({
      pid: 111,
      startedAt: "2026-09-15T00:00:00Z",
      token: "actor-c",
      command: "run",
      requestId: null,
    });
    const dRecord = {
      pid: 222,
      startedAt: "2026-09-15T00:00:01Z",
      token: "actor-d",
      command: "run",
      requestId: null,
    };
    const b = new ProcessLock(
      p,
      deps({
        pid: 1,
        // fires during judgeStale, *before* the rename below: simulates actor C successfully
        // creating a live lock at `p` right after B read the old record but before B moved it
        // aside, so what actually gets renamed to stalePath is C's record, not the one B judged.
        isProcessAlive: (pid) => {
          if (pid === 999) {
            writeFileSync(p, cRecord);
            return false; // the OLD record's pid is still reported dead; B proceeds to reclaim
          }
          return true;
        },
        // fires right after the rename (p is now empty): simulates actor D creating its own live
        // lock in the narrow window before B's mismatch-restore step runs.
        afterStaleRename: () => {
          writeFileSync(p, JSON.stringify(dRecord));
        },
      }),
    );
    const r = await b.acquire("run", null);
    expect(r.kind).toBe("busy");
    // D's lock must survive untouched — this is the property the old blind rename(stalePath, p)
    // broke.
    const finalRecord = await readLockRecord(p);
    expect(finalRecord?.token).toBe("actor-d");
    // C's orphaned copy is preserved on disk (for doctor/manual cleanup), not silently discarded.
    const entries = await readdir(dir);
    expect(entries.some((f) => f.startsWith(`${basename(p)}.stale-`))).toBe(true);
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
