/** Host-local v2 tables in the existing jobs.db; WAL/FULL follows JobStore.
 * The snapshot, event, start consumption and receipt are committed in one transaction.
 * Files are exports, never completion authority. No PID-only reclamation or automatic replay.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { assertDeliveryBinding } from "../contracts/delivery-proof.js";
import {
  type MaterializationReceiptV1,
  parseMaterializationReceiptV1,
  serializeMaterializationReceiptV1,
} from "../contracts/materialization.js";
import { serializeTaskResult, taskResultArtifactRefs } from "../contracts/task.js";
import type {
  ApprovalEnvelope,
  ArtifactRef,
  ProcessIdentity,
  ResultSpec,
} from "../contracts/task-types.js";
import {
  checkWorkflowGrant,
  parseWorkflowManifest,
  type WorkflowGrant,
} from "../contracts/task-workflow.js";
import { assertTaskTransition, isTerminalTask } from "./task-machine.js";
import type { TaskQuotaSnapshot } from "./task-quota.js";

export interface RunIntent {
  runId: string;
  startSequence: number;
  fencingToken: number;
  approvalId: string;
  deadlineAt: string;
  sessionId: string;
  executorId: string;
  resourceKeys: string[];
  cancelAt: string | null;
  cancelReason: "user" | "timeout" | null;
}
export interface TaskRecord {
  projectRegistration?:
    | import("../contracts/project-registry.js").ProjectRegistrationReference
    | null;
  rawSpec: string;
  taskBytesBase64: string;
  result: ResultSpec;
  intent: RunIntent | null;
  transportRequestId: string | null;
  bridgeId: string;
  requesterId: string;
  sessionId: string;
  workflowId: string | null;
}
export interface TaskHandshake {
  eventId: string;
  stage: "receipt_ack" | "start_receipt" | "terminal_result" | "result_ack";
  requestId: string;
  taskSpecHash: string;
  runId: string | null;
  sequence: number;
  actorId: string;
  payloadSha256: string;
  fencingToken: number;
  startIntentSequence: number | null;
  processIdentity: ProcessIdentity | null;
}
export interface StoreFaults {
  beforeCommit?: () => void;
  afterCommit?: () => void;
}
export class TaskStore {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly faults: StoreFaults = {},
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_materialization (request_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_quota_observations (observation_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_jobs (
        request_id TEXT PRIMARY KEY, spec_hash TEXT NOT NULL,
        sequence INTEGER NOT NULL, snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_approvals (
        approval_id TEXT PRIMARY KEY, nonce TEXT UNIQUE NOT NULL,
        request_id TEXT NOT NULL, envelope TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS task_events (
        request_id TEXT NOT NULL, sequence INTEGER NOT NULL, snapshot TEXT NOT NULL,
        PRIMARY KEY(request_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS task_approval_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, approval_id TEXT NOT NULL, action TEXT NOT NULL, envelope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_session_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, action TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_fences (resource_key TEXT PRIMARY KEY, token INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_write_locks (lock_key TEXT PRIMARY KEY, request_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_workflows (workflow_id TEXT PRIMARY KEY, grant_id TEXT UNIQUE NOT NULL, raw_manifest TEXT NOT NULL, manifest_hash TEXT NOT NULL, grant_json TEXT NOT NULL, nonce TEXT UNIQUE NOT NULL, starts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS task_dependencies (request_id TEXT PRIMARY KEY, dependencies TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_reservations (reservation_id TEXT PRIMARY KEY, approval_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_handshakes (
        request_id TEXT NOT NULL, stage TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(request_id,stage)
      );
      CREATE TABLE IF NOT EXISTS task_evidence (artifact_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_sessions (
        session_id TEXT PRIMARY KEY, stopped INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
        starts INTEGER NOT NULL DEFAULT 0, reserved REAL NOT NULL DEFAULT 0, reserved_seconds INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS task_deliveries (
        request_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS task_receipts (
        request_id TEXT PRIMARY KEY, receipt_id TEXT UNIQUE NOT NULL,
        sequence INTEGER NOT NULL, snapshot TEXT NOT NULL
      );
    `);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const result = fn();
      this.faults.beforeCommit?.();
      this.db.exec("COMMIT");
      committed = true;
      this.faults.afterCommit?.();
      return result;
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT snapshot FROM task_jobs WHERE request_id=?").get(id) as
      | { snapshot: string }
      | undefined;
    return row ? (JSON.parse(row.snapshot) as TaskRecord) : null;
  }
  /** Read-only product projections; snapshots remain immutable controller authority. */
  listAll(): TaskRecord[] {
    const rows = this.db.prepare("SELECT snapshot FROM task_jobs ORDER BY rowid DESC").all() as {
      snapshot: string;
    }[];
    return rows.map((row) => JSON.parse(row.snapshot) as TaskRecord);
  }
  events(requestId: string): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT snapshot FROM task_events WHERE request_id=? ORDER BY sequence")
      .all(requestId) as { snapshot: string }[];
    return rows.map((row) => JSON.parse(row.snapshot) as TaskRecord);
  }
  approvalsForRequest(requestId: string): { envelope: ApprovalEnvelope; consumed: boolean }[] {
    const rows = this.db
      .prepare("SELECT envelope, consumed FROM task_approvals WHERE request_id=? ORDER BY rowid")
      .all(requestId) as { envelope: string; consumed: number }[];
    return rows.map((row) => ({
      envelope: JSON.parse(row.envelope) as ApprovalEnvelope,
      consumed: row.consumed === 1,
    }));
  }
  receive(record: TaskRecord): { record: TaskRecord; duplicate: boolean } {
    return this.transaction(() => {
      const prior = this.get(record.result.request_id);
      if (prior) {
        if (
          JSON.stringify(prior.projectRegistration ?? null) !==
            JSON.stringify(record.projectRegistration ?? null) ||
          prior.rawSpec !== record.rawSpec ||
          prior.taskBytesBase64 !== record.taskBytesBase64 ||
          prior.bridgeId !== record.bridgeId ||
          prior.requesterId !== record.requesterId ||
          prior.sessionId !== record.sessionId
        )
          throw new Error("request_id_conflict");
        return { record: prior, duplicate: true };
      }
      const snapshot = JSON.stringify(record);
      this.db
        .prepare("INSERT INTO task_jobs VALUES (?,?,?,?)")
        .run(
          record.result.request_id,
          record.result.task_spec_hash,
          record.result.observation_seq,
          snapshot,
        );
      this.db
        .prepare("INSERT INTO task_events VALUES (?,?,?)")
        .run(record.result.request_id, record.result.observation_seq, snapshot);
      this.handshakeInside(record, "receipt_ack");
      return { record, duplicate: false };
    });
  }
  /** Called only by an authenticated approval authority, never from task/transport JSON. */
  recordApproval(envelope: ApprovalEnvelope): void {
    this.transaction(() => {
      const old = this.approval(envelope.approval_id);
      if (old) {
        if (JSON.stringify(old) !== JSON.stringify(envelope))
          throw new Error("approval_id_conflict");
        return;
      }
      this.db
        .prepare("INSERT INTO task_approvals VALUES (?,?,?,?,0)")
        .run(envelope.approval_id, envelope.nonce, envelope.request_id, JSON.stringify(envelope));
      this.db
        .prepare("INSERT INTO task_approval_events(approval_id,action,envelope) VALUES (?,?,?)")
        .run(envelope.approval_id, "issued", JSON.stringify(envelope));
    });
  }
  approval(id: string): ApprovalEnvelope | null {
    const row = this.db
      .prepare("SELECT envelope FROM task_approvals WHERE approval_id=?")
      .get(id) as { envelope: string } | undefined;
    return row ? (JSON.parse(row.envelope) as ApprovalEnvelope) : null;
  }
  revokeApproval(id: string): void {
    this.transaction(() => {
      const approval = this.approval(id);
      if (!approval) throw new Error("approval_missing");
      approval.decision = "revoked";
      approval.max_starts = 0;
      this.db
        .prepare("UPDATE task_approvals SET envelope=? WHERE approval_id=?")
        .run(JSON.stringify(approval), id);
      this.db
        .prepare("INSERT INTO task_approval_events(approval_id,action,envelope) VALUES (?,?,?)")
        .run(id, "revoked", JSON.stringify(approval));
    });
  }
  /** CAS fences every asynchronous observer. A stale executor response cannot overwrite a newer
   * cancel request, terminal receipt, or another controller's observation. */
  save(record: TaskRecord, expectedSequence: number, terminal = false): TaskRecord {
    return this.transaction(() => this.saveInside(record, expectedSequence, terminal));
  }
  private saveInside(
    record: TaskRecord,
    expected: number,
    terminal: boolean,
    enrollWorkflow = false,
  ): TaskRecord {
    const prior = this.get(record.result.request_id);
    if (!prior || prior.result.observation_seq !== expected) throw new Error("stale_observation");
    if (
      record.rawSpec !== prior.rawSpec ||
      record.taskBytesBase64 !== prior.taskBytesBase64 ||
      record.bridgeId !== prior.bridgeId ||
      record.requesterId !== prior.requesterId ||
      record.sessionId !== prior.sessionId
    )
      throw new Error("immutable_task_changed");
    for (const key of [
      "request_id",
      "task_spec_hash",
      "task_file_hash",
      "base_commit",
      "synthetic",
    ] as const)
      if (prior.result[key] !== record.result[key]) throw new Error("immutable_identity_changed");
    if (
      prior.intent &&
      (!record.intent ||
        prior.intent.runId !== record.intent.runId ||
        prior.intent.startSequence !== record.intent.startSequence ||
        prior.intent.fencingToken !== record.intent.fencingToken ||
        prior.intent.approvalId !== record.intent.approvalId ||
        prior.intent.sessionId !== record.intent.sessionId ||
        prior.intent.executorId !== record.intent.executorId ||
        JSON.stringify(prior.intent.resourceKeys) !== JSON.stringify(record.intent.resourceKeys) ||
        prior.intent.deadlineAt !== record.intent.deadlineAt)
    )
      throw new Error("immutable_run_changed");
    if (record.intent)
      for (const key of record.intent.resourceKeys) {
        const fence = this.db
          .prepare("SELECT token FROM task_fences WHERE resource_key=?")
          .get(key) as { token: number } | undefined;
        const lock = this.db
          .prepare("SELECT request_id FROM task_write_locks WHERE lock_key=?")
          .get(key) as { request_id: string } | undefined;
        if (
          fence?.token !== record.intent.fencingToken ||
          lock?.request_id !== record.result.request_id
        )
          throw new Error("stale_fencing_token");
      }
    if (
      prior.workflowId !== record.workflowId &&
      (!enrollWorkflow || prior.workflowId !== null || record.workflowId === null)
    )
      throw new Error("immutable_workflow_enrollment");
    assertTaskTransition(prior.result.status, record.result.status);
    if (record.result.observation_seq !== expected + 1) throw new Error("invalid_sequence");
    if (terminal !== isTerminalTask(record.result.status))
      throw new Error("terminal_receipt_required");
    if (terminal && !record.result.synthetic) {
      const receipt = record.result.receipt;
      if (
        !receipt ||
        receipt.request_id !== record.result.request_id ||
        receipt.task_spec_sha256 !== record.result.task_spec_hash ||
        receipt.run_id !== record.result.run_id ||
        receipt.fencing_token !== record.result.fencing_token ||
        receipt.ledger_sequence !== record.result.observation_seq ||
        receipt.terminal_status !== record.result.status
      )
        throw new Error("receipt_mismatch");
    }
    if (
      record.intent &&
      record.result.status === "unknown" &&
      record.result.error?.code === "reconciliation_required"
    )
      this.db
        .prepare("UPDATE task_sessions SET paused=1 WHERE session_id=?")
        .run(record.intent.sessionId);
    const snapshot = JSON.stringify(record);
    this.db
      .prepare("UPDATE task_jobs SET sequence=?,snapshot=? WHERE request_id=? AND sequence=?")
      .run(record.result.observation_seq, snapshot, record.result.request_id, expected);
    this.db
      .prepare("INSERT INTO task_events VALUES (?,?,?)")
      .run(record.result.request_id, record.result.observation_seq, snapshot);
    if (terminal)
      this.db
        .prepare("INSERT INTO task_receipts VALUES (?,?,?,?)")
        .run(
          record.result.request_id,
          record.result.receipt?.receipt_id ?? randomUUID(),
          record.result.observation_seq,
          snapshot,
        );
    if (record.result.started_at && !prior.result.started_at)
      this.handshakeInside(record, "start_receipt");
    if (terminal) {
      this.handshakeInside(record, "terminal_result");
      this.db
        .prepare("DELETE FROM task_write_locks WHERE request_id=?")
        .run(record.result.request_id);
    }
    if (terminal)
      this.db
        .prepare("INSERT INTO task_deliveries VALUES (?,?,0)")
        .run(record.result.request_id, record.result.observation_seq);
    return record;
  }
  /** Atomic one-start consumption and durable dispatch intent precede executor.start. */
  claimStart(
    record: TaskRecord,
    expected: number,
    check: (grant: ApprovalEnvelope) => void,
    session: {
      id: string;
      maxStarts: number;
      reservation: number;
      budgetLimit: number;
      resourceKeys: string[];
      workflowHash: string | null;
      runSeconds: number;
      maxTotalRunSeconds: number;
      now: () => Date;
    },
  ): TaskRecord {
    return this.transaction(() => {
      const prior = this.get(record.result.request_id);
      if (!prior || prior.intent || prior.result.status !== "approved" || !record.intent)
        throw new Error("start_already_claimed");
      const id = record.intent?.approvalId;
      if (!id) throw new Error("approval_missing");
      const grant = this.approval(id);
      if (!grant) throw new Error("approval_missing");
      this.db.prepare("INSERT OR IGNORE INTO task_sessions(session_id) VALUES (?)").run(session.id);
      const usage = this.db
        .prepare("SELECT * FROM task_sessions WHERE session_id=?")
        .get(session.id) as {
        stopped: number;
        paused: number;
        starts: number;
        reserved: number;
        reserved_seconds: number;
      };
      if (
        usage.stopped ||
        usage.starts >= session.maxStarts ||
        usage.reserved + session.reservation > session.budgetLimit ||
        usage.reserved_seconds + session.runSeconds > session.maxTotalRunSeconds
      )
        throw new Error("session_limit_or_stopped");
      if (usage.paused) throw new Error("session_unknown_pause");
      // Unknown outcome blocks further starts for the whole session. Session identity is in intent.
      const unresolved = this.db.prepare("SELECT snapshot FROM task_jobs").all() as {
        snapshot: string;
      }[];
      if (
        unresolved.some((row) => {
          const job = JSON.parse(row.snapshot) as TaskRecord;
          return job.intent?.sessionId === session.id && job.result.status === "unknown";
        })
      )
        throw new Error("session_unknown_pause");
      const dependencyRecord = this.dependencyRecord(record.result.request_id);
      if ((dependencyRecord?.workflowId ?? null) !== record.workflowId)
        throw new Error("workflow_enrollment_missing_or_mismatched");
      let dependencies = dependencyRecord?.dependencies ?? [];
      if (dependencyRecord?.workflowId) {
        const workflow = this.workflow(dependencyRecord.workflowId);
        if (!workflow) throw new Error("workflow_authority_unconfigured");
        const parsed = parseWorkflowManifest(Buffer.from(workflow.raw));
        checkWorkflowGrant(workflow.grant, parsed.manifest, parsed.hash, session.now());
        const node = parsed.manifest.jobs.find(
          (job) => job.request_id === record.result.request_id,
        );
        if (!node) throw new Error("workflow_binding_mismatch");
        const tasks = new Map(
          parsed.manifest.jobs.map((job) => [job.request_id, job.task_spec_sha256]),
        );
        dependencies = node.depends_on.map((dep) => ({
          requestId: dep.request_id,
          taskSpecHash: tasks.get(dep.request_id) ?? "",
          expectedCommit: dep.expected_commit,
          requireAck: dep.require_result_ack,
        }));
        if (JSON.stringify(dependencies) !== JSON.stringify(dependencyRecord.dependencies))
          throw new Error("workflow_dependency_corrupt");
        if (workflow.starts >= workflow.grant.max_starts) throw new Error("workflow_start_limit");
        this.db
          .prepare("UPDATE task_workflows SET starts=starts+1 WHERE workflow_id=?")
          .run(dependencyRecord.workflowId);
        if (
          parsed.hash !== dependencyRecord.workflowHash ||
          workflow.grant.session_id !== record.sessionId ||
          workflow.grant.bridge_id !== record.bridgeId ||
          workflow.grant.policy_snapshot_sha256 !==
            (JSON.parse(record.rawSpec) as { policy_snapshot_sha256: string })
              .policy_snapshot_sha256 ||
          !parsed.manifest.jobs.some(
            (job) =>
              job.request_id === record.result.request_id &&
              job.task_spec_sha256 === record.result.task_spec_hash,
          )
        )
          throw new Error("workflow_binding_mismatch");
      } else {
        if (dependencyRecord && !record.result.synthetic)
          throw new Error("workflow_authority_unconfigured");
        if ((dependencyRecord?.workflowHash ?? null) !== session.workflowHash)
          throw new Error("workflow_binding_mismatch");
      }
      for (const dependency of dependencies) {
        const job = this.get(dependency.requestId);
        if (
          job?.result.status !== "succeeded" ||
          !this.receipt(dependency.requestId) ||
          job.result.task_spec_hash !== dependency.taskSpecHash ||
          (dependency.expectedCommit !== null &&
            job.result.resulting_commit !== dependency.expectedCommit) ||
          (dependency.requireAck && !this.deliveryVerified(dependency.requestId)) ||
          (!record.result.synthetic && job.result.synthetic)
        )
          throw new Error("dependency_not_succeeded");
      }
      let token = 0;
      for (const key of session.resourceKeys) {
        const holder = this.db
          .prepare("SELECT request_id FROM task_write_locks WHERE lock_key=?")
          .get(key);
        if (holder) throw new Error("worktree_write_locked");
        const priorFence = this.db
          .prepare("SELECT token FROM task_fences WHERE resource_key=?")
          .get(key) as { token: number } | undefined;
        token = Math.max(token, priorFence?.token ?? 0);
      }
      if (!Number.isSafeInteger(token + 1)) throw new Error("fencing_token_exhausted");
      token++;
      record.intent.fencingToken = token;
      record.intent.startSequence = record.result.observation_seq;
      record.result.run_id = record.intent.runId;
      record.result.fencing_token = token;
      record.intent.resourceKeys = [...session.resourceKeys];
      for (const key of session.resourceKeys) {
        this.db
          .prepare("INSERT INTO task_write_locks VALUES (?,?)")
          .run(key, record.result.request_id);
        this.db
          .prepare(
            "INSERT INTO task_fences VALUES (?,?) ON CONFLICT(resource_key) DO UPDATE SET token=excluded.token",
          )
          .run(key, token);
      }
      if (grant.usage_reservation_id)
        this.db
          .prepare("INSERT INTO task_reservations VALUES (?,?)")
          .run(grant.usage_reservation_id, grant.approval_id);
      check(grant); // freshness/revocation/hash checked under this same write lock
      const consumed = this.db
        .prepare("UPDATE task_approvals SET consumed=1 WHERE approval_id=? AND consumed=0")
        .run(id);
      if (consumed.changes !== 1) throw new Error("approval_consumed");
      this.db
        .prepare(
          "UPDATE task_sessions SET starts=starts+1,reserved=reserved+?,reserved_seconds=reserved_seconds+? WHERE session_id=?",
        )
        .run(session.reservation, session.runSeconds, session.id);
      return this.saveInside(record, expected, false);
    });
  }
  receipt(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT snapshot FROM task_receipts WHERE request_id=?").get(id) as
      | { snapshot: string }
      | undefined;
    return row ? (JSON.parse(row.snapshot) as TaskRecord) : null;
  }
  /** Authenticated authority only; raw manifest/grant never comes from task prose or CLI. */
  configureWorkflow(raw: Uint8Array, grant: WorkflowGrant, now: Date): void {
    const parsed = parseWorkflowManifest(raw);
    checkWorkflowGrant(grant, parsed.manifest, parsed.hash, now);
    this.transaction(() => {
      const existing = this.workflow(parsed.manifest.workflow_id);
      if (existing) {
        if (
          existing.raw !== Buffer.from(raw).toString("utf8") ||
          JSON.stringify(existing.grant) !== JSON.stringify(grant)
        )
          throw new Error("workflow_conflict");
        return;
      }
      const bound = new Map(
        parsed.manifest.jobs.map((job) => [job.request_id, job.task_spec_sha256]),
      );
      for (const job of parsed.manifest.jobs) {
        const row = this.get(job.request_id);
        if (!row || !["received", "awaiting_approval"].includes(row.result.status))
          throw new Error("workflow_requires_unapproved_nodes");
        if (
          row.result.task_spec_hash !== job.task_spec_sha256 ||
          row.sessionId !== grant.session_id ||
          row.bridgeId !== grant.bridge_id ||
          (JSON.parse(row.rawSpec) as { policy_snapshot_sha256: string }).policy_snapshot_sha256 !==
            grant.policy_snapshot_sha256
        )
          throw new Error("workflow_binding_mismatch");
        if (this.dependencyRecord(job.request_id)) throw new Error("workflow_conflict");
      }
      this.db
        .prepare(
          "INSERT INTO task_workflows(workflow_id,grant_id,raw_manifest,manifest_hash,grant_json,nonce) VALUES (?,?,?,?,?,?)",
        )
        .run(
          parsed.manifest.workflow_id,
          grant.grant_id,
          Buffer.from(raw).toString("utf8"),
          parsed.hash,
          JSON.stringify(grant),
          grant.nonce,
        );
      for (const job of parsed.manifest.jobs) {
        const row = this.get(job.request_id);
        if (!row) throw new Error("workflow_missing_reference");
        const sequence = row.result.observation_seq;
        row.workflowId = parsed.manifest.workflow_id;
        row.result.observation_seq++;
        row.result.observed_at = now.toISOString();
        this.saveInside(row, sequence, false, true);
      }
      for (const job of parsed.manifest.jobs)
        this.db.prepare("INSERT INTO task_dependencies VALUES (?,?)").run(
          job.request_id,
          JSON.stringify({
            workflowId: parsed.manifest.workflow_id,
            workflowHash: parsed.hash,
            dependencies: job.depends_on.map((dep) => ({
              requestId: dep.request_id,
              taskSpecHash: bound.get(dep.request_id),
              expectedCommit: dep.expected_commit,
              requireAck: dep.require_result_ack,
            })),
          }),
        );
    });
  }
  private workflow(id: string): { raw: string; grant: WorkflowGrant; starts: number } | null {
    const row = this.db
      .prepare("SELECT raw_manifest,grant_json,starts FROM task_workflows WHERE workflow_id=?")
      .get(id) as { raw_manifest: string; grant_json: string; starts: number } | undefined;
    return row
      ? {
          raw: row.raw_manifest,
          grant: JSON.parse(row.grant_json) as WorkflowGrant,
          starts: row.starts,
        }
      : null;
  }
  workflowJobs(workflowId: string): string[] {
    const row = this.workflow(workflowId);
    if (!row) throw new Error("workflow_not_found");
    return parseWorkflowManifest(Buffer.from(row.raw)).manifest.jobs.map((job) => job.request_id);
  }
  workflowStopped(requestId: string, now: Date): boolean {
    const dep = this.dependencyRecord(requestId);
    if (!dep?.workflowId) return false;
    const row = this.workflow(dep.workflowId);
    if (!row) return true;
    return row.grant.decision !== "approved" || Date.parse(row.grant.expires_at) <= now.getTime();
  }
  revokeWorkflow(id: string): void {
    this.transaction(() => {
      const row = this.workflow(id);
      if (!row) throw new Error("workflow_not_found");
      row.grant.decision = "revoked";
      this.db
        .prepare("UPDATE task_workflows SET grant_json=? WHERE workflow_id=?")
        .run(JSON.stringify(row.grant), id);
    });
  }
  /** Configure a bounded graph from an authenticated policy snapshot before approving any node. */
  configureDependencies(
    graph: Record<
      string,
      {
        requestId: string;
        taskSpecHash: string;
        expectedCommit: string | null;
        requireAck: boolean;
      }[]
    >,
    workflowHash: string,
  ): void {
    if (
      Object.keys(graph).length === 0 ||
      Object.keys(graph).length > 256 ||
      createHash("sha256").update(JSON.stringify(graph)).digest("hex") !== workflowHash
    )
      throw new Error("workflow_binding_mismatch");
    this.transaction(() => {
      const active = new Set<string>();
      const done = new Set<string>();
      for (const [id, deps] of Object.entries(graph)) {
        const target = this.get(id);
        if (target && !target.result.synthetic) throw new Error("workflow_authority_unconfigured");
        if (!target || !["received", "awaiting_approval"].includes(target.result.status))
          throw new Error("workflow_requires_unapproved_nodes");
        if (deps.length > 256 || new Set(deps.map((dep) => dep.requestId)).size !== deps.length)
          throw new Error("workflow_invalid_edges");
        for (const dep of deps) {
          const prerequisite = this.get(dep.requestId);
          if (!prerequisite || !Object.hasOwn(graph, dep.requestId))
            throw new Error("workflow_missing_reference");
          if (
            prerequisite.result.task_spec_hash !== dep.taskSpecHash ||
            (dep.expectedCommit !== null &&
              !/^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\s\S])/.test(dep.expectedCommit))
          )
            throw new Error("workflow_binding_mismatch");
        }
        const prior = this.dependencyRecord(id);
        if (prior && prior.workflowHash !== workflowHash) throw new Error("workflow_conflict");
      }
      function visit(id: string): void {
        if (active.has(id)) throw new Error("dependency_cycle");
        if (done.has(id)) return;
        active.add(id);
        for (const dep of graph[id] ?? []) visit(dep.requestId);
        active.delete(id);
        done.add(id);
      }
      for (const id of Object.keys(graph)) visit(id);
      for (const [id, dependencies] of Object.entries(graph))
        this.db
          .prepare("INSERT OR IGNORE INTO task_dependencies VALUES (?,?)")
          .run(id, JSON.stringify({ workflowHash, dependencies }));
    });
  }
  dependencies(requestId: string) {
    return this.dependencyRecord(requestId);
  }
  private dependencyRecord(requestId: string): {
    workflowHash: string;
    workflowId?: string;
    dependencies: {
      requestId: string;
      taskSpecHash: string;
      expectedCommit: string | null;
      requireAck: boolean;
    }[];
  } | null {
    const row = this.db
      .prepare("SELECT dependencies FROM task_dependencies WHERE request_id=?")
      .get(requestId) as { dependencies: string } | undefined;
    return row ? JSON.parse(row.dependencies) : null;
  }
  localEvidence(value: unknown): ArtifactRef {
    const body = JSON.stringify(value);
    const artifact_id = `bridge-${randomUUID()}`;
    const sha256 = createHash("sha256").update(body).digest("hex");
    this.db.prepare("INSERT INTO task_evidence VALUES (?,?,?)").run(artifact_id, sha256, body);
    return {
      artifact_id,
      sha256,
      size_bytes: Buffer.byteLength(body),
      media_type: "application/json",
    };
  }
  readLocalEvidence(ref: ArtifactRef): Uint8Array | null {
    const row = this.db
      .prepare("SELECT sha256,body FROM task_evidence WHERE artifact_id=?")
      .get(ref.artifact_id);
    if (!row) return null;
    const bytes = Buffer.from(String(row.body));
    if (
      row.sha256 !== ref.sha256 ||
      bytes.byteLength !== ref.size_bytes ||
      createHash("sha256").update(bytes).digest("hex") !== ref.sha256
    )
      throw new Error("local_evidence_hash_mismatch");
    return bytes;
  }
  stopSession(sessionId: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO task_sessions(session_id,stopped) VALUES (?,1) ON CONFLICT(session_id) DO UPDATE SET stopped=1",
        )
        .run(sessionId);
      this.db
        .prepare("INSERT INTO task_session_events(session_id,action) VALUES (?,?)")
        .run(sessionId, "stopped");
      const rows = this.db
        .prepare("SELECT approval_id,envelope FROM task_approvals WHERE consumed=0")
        .all() as { approval_id: string; envelope: string }[];
      for (const row of rows) {
        const grant = JSON.parse(row.envelope) as ApprovalEnvelope;
        if (this.get(grant.request_id)?.sessionId === sessionId) {
          grant.decision = "revoked";
          grant.max_starts = 0;
          this.db
            .prepare("UPDATE task_approvals SET envelope=? WHERE approval_id=?")
            .run(JSON.stringify(grant), row.approval_id);
          this.db
            .prepare("INSERT INTO task_approval_events(approval_id,action,envelope) VALUES (?,?,?)")
            .run(row.approval_id, "revoked", JSON.stringify(grant));
        }
      }
    });
  }
  pauseSession(sessionId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE task_sessions SET paused=1 WHERE session_id=?").run(sessionId);
      this.db
        .prepare("INSERT INTO task_session_events(session_id,action) VALUES (?,?)")
        .run(sessionId, "paused_unknown");
    });
  }
  resumeSession(sessionId: string): void {
    this.transaction(() => {
      if (
        this.sessionStopped(sessionId) ||
        this.listSession(sessionId).some((job) => job.result.status === "unknown")
      )
        throw new Error("session_resume_denied");
      this.db.prepare("UPDATE task_sessions SET paused=0 WHERE session_id=?").run(sessionId);
      this.db
        .prepare("INSERT INTO task_session_events(session_id,action) VALUES (?,?)")
        .run(sessionId, "resumed");
    });
  }
  sessionStopped(sessionId: string): boolean {
    const row = this.db
      .prepare("SELECT stopped FROM task_sessions WHERE session_id=?")
      .get(sessionId) as { stopped: number } | undefined;
    return row?.stopped === 1;
  }
  /** Monitor order only: the authoritative insertion rowid, with an opaque existing UUID cursor. */
  recentPage(after = "", limit = 32): { requestIds: string[]; next: string | null } {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 256 ||
      (after !== "" &&
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(after))
    )
      throw new Error("task_page_invalid");
    const cursor = after
      ? this.db.prepare("SELECT rowid AS position FROM task_jobs WHERE request_id=?").get(after)
      : null;
    if (after && !cursor) throw new Error("task_page_cursor_missing");
    const rows = (
      cursor
        ? this.db
            .prepare("SELECT request_id FROM task_jobs WHERE rowid<? ORDER BY rowid DESC LIMIT ?")
            .all(Number(cursor.position), limit + 1)
        : this.db
            .prepare("SELECT request_id FROM task_jobs ORDER BY rowid DESC LIMIT ?")
            .all(limit + 1)
    ) as { request_id: string }[];
    return {
      requestIds: rows.slice(0, limit).map((row) => row.request_id),
      next: rows.length > limit ? (rows[limit - 1]?.request_id ?? null) : null,
    };
  }
  listPage(after = "", limit = 32): { requestIds: string[]; next: string | null } {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 256 ||
      (after !== "" && !/^[a-f0-9-]{36}$/.test(after))
    )
      throw new Error("task_page_invalid");
    const rows = this.db
      .prepare("SELECT request_id FROM task_jobs WHERE request_id>? ORDER BY request_id LIMIT ?")
      .all(after, limit + 1) as { request_id: string }[];
    return {
      requestIds: rows.slice(0, limit).map((row) => row.request_id),
      next: rows.length > limit ? (rows[limit - 1]?.request_id ?? null) : null,
    };
  }
  listSession(sessionId: string): TaskRecord[] {
    const rows = this.db.prepare("SELECT snapshot FROM task_jobs").all() as { snapshot: string }[];
    return rows
      .map((row) => JSON.parse(row.snapshot) as TaskRecord)
      .filter((row) => row.sessionId === sessionId);
  }
  /** Read-only projection of durable counters. Limits come separately from the trusted policy. */
  sessionSnapshot(sessionId: string): {
    sessionId: string;
    stopped: boolean;
    paused: boolean;
    starts: number;
    reserved: number;
    reservedSeconds: number;
  } {
    const row = this.db.prepare("SELECT * FROM task_sessions WHERE session_id=?").get(sessionId) as
      | {
          stopped: number;
          paused: number;
          starts: number;
          reserved: number;
          reserved_seconds: number;
        }
      | undefined;
    return {
      sessionId,
      stopped: row?.stopped === 1,
      paused: row?.paused === 1,
      starts: row?.starts ?? 0,
      reserved: row?.reserved ?? 0,
      reservedSeconds: row?.reserved_seconds ?? 0,
    };
  }
  /** Opaque registered resource keys, not filesystem paths; no PID-only lock release. */
  activeLocks(sessionId: string): { resourceKey: string; requestId: string }[] {
    const ids = new Set(this.listSession(sessionId).map((row) => row.result.request_id));
    return (
      this.db
        .prepare(
          "SELECT lock_key AS resourceKey,request_id AS requestId FROM task_write_locks ORDER BY lock_key",
        )
        .all() as unknown as { resourceKey: string; requestId: string }[]
    ).filter((row) => ids.has(row.requestId));
  }
  pendingDeliveries(): { requestId: string; sequence: number }[] {
    return (
      this.db
        .prepare("SELECT request_id AS requestId, sequence FROM task_deliveries")
        .all() as unknown as { requestId: string; sequence: number }[]
    ).filter((row) => !this.deliveryVerified(row.requestId));
  }
  private handshakeInside(record: TaskRecord, stage: TaskHandshake["stage"]): TaskHandshake {
    const event: TaskHandshake = {
      eventId: randomUUID(),
      stage,
      requestId: record.result.request_id,
      taskSpecHash: record.result.task_spec_hash,
      runId: record.result.run_id,
      sequence: record.result.observation_seq,
      actorId: record.bridgeId,
      fencingToken: record.result.fencing_token,
      startIntentSequence: record.intent?.startSequence ?? null,
      processIdentity: record.result.process_identity,
      payloadSha256: createHash("sha256").update(serializeTaskResult(record.result)).digest("hex"),
    };
    this.db
      .prepare("INSERT INTO task_handshakes VALUES (?,?,?)")
      .run(event.requestId, stage, JSON.stringify(event));
    return event;
  }
  handshake(requestId: string, stage: TaskHandshake["stage"]): TaskHandshake | null {
    const row = this.db
      .prepare("SELECT body FROM task_handshakes WHERE request_id=? AND stage=?")
      .get(requestId, stage) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as TaskHandshake) : null;
  }
  appendQuotaObservation(snapshot: TaskQuotaSnapshot): void {
    if (!this.get(snapshot.requestId)) throw new Error("task_not_found");
    this.db
      .prepare("INSERT INTO task_quota_observations VALUES (?,?,?)")
      .run(randomUUID(), snapshot.requestId, JSON.stringify(snapshot));
  }
  quotaObservations(requestId: string): TaskQuotaSnapshot[] {
    return (
      this.db
        .prepare("SELECT snapshot FROM task_quota_observations WHERE request_id=? ORDER BY rowid")
        .all(requestId) as { snapshot: string }[]
    ).map((row) => JSON.parse(row.snapshot) as TaskQuotaSnapshot);
  }
  deliveryPayload(requestId: string): Uint8Array {
    const record = this.receipt(requestId);
    const event = this.handshake(requestId, "terminal_result");
    if (!record || !event) throw new Error("delivery_not_terminal");
    const bytes = Buffer.from(serializeTaskResult(record.result));
    if (createHash("sha256").update(bytes).digest("hex") !== event.payloadSha256)
      throw new Error("delivery_payload_corrupt");
    return bytes;
  }
  /** Authenticated requester ACK of one immutable terminal event. This is delivery acceptance,
   * not execution, review approval or a Git merge. Redelivery uses the same eventId. */
  acknowledgeDelivery(ack: TaskHandshake, proof?: MaterializationReceiptV1): void {
    this.transaction(() => {
      const record = this.get(ack.requestId);
      const terminal = this.handshake(ack.requestId, "terminal_result");
      if (
        !record ||
        !terminal ||
        ack.stage !== "result_ack" ||
        ack.actorId !== record.requesterId ||
        ack.eventId !== terminal.eventId ||
        ack.sequence !== terminal.sequence ||
        ack.taskSpecHash !== terminal.taskSpecHash ||
        ack.runId !== terminal.runId ||
        ack.payloadSha256 !== terminal.payloadSha256 ||
        ack.fencingToken !== terminal.fencingToken ||
        ack.startIntentSequence !== terminal.startIntentSequence ||
        !isDeepStrictEqual(ack.processIdentity, terminal.processIdentity)
      )
        throw new Error("delivery_identity_mismatch");
      if (proof) {
        this.validateMaterialization(record, terminal, proof);
        const body = serializeMaterializationReceiptV1(proof);
        const previous = this.materialization(ack.requestId);
        if (previous && serializeMaterializationReceiptV1(previous) !== body)
          throw new Error("delivery_proof_conflict");
        this.db
          .prepare("INSERT OR IGNORE INTO task_materialization VALUES (?,?)")
          .run(ack.requestId, body);
      } else if (!record.result.synthetic) throw new Error("delivery_materialization_required");
      // Synthetic demo ACK is labelled simulation and can never unlock a non-synthetic dependent.
      const prior = this.handshake(ack.requestId, "result_ack");
      if (prior && !isDeepStrictEqual(prior, ack)) throw new Error("ack_conflict");
      if (!prior)
        this.db
          .prepare("INSERT INTO task_handshakes VALUES (?,?,?)")
          .run(ack.requestId, ack.stage, JSON.stringify(ack));
      this.db
        .prepare("UPDATE task_deliveries SET acknowledged=1 WHERE request_id=? AND sequence=?")
        .run(ack.requestId, ack.sequence);
    });
  }
  materialization(requestId: string): MaterializationReceiptV1 | null {
    const row = this.db
      .prepare("SELECT body FROM task_materialization WHERE request_id=?")
      .get(requestId) as { body: string } | undefined;
    return row ? parseMaterializationReceiptV1(Buffer.from(row.body)) : null;
  }
  private validateMaterialization(
    record: TaskRecord,
    terminal: TaskHandshake,
    proof: MaterializationReceiptV1,
  ): void {
    serializeMaterializationReceiptV1(proof);
    assertDeliveryBinding(proof, {
      requesterActorId: record.requesterId,
      recipientActorId: record.bridgeId,
      requestId: terminal.requestId,
      taskSpecHash: terminal.taskSpecHash,
      execution: { kind: "local_execution", runId: terminal.runId },
      terminalEventId: terminal.eventId,
      payloadSha256: terminal.payloadSha256,
    });
    if (
      proof.synthetic !== record.result.synthetic ||
      proof.payloadVerification !== "local_result_and_receipt"
    )
      throw new Error("delivery_proof_scope_mismatch");
    for (const ref of taskResultArtifactRefs(record.result)) {
      const row = proof.verifiedArtifacts.find((row) => row.artifactId === ref.artifact_id);
      if (!row?.required || row.contentSha256 !== ref.sha256 || row.sizeBytes !== ref.size_bytes)
        throw new Error("delivery_proof_artifact_missing");
    }
  }
  /** Historical payload-only ACKs are visible but insufficient for real delivery/dependencies. */
  deliveryVerified(requestId: string): boolean {
    const record = this.get(requestId),
      terminal = this.handshake(requestId, "terminal_result");
    if (!record || !terminal || !this.handshake(requestId, "result_ack")) return false;
    const proof = this.materialization(requestId);
    if (!proof) return record.result.synthetic;
    this.validateMaterialization(record, terminal, proof);
    return true;
  }
  close(): void {
    this.db.close();
  }
}
export async function openTaskStore(path: string, faults?: StoreFaults): Promise<TaskStore> {
  await mkdir(dirname(path), { recursive: true });
  return new TaskStore(path, faults);
}
