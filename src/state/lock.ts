import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { deleteStopRequest, stopRequestPath } from "./stop-request.js";

export interface LockRecord {
  pid: number;
  startedAt: string;
  token: string;
  command: string;
  requestId: string | null;
  /** A-108: empty string for pre-A-108 lock files (treated as "unknown host", falls back to the
   * old same-machine PID check below — never breaks locks a human already had on disk). */
  hostname: string;
  /** Last owner lease renewal. Legacy locks retain PID-only liveness semantics. */
  heartbeatAt?: string;
  /** OS process creation time captured at acquire; protects against PID reuse. */
  processStartedAt?: string | null;
}

export interface LockDeps {
  /** process.kill(pid, 0) semantics: true if the process exists. */
  isProcessAlive: (pid: number) => boolean;
  /** Process creation time via WMI (best-effort). null when unknown. */
  processStartedAt: (pid: number) => Promise<Date | null>;
  now: () => Date;
  pid: number;
  /** A-108: os.hostname() of this machine — see judgeStale's foreign-host branch. */
  hostname: string;
  /** Empty / unparseable lock files younger than this are treated as live. */
  unparseableGraceMs: number;
  /** Renewal period; the timer is unref'ed and cannot keep a terminal run alive. */
  heartbeatMs?: number;
  /** A lease older than this is abandoned, but live owners require explicit recovery. */
  staleHeartbeatMs?: number;
  /** A-119: test-only seam, fired right after the stale lock is renamed aside and before the
   * moved-vs-judged comparison. Lets a test deterministically land a *fourth* process's write at
   * `this.path` inside the exact window the redesign review flagged (§"stale lock recovery に所有権競合"),
   * instead of relying on real timing-dependent concurrency. No-op by default. */
  afterStaleRename?: () => Promise<void> | void;
}

export type AcquireOutcome =
  | { kind: "ok"; record: LockRecord }
  | { kind: "busy"; cause: string; holder: LockRecord | null };

export type StaleVerdict =
  | { stale: true; reason: string; reclaimable: boolean }
  | { stale: false; reason: string };

export const defaultLockDeps: LockDeps = {
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  // A-122 (Phase 0-B-6, ChatGPT Pro redesign review §3): this used to unconditionally return null
  // on macOS/Linux, so verifyOwnedProcess()/judgeStale() on those platforms fell back to a bare
  // "PID is alive" check that cannot distinguish our own process from an unrelated one that has
  // since reused the same PID. `ps -o lstart=` (supported by both BSD/macOS and Linux/procps ps)
  // gives the same PID-reuse guard Windows already had via WMI's CreationDate.
  processStartedAt: async (pid) => {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      if (process.platform === "win32") {
        const { stdout } = await run(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.floor(pid)}").CreationDate.ToUniversalTime().ToString("o")`,
          ],
          { timeout: 5000, windowsHide: true },
        );
        const s = stdout.trim();
        if (!s) return null;
        const d = new Date(s);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(Math.floor(pid))], {
        timeout: 5000,
      });
      const s = stdout.trim();
      if (!s) return null;
      const d = new Date(s); // `ps -o lstart=` has no timezone offset; parsed as local time
      return Number.isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    }
  },
  now: () => new Date(),
  pid: process.pid,
  hostname: osHostname(),
  unparseableGraceMs: 10_000,
  heartbeatMs: 5_000,
  staleHeartbeatMs: 30_000,
};

