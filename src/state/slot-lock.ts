/**
 * Phase 3 MVP (`docs/23-DURABLE-BRIDGE-PHASES.md`): the scope the user chose is the minimal one —
 * a "generation slot" and a "Page slot" are treated as the same resource, unlike the fuller
 * generation/Page/browser slot separation §6.1 of the redesign review describes. Concurrency is
 * just "up to N `run`s may hold a slot at once", where N is `CHATGPT_BRIDGE_MAX_CONCURRENCY`.
 *
 * This reuses `ProcessLock` verbatim as N independent lock files (`<basePath>.slot0` ..
 * `<basePath>.slot{N-1}`) instead of inventing a new concurrency primitive: `ProcessLock` already
 * has the O_EXCL create, owner-token, and stale-PID-recovery protocol this needs, battle-tested by
 * every other lock in this codebase (A-116/A-119/A-120).
 */
import {
  defaultLockDeps,
  judgeStale,
  type LockDeps,
  type LockRecord,
  ProcessLock,
  readLockRecord,
} from "./lock.js";

export function slotPath(basePath: string, index: number): string {
  return `${basePath}.slot${index}`;
}

export interface AcquiredSlot {
  index: number;
  lock: ProcessLock;
}

export type SlotAcquireOutcome =
  | { kind: "ok"; slot: AcquiredSlot }
  | { kind: "busy"; cause: string };

/** Tries slots 0..slots-1 in order and returns the first one this call manages to acquire. */
export async function acquireSlot(
  basePath: string,
  slots: number,
  command: string,
  requestId: string | null,
  deps: LockDeps = defaultLockDeps,
): Promise<SlotAcquireOutcome> {
  const causes: string[] = [];
  for (let i = 0; i < slots; i++) {
    const lock = new ProcessLock(slotPath(basePath, i), deps);
    const res = await lock.acquire(command, requestId);
    if (res.kind === "ok") return { kind: "ok", slot: { index: i, lock } };
    causes.push(`slot ${i}: ${res.cause}`);
  }
  return { kind: "busy", cause: `all ${slots} generation slots busy (${causes.join("; ")})` };
}

export interface AcquiredBarrier {
  locks: ProcessLock[];
}

export type BarrierAcquireOutcome =
  | { kind: "ok"; barrier: AcquiredBarrier }
  | { kind: "busy"; cause: string };

/**
 * Opus review of A-136, High#1: a generation slot pool alone gives pooled `run`s mutual exclusion
 * against *each other*, but nothing that only ever touched the single `bridge.lock` (`login`,
 * `doctor`, `inspect-ui`, and the daemon's own keepalive tick) would still be excluded from a
 * pooled `run` in flight — they'd happily attach with the old "reuse whatever's open" `getUsablePage()`
 * and navigate/close a tab a concurrent generation is actively using. Acquiring *every* slot at once
 * (a barrier over the whole pool) gives those callers the same "nothing else is touching the browser
 * right now" guarantee `bridge.lock` used to, without requiring them to know which specific slot(s)
 * are in use. Never holds a partial barrier: any slot it can't get, it releases whatever it already
 * grabbed and reports busy.
 */
export async function acquireAllSlots(
  basePath: string,
  slots: number,
  command: string,
  requestId: string | null,
  deps: LockDeps = defaultLockDeps,
): Promise<BarrierAcquireOutcome> {
  const held: ProcessLock[] = [];
  for (let i = 0; i < slots; i++) {
    const lock = new ProcessLock(slotPath(basePath, i), deps);
    const res = await lock.acquire(command, requestId);
    if (res.kind !== "ok") {
      for (const h of held) await h.release();
      return { kind: "busy", cause: `slot ${i} busy: ${res.cause}` };
    }
    held.push(lock);
  }
  return { kind: "ok", barrier: { locks: held } };
}

export async function releaseAllSlots(barrier: AcquiredBarrier): Promise<void> {
  for (const lock of barrier.locks) await lock.release();
}

export async function verifyAllSlots(barrier: AcquiredBarrier): Promise<boolean> {
  for (const lock of barrier.locks) {
    if (!(await lock.verify())) return false;
  }
  return true;
}

/**
 * Read-only: mirrors `cli/submit.ts`'s pre-existing single-lock busy check (`checkLockBusy`),
 * extended to a pool. Returns null (free) as soon as any one slot looks unheld or stale; never
 * acquires anything, so it can't itself race a real `acquireSlot()` call into a false "busy".
 */
export async function checkSlotsBusy(
  basePath: string,
  slots: number,
  deps: Pick<LockDeps, "isProcessAlive" | "processStartedAt" | "now" | "pid" | "hostname">,
): Promise<string | null> {
  const fullDeps: LockDeps = { ...deps, unparseableGraceMs: 10_000 };
  const busyReasons: string[] = [];
  for (let i = 0; i < slots; i++) {
    const path = slotPath(basePath, i);
    const record: LockRecord | null = await readLockRecord(path);
    const verdict = await judgeStale(path, record, fullDeps);
    // A live process with an expired heartbeat is diagnostic-only abandoned: it is
    // deliberately not a free slot, because acquiring would just spawn a child that
    // immediately loses ALREADY_RUNNING to the still-owned lock.
    if (verdict.stale && verdict.reclaimable) return null; // this slot is free
    busyReasons.push(`slot ${i}: ${verdict.reason}`);
  }
  return `all ${slots} generation slots busy (${busyReasons.join("; ")})`;
}
