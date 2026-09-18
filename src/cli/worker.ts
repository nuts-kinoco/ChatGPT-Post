/**
 * 21 §5c / A-094: file-queue worker. Other projects drop <queue>/pending/<requestId>/ (request.json +
 * prompt.md + attachments); the worker processes them one at a time through the normal `run` path
 * (same lock, marker, fail-closed rules) and moves each directory to done / failed / blocked.
 * No server, no database: the directory tree is the whole protocol.
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidRequestId } from "../contracts/request.js";
import { EXIT_CODES } from "../contracts/types.js";
import { defaultLockDeps, isOwnerLive, type LockDeps, type ProcessOwner } from "../state/lock.js";

export const QUEUE_DIRS = ["pending", "running", "done", "failed", "blocked"] as const;
export type QueueDir = (typeof QUEUE_DIRS)[number];

export interface WorkerOptions {
  queueDir: string;
  /** Process one item and exit. */
  once: boolean;
  /** Process until pending is empty and exit. */
  drain: boolean;
  pollMs: number;
  /** How many times an item may bounce on exit 4 (busy) before it is failed. */
  maxBusyRetries: number;
}

export interface WorkerItemOutcome {
  requestId: string;
  exitCode: number;
  movedTo: QueueDir;
}

/** rename() with bounded retries (Windows: a handle held by another process fails transiently). */
async function moveDir(
  from: string,
  to: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let last: Error | null = null;
  for (let i = 0; i < 5; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      last = err as Error;
      await sleep(500 * (i + 1));
    }
  }
  throw last ?? new Error("rename failed");
}

const OWNER_FILE = ".worker-owner.json";

type OwnerDeps = Pick<LockDeps, "isProcessAlive" | "processStartedAt" | "now" | "pid" | "hostname">;

/** A-116 (Phase 0-B-1, `docs/23-DURABLE-BRIDGE-PHASES.md`): written into `running/<id>/` right
 * after this worker claims the item, so a *concurrently running* worker's `recoverRunning()` can
 * tell "crashed, truly orphaned" apart from "another worker is still actively processing this".
 * Best-effort: a failure to write it just means recovery falls back to the pre-existing
 * result.json-based heuristic for that item (no worse than before this change). */
async function writeOwnerFile(
  dir: string,
  deps: Pick<OwnerDeps, "now" | "pid" | "hostname">,
): Promise<void> {
  const owner: ProcessOwner = {
    pid: deps.pid,
    startedAt: deps.now().toISOString(),
    hostname: deps.hostname,
  };
  await writeFile(join(dir, OWNER_FILE), JSON.stringify(owner), "utf8").catch(() => undefined);
}

async function readOwnerFile(dir: string): Promise<ProcessOwner | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(dir, OWNER_FILE), "utf8"),
    ) as Partial<ProcessOwner>;
    if (typeof parsed.pid !== "number" || typeof parsed.hostname !== "string") return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      hostname: parsed.hostname,
    };
  } catch {
    return null;
  }
}

/**
 * Codex P6-2: items left in running/ by a crashed or interrupted worker. With a result.json the
 * outcome is known and the item is routed by status; without one it goes back to pending — a
 * re-run is safe because the bridge's own submit marker turns an unknown send into
 * SUBMIT_STATE_UNKNOWN instead of a second submission.
 *
 * A-116 (Phase 0-B-1): before treating a `running/<id>` entry as an orphan, check whether its
 * `.worker-owner.json` names a still-live process. Reproduced live in the 2026-09-18 ChatGPT Pro
 * redesign review (§3.2): two workers started against the same queue directory would otherwise let
 * the second one's startup recovery yank the first one's in-flight item back to pending.
 */
export async function recoverRunning(
  queueDir: string,
  log: (m: string) => void,
  sleep: (ms: number) => Promise<void>,
  deps: OwnerDeps = defaultLockDeps,
): Promise<void> {
  await ensureQueue(queueDir);
  const entries = await readdir(join(queueDir, "running")).catch(() => [] as string[]);
  for (const id of entries) {
    if (!isValidRequestId(id)) continue;
    const dir = join(queueDir, "running", id);
    const owner = await readOwnerFile(dir);
    if (owner && (await isOwnerLive(owner, deps))) {
      log(
        `worker: ${id} still owned by pid ${owner.pid}@${owner.hostname}; leaving it in running/`,
      );
      continue;
    }
    let dest: QueueDir = "pending";
    try {
      const res = JSON.parse(await readFile(join(dir, "result.json"), "utf8")) as {
        status?: string;
      };
      dest =
        res.status === "completed"
          ? "done"
          : res.status === "manual_intervention_required"
            ? "blocked"
            : "failed";
    } catch {
      /* no result.json: back to pending */
    }
    try {
      await moveDir(dir, join(queueDir, dest, id), sleep);
      log(`worker: recovered orphan ${id} -> ${dest}`);
    } catch (err) {
      log(
        `worker: orphan ${id} could not be moved (${(err as Error).message}); leaving it in running/`,
      );
    }
  }
}

export type Runner = (requestPath: string) => Promise<number>;

export async function ensureQueue(queueDir: string): Promise<void> {
  for (const d of QUEUE_DIRS) await mkdir(join(queueDir, d), { recursive: true });
}

