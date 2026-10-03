/** Small, versioned model-session reminders. No process, transport or approval authority. */
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";

export const SESSION_BOOTSTRAP_VERSION = "bridge-v2-session/1";
export const MAX_BOOTSTRAP_BYTES = 8192;
export const MAX_BOOTSTRAP_ACK_BYTES = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DOCS = [
  "docs/bridge-v2/USAGE.md",
  "docs/bridge-v2/SESSION-BOOTSTRAP.md",
  "docs/bridge-v2/ADAPTERS.md",
] as const;
const COMMON = [
  "Bridge v2 reminder for this Bridge-launched model session only. Installing Bridge does not make new sessions remember it. Read linked docs only when needed, at the same checkout revision.",
  "Discover current capabilities, then the shipped TaskSpec/result schemas. Generate JSON and validate it; never guess fields, registered agent/model/repo IDs, effort support, authority or delivery targets.",
  "Preserve the exact request UUID, raw TaskSpec/task-file bytes and SHA-256 hashes. Keep response framing bound to the exact request UUID, task hash and attempt UUID supplied by Bridge.",
  "Distinguish receiptACK, startReceipt, terminal result and resultACK. Verify matching durable receipts, result/artifact hashes and evidence before accepting a result; transport arrival is not task success.",
  "Unknown outcome, timeout, disconnect or lost ACK: reconcile the original UUID/hash/attempt and receipts. Never reexecute, mint a replacement UUID, change model or switch billing routes to hide uncertainty.",
  "BEGIN/END framing is transport only: not approval, execution authority, process termination or success evidence. Ordinary Chat returns hosted-response-1 evidence, not a fabricated local-process ResultSpec.",
  "This bootstrap ACK acknowledges only the reminder version. If requested, include its ack JSON inside the framed response body; never replace task receiptACK/resultACK with it or put extra text outside the frame. Version changes or lost/compacted context require a short reconfirmation.",
] as const;
const ROLE = {
  issuer:
    "Issuer: inspect task capabilities and task schema task/result, prepare and validate exact-byte JSON, then use only the configured authorized bus route. Retrieve and verify the original result before acknowledging its exact payload hash.",
  response_producer:
    "Response producer: act only on the verified request and configured authority. Return one complete answer inside the exact supplied BEGIN/END frame, without quoting or echoing the frame template. Do not claim local execution without authenticated local evidence.",
} as const;

