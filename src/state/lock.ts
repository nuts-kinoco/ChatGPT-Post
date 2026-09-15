import { randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface LockRecord {
  pid: number;
  startedAt: string;
  token: string;
  command: string;
  requestId: string | null;
}

export interface LockDeps {
  /** process.kill(pid, 0) semantics: true if the process exists. */
  isProcessAlive: (pid: number) => boolean;
  /** Process creation time via WMI (best-effort). null when unknown. */
  processStartedAt: (pid: number) => Promise<Date | null>;
  now: () => Date;
  pid: number;
  /** Empty / unparseable lock files younger than this are treated as live. */
  unparseableGraceMs: number;
}

export type AcquireOutcome =
  | { kind: "ok"; record: LockRecord }
  | { kind: "busy"; cause: string; holder: LockRecord | null };

export type StaleVerdict = { stale: true; reason: string } | { stale: false; reason: string };

export const defaultLockDeps: LockDeps = {
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  processStartedAt: async (pid) => {
    if (process.platform !== "win32") return null;
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
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
    } catch {
      return null;
    }
  },
  now: () => new Date(),
  pid: process.pid,
  unparseableGraceMs: 10_000,
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
    };
  } catch {
    return null;
  }
}

/** ADR-005 決定 2: stale if the PID is gone, or the PID was reused (created after the lock). */
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
        ? { stale: true, reason: `unparseable lock older than ${deps.unparseableGraceMs} ms` }
        : { stale: false, reason: "unparseable lock is recent; treating as live" };
    } catch {
      return { stale: true, reason: "lock vanished" };
    }
  }
  if (record.pid === deps.pid) return { stale: false, reason: "held by this process" };
  if (!deps.isProcessAlive(record.pid))
    return { stale: true, reason: `pid ${record.pid} not running` };
  const created = await deps.processStartedAt(record.pid);
  const lockStarted = new Date(record.startedAt);
  if (
    created &&
    !Number.isNaN(lockStarted.getTime()) &&
    created.getTime() > lockStarted.getTime() + 2000
  ) {
    return { stale: true, reason: `pid ${record.pid} was reused (created after the lock)` };
  }
  return { stale: false, reason: `pid ${record.pid} is alive` };
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
    const record: LockRecord = {
      pid: this.deps.pid,
      startedAt: this.deps.now().toISOString(),
      token: randomBytes(16).toString("hex"),
      command,
      requestId,
    };
    const content = JSON.stringify(record);
    if (createExclusive(this.path, content)) return this.confirm(record);

    const existing = await readLockRecord(this.path);
    const verdict = await judgeStale(this.path, existing, this.deps);
    if (!verdict.stale) return { kind: "busy", cause: verdict.reason, holder: existing };

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
    const moved = await readLockRecord(stalePath);
    const sameAsJudged =
      (existing === null && moved === null) ||
      (existing !== null &&
        moved !== null &&
        existing.pid === moved.pid &&
        existing.token === moved.token);
    if (!sameAsJudged) {
      // we grabbed someone else's live lock: put it back and yield
      try {
        await rename(stalePath, this.path);
      } catch {
        /* someone re-created the lock meanwhile; leave the stale copy for doctor */
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
    if (!seen || seen.token !== record.token) {
      return { kind: "busy", cause: "lock token mismatch right after creation", holder: seen };
    }
    this.record = record;
    return { kind: "ok", record };
  }

  /** ADR-005 決定 1: re-verify ownership (used right before writing the submit marker). */
  async verify(): Promise<boolean> {
    if (!this.record) return false;
    const seen = await readLockRecord(this.path);
    return seen !== null && seen.token === this.record.token;
  }

  /** Delete only if we still own it. */
  async release(): Promise<void> {
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
}
