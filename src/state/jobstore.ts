/**
 * Phase 1 (`docs/23-DURABLE-BRIDGE-PHASES.md`): a lightweight SQLite-backed job ledger, separate
 * from the per-request `request.json`/`result.json` files (which remain the source of truth for
 * a request's own content and outcome). This DB exists so `submit`/`status`/`wait`/`result` can
 * answer "what did I submit, and is it done yet" without the caller having to keep its own
 * process alive for the whole generation — the actual `run` happens in a detached child process
 * whose lifetime is independent of the CLI invocation that started it (§4.3, §7.5 of
 * `reviews/chatgpt-pro-redesign-review.md`: "DBは単なる捨てられるindexではない").
 *
 * Uses `node:sqlite` (stable-enough as of Node 22.5+; this repo's `engines.node` was bumped
 * accordingly) rather than adding a native dependency (`better-sqlite3`) — see DECISION-LOG A-132.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "manual_intervention_required";

export class JobAlreadyExistsError extends Error {
  constructor(public readonly requestId: string) {
    super(`jobstore: ${requestId} already exists`);
  }
}

export interface JobRow {
  requestId: string;
  status: JobStatus;
  requestPath: string;
  requestDir: string;
  /** sha1 over the prompt text + attachment bytes at submit time (12 §5 / A-132 idempotency). */
  inputHash: string;
  pid: number | null;
  hostname: string;
  submittedAt: string;
  updatedAt: string;
  resultPath: string | null;
  errorCode: string | null;
  exitCode: number | null;
}

export class JobStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    // §8 (redesign review): FULL over NORMAL for this use case — durability across an OS
    // crash/power loss matters more here than the extra fsync cost of a low-volume job ledger.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    // A-132 Opus review, Medium #3: without this, a second connection writing while another holds
    // the write lock throws ERR_SQLITE_ERROR("database is locked") immediately instead of waiting
    // — verified empirically (busy_timeout defaults to 0). Two sessions polling `wait`/`status`
    // while a third `submit`s is an ordinary occurrence for this tool, not an edge case.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        requestId TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        requestPath TEXT NOT NULL,
        requestDir TEXT NOT NULL,
        inputHash TEXT NOT NULL,
        pid INTEGER,
        hostname TEXT NOT NULL,
        submittedAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        resultPath TEXT,
        errorCode TEXT,
        exitCode INTEGER
      )
    `);
  }

  /** Throws `JobAlreadyExistsError` (not a raw SQLite constraint error) if `requestId` is already
   * present — A-132 Opus review, Medium #4: two near-simultaneous `submit`s of a brand-new
   * requestId can both pass a `get()`-based existence check before either inserts; the loser must
   * get a typed, catchable outcome instead of an opaque native exception. */
  insert(job: JobRow): void {
    try {
      this.db
        .prepare(
          `INSERT INTO jobs
           (requestId, status, requestPath, requestDir, inputHash, pid, hostname, submittedAt, updatedAt, resultPath, errorCode, exitCode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.requestId,
          job.status,
          job.requestPath,
          job.requestDir,
          job.inputHash,
          job.pid,
          job.hostname,
          job.submittedAt,
          job.updatedAt,
          job.resultPath,
          job.errorCode,
          job.exitCode,
        );
    } catch (err) {
      if (/UNIQUE constraint failed/.test((err as Error).message)) {
        throw new JobAlreadyExistsError(job.requestId);
      }
      throw err;
    }
  }

  get(requestId: string): JobRow | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE requestId = ?").get(requestId) as
      | (Omit<JobRow, "status"> & { status: string })
      | undefined;
    return row ? (row as unknown as JobRow) : null;
  }

  /** A-132 Opus review, Low #13: a targeted `UPDATE ... SET <only the patched columns>` rather
   * than reading the row into JS, merging, and rewriting every column — the previous version could
   * lose a concurrent write to an untouched column between this call's own `get()` and its
   * full-row `UPDATE`. Column names come only from `JobRow`'s statically-known keys, never from
   * request/user input, so building the SET clause from `Object.keys(patch)` is not an injection
   * risk. */
  update(requestId: string, patch: Partial<Omit<JobRow, "requestId">>): JobRow {
    const cols = Object.keys(patch) as (keyof typeof patch)[];
    if (cols.length > 0) {
      const setClause = cols.map((c) => `${c} = ?`).join(", ");
      const values = cols.map((c) => patch[c] ?? null);
      const info = this.db
        .prepare(`UPDATE jobs SET ${setClause} WHERE requestId = ?`)
        .run(...values, requestId);
      if (info.changes === 0) throw new Error(`jobstore: no such job ${requestId}`);
    }
    const updated = this.get(requestId);
    if (!updated) throw new Error(`jobstore: no such job ${requestId}`);
    return updated;
  }

  close(): void {
    this.db.close();
  }
}

export async function openJobStore(dbPath: string): Promise<JobStore> {
  await mkdir(dirname(dbPath), { recursive: true });
  return new JobStore(dbPath);
}