async function listPending(queueDir: string): Promise<string[]> {
  const entries = await readdir(join(queueDir, "pending")).catch(() => [] as string[]);
  const dirs: string[] = [];
  for (const e of entries) {
    const st = await stat(join(queueDir, "pending", e)).catch(() => null);
    // the directory name is used as a path segment: only well-formed requestIds are picked up
    if (st?.isDirectory() && isValidRequestId(e)) {
      const req = await stat(join(queueDir, "pending", e, "request.json")).catch(() => null);
      if (req?.isFile()) dirs.push(e);
    }
  }
  // requestIds are time-prefixed, so lexical order is submission order
  return dirs.sort();
}

export function destinationFor(exitCode: number): QueueDir {
  if (exitCode === EXIT_CODES.completed) return "done";
  if (exitCode === EXIT_CODES.manualIntervention) return "blocked";
  if (exitCode === EXIT_CODES.beforeBrowser) return "pending"; // busy: retry later
  return "failed";
}

/** A-131 (Phase 0-F, ChatGPT Pro self-review §13): best-effort read of the error code the `run`
 * that just finished actually wrote, so the queue can react to specific codes exit-code grouping
 * alone can't distinguish (GENERATION_TIMEOUT_ACTIVE and plain GENERATION_TIMEOUT are both exit 1). */
async function readResultErrorCode(dir: string): Promise<string | null> {
  try {
    const res = JSON.parse(await readFile(join(dir, "result.json"), "utf8")) as {
      error?: { code?: string } | null;
    };
    return res.error?.code ?? null;
  } catch {
    return null;
  }
}

/**
 * Processes one pending item. Returns null when pending is empty.
 * A "blocked" outcome (exit 3) means the caller must stop the whole queue (A-094).
 */
export async function processOne(
  opts: WorkerOptions,
  run: Runner,
  busyCounts: Map<string, number>,
  log: (m: string) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  deps: OwnerDeps = defaultLockDeps,
): Promise<WorkerItemOutcome | null> {
  const pending = await listPending(opts.queueDir);
  const id = pending[0];
  if (!id) return null;
  const from = join(opts.queueDir, "pending", id);
  const running = join(opts.queueDir, "running", id);
  await moveDir(from, running, sleep);
  await writeOwnerFile(running, deps);
  log(`worker: ${id} -> running`);
  let exitCode: number;
  try {
    exitCode = await run(join(running, "request.json"));
  } catch (err) {
    log(`worker: ${id} runner threw: ${(err as Error).message}`);
    exitCode = EXIT_CODES.afterBrowser;
  }
  let dest = destinationFor(exitCode);
  if (dest === "pending") {
    const n = (busyCounts.get(id) ?? 0) + 1;
    busyCounts.set(id, n);
    if (n > opts.maxBusyRetries) dest = "failed";
  }
  // A-131 (Phase 0-F): GENERATION_TIMEOUT_ACTIVE's own error message warns that the previous
  // generation may still be running in the shared profile, and that resubmitting into it risks a
  // collision (the exact class of incident #124 was about). Exit code alone maps this to a plain
  // "failed" -> the worker would otherwise move straight on to the next pending item in the same
  // profile. Route it like a manual-intervention outcome instead: stop the queue for a human to
  // check `doctor`/the screenshot before anything else touches this profile.
  if (dest === "failed" && (await readResultErrorCode(running)) === "GENERATION_TIMEOUT_ACTIVE") {
    dest = "blocked";
  }
  try {
    await moveDir(running, join(opts.queueDir, dest, id), sleep);
  } catch (err) {
    // the outcome is recorded in running/<id>/result.json; recoverRunning() routes it on restart
    log(
      `worker: ${id} exit ${exitCode} but could not be moved to ${dest} (${(err as Error).message}); stopping`,
    );
    throw new WorkerMoveError(id, dest);
  }
  log(`worker: ${id} exit ${exitCode} -> ${dest}`);
  return { requestId: id, exitCode, movedTo: dest };
}

export class WorkerMoveError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly dest: QueueDir,
  ) {
    super(`queue item ${requestId} stuck in running/ (wanted ${dest})`);
  }
}

export async function runWorker(
  opts: WorkerOptions,
  run: Runner,
  log: (m: string) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  shouldStop: () => boolean = () => false,
  deps: OwnerDeps = defaultLockDeps,
): Promise<{
  processed: WorkerItemOutcome[];
  stoppedBy: "once" | "drain" | "blocked" | "signal" | "error";
}> {
  await ensureQueue(opts.queueDir);
  await recoverRunning(opts.queueDir, log, sleep, deps);
  const processed: WorkerItemOutcome[] = [];
  const busy = new Map<string, number>();
  for (;;) {
    if (shouldStop()) return { processed, stoppedBy: "signal" };
    let out: WorkerItemOutcome | null;
    try {
      out = await processOne(opts, run, busy, log, sleep, deps);
    } catch (err) {
      log(`worker: stopping after error: ${(err as Error).message}`);
      return { processed, stoppedBy: "error" };
    }
    if (out) {
      processed.push(out);
      if (out.movedTo === "blocked") {
        log("worker: manual intervention required; stopping the queue (A-094)");
        return { processed, stoppedBy: "blocked" };
      }
      if (opts.once) return { processed, stoppedBy: "once" };
      if (out.movedTo === "pending") await sleep(opts.pollMs);
      continue;
    }
    if (opts.drain || opts.once) return { processed, stoppedBy: "drain" };
    await sleep(opts.pollMs);
  }
}
