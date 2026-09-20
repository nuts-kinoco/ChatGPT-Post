import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LockDeps } from "../../src/state/lock.js";
import { acquireSlot, checkSlotsBusy, slotPath } from "../../src/state/slot-lock.js";

let dir: string;
let basePath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-slot-lock-"));
  basePath = join(dir, "bridge.lock");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(over: Partial<LockDeps> = {}): LockDeps {
  return {
    isProcessAlive: () => true,
    processStartedAt: async () => null,
    now: () => new Date("2026-09-19T00:00:00Z"),
    pid: 4242,
    hostname: "test-host",
    unparseableGraceMs: 10_000,
    ...over,
  };
}

describe("acquireSlot (Phase 3 MVP, A-136)", () => {
  it("acquires slot 0 first when the pool is entirely free", async () => {
    const res = await acquireSlot(basePath, 3, "run", "req-1", deps());
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.slot.index).toBe(0);
    expect(res.slot.lock.path).toBe(slotPath(basePath, 0));
  });

  it("skips slots already held by a live owner and lands on the first free one", async () => {
    const first = await acquireSlot(basePath, 3, "run", "req-1", deps({ pid: 100 }));
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    expect(first.slot.index).toBe(0);

    const second = await acquireSlot(basePath, 3, "run", "req-2", deps({ pid: 200 }));
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    expect(second.slot.index).toBe(1); // slot 0 is busy (pid 100, alive)
  });

  it("reports busy only once every slot in the pool is genuinely held", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await acquireSlot(basePath, 2, "run", `req-${i}`, deps({ pid: 100 + i }));
      expect(res.kind).toBe("ok");
    }
    const third = await acquireSlot(basePath, 2, "run", "req-overflow", deps({ pid: 999 }));
    expect(third.kind).toBe("busy");
    if (third.kind !== "busy") return;
    expect(third.cause).toMatch(/all 2 generation slots busy/);
  });

  it("reclaims a slot whose owner is dead (stale) instead of reporting it busy", async () => {
    const first = await acquireSlot(basePath, 2, "run", "req-1", deps({ pid: 100 }));
    expect(first.kind).toBe("ok");
    // simulate the owning process dying: isProcessAlive now says pid 100 is gone
    const second = await acquireSlot(
      basePath,
      2,
      "run",
      "req-2",
      deps({ pid: 200, isProcessAlive: (pid) => pid !== 100 }),
    );
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    expect(second.slot.index).toBe(0); // reclaimed, not skipped to slot 1
  });

  it("releasing a slot frees exactly that index for a later acquire", async () => {
    const a = await acquireSlot(basePath, 2, "run", "req-a", deps({ pid: 100 }));
    const b = await acquireSlot(basePath, 2, "run", "req-b", deps({ pid: 200 }));
    expect(a.kind === "ok" && b.kind === "ok").toBe(true);
    if (a.kind !== "ok" || b.kind !== "ok") return;
    await a.slot.lock.release();
    const c = await acquireSlot(basePath, 2, "run", "req-c", deps({ pid: 300 }));
    expect(c.kind).toBe("ok");
    if (c.kind !== "ok") return;
    expect(c.slot.index).toBe(0); // the one just released, not slot 1 (still held by b)
  });
});

describe("checkSlotsBusy (Phase 3 MVP, A-136)", () => {
  it("returns null (free) when the pool has never been used", async () => {
    expect(await checkSlotsBusy(basePath, 3, deps())).toBeNull();
  });

  it("returns null as soon as any one slot is free, even if others are held", async () => {
    await acquireSlot(basePath, 3, "run", "req-1", deps({ pid: 100 }));
    await acquireSlot(basePath, 3, "run", "req-2", deps({ pid: 200 }));
    // slot 2 still free
    expect(await checkSlotsBusy(basePath, 3, deps())).toBeNull();
  });

  it("reports busy only when every slot is held by a live owner", async () => {
    await acquireSlot(basePath, 2, "run", "req-1", deps({ pid: 100 }));
    await acquireSlot(basePath, 2, "run", "req-2", deps({ pid: 200 }));
    const busy = await checkSlotsBusy(basePath, 2, deps());
    expect(busy).toMatch(/all 2 generation slots busy/);
  });

  it("never acquires anything (read-only): a slot it reports busy can still be acquired by someone else's stale-reclaim logic", async () => {
    await acquireSlot(basePath, 1, "run", "req-1", deps({ pid: 100 }));
    await checkSlotsBusy(basePath, 1, deps());
    // still held by pid 100 -> reclaim still requires isProcessAlive(100) === false
    const attempt = await acquireSlot(basePath, 1, "run", "req-2", deps({ pid: 200 }));
    expect(attempt.kind).toBe("busy");
  });
});