export interface SessionBootstrapIdentity {
  /** Host-generated model-session UUID, not a machine installation or approval-session ID. */
  sessionId: string;
  provider: "claude" | "codex" | "chatgpt" | "antigravity";
  role: "issuer" | "response_producer";
  repoId: string;
  /** Trusted launcher increments this before reuse after possible context loss. */
  contextEpoch: number;
}
export interface SessionBootstrapAck {
  protocol: "bridge-session-bootstrap-ack/1";
  sessionId: string;
  contextEpoch: number;
  version: string;
  bootstrapSha256: string;
  challengeId: string;
}
export interface SessionBootstrapReminder {
  protocol: "bridge-session-bootstrap/1";
  session: SessionBootstrapIdentity;
  version: string;
  bootstrapSha256: string;
  challengeId: string;
  instructions: string[];
  docs: string[];
  ack: SessionBootstrapAck;
  reexecute: false;
}
export interface SessionBootstrapPlan {
  reminder: SessionBootstrapReminder;
  reminderJson: string;
  reminderSha256: string;
  bootstrapSha256: string;
  version: string;
  challengeId: string;
  ack: SessionBootstrapAck;
}
function checkedIdentity(session: SessionBootstrapIdentity): void {
  if (
    !session ||
    typeof session.sessionId !== "string" ||
    !UUID.test(session.sessionId) ||
    !["claude", "codex", "chatgpt", "antigravity"].includes(session.provider) ||
    !["issuer", "response_producer"].includes(session.role) ||
    (session.provider === "chatgpt" && session.role !== "response_producer") ||
    typeof session.repoId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(session.repoId) ||
    !Number.isSafeInteger(session.contextEpoch) ||
    session.contextEpoch < 1 ||
    Object.keys(session).sort().join(",") !== "contextEpoch,provider,repoId,role,sessionId"
  )
    throw new Error("bootstrap_session_invalid");
}
function checkedVersion(version: string): void {
  if (typeof version !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/.test(version))
    throw new Error("bootstrap_version_invalid");
}
/** Pure planner; it neither invokes a model nor edits CLI settings or task-file bytes. */
export function createSessionBootstrap(
  session: SessionBootstrapIdentity,
  options: { version?: string; challengeId?: string } = {},
): SessionBootstrapPlan {
  checkedIdentity(session);
  const version = options.version ?? SESSION_BOOTSTRAP_VERSION;
  checkedVersion(version);
  const challengeId = options.challengeId ?? randomUUID();
  if (!UUID.test(challengeId)) throw new Error("bootstrap_challenge_invalid");
  const instructions = [...COMMON, ROLE[session.role]];
  const docs =
    session.provider === "antigravity" ? [...DOCS, "docs/bridge-v2/ANTIGRAVITY.md"] : [...DOCS];
  const bootstrapSha256 = sha256Bytes(Buffer.from(JSON.stringify({ version, instructions, docs })));
  const ack: SessionBootstrapAck = {
    protocol: "bridge-session-bootstrap-ack/1",
    sessionId: session.sessionId,
    contextEpoch: session.contextEpoch,
    version,
    bootstrapSha256,
    challengeId,
  };
  const reminder: SessionBootstrapReminder = {
    protocol: "bridge-session-bootstrap/1",
    session: structuredClone(session),
    version,
    bootstrapSha256,
    challengeId,
    instructions,
    docs,
    ack,
    reexecute: false,
  };
  const reminderJson = JSON.stringify(reminder);
  if (Buffer.byteLength(reminderJson) > MAX_BOOTSTRAP_BYTES)
    throw new Error("bootstrap_reminder_too_large");
  // Round trip through the strict wire parser; no manually interpolated JSON instructions.
  if (!isDeepStrictEqual(parseStrictJsonBytes(Buffer.from(reminderJson)), reminder))
    throw new Error("bootstrap_reminder_invalid");
  return {
    reminder,
    reminderJson,
    reminderSha256: sha256Bytes(Buffer.from(reminderJson)),
    bootstrapSha256,
    version,
    challengeId,
    ack: structuredClone(ack),
  };
}
/** Validate exact bytes/hash AND the generated protocol shape, including fixed guidance. */
export function parseSessionBootstrap(
  bytes: Uint8Array,
  expectedSha256: string,
): SessionBootstrapReminder {
  if (
    bytes.byteLength > MAX_BOOTSTRAP_BYTES ||
    !HASH.test(expectedSha256) ||
    sha256Bytes(bytes) !== expectedSha256
  )
    throw new Error("bootstrap_reminder_hash_mismatch");
  const parsed = parseStrictJsonBytes(bytes) as SessionBootstrapReminder;
  if (!parsed || typeof parsed !== "object") throw new Error("bootstrap_reminder_invalid");
  const expected = createSessionBootstrap(parsed.session, {
    version: parsed.version,
    challengeId: parsed.challengeId,
  });
  if (!isDeepStrictEqual(parsed, expected.reminder)) throw new Error("bootstrap_reminder_invalid");
  return parsed;
}

