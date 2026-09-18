/**
 * Phase 1 (`docs/23-DURABLE-BRIDGE-PHASES.md`): `submit`/`status`/`wait`/`result` — a durable
 * path alongside the existing `run` (which is untouched and still the right tool for a
 * fire-and-forget single request; see A-132). `submit` validates the request, records it in the
 * job ledger (`state/jobstore.ts`), and hands the actual generation off to a *detached* child
 * process before returning — so the submitting CLI's own lifetime is no longer what the
 * generation's lifetime is bound to (redesign review §4.3, §5.4: "CLIの待機期限: CLIだけ終了。
 * requestIdと現在状態を返す").
 *
 * Opus review of the first cut (A-132): findings 1/2/4/6/7 below were real fail-open/correctness
 * gaps, fixed here; see DECISION-LOG A-132/A-133 for the full list.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRequestFile, validateAndLoad } from "../contracts/request.js";
import type { BridgeResult } from "../contracts/types.js";
import {
  JobAlreadyExistsError,
  type JobRow,
  type JobStatus,
  type JobStore,
  openJobStore,
} from "../state/jobstore.js";
import {
  defaultLockDeps,
  isOwnerLive,
  judgeStale,
  type LockDeps,
  readLockRecord,
} from "../state/lock.js";
import type { BridgeConfig } from "./config.js";

/**
 * A-132 Opus review, Medium #9: `cfg.runtimeDir` defaults to `<repo>/runtime`, which A-108's own
 * history records as having been genuinely SMB-shared between a Windows and a Mac host. WAL mode
 * (see `state/jobstore.ts`) needs working shared-memory + POSIX-ish locking that SMB does not
 * reliably provide, and `docs/23-DURABLE-BRIDGE-PHASES.md`'s "最終判断" explicitly rejects putting
 * SQLite on a shared drive for multi-machine use. This is not yet enforced at runtime (no reliable
 * cross-platform SMB/network-mount detection exists here) — `CHATGPT_BRIDGE_RUNTIME_DIR` must be
 * set to a host-local directory before using `submit`/`status`/`wait`/`result`, same as the
 * existing requirement for `runtime/profile`.
 */
export function jobStorePath(cfg: BridgeConfig): string {
  return join(cfg.runtimeDir, "jobs.db");
}

/**
 * A-132 Opus review, Medium #5: hashing only the prompt/attachment bytes let a resubmit under the
 * same requestId with a different preset/newChat/project/model/timeoutMs silently pass the
 * idempotency check and return the *old* job — the edited request was never actually run and no
 * conflict was reported. Every field that changes what gets submitted now contributes to the hash.
 */
async function computeInputHash(
  req: {
    preset: string;
    model?: string;
    newChat: boolean;
    conversationUrl?: string;
    project?: string;
    responseFormat: string;
    timeoutMs?: number;
  },
  prompt: string,
  attachments: string[],
): Promise<string> {
  const h = createHash("sha1");
  h.update(
    JSON.stringify({
      preset: req.preset,
      model: req.model ?? null,
      newChat: req.newChat,
      conversationUrl: req.conversationUrl ?? null,
      project: req.project ?? null,
      responseFormat: req.responseFormat,
      timeoutMs: req.timeoutMs ?? null,
    }),
  );
  h.update("\0prompt\0");
  h.update(prompt);
  for (const p of attachments) {
    h.update("\0attachment\0");
    h.update(await readFile(p));
  }
  return h.digest("hex");
}

/** Injectable so submit's own logic is testable without actually spawning a process. Returns the
 * new process's pid (or null if unknown). */
export type SpawnRunner = (requestPath: string, logPath: string) => Promise<number | null>;

