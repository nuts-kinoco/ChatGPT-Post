/** Host-local durable broker. The installed isolation supervisor is the process authority.
 * No UNKNOWN state, disconnect, or restart ever permits a second start RPC. */
import { chmodSync, closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  sha256Bytes,
  taskResultArtifactRefs,
  validateTaskResult,
  validateTaskSpec,
  verifyTaskFileBytes,
} from "../contracts/task.js";
import type { ArtifactRef, TaskSpec } from "../contracts/task-types.js";
import type {
  ExecutionIdentity,
  ExecutorObservation,
  TaskExecutor,
} from "../state/task-executor.js";
import type { RunIntent } from "../state/task-store.js";
import { type CliIsolationRuntime, verifyIsolationCapabilities } from "./cli-isolation.js";
import {
  type CliInstallation,
  type CliLaunchPlan,
  checkedIdentity,
  createCliLaunchPlan,
  sameCliIdentity,
  validateInstallation,
} from "./cli-launch.js";

interface BrokerRow {
  identity: ExecutionIdentity;
  task: TaskSpec | null;
  plan: CliLaunchPlan | null;
  deadlineAt: string | null;
  cancelReason: "user" | "timeout" | null;
  cancelGrace: number;
  dispatchCommitted: boolean;
  observation: ExecutorObservation;
}
export interface CliBrokerOptions {
  executorId: string;
  dbPath: string;
  installations: readonly CliInstallation[];
  runtime: CliIsolationRuntime;
  now?: () => Date;
  rpcTimeoutMs?: number;
  maxArtifactBytes?: number;
}
export class CliBrokerService implements TaskExecutor {
  readonly synthetic = false;
  readonly executorId: string;
  private readonly db: DatabaseSync;
  private readonly installations: readonly CliInstallation[];
  private readonly runtime: CliIsolationRuntime;
  private readonly now: () => Date;
  private readonly timeout: number;
  private readonly maxArtifact: number;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private recovering = false;
  constructor(options: CliBrokerOptions) {
    this.executorId = options.executorId;
    this.installations = structuredClone(options.installations);
    for (const install of this.installations) validateInstallation(install);
    this.runtime = options.runtime;
    this.now = options.now ?? (() => new Date());
    this.timeout = options.rpcTimeoutMs ?? 10000;
    this.maxArtifact = options.maxArtifactBytes ?? 4 * 1024 * 1024;
    const parent = dirname(options.dbPath);
    const parentStat = lstatSync(parent);
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      (parentStat.mode & 0o077) !== 0 ||
      parentStat.uid !== process.getuid?.() ||
      realpathSync(parent) !== parent
    )
      throw new Error("cli_broker_state_directory_not_private");
    try {
      closeSync(openSync(options.dbPath, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const state = lstatSync(options.dbPath);
    if (
      !state.isFile() ||
      state.isSymbolicLink() ||
      state.nlink !== 1 ||
      state.uid !== process.getuid?.() ||
      (state.mode & 0o077) !== 0
    )
      throw new Error("cli_broker_state_file_not_private");
    this.db = new DatabaseSync(options.dbPath);
    chmodSync(options.dbPath, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cli_broker_runs (run_id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, row_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cli_broker_fences (resource TEXT PRIMARY KEY, fence INTEGER NOT NULL, active_run TEXT);
      CREATE TABLE IF NOT EXISTS cli_broker_artifacts (artifact_id TEXT PRIMARY KEY, ref_json TEXT NOT NULL, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS cli_broker_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const existing = this.db
      .prepare("SELECT value FROM cli_broker_meta WHERE key='executor'")
      .get();
    if (existing && existing.value !== this.executorId) {
      this.db.close();
      throw new Error("cli_broker_executor_changed");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO cli_broker_meta VALUES ('executor',?)")
      .run(this.executorId);
  }
  close(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    this.db.close();
  }
  /** The service owner calls this once after binding its authenticated socket. Deadlines are also
   * independently enforced by the supervisor; this loop handles restart reconciliation. */
  startRecoveryLoop(intervalMs = 1000): void {
    if (this.recoveryTimer) return;
    this.recoveryTimer = setInterval(() => {
      void this.recover().catch(() => {
        /* remains unknown */
      });
    }, intervalMs);
    this.recoveryTimer.unref();
  }
  async recover(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const rows = this.db.prepare("SELECT row_json FROM cli_broker_runs").all();
      for (const row of rows) {
        const r = JSON.parse(String(row.row_json)) as BrokerRow;
        if (r.observation.kind !== "terminal") await this.status(r.identity);
      }
    } finally {
      this.recovering = false;
    }
  }
  private install(task: TaskSpec): CliInstallation {
    if (!validateTaskSpec(task).valid || task.mode === "design_fixture")
      throw new Error("cli_task_invalid");
    const found = this.installations.filter(
      (i) =>
        i.agent === task.agent && i.repoId === task.repo && i.models.includes(task.requested_model),
    );
    if (found.length !== 1) throw new Error("cli_agent_model_repo_denied");
    return found[0] as CliInstallation;
  }
  private async bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("cli_broker_rpc_timeout_unknown")),
            this.timeout,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private unknown(identity: ExecutionIdentity, reason: string): ExecutorObservation {
    return { kind: "unknown", identity: structuredClone(identity), reason };
  }
  private row(identity: ExecutionIdentity): BrokerRow | null {
    checkedIdentity(identity);
    const found = this.db
      .prepare("SELECT row_json FROM cli_broker_runs WHERE run_id=? OR request_id=?")
      .all(identity.runId, identity.requestId);
    if (!found.length) return null;
    if (found.length !== 1) throw new Error("cli_identity_conflict");
    const r = JSON.parse(String(found[0]?.row_json)) as BrokerRow;
    if (!sameCliIdentity(r.identity, identity)) throw new Error("cli_identity_conflict");
    return r;
  }
  private save(row: BrokerRow): void {
    this.db
      .prepare(
        "INSERT INTO cli_broker_runs VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET row_json=excluded.row_json",
      )
      .run(row.identity.runId, row.identity.requestId, JSON.stringify(row));
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async checkCapabilities(task: TaskSpec): Promise<void> {
    const i = this.install(task);
    const request = {
      task: structuredClone(task),
      executable: i.executable,
      executableSha256: i.executableSha256,
      version: i.version,
    };
    verifyIsolationCapabilities(await this.bounded(this.runtime.check(request)), request);
  }
  async start(
    task: TaskSpec,
    bytes: Uint8Array,
    identity: ExecutionIdentity,
    intent: RunIntent,
  ): Promise<ExecutorObservation> {
    task = structuredClone(task);
    bytes = Uint8Array.from(bytes);
    identity = structuredClone(identity);
    intent = structuredClone(intent);
    checkedIdentity(identity);
    if (
      !validateTaskSpec(task).valid ||
      !verifyTaskFileBytes(task, bytes).valid ||
      task.request_id !== identity.requestId
    )
      throw new Error("cli_task_invalid");
    // Late start checks the tombstone before deadline/plan validation and must never spawn.
    const earlier = this.row(identity);
    if (earlier) {
      if (earlier.task && !isDeepStrictEqual(earlier.task, task))
        throw new Error("cli_start_payload_conflict");
      return this.status(identity);
    }
    if (intent.executorId !== this.executorId) throw new Error("cli_executor_mismatch");
    const plan = createCliLaunchPlan(task, bytes, identity, intent, this.install(task), this.now());
    const resourceKeys = [
      ...new Set([...intent.resourceKeys, `repo:${task.repo}`, `worktree:${plan.cwd}`]),
    ];
    const admitted = this.transaction(() => {
      if (this.row(identity)) return false;
      for (const resource of resourceKeys) {
        const prior = this.db
          .prepare("SELECT fence,active_run FROM cli_broker_fences WHERE resource=?")
          .get(resource);
        if (prior && (Number(prior.fence) >= identity.fencingToken || prior.active_run !== null))
          throw new Error("cli_resource_fenced_or_busy");
      }
      for (const resource of resourceKeys)
        this.db
          .prepare(
            "INSERT INTO cli_broker_fences VALUES (?,?,?) ON CONFLICT(resource) DO UPDATE SET fence=excluded.fence,active_run=excluded.active_run",
          )
          .run(resource, identity.fencingToken, identity.runId);
      this.save({
        identity,
        task,
        plan,
        deadlineAt: intent.deadlineAt,
        cancelReason: intent.cancelAt ? (intent.cancelReason ?? "user") : null,
        cancelGrace: task.timeout.cancel_grace_seconds,
        dispatchCommitted: true,
        observation: this.unknown(identity, "dispatch_committed"),
      });
      return true;
    });
    if (!admitted) return this.status(identity);
    try {
      await this.checkCapabilities(task);
      const current = this.row(identity);
      if (current?.cancelReason || this.now().getTime() >= Date.parse(intent.deadlineAt))
        return this.cancel(
          identity,
          current?.cancelReason ?? "timeout",
          task.timeout.cancel_grace_seconds,
        );
      // Never retried: intent was committed before the first possible external effect.
      return await this.accept(identity, await this.bounded(this.runtime.start(plan)));
    } catch {
      return this.unknown(identity, "dispatch_or_capability_unconfirmed");
    }
  }
  async status(identity: ExecutionIdentity): Promise<ExecutorObservation> {
    const r = this.row(identity);
    if (!r) return this.unknown(identity, "no_confirmed_run");
    if (r.observation.kind === "terminal") return r.observation;
    if (
      r.cancelReason ||
      (r.deadlineAt !== null && this.now().getTime() >= Date.parse(r.deadlineAt))
    )
      return this.cancel(identity, r.cancelReason ?? "timeout", r.cancelGrace);
    try {
      return await this.accept(identity, await this.bounded(this.runtime.status(identity)));
    } catch {
      return this.unknown(identity, "status_unconfirmed");
    }
  }
  async cancel(
    identity: ExecutionIdentity,
    reason: "user" | "timeout",
    graceSeconds: number,
  ): Promise<ExecutorObservation> {
    checkedIdentity(identity);
    if (
      !["user", "timeout"].includes(reason) ||
      !Number.isSafeInteger(graceSeconds) ||
      graceSeconds < 0 ||
      graceSeconds > 300
    )
      throw new Error("cli_cancel_invalid");
    const r = this.transaction(() => {
      const prior = this.row(identity);
      if (prior?.observation.kind === "terminal") return prior;
      const row: BrokerRow = prior ?? {
        identity: structuredClone(identity),
        task: null,
        plan: null,
        deadlineAt: null,
        cancelReason: null,
        cancelGrace: graceSeconds,
        dispatchCommitted: false,
        observation: this.unknown(identity, "cancel_before_registration"),
      };
      row.cancelReason ??= reason;
      row.cancelGrace = Math.min(row.cancelGrace, graceSeconds);
      this.save(row);
      return row;
    });
    if (r.observation.kind === "terminal") return r.observation;
    try {
      return await this.accept(
        identity,
        await this.bounded(this.runtime.cancel(identity, r.cancelReason ?? reason, r.cancelGrace)),
      );
    } catch {
      return this.unknown(identity, "cancel_unconfirmed_tombstone_retained");
    }
  }
  async collect(identity: ExecutionIdentity): Promise<ExecutorObservation> {
    const r = this.row(identity);
    if (
      !r ||
      r.observation.kind === "terminal" ||
      r.cancelReason ||
      (r.deadlineAt !== null && this.now().getTime() >= Date.parse(r.deadlineAt))
    )
      return this.status(identity);
    try {
      return await this.accept(identity, await this.bounded(this.runtime.collect(identity)));
    } catch {
      return this.unknown(identity, "collection_unconfirmed");
    }
  }
  private async accept(
    identity: ExecutionIdentity,
    observation: ExecutorObservation,
  ): Promise<ExecutorObservation> {
    observation = structuredClone(observation);
    if (!observation || !sameCliIdentity(identity, observation.identity))
      throw new Error("cli_observation_identity_mismatch");
    const r = this.row(identity);
    if (!r) throw new Error("cli_run_missing");
    if (r.observation.kind === "terminal") return r.observation;
    if (observation.kind === "unknown") return this.unknown(identity, "supervisor_unknown");
    if (!r.task || !r.plan) return this.unknown(identity, "tombstone_registered_no_task");
    const oldProcess = r.observation.kind === "running" ? r.observation.process : null;
    if (observation.kind === "running") {
      const p = observation.process;
      if (
        !p?.host_id ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(p.boot_id) ||
        !p.process_group_id ||
        !Number.isSafeInteger(p.pid) ||
        p.pid <= 0 ||
        !Number.isFinite(Date.parse(p.creation_time)) ||
        !Number.isFinite(Date.parse(observation.startedAt)) ||
        p.executable_sha256 !== r.plan.executableSha256 ||
        observation.actualAgent !== r.task.agent ||
        observation.actualModel !== r.task.requested_model ||
        (oldProcess && !isDeepStrictEqual(oldProcess, p))
      )
        throw new Error("cli_running_evidence_invalid");
    } else if (observation.kind === "terminal") {
      const result = observation.result;
      if (
        !observation.allTerminated ||
        result.synthetic ||
        !["succeeded", "failed", "cancelled"].includes(result.status) ||
        !result.receipt ||
        result.verification.state !== "verified" ||
        (result.process_identity &&
          result.process_identity.executable_sha256 !== r.plan.executableSha256)
      )
        throw new Error("cli_terminal_evidence_invalid");
      const check = validateTaskResult(result, {
        task: r.task,
        taskSpecHash: identity.taskSpecHash,
        expectedRunId: identity.runId,
        expectedFencingToken: identity.fencingToken,
        ...(oldProcess ? { expectedProcessIdentity: oldProcess } : {}),
      });
      if (!check.valid) throw new Error("cli_terminal_contract_invalid");
      for (const ref of taskResultArtifactRefs(result)) await this.cacheArtifact(ref);
    } else throw new Error("cli_observation_kind_invalid");
    return this.transaction(() => {
      const latest = this.row(identity);
      if (!latest) throw new Error("cli_run_missing");
      if (latest.observation.kind === "terminal") return latest.observation;
      if (latest.observation.kind === "running") {
        const observedProcess =
          observation.kind === "running"
            ? observation.process
            : observation.result.process_identity;
        if (!isDeepStrictEqual(latest.observation.process, observedProcess))
          throw new Error("cli_process_identity_race");
      }
      if (
        !latest.cancelReason &&
        latest.deadlineAt &&
        this.now().getTime() >= Date.parse(latest.deadlineAt)
      )
        latest.cancelReason = "timeout";
      // A cancellation or deadline committed during RPC/verification wins the late success.
      if (observation.kind === "terminal" && latest.cancelReason) {
        const status = latest.cancelReason === "timeout" ? "failed" : "cancelled";
        observation.result.status = status;
        observation.result.last_confirmed_status = status;
        observation.result.error = {
          code: latest.cancelReason === "timeout" ? "run_timeout" : "cancellation_committed_first",
          message: "Durable stop intent preceded termination collection",
          retryable: false,
        };
        if (observation.result.receipt) observation.result.receipt.terminal_status = status;
      }
      latest.observation = observation;
      this.save(latest);
      if (observation.kind === "terminal")
        this.db
          .prepare("UPDATE cli_broker_fences SET active_run=NULL WHERE active_run=?")
          .run(identity.runId);
      return observation;
    });
  }
  private async cacheArtifact(ref: ArtifactRef): Promise<Uint8Array> {
    if (
      !ref ||
      typeof ref.artifact_id !== "string" ||
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      !Number.isSafeInteger(ref.size_bytes) ||
      ref.size_bytes < 0 ||
      ref.size_bytes > this.maxArtifact
    )
      throw new Error("cli_artifact_limit_or_invalid");
    const existing = this.db
      .prepare("SELECT ref_json,bytes FROM cli_broker_artifacts WHERE artifact_id=?")
      .get(ref.artifact_id);
    if (existing) {
      if (!isDeepStrictEqual(JSON.parse(String(existing.ref_json)), ref))
        throw new Error("cli_artifact_identity_conflict");
      return new Uint8Array(existing.bytes as Uint8Array);
    }
    const bytes = await this.bounded(this.runtime.readArtifact(ref));
    if (bytes.length !== ref.size_bytes || sha256Bytes(bytes) !== ref.sha256)
      throw new Error("cli_artifact_hash_mismatch");
    this.transaction(() => {
      const prior = this.db
        .prepare("SELECT ref_json FROM cli_broker_artifacts WHERE artifact_id=?")
        .get(ref.artifact_id);
      if (prior && !isDeepStrictEqual(JSON.parse(String(prior.ref_json)), ref))
        throw new Error("cli_artifact_identity_conflict");
      this.db
        .prepare("INSERT OR IGNORE INTO cli_broker_artifacts VALUES (?,?,?)")
        .run(ref.artifact_id, JSON.stringify(ref), bytes);
    });
    return Uint8Array.from(bytes);
  }
  async readArtifact(ref: ArtifactRef): Promise<Uint8Array> {
    const existing = this.db
      .prepare("SELECT ref_json,bytes FROM cli_broker_artifacts WHERE artifact_id=?")
      .get(ref.artifact_id);
    if (!existing || !isDeepStrictEqual(JSON.parse(String(existing.ref_json)), ref))
      throw new Error("cli_artifact_not_collected");
    return new Uint8Array(existing.bytes as Uint8Array);
  }
}