/** Validate every supplied plan field and its original v1 byte representation. */
export function validateSessionBootstrapPlan(
  plan: SessionBootstrapPlan,
  expectedSession?: SessionBootstrapIdentity,
): SessionBootstrapPlan {
  if (!plan || typeof plan.reminderJson !== "string") throw new Error("bootstrap_plan_invalid");
  const reminder = parseSessionBootstrap(Buffer.from(plan.reminderJson), plan.reminderSha256);
  const expected = createSessionBootstrap(reminder.session, {
    version: reminder.version,
    challengeId: reminder.challengeId,
  });
  if (
    !isDeepStrictEqual(plan, expected) ||
    (expectedSession && !isDeepStrictEqual(reminder.session, expectedSession))
  )
    throw new Error("bootstrap_plan_mismatch");
  return structuredClone(expected);
}

export interface SessionBootstrapReceipt {
  protocol: "bridge-session-bootstrap-receipt/1";
  receiptId: string;
  session: SessionBootstrapIdentity;
  version: string;
  bootstrapSha256: string;
  reminderSha256: string;
  challengeId: string;
  acknowledgedAt: string;
  expiresAt: string;
  evidence: "bootstrap-ack-only";
}
export interface PrepareSessionBootstrap {
  session: SessionBootstrapIdentity;
  /** Set by trusted Bridge launcher code, never inferred from model output. */
  bridgeLaunched: true;
  startup:
    | "claude-print-stdin"
    | "codex-exec-stdin"
    | "ordinary-chat-prompt"
    | "antigravity-stream-stdin";
  mode: "new" | "resume";
  context: "retained" | "lost";
  /** Opaque ID must resolve to this store's matching, unexpired receipt. */
  receiptId?: string;
}
export type SessionBootstrapDecision =
  | { kind: "reuse"; receipt: SessionBootstrapReceipt }
  | {
      kind: "confirm";
      reason: "new_session" | "version_changed" | "context_lost" | "receipt_missing";
      plan: SessionBootstrapPlan;
      alreadyPending: boolean;
    };
interface StoredSession {
  plan: SessionBootstrapPlan;
  receipt: SessionBootstrapReceipt | null;
  reason: Extract<SessionBootstrapDecision, { kind: "confirm" }>["reason"];
  createdAt: number;
  expiresAt: number;
}
export interface SessionBootstrapStoreOptions {
  /** Optional private host-local SQLite file. Omit for process-local memory only. */
  dbPath?: string;
  version?: string;
  maxSessions?: number;
  ttlMs?: number;
  now?: () => Date;
}
/** Bounded acknowledgement ledger; not an authentication service or execution ledger.
 * Persist before sending. An uncertain send stays pending; it never permits task replay. */