export async function readLockRecord(path: string): Promise<LockRecord | null> {
  try {
    const text = await readFile(path, "utf8");
    if (!text.trim()) return null;
    const parsed = JSON.parse(text) as Partial<LockRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.token !== "string") return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      token: parsed.token,
      command: typeof parsed.command === "string" ? parsed.command : "",
      requestId: typeof parsed.requestId === "string" ? parsed.requestId : null,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "",
      ...(typeof parsed.heartbeatAt === "string" ? { heartbeatAt: parsed.heartbeatAt } : {}),
      ...(typeof parsed.processStartedAt === "string"
        ? { processStartedAt: parsed.processStartedAt }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Explicit recovery only.  Normal acquire may reclaim a dead/reused PID as it always has, but
 * deliberately refuses a merely stale heartbeat from a live process.  This command likewise
 * never kills anything: a live owner must be investigated or terminated by its operator. */
export async function unlockReclaimableStale(
  path: string,
  deps: LockDeps = defaultLockDeps,
  runtimeStateDir?: string,
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
  const record = await readLockRecord(path);
  const verdict = await judgeStale(path, record, deps);
  if (!verdict.stale) return { ok: false, detail: `lock is live: ${verdict.reason}` };
  if (!verdict.reclaimable) {
    return {
      ok: false,
      detail: `lock is abandoned but its owner pid is still alive: ${verdict.reason}; refusing to kill or unlock a live process automatically`,
    };
  }
  const seen = await readLockRecord(path);
  const same =
    (record === null && seen === null) ||
    (record !== null && seen !== null && record.token === seen.token && record.pid === seen.pid);
  if (!same) return { ok: false, detail: "lock changed while checking; retry doctor" };
  try {
    await unlink(path);
    if (
      runtimeStateDir !== undefined &&
      record?.requestId !== null &&
      record?.requestId !== undefined
    ) {
      await deleteStopRequest(stopRequestPath(runtimeStateDir, record.requestId)).catch(
        () => undefined,
      );
    }
    return { ok: true, detail: `removed reclaimable stale lock: ${verdict.reason}` };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: true, detail: "lock vanished" };
    return { ok: false, detail: `could not remove stale lock: ${(err as Error).message}` };
  }
}

/** ADR-005 決定 2: stale if the PID is gone, or the PID was reused (created after the lock).
 * A-108: `pid`/`isProcessAlive` are meaningless across machines (PID namespaces aren't shared) —
 * if `runtime/` is shared over a network drive and another host holds the lock, treat it as live
 * unconditionally rather than risk two hosts believing they both hold it (the exact failure a
 * Mac session observed reclaiming a Windows host's live lock, 2026-09-16). */
export async function judgeStale(
  path: string,
  record: LockRecord | null,
  deps: LockDeps,
): Promise<StaleVerdict> {
  if (record === null) {
    try {
      const st = await stat(path);
      const age = deps.now().getTime() - st.mtimeMs;
      return age > deps.unparseableGraceMs
        ? {
            stale: true,
            reason: `unparseable lock older than ${deps.unparseableGraceMs} ms`,
            reclaimable: true,
          }
        : { stale: false, reason: "unparseable lock is recent; treating as live" };
    } catch {
      return { stale: true, reason: "lock vanished", reclaimable: true };
    }
  }
  if (record.pid === deps.pid) return { stale: false, reason: "held by this process" };
  if (record.hostname && record.hostname !== deps.hostname) {
    return {
      stale: false,
      reason: `held by pid ${record.pid} on host ${record.hostname} (different host; PID liveness can't be checked remotely, assuming live)`,
    };
  }
  if (!deps.isProcessAlive(record.pid))
    return { stale: true, reason: `pid ${record.pid} not running`, reclaimable: true };
  const created = await deps.processStartedAt(record.pid);
  const lockStarted = new Date(record.processStartedAt ?? record.startedAt);
  if (
    created &&
    !Number.isNaN(lockStarted.getTime()) &&
    created.getTime() > lockStarted.getTime() + 2000
  ) {
    return {
      stale: true,
      reason: `pid ${record.pid} was reused (created after the lock)`,
      reclaimable: true,
    };
  }
  // Pre-A-150 locks have no lease. Preserve their documented PID-only behavior rather than
  // retroactively calling a healthy legacy owner abandoned from its old acquire timestamp.
  if (!record.heartbeatAt)
    return { stale: false, reason: `pid ${record.pid} is alive (legacy lock without heartbeat)` };
  const heartbeat = new Date(record.heartbeatAt);
  const threshold = deps.staleHeartbeatMs ?? defaultLockDeps.staleHeartbeatMs ?? 30_000;
  const age = deps.now().getTime() - heartbeat.getTime();
  if (!Number.isNaN(heartbeat.getTime()) && age > threshold) {
    return {
      stale: true,
      reclaimable: false,
      reason: `heartbeat stale for ${age} ms (threshold ${threshold} ms; live owner requires manual investigation)`,
    };
  }
  return { stale: false, reason: `pid ${record.pid} is alive` };
}

export interface ProcessOwner {
  pid: number;
  startedAt: string;
  hostname: string;
}

/**
 * A-132 (Opus review of Phase 1's jobstore, ChatGPT Pro redesign review §3): the same
 * cross-host/PID-reuse guard as `judgeStale()` above, factored out so any "is the process that
 * recorded this row/file still the one that's alive" check in the codebase (previously
 * duplicated as `worker.ts`'s private `ownerIsLive`, and needed again by `cli/submit.ts`'s job
 * ledger) uses one implementation. A different host can't be checked remotely, so is assumed
 * live; a dead PID or one reused after the recorded start time means the owner is gone.
 */
export async function isOwnerLive(
  owner: ProcessOwner,
  deps: Pick<LockDeps, "isProcessAlive" | "processStartedAt" | "hostname">,
): Promise<boolean> {
  if (owner.hostname && owner.hostname !== deps.hostname) return true;
  if (!deps.isProcessAlive(owner.pid)) return false;
  const created = await deps.processStartedAt(owner.pid);
  const started = new Date(owner.startedAt);
  if (created && !Number.isNaN(started.getTime()) && created.getTime() > started.getTime() + 2000) {
    return false; // PID reused since this owner recorded its start time
  }
  return true;
}

function createExclusive(path: string, content: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx");
    writeSync(fd, content, null, "utf8");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class ProcessLock {
  private record: LockRecord | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    public readonly path: string,
    private readonly deps: LockDeps = defaultLockDeps,
  ) {}

  get token(): string | null {
    return this.record?.token ?? null;
  }

  /** ADR-005 決定 1/2: O_EXCL create; on EEXIST judge stale and reclaim via content-verified rename. */
  async acquire(command: string, requestId: string | null): Promise<AcquireOutcome> {
    await mkdir(dirname(this.path), { recursive: true });
    const processStartedAt = await this.deps.processStartedAt(this.deps.pid);
    const now = this.deps.now().toISOString();
    const record: LockRecord = {
      pid: this.deps.pid,
      startedAt: now,
      heartbeatAt: now,
      processStartedAt: processStartedAt?.toISOString() ?? null,
      token: randomBytes(16).toString("hex"),
      command,
      requestId,
      hostname: this.deps.hostname,
    };
    const content = JSON.stringify(record);
    if (createExclusive(this.path, content)) return this.confirm(record);

    const existing = await readLockRecord(this.path);
    const verdict = await judgeStale(this.path, existing, this.deps);
    if (!verdict.stale || !verdict.reclaimable)
      return { kind: "busy", cause: verdict.reason, holder: existing };

    // content-verified reclaim
    const stalePath = join(
      dirname(this.path),
      `${basename(this.path)}.stale-${this.deps.pid}-${record.token.slice(0, 8)}`,
    );
    try {
      await rename(this.path, stalePath);
    } catch {
      return { kind: "busy", cause: "lost reclaim race", holder: existing };
    }
    await this.deps.afterStaleRename?.();
    const moved = await readLockRecord(stalePath);
    const sameAsJudged =
      (existing === null && moved === null) ||
      (existing !== null &&
        moved !== null &&
        existing.pid === moved.pid &&
        existing.token === moved.token);
    if (!sameAsJudged) {
      // A-119 (Phase 0-B-3, ChatGPT Pro redesign review §3, "stale lock recovery に所有権競合"):
      // we grabbed someone else's live lock (a third process created it between our judgeStale()
      // and our rename() above). `rename(stalePath, this.path)` would silently OVERWRITE whatever
      // now sits at `this.path` — including a live lock a *fourth* process may have legitimately
      // acquired in the meantime, since this recovery attempt started. Restore via an exclusive
      // create instead: it only succeeds if `this.path` is genuinely still absent, and never
      // clobbers a lock we didn't ourselves just move aside.
      if (moved !== null) {
        try {
          if (!createExclusive(this.path, JSON.stringify(moved))) {
            // something else now legitimately holds this.path; leave our copy at stalePath for
            // doctor/manual cleanup rather than destroying that other lock to force a restore
          } else {
            await unlink(stalePath).catch(() => undefined);
          }
        } catch {
          /* leave the stale copy for doctor */
        }
      }
      return { kind: "busy", cause: "reclaim collided with a live lock", holder: moved };
    }
    try {
      await unlink(stalePath);
    } catch {
      /* ignore */
    }
    if (createExclusive(this.path, content)) return this.confirm(record);
    return {
      kind: "busy",
      cause: "lock re-created by another process during reclaim",
      holder: await readLockRecord(this.path),
    };
  }

  private async confirm(record: LockRecord): Promise<AcquireOutcome> {
    const seen = await readLockRecord(this.path);
    if (seen && seen.token !== record.token) {
      return { kind: "busy", cause: "lock token mismatch right after creation", holder: seen };
    }
    this.record = record;
    this.startHeartbeat();
    return { kind: "ok", record };
  }

  private startHeartbeat(): void {
    const interval = this.deps.heartbeatMs ?? defaultLockDeps.heartbeatMs ?? 5_000;
    if (interval <= 0 || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), interval);
    this.heartbeatTimer.unref?.();
  }

  /** Renew only this exact token. Atomic replacement avoids partial JSON and never clobbers a
   * replacement owner. */
  async heartbeat(): Promise<boolean> {
    const record = this.record;
    if (!record) return false;
    const seen = await readLockRecord(this.path);
    // A transient sharing/read error is represented by null.  It must not turn a
    // healthy owner into a permanently non-renewing owner; only a positively read,
    // different token proves that ownership was replaced.
    if (seen && seen.token !== record.token) {
      this.stopHeartbeat();
      return false;
    }
    if (!seen) return false;
    const renewed: LockRecord = { ...record, heartbeatAt: this.deps.now().toISOString() };
    const temp = `${this.path}.${record.token}.heartbeat`;
    try {
      await writeFile(temp, JSON.stringify(renewed), "utf8");
      const latest = await readLockRecord(this.path);
      if (!latest || latest.token !== record.token) return false;
      await rename(temp, this.path);
      this.record = renewed;
      return true;
    } catch {
      return false;
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** ADR-005 決定 1: re-verify ownership (used right before writing the submit marker). */
  async verify(): Promise<boolean> {
    if (!this.record) return false;
    const seen = await readLockRecord(this.path);
    return seen !== null && seen.token === this.record.token;
  }

  /** Delete only if we still own it. */
  async release(): Promise<void> {
    this.stopHeartbeat();
    if (!this.record) return;
    const seen = await readLockRecord(this.path);
    if (seen && seen.token === this.record.token) {
      try {
        await unlink(this.path);
      } catch {
        /* ignore */
      }
    }
    this.record = null;
  }

  /**
   * Hard-watchdog escape hatch. This intentionally performs only a local, token-checked
   * read/unlink and never waits for a promise or a browser/CDP operation.
   */
  releaseSync(): boolean {
    this.stopHeartbeat();
    const record = this.record;
    if (!record) return false;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LockRecord>;
      if (parsed.token !== record.token || parsed.pid !== record.pid) return false;
      unlinkSync(this.path);
      this.record = null;
      return true;
    } catch {
      return false;
    }
  }
}