export const defaultSpawnRunner: SpawnRunner = async (requestPath, logPath) => {
  const { open } = await import("node:fs/promises");
  const cliEntry = fileURLToPath(new URL("./main.js", import.meta.url));
  const fd = await open(logPath, "a");
  try {
    const child = spawn(process.execPath, [cliEntry, "run", "--request", requestPath, "--json"], {
      detached: true,
      stdio: ["ignore", fd.fd, fd.fd],
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    await fd.close();
  }
};

export type SubmitOutcome =
  | { ok: true; job: JobRow; alreadySubmitted: boolean }
  | { ok: false; cause: string };

/**
 * A-132: idempotent by (requestId, content hash) — a resubmit of the exact same requestId with
 * the exact same content returns the existing job without spawning a second `run`; a resubmit
 * with *different* content under the same requestId is an explicit conflict (redesign review
 * §7.3: "同一requestIdで同一入力なら既存ジョブを返す。異なる入力なら競合として拒否する").
 */
export async function submitJob(
  cfg: BridgeConfig,
  requestPath: string,
  spawnRunner: SpawnRunner = defaultSpawnRunner,
  deps: Pick<
    LockDeps,
    "isProcessAlive" | "processStartedAt" | "now" | "pid" | "hostname"
  > = defaultLockDeps,
): Promise<SubmitOutcome> {
  const abs = resolve(requestPath);
  const read = await readRequestFile(abs);
  if (read.kind === "unreadable") return { ok: false, cause: `INVALID_REQUEST: ${read.cause}` };
  const validated = await validateAndLoad(read.raw, read.requestDir);
  if (validated.kind === "invalid") {
    return { ok: false, cause: `INVALID_REQUEST: ${validated.errors.join("; ")}` };
  }
  const requestId = validated.request.requestId;
  const inputHash = await computeInputHash(
    validated.request,
    validated.prompt,
    validated.attachments,
  );

  const store = await openJobStore(jobStorePath(cfg));
  try {
    const existing = store.get(requestId);
    if (existing) return checkExisting(existing, inputHash);

    // A-132 Opus review, Medium #6: ALREADY_RUNNING writes no result.json (it's in
    // contracts/types.ts's NO_RESULT_CODES) and exits fast — spawning into a busy lock just
    // produces a dead-pid-no-result job that reconcileJob can only describe as INTERNAL_ERROR,
    // telling the caller the bridge broke when actually nothing was ever submitted. Check first
    // and fail closed with a plain, retryable "busy" instead of spawning a doomed child.
    const lockBusy = await checkLockBusy(cfg, deps);
    if (lockBusy) {
      return { ok: false, cause: `ALREADY_RUNNING: ${lockBusy} — retry submit in a moment` };
    }

    const now = deps.now().toISOString();
    try {
      store.insert({
        requestId,
        status: "queued",
        requestPath: abs,
        requestDir: read.requestDir,
        inputHash,
        pid: null,
        hostname: deps.hostname,
        submittedAt: now,
        updatedAt: now,
        resultPath: null,
        errorCode: null,
        exitCode: null,
      });
    } catch (err) {
      // A-132 Opus review, Medium #4: two near-simultaneous submits of the same brand-new
      // requestId can both pass the `store.get()` check above before either inserts. The loser
      // gets a typed error here instead of an opaque native exception — fall back to the same
      // idempotent path as if the row had already existed.
      if (err instanceof JobAlreadyExistsError) {
        const winner = store.get(requestId);
        if (winner) return checkExisting(winner, inputHash);
      }
      throw err;
    }

    // A-132 Opus review, High #1: a submit that dies here (spawn throws, or the child reports no
    // pid) used to leave the row stuck at status:"queued"/pid:null forever — reconcileJob's guard
    // only judges pid liveness for a *non-null* pid, so nothing ever moved it, and idempotency
    // then refused to let a retry through. Any failure to truly hand off to a live child process
    // is recorded as a failed job immediately instead.
    let pid: number | null = null;
    try {
      pid = await spawnRunner(abs, join(read.requestDir, "submit.log"));
    } catch (err) {
      store.update(requestId, {
        status: "failed",
        errorCode: "INTERNAL_ERROR",
        updatedAt: deps.now().toISOString(),
      });
      return {
        ok: false,
        cause: `INTERNAL_ERROR: failed to start the run: ${(err as Error).message}`,
      };
    }
    if (pid === null) {
      store.update(requestId, {
        status: "failed",
        errorCode: "INTERNAL_ERROR",
        updatedAt: deps.now().toISOString(),
      });
      return { ok: false, cause: "INTERNAL_ERROR: the spawned run reported no pid" };
    }
    const job = store.update(requestId, {
      status: "running",
      pid,
      updatedAt: deps.now().toISOString(),
    });
    return { ok: true, job, alreadySubmitted: false };
  } finally {
    store.close();
  }
}

function checkExisting(existing: JobRow, inputHash: string): SubmitOutcome {
  if (existing.inputHash !== inputHash) {
    return {
      ok: false,
      cause: `INVALID_REQUEST: requestId ${existing.requestId} was already submitted with different content (conflict) — use a new requestId`,
    };
  }
  return { ok: true, job: existing, alreadySubmitted: true };
}

/** Read-only busy check against the bridge lock (never acquires it). Returns a human-readable
 * reason when busy, or null when free/unreadable-so-assumed-free. */
async function checkLockBusy(
  cfg: BridgeConfig,
  deps: Pick<LockDeps, "isProcessAlive" | "processStartedAt" | "now" | "pid" | "hostname">,
): Promise<string | null> {
  const lockPath = join(cfg.locksDir, "bridge.lock");
  const record = await readLockRecord(lockPath);
  if (!record) return null;
  const verdict = await judgeStale(lockPath, record, { ...deps, unparseableGraceMs: 10_000 });
  return verdict.stale ? null : verdict.reason;
}

function statusFromResult(res: BridgeResult): JobStatus {
  if (res.status === "completed") return "completed";
  if (res.status === "manual_intervention_required") return "manual_intervention_required";
  return "failed";
}

/**
 * Reconciles a job row against ground truth. `result.json` is checked (and, if present, applied)
 * unconditionally — not just while the row still says "queued"/"running" — because A-132 Opus
 * review, High #2 found that once `reconcileJob`'s own dead-pid guess marked a job "failed", a
 * genuinely-completed `result.json` that showed up afterward was never revisited, permanently
 * hiding a real answer behind a wrong guess. The dead-pid fallback itself now uses the same
 * cross-host/PID-reuse guard (`isOwnerLive`, shared with `worker.ts` via `state/lock.ts`) the rest
 * of this codebase already uses — a bare `isProcessAlive` check can't tell "pid reused by an
 * unrelated process" from "still running", and can't tell "different host, can't check" from
 * "definitely dead" (this ledger, like `runtime/`, can end up on shared storage — A-108).
 */
export async function reconcileJob(
  store: JobStore,
  job: JobRow,
  deps: Pick<LockDeps, "isProcessAlive" | "processStartedAt" | "hostname"> = defaultLockDeps,
): Promise<JobRow> {
  const resultPath = join(job.requestDir, "result.json");
  try {
    const raw = JSON.parse(await readFile(resultPath, "utf8")) as BridgeResult;
    const status = statusFromResult(raw);
    const errorCode = raw.error?.code ?? null;
    if (job.status === status && job.resultPath === resultPath && job.errorCode === errorCode) {
      return job; // already reconciled; avoid a pointless write
    }
    return store.update(job.requestId, {
      status,
      resultPath,
      errorCode,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    /* no result.json yet (or unreadable) */
  }
  if (job.status !== "queued" && job.status !== "running") return job; // already terminal
  if (job.pid !== null) {
    const live = await isOwnerLive(
      { pid: job.pid, startedAt: job.submittedAt, hostname: job.hostname },
      deps,
    );
    if (!live) {
      return store.update(job.requestId, {
        status: "failed",
        errorCode: "INTERNAL_ERROR",
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return job;
}

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "failed",
  "manual_intervention_required",
]);

export async function waitForJob(
  store: JobStore,
  requestId: string,
  timeoutMs: number,
  pollMs = 1000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ job: JobRow | null; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = store.get(requestId);
    if (!job) return { job: null, timedOut: false };
    const reconciled = await reconcileJob(store, job);
    if (TERMINAL_STATUSES.has(reconciled.status)) return { job: reconciled, timedOut: false };
    if (Date.now() >= deadline) return { job: reconciled, timedOut: true };
    await sleep(pollMs);
  }
}