export class SessionBootstrapStore {
  private readonly db: DatabaseSync;
  private readonly version: string;
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  constructor(options: SessionBootstrapStoreOptions = {}) {
    this.version = options.version ?? SESSION_BOOTSTRAP_VERSION;
    checkedVersion(this.version);
    this.maxSessions = options.maxSessions ?? 1024;
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    if (
      !Number.isSafeInteger(this.maxSessions) ||
      this.maxSessions < 1 ||
      this.maxSessions > 10000 ||
      !Number.isSafeInteger(this.ttlMs) ||
      this.ttlMs < 1 ||
      this.ttlMs > 30 * 24 * 60 * 60 * 1000
    )
      throw new Error("bootstrap_store_limits_invalid");
    if (options.dbPath !== undefined) {
      const parent = dirname(options.dbPath);
      const directory = lstatSync(parent);
      if (
        !isAbsolute(options.dbPath) ||
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        realpathSync(parent) !== parent ||
        directory.uid !== process.getuid?.() ||
        (directory.mode & 0o077) !== 0
      )
        throw new Error("bootstrap_state_directory_not_private");
      try {
        closeSync(openSync(options.dbPath, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const file = lstatSync(options.dbPath);
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.nlink !== 1 ||
        file.uid !== process.getuid?.() ||
        (file.mode & 0o077) !== 0
      )
        throw new Error("bootstrap_state_file_not_private");
    }
    this.db = new DatabaseSync(options.dbPath ?? ":memory:");
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS bridge_session_bootstrap (
          session_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          row_json TEXT NOT NULL CHECK(length(row_json) <= 32768));`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private time(): number {
    const time = this.now().getTime();
    if (!Number.isSafeInteger(time) || time < 0 || time + this.ttlMs > 8640000000000000)
      throw new Error("bootstrap_time_invalid");
    return time;
  }
  private read(sessionId: string, now: number): StoredSession | null {
    const raw = this.db
      .prepare("SELECT row_json FROM bridge_session_bootstrap WHERE session_id=? AND expires_at>?")
      .get(sessionId, now);
    if (!raw) return null;
    const row = parseStrictJsonBytes(Buffer.from(String(raw.row_json))) as StoredSession;
    const reminder = parseSessionBootstrap(
      Buffer.from(row.plan.reminderJson),
      row.plan.reminderSha256,
    );
    if (
      reminder.session.sessionId !== sessionId ||
      !isDeepStrictEqual(
        row.plan,
        createSessionBootstrap(reminder.session, {
          version: reminder.version,
          challengeId: reminder.challengeId,
        }),
      ) ||
      !Number.isSafeInteger(row.createdAt) ||
      !Number.isSafeInteger(row.expiresAt) ||
      row.expiresAt <= now
    )
      throw new Error("bootstrap_store_invalid");
    if (
      row.receipt &&
      (!UUID.test(row.receipt.receiptId) ||
        !isDeepStrictEqual(
          row.receipt,
          this.receipt(row, row.receipt.receiptId, row.receipt.acknowledgedAt),
        ))
    )
      throw new Error("bootstrap_store_invalid");
    return row;
  }
  private save(row: StoredSession, now: number): void {
    this.db.prepare("DELETE FROM bridge_session_bootstrap WHERE expires_at<=?").run(now);
    this.db
      .prepare(
        "INSERT INTO bridge_session_bootstrap VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET created_at=excluded.created_at,expires_at=excluded.expires_at,row_json=excluded.row_json",
      )
      .run(row.plan.reminder.session.sessionId, row.createdAt, row.expiresAt, JSON.stringify(row));
    this.db
      .prepare(
        "DELETE FROM bridge_session_bootstrap WHERE session_id IN (SELECT session_id FROM bridge_session_bootstrap ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)",
      )
      .run(this.maxSessions);
  }
  private receipt(
    row: StoredSession,
    receiptId: string,
    acknowledgedAt: string,
  ): SessionBootstrapReceipt {
    if (
      !Number.isFinite(Date.parse(acknowledgedAt)) ||
      new Date(acknowledgedAt).toISOString() !== acknowledgedAt ||
      Date.parse(acknowledgedAt) < row.createdAt ||
      Date.parse(acknowledgedAt) >= row.expiresAt
    )
      throw new Error("bootstrap_receipt_time_invalid");
    const { reminder, reminderSha256, bootstrapSha256, version, challengeId } = row.plan;
    return {
      protocol: "bridge-session-bootstrap-receipt/1",
      receiptId,
      session: structuredClone(reminder.session),
      version,
      bootstrapSha256,
      reminderSha256,
      challengeId,
      acknowledgedAt,
      expiresAt: new Date(row.expiresAt).toISOString(),
      evidence: "bootstrap-ack-only",
    };
  }
  prepare(input: PrepareSessionBootstrap): SessionBootstrapDecision {
    checkedIdentity(input.session);
    const startup = {
      claude: "claude-print-stdin",
      codex: "codex-exec-stdin",
      chatgpt: "ordinary-chat-prompt",
      antigravity: "antigravity-stream-stdin",
    };
    if (
      input.bridgeLaunched !== true ||
      input.startup !== startup[input.session.provider] ||
      !["new", "resume"].includes(input.mode) ||
      !["retained", "lost"].includes(input.context) ||
      (input.receiptId !== undefined && !UUID.test(input.receiptId))
    )
      throw new Error("bootstrap_launch_invalid");
    return this.transaction(() => {
      const now = this.time();
      const previous = this.read(input.session.sessionId, now);
      if (previous) {
        const old = previous.plan.reminder.session;
        if (
          !isDeepStrictEqual({ ...old, contextEpoch: input.session.contextEpoch }, input.session) ||
          input.session.contextEpoch < old.contextEpoch
        )
          throw new Error("bootstrap_session_conflict");
        if (input.mode === "new" && previous.receipt)
          throw new Error("bootstrap_session_id_reused");
        if (
          input.context === "lost" &&
          input.session.contextEpoch <= old.contextEpoch &&
          (previous.receipt || previous.reason !== "context_lost")
        )
          throw new Error("bootstrap_context_epoch_required");
      }
      const current = createSessionBootstrap(input.session, {
        version: this.version,
        ...(previous ? { challengeId: previous.plan.challengeId } : {}),
      });
      const sameVersion = previous?.plan.bootstrapSha256 === current.bootstrapSha256;
      const sameContext =
        previous?.plan.reminder.session.contextEpoch === input.session.contextEpoch;
      if (
        previous?.receipt &&
        input.mode === "resume" &&
        input.context === "retained" &&
        sameVersion &&
        sameContext &&
        input.receiptId === previous.receipt.receiptId
      )
        return { kind: "reuse", receipt: structuredClone(previous.receipt) };
      if (previous && !previous.receipt && sameVersion && sameContext)
        return {
          kind: "confirm",
          reason: previous.reason,
          plan: structuredClone(previous.plan),
          alreadyPending: true,
        };
      const reason =
        input.context === "lost" || (previous && !sameContext)
          ? "context_lost"
          : previous && !sameVersion
            ? "version_changed"
            : input.mode === "new"
              ? "new_session"
              : "receipt_missing";
      // Only a genuinely new confirmation gets a challenge. Retained pending reads generate none.
      const fresh = previous
        ? createSessionBootstrap(input.session, { version: this.version })
        : current;
      const row: StoredSession = {
        plan: fresh,
        receipt: null,
        reason,
        createdAt: now,
        expiresAt: now + this.ttlMs,
      };
      this.save(row, now);
      return { kind: "confirm", reason, plan: structuredClone(fresh), alreadyPending: false };
    });
  }
  /** Read only. A dispatched run must never prepare replacement advisory state. */
  inspect(plan: SessionBootstrapPlan): { receipt: SessionBootstrapReceipt | null } | null {
    validateSessionBootstrapPlan(plan);
    const row = this.read(plan.reminder.session.sessionId, this.time());
    if (!row || !isDeepStrictEqual(row.plan, plan)) return null;
    return { receipt: structuredClone(row.receipt) };
  }
  /** Caller must authenticate the session/channel before invoking this function. */
  acknowledge(session: SessionBootstrapIdentity, bytes: Uint8Array): SessionBootstrapReceipt {
    checkedIdentity(session);
    if (bytes.byteLength > MAX_BOOTSTRAP_ACK_BYTES) throw new Error("bootstrap_ack_too_large");
    const ack = parseStrictJsonBytes(bytes);
    return this.transaction(() => {
      const now = this.time();
      const row = this.read(session.sessionId, now);
      if (!row) throw new Error("bootstrap_ack_mismatch");
      const current = createSessionBootstrap(session, {
        version: this.version,
        challengeId: row.plan.challengeId,
      });
      if (
        !isDeepStrictEqual(row.plan.reminder.session, session) ||
        row.plan.bootstrapSha256 !== current.bootstrapSha256 ||
        !isDeepStrictEqual(ack, row.plan.ack)
      )
        throw new Error("bootstrap_ack_mismatch");
      if (!row.receipt) {
        row.receipt = this.receipt(row, randomUUID(), new Date(now).toISOString());
        this.save(row, now);
      }
      return structuredClone(row.receipt);
    });
  }
}
