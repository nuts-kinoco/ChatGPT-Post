/** Durable local lifecycle evidence. Appending belongs to the owner's source transaction. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sha256Bytes } from "../contracts/task.js";
import type { BridgeResult } from "../contracts/types.js";

export interface BridgeUsageEvent {
  version: 1;
  sourceId: string;
  eventId: string;
  sequence: number;
  origin: "direct" | "hosted";
  kind: "start" | "result" | "coverage_gap";
  requestId: string;
  requesterActorId: string | null;
  runId: string | null;
  attemptId: string | null;
  attemptedAt: string | null;
  observedAt: string;
  revision: number;
  result?: BridgeResult;
}
export type UsageEventInput = Omit<
  BridgeUsageEvent,
  "version" | "sourceId" | "eventId" | "sequence" | "revision"
>;
export interface LifecycleSinkBinding {
  targetId: string;
  directActorId: string | null;
}
export interface UsageLifecycleSource {
  readonly sourceId: string;
  readonly scopeId?: string;
  cursorPosition?(consumerId: string): number;
  registerLifecycleSink?(namespace: string, binding: LifecycleSinkBinding): void;
  drainLifecycle(
    consumerId: string,
    consume: UsageConsumer,
    limit?: number,
  ): Promise<{ processed: number; pending: boolean }>;
}
export type UsageConsumer = (event: BridgeUsageEvent) => void | Promise<void>;
const hash = (value: string) => sha256Bytes(Buffer.from(value));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SINK_TARGET = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]$/;
function validInput(input: UsageEventInput): boolean {
  return (
    ["direct", "hosted"].includes(input.origin) &&
    ["start", "result", "coverage_gap"].includes(input.kind) &&
    REQUEST_ID.test(input.requestId) &&
    instant(input.observedAt) &&
    (input.attemptedAt === null ||
      (instant(input.attemptedAt) && input.observedAt >= input.attemptedAt)) &&
    (input.runId === null || UUID.test(input.runId)) &&
    (input.attemptId === null || UUID.test(input.attemptId)) &&
    (input.requesterActorId === null || /^[a-z][a-z0-9_-]{0,63}$/.test(input.requesterActorId)) &&
    (input.origin !== "direct" || input.requesterActorId === null) &&
    (input.kind === "coverage_gap" || !!input.attemptId || !!input.runId) &&
    (input.kind !== "start" || (!!input.attemptId && input.attemptedAt === input.observedAt)) &&
    (input.kind !== "result" || !!input.result)
  );
}
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
export class UsageLifecycleJournal {
  readonly sourceId: string;
  private readonly draining = new Set<string>();
  constructor(private readonly db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS usage_lifecycle_identity(id INTEGER PRIMARY KEY CHECK(id=1),source_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS usage_lifecycle_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,identity TEXT NOT NULL,evidence_digest TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,raw TEXT NOT NULL,UNIQUE(identity,evidence_digest)); CREATE TABLE IF NOT EXISTS usage_lifecycle_cursors(consumer TEXT PRIMARY KEY,sequence INTEGER NOT NULL);",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS usage_lifecycle_request_kind ON usage_lifecycle_events(json_extract(body,'$.requestId'),json_extract(body,'$.kind')); CREATE INDEX IF NOT EXISTS usage_lifecycle_identity_sequence ON usage_lifecycle_events(identity,sequence);",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS usage_lifecycle_sinks(namespace TEXT PRIMARY KEY,target_id TEXT NOT NULL,direct_actor_id TEXT,digest TEXT NOT NULL);",
    );
    db.prepare("INSERT OR IGNORE INTO usage_lifecycle_identity VALUES(1,?)").run(randomUUID());
    this.sourceId = String(
      db.prepare("SELECT source_id FROM usage_lifecycle_identity WHERE id=1").get()?.source_id,
    );
    if (!UUID.test(this.sourceId)) throw new Error("usage_lifecycle_source_invalid");
  }
  private parse(row: Record<string, unknown>): BridgeUsageEvent {
    const body = String(row.body);
    if (hash(body) !== row.digest) throw new Error("usage_lifecycle_integrity_unavailable");
    const event = JSON.parse(body) as BridgeUsageEvent;
    if (
      event.version !== 1 ||
      event.sourceId !== this.sourceId ||
      event.sequence !== row.sequence ||
      !validInput(event) ||
      !UUID.test(event.eventId) ||
      row.identity !==
        JSON.stringify([event.origin, event.requestId, event.attemptId ?? event.runId]) ||
      row.evidence_digest !== hash(JSON.stringify([event.kind, String(row.raw)])) ||
      !Number.isSafeInteger(event.revision) ||
      event.revision < 1
    )
      throw new Error("usage_lifecycle_integrity_unavailable");
    return event;
  }
  /** Caller MUST hold a source BEGIN IMMEDIATE transaction; exact source bytes dedupe replay. */
  append(input: UsageEventInput, raw = JSON.stringify(input)): BridgeUsageEvent {
    if (!validInput(input) || typeof raw !== "string" || Buffer.byteLength(raw) > 2 * 1024 * 1024)
      throw new Error("usage_lifecycle_event_invalid");
    const identity = JSON.stringify([
      input.origin,
      input.requestId,
      input.attemptId ?? input.runId,
    ]);
    const evidenceDigest = hash(JSON.stringify([input.kind, raw]));
    const old = this.db
      .prepare("SELECT * FROM usage_lifecycle_events WHERE identity=? AND evidence_digest=?")
      .get(identity, evidenceDigest);
    if (old) return this.parse(old);
    if (
      Number(this.db.prepare("SELECT COUNT(*) AS n FROM usage_lifecycle_events").get()?.n) >= 100000
    )
      throw new Error("usage_lifecycle_capacity");
    const previous = this.db
      .prepare(
        "SELECT * FROM usage_lifecycle_events WHERE identity=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(identity);
    const prior = previous ? this.parse(previous) : null;
    if (prior && input.observedAt < prior.observedAt)
      throw new Error("usage_lifecycle_evidence_regression");
    const sequence = Number(
      this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM usage_lifecycle_events").get()
        ?.n,
    );
    const event: BridgeUsageEvent = {
      ...structuredClone(input),
      version: 1,
      sourceId: this.sourceId,
      eventId: randomUUID(),
      sequence,
      revision: (prior?.revision ?? 0) + 1,
    };
    const body = JSON.stringify(event);
    this.db
      .prepare("INSERT INTO usage_lifecycle_events VALUES(?,?,?,?,?,?)")
      .run(sequence, identity, evidenceDigest, body, hash(body), raw);
    return event;
  }
  hasStart(requestId: string, attemptId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM usage_lifecycle_events WHERE json_extract(body,'$.requestId')=? AND json_extract(body,'$.attemptId')=? AND json_extract(body,'$.kind')='start'",
      )
      .get(requestId, attemptId);
  }
  /** A source consumer namespace has exactly one durable notification target and direct actor. */
  registerLifecycleSink(namespace: string, binding: LifecycleSinkBinding): void {
    const id = /^[a-z][a-z0-9_-]{0,63}$/;
    if (
      typeof namespace !== "string" ||
      !id.test(namespace) ||
      !binding ||
      typeof binding !== "object" ||
      Array.isArray(binding) ||
      Object.keys(binding).sort().join() !== "directActorId,targetId" ||
      typeof binding.targetId !== "string" ||
      !SINK_TARGET.test(binding.targetId) ||
      (binding.directActorId !== null &&
        (typeof binding.directActorId !== "string" || !id.test(binding.directActorId)))
    )
      throw new Error("usage_lifecycle_sink_invalid");
    const digest = hash(
      JSON.stringify([this.sourceId, namespace, binding.targetId, binding.directActorId]),
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare(
          "SELECT target_id,direct_actor_id,digest FROM usage_lifecycle_sinks WHERE namespace=?",
        )
        .get(namespace);
      if (prior) {
        if (
          typeof prior.target_id !== "string" ||
          !SINK_TARGET.test(prior.target_id) ||
          (prior.direct_actor_id !== null &&
            (typeof prior.direct_actor_id !== "string" || !id.test(prior.direct_actor_id))) ||
          prior.digest !==
            hash(JSON.stringify([this.sourceId, namespace, prior.target_id, prior.direct_actor_id]))
        )
          throw new Error("usage_lifecycle_sink_integrity_unavailable");
        if (prior.target_id !== binding.targetId || prior.direct_actor_id !== binding.directActorId)
          throw new Error("usage_lifecycle_sink_conflict");
      } else {
        const cursor = this.db
          .prepare("SELECT sequence FROM usage_lifecycle_cursors WHERE consumer=?")
          .get(namespace);
        if (cursor && cursor.sequence !== 0)
          throw new Error("usage_lifecycle_sink_binding_unavailable");
        if (
          Number(this.db.prepare("SELECT COUNT(*) AS n FROM usage_lifecycle_sinks").get()?.n) >= 256
        )
          throw new Error("usage_lifecycle_sink_capacity");
        this.db
          .prepare("INSERT INTO usage_lifecycle_sinks VALUES(?,?,?,?)")
          .run(namespace, binding.targetId, binding.directActorId, digest);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  cursorPosition(consumerId: string): number {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(consumerId))
      throw new Error("usage_lifecycle_consumer_invalid");
    const row = this.db
      .prepare("SELECT sequence FROM usage_lifecycle_cursors WHERE consumer=?")
      .get(consumerId);
    const sequence = row ? Number(row.sequence) : 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0)
      throw new Error("usage_lifecycle_cursor_invalid");
    return sequence;
  }
  async drainLifecycle(
    consumerId: string,
    consume: UsageConsumer,
    limit = 32,
  ): Promise<{ processed: number; pending: boolean }> {
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/.test(consumerId) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("usage_lifecycle_consumer_invalid");
    if (this.draining.has(consumerId)) throw new Error("usage_lifecycle_consumer_busy");
    this.draining.add(consumerId);
    try {
      this.db.prepare("INSERT OR IGNORE INTO usage_lifecycle_cursors VALUES(?,0)").run(consumerId);
      let cursor = Number(
        this.db
          .prepare("SELECT sequence FROM usage_lifecycle_cursors WHERE consumer=?")
          .get(consumerId)?.sequence,
      );
      if (!Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error("usage_lifecycle_cursor_invalid");
      const rows = this.db
        .prepare("SELECT * FROM usage_lifecycle_events WHERE sequence>? ORDER BY sequence LIMIT ?")
        .all(cursor, limit);
      for (const row of rows) {
        const event = this.parse(row);
        await consume(structuredClone(event));
        const changed = this.db
          .prepare("UPDATE usage_lifecycle_cursors SET sequence=? WHERE consumer=? AND sequence=?")
          .run(event.sequence, consumerId, cursor);
        if (changed.changes !== 1) throw new Error("usage_lifecycle_cursor_changed");
        cursor = event.sequence;
      }
      return {
        processed: rows.length,
        pending: !!this.db
          .prepare("SELECT 1 FROM usage_lifecycle_events WHERE sequence>? LIMIT 1")
          .get(cursor),
      };
    } finally {
      this.draining.delete(consumerId);
    }
  }
}
