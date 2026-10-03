/** Optional, trusted-host notification runtime. Imports never activate a transport.
 * All external effects require a registered actor/destination and a fresh synchronous authority gate. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  buildNotificationText,
  canonicalChatReference,
  type NotificationSendOutcome,
  type PreparedNotificationTransport,
} from "../adapters/notification-transports.js";
import { sha256Bytes } from "../contracts/task.js";
import { UiError } from "../contracts/ui.js";
import {
  type NotificationPreferencesStore,
  validateNotificationActor,
} from "./notification-preferences.js";
import type {
  NotificationCataloguePort,
  RegisteredNotificationDestination,
} from "./notification-settings.js";

export type CredentialState = "configured" | "missing" | "unavailable";
export interface PreparedNotificationBinding {
  generation: string;
  revision: number;
  transport: PreparedNotificationTransport;
}
export interface NotificationBinding {
  destinationId: string;
  channel: "email" | "discord";
  /** Safe display name, never a raw recipient, URL or credential. */
  label: string;
  /** Opaque immutable version for the exact recipient AND credential binding. */
  generation: string;
  /** Host registry revision must increase on recipient/credential replacement; rollback is denied. */
  revision: number;
  /** Original activation of this immutable binding version, not list/replay time. */
  activatedAt: string;
  credentialState: CredentialState;
  prepare(signal: AbortSignal): Promise<PreparedNotificationBinding | null>;
}
export interface SecureNotificationRegistry {
  /** Synchronous authoritative version gate. It must become false before a binding retires. */
  isCurrent(actorId: string, destinationId: string, generation: string, revision: number): boolean;
  /** Read-only actor-authorized registration. It cannot create or retarget recipients. */
  list(actorId: string, signal: AbortSignal): Promise<readonly NotificationBinding[]>;
  /** The native provider owns confirmation, secret entry and save. Never return a secret. */
  beginCredentialInteraction?(input: {
    actorId: string;
    destinationId: string;
    actionId: string;
    signal: AbortSignal;
  }): Promise<"saved" | "cancelled" | "rejected" | "uncertain">;
}
export interface NotificationLifecycleEvent {
  version: 1;
  sourceId: string;
  eventId: string;
  origin: "direct" | "hosted";
  kind: "start" | "result" | "coverage_gap";
  requestId: string;
  requesterActorId?: string | null;
  runId: string | null;
  attemptId: string | null;
  observedAt: string;
  result?: {
    target?: "chat" | "dot";
    error: { code: string } | null;
    conversationUrl: string | null;
  };
}
export interface NotificationLifecycleSource {
  readonly sourceId: string;
  registerLifecycleSink?(
    namespace: string,
    binding: { targetId: string; directActorId: string | null },
  ): void;
  drainLifecycle(
    consumerId: string,
    consumer: (event: NotificationLifecycleEvent) => Promise<void> | void,
    limit?: number,
  ): Promise<{ processed: number; pending: boolean | number }>;
}
export type NotificationDeliveryState =
  | "queued"
  | "sending"
  | "delivered"
  | "not_sent"
  | "uncertain"
  | "cancelled";
export interface NotificationActionView {
  actionId: string;
  kind: "test" | "credential";
  destinationId: string;
  state: NotificationDeliveryState | "saved" | "rejected";
}
export interface NotificationControlsView {
  version: "bridge-notification-controls-1";
  credentialInteractionAvailable: boolean;
  destinations: {
    destinationId: string;
    credentialState: CredentialState;
    masked: "••••••••" | null;
  }[];
  recent: {
    destinationId: string;
    kind: "test" | "human_check";
    state: NotificationDeliveryState;
    attempts: number;
  }[];
}
interface Content {
  kind: "human_check" | "test";
  requestId?: string;
  category?: "AUTH_REQUIRED" | "CAPTCHA_OR_CHALLENGE";
  conversationUrl?: string | null;
}
interface QueueRow {
  key: string;
  actor: string;
  destination: string;
  generation: string;
  binding_revision: number;
  preference_revision: number;
  preference_digest: string;
  content: string;
  content_hash: string;
  state: NotificationDeliveryState;
  attempts: number;
  next_at: number;
  owner: string | null;
  action_id: string | null;
}
interface BindingRow {
  generation: string;
  revision: number;
  activated_at: string;
  state: "ready" | "credential_pending" | "unavailable";
  action_id: string | null;
}
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const REQUEST = /^[A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OPAQUE = /^[A-Za-z0-9_.:-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const hash = (value: unknown) => sha256Bytes(Buffer.from(JSON.stringify(value)));
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function error(code: string): never {
  throw new UiError(code, code, 409);
}
function validateBinding(value: NotificationBinding): void {
  if (
    !value ||
    !ID.test(value.destinationId) ||
    !["email", "discord"].includes(value.channel) ||
    typeof value.label !== "string" ||
    !value.label.trim() ||
    value.label.length > 128 ||
    /[\0\r\n@]|https?:\/\//i.test(value.label) ||
    !OPAQUE.test(value.generation) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !instant(value.activatedAt) ||
    !["configured", "missing", "unavailable"].includes(value.credentialState) ||
    typeof value.prepare !== "function"
  )
    error("notification_registration_invalid");
}
function actionInput(input: unknown): {
  actionId: string;
  destinationId: string;
  expectedRevision: number;
} {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !== "actionId,destinationId,expectedRevision"
  )
    error("notification_action_invalid");
  const value = input as { actionId: string; destinationId: string; expectedRevision: number };
  if (
    !UUID.test(value.actionId) ||
    !ID.test(value.destinationId) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    value.expectedRevision >= 10000
  )
    error("notification_action_invalid");
  return value;
}

export class NotificationRuntime implements NotificationCataloguePort {
  readonly targetId: string;
  private readonly owner = randomUUID();
  private readonly active = new Map<string, AbortController>();
  private readonly sources: { source: NotificationLifecycleSource; directActorId?: string }[] = [];
  private closing = false;
  private closed = false;
  private ticking: Promise<void> | null = null;
  private closeSettled = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  constructor(
    readonly preferences: NotificationPreferencesStore,
    private readonly options: {
      registry: SecureNotificationRegistry;
      /** Must represent already approved destination, data category and recurring/test authority. */
      authorizeSend(actorId: string, destinationId: string, kind: "human_check" | "test"): boolean;
      timeoutMs?: number;
      now?: () => Date;
    },
  ) {
    if (!preferences.runtimeScopeId) error("notification_durable_store_required");
    if (typeof options.registry?.isCurrent !== "function")
      error("notification_current_binding_gate_unavailable");
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 30000)
      error("notification_timeout_invalid");
    preferences.withRuntimeTransaction((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS notification_bindings(actor TEXT NOT NULL,destination TEXT NOT NULL,generation TEXT NOT NULL,revision INTEGER NOT NULL,activated_at TEXT NOT NULL,state TEXT NOT NULL,action_id TEXT,PRIMARY KEY(actor,destination));
      CREATE TABLE IF NOT EXISTS notification_outbox(key TEXT PRIMARY KEY,actor TEXT NOT NULL,destination TEXT NOT NULL,generation TEXT NOT NULL,binding_revision INTEGER NOT NULL,preference_revision INTEGER NOT NULL,preference_digest TEXT NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,next_at INTEGER NOT NULL,owner TEXT,action_id TEXT);
      CREATE TABLE IF NOT EXISTS notification_seen(actor TEXT NOT NULL,event_key TEXT NOT NULL,observed_at TEXT NOT NULL,outcome TEXT NOT NULL,PRIMARY KEY(actor,event_key));
      CREATE TABLE IF NOT EXISTS notification_actions(actor TEXT NOT NULL,action_id TEXT NOT NULL,kind TEXT NOT NULL,destination TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,owner TEXT,PRIMARY KEY(actor,action_id));
      CREATE TABLE IF NOT EXISTS notification_rates(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,destination TEXT NOT NULL,attempt_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_clock(id INTEGER PRIMARY KEY CHECK(id=1),last_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_source_bindings(source_id TEXT PRIMARY KEY,direct_actor TEXT);
      CREATE TABLE IF NOT EXISTS notification_target_identity(id INTEGER PRIMARY KEY CHECK(id=1),generation TEXT NOT NULL);
    `),
    );
    this.targetId = preferences.withRuntimeTransaction((db) => {
      db.prepare("INSERT OR IGNORE INTO notification_target_identity VALUES(1,?)").run(
        randomUUID(),
      );
      const generation = db
        .prepare("SELECT generation FROM notification_target_identity WHERE id=1")
        .get()?.generation;
      if (typeof generation !== "string" || !UUID.test(generation))
        error("notification_target_identity_unavailable");
      return hash([preferences.runtimeScopeId, generation]);
    });
  }
  private transaction<T>(fn: (db: DatabaseSync, now: number) => T): T {
    if (this.closed) error("notification_runtime_closed");
    return this.preferences.withRuntimeTransaction((db) => {
      const now = this.now().getTime();
      const previous = Number(
        db.prepare("SELECT last_at FROM notification_clock WHERE id=1").get()?.last_at ?? 0,
      );
      if (!Number.isSafeInteger(now) || now < previous) error("notification_clock_unavailable");
      db.prepare(
        "INSERT INTO notification_clock VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_at=excluded.last_at",
      ).run(now);
      return fn(db, now);
    });
  }
  private capacity(
    db: DatabaseSync,
    table:
      | "notification_outbox"
      | "notification_seen"
      | "notification_actions"
      | "notification_rates",
  ): void {
    const maximum = table === "notification_rates" ? 15000 : 5000;
    if (Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0) >= maximum)
      error("notification_storage_limit");
  }
  private binding(db: DatabaseSync, actor: string, destination: string): BindingRow | undefined {
    return db
      .prepare(
        "SELECT generation,revision,activated_at,state,action_id FROM notification_bindings WHERE actor=? AND destination=?",
      )
      .get(actor, destination) as unknown as BindingRow | undefined;
  }
  private register(db: DatabaseSync, actor: string, binding: NotificationBinding): void {
    validateBinding(binding);
    const current = this.binding(db, actor, binding.destinationId);
    if (current?.state === "credential_pending" || current?.state === "unavailable") return;
    if (current && current.revision > binding.revision) return;
    if (
      current &&
      binding.revision > current.revision &&
      binding.activatedAt < current.activated_at
    )
      error("notification_registration_activation_regression");
    if (current && current.revision === binding.revision) {
      if (current.generation !== binding.generation || current.activated_at !== binding.activatedAt)
        error("notification_registration_revision_conflict");
      return;
    }
    db.prepare(
      "INSERT INTO notification_bindings VALUES(?,?,?,?,?,'ready',NULL) ON CONFLICT(actor,destination) DO UPDATE SET generation=excluded.generation,revision=excluded.revision,activated_at=excluded.activated_at,state='ready',action_id=NULL",
    ).run(actor, binding.destinationId, binding.generation, binding.revision, binding.activatedAt);
    db.prepare(
      "UPDATE notification_outbox SET state='cancelled' WHERE actor=? AND destination=? AND state='queued' AND (generation<>? OR binding_revision<>?)",
    ).run(actor, binding.destinationId, binding.generation, binding.revision);
    this.syncCancelledActions(db);
  }
  private syncCancelledActions(db: DatabaseSync): void {
    db.exec(
      "UPDATE notification_actions SET state='cancelled' WHERE kind='test' AND state='queued' AND EXISTS (SELECT 1 FROM notification_outbox WHERE notification_outbox.actor=notification_actions.actor AND notification_outbox.action_id=notification_actions.action_id AND notification_outbox.state='cancelled')",
    );
  }
  private async bounded<T>(
    work: (signal: AbortSignal) => Promise<T>,
    abort: AbortController,
    deadline = performance.now() + this.timeoutMs,
  ): Promise<T> {
    if (this.closing || abort.signal.aborted || performance.now() >= deadline)
      error("notification_operation_stopped");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (this.closing || abort.signal.aborted || performance.now() >= deadline)
            error("notification_operation_stopped");
          return work(abort.signal);
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              abort.abort();
              reject(new Error("notification_operation_timeout"));
            },
            Math.max(1, deadline - performance.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async bindings(
    actor: string,
    abort = new AbortController(),
    deadline = performance.now() + this.timeoutMs,
  ): Promise<NotificationBinding[]> {
    validateNotificationActor(actor);
    const values = await this.bounded(
      (signal) => this.options.registry.list(actor, signal),
      abort,
      deadline,
    );
    if (
      this.closing ||
      abort.signal.aborted ||
      !Array.isArray(values) ||
      values.length > 64 ||
      new Set(values.map((v) => v.destinationId)).size !== values.length
    )
      error("notification_registry_unavailable");
    for (const value of values) {
      validateBinding(value);
      if (Date.parse(value.activatedAt) > this.now().getTime())
        error("notification_registration_activation_unavailable");
    }
    this.transaction((db) => {
      for (const value of values) this.register(db, actor, value);
    });
    return values.map((value) =>
      Object.freeze({
        destinationId: value.destinationId,
        channel: value.channel,
        label: value.label,
        generation: value.generation,
        revision: value.revision,
        activatedAt: value.activatedAt,
        credentialState: value.credentialState,
        prepare: value.prepare.bind(value),
      }),
    );
  }
  async list(actor: string): Promise<RegisteredNotificationDestination[]> {
    const values = await this.bindings(actor);
    return this.transaction((db) =>
      values.map((value) => ({
        destinationId: value.destinationId,
        channel: value.channel,
        label: value.label,
        transportAvailable:
          value.credentialState === "configured" &&
          this.binding(db, actor, value.destinationId)?.state === "ready" &&
          this.binding(db, actor, value.destinationId)?.generation === value.generation &&
          this.binding(db, actor, value.destinationId)?.revision === value.revision,
        unavailableReason:
          value.credentialState === "configured" &&
          this.binding(db, actor, value.destinationId)?.state === "ready" &&
          this.binding(db, actor, value.destinationId)?.generation === value.generation &&
          this.binding(db, actor, value.destinationId)?.revision === value.revision
            ? null
            : "notification_credentials_unavailable",
      })),
    );
  }
  attachSource(source: NotificationLifecycleSource, directActorId?: string): void {
    if (this.closing) error("notification_runtime_closed");
    if (directActorId !== undefined) validateNotificationActor(directActorId);
    if (!OPAQUE.test(source.sourceId)) error("notification_source_invalid");
    if (typeof source.registerLifecycleSink !== "function")
      error("notification_source_sink_binding_unavailable");
    const existing = this.sources.find((item) => item.source.sourceId === source.sourceId);
    if (existing && existing.directActorId !== directActorId)
      error("notification_source_actor_changed");
    this.transaction((db) => {
      const prior = db
        .prepare("SELECT direct_actor FROM notification_source_bindings WHERE source_id=?")
        .get(source.sourceId);
      if (prior && prior.direct_actor !== (directActorId ?? null))
        error("notification_source_actor_changed");
    });
    // The source owns this durable seal. A different store/profile/actor cannot adopt its cursor.
    source.registerLifecycleSink("notification-runtime-1", {
      targetId: this.targetId,
      directActorId: directActorId ?? null,
    });
    this.transaction((db) => {
      const prior = db
        .prepare("SELECT direct_actor FROM notification_source_bindings WHERE source_id=?")
        .get(source.sourceId);
      if (prior && prior.direct_actor !== (directActorId ?? null))
        error("notification_source_actor_changed");
      if (!prior) {
        if (
          Number(db.prepare("SELECT COUNT(*) AS n FROM notification_source_bindings").get()?.n) >=
          64
        )
          error("notification_source_limit");
        db.prepare("INSERT INTO notification_source_bindings VALUES(?,?)").run(
          source.sourceId,
          directActorId ?? null,
        );
      }
    });
    if (!existing) this.sources.push({ source, ...(directActorId ? { directActorId } : {}) });
  }
  /** Starts only on an explicitly configured trusted host; no transport is constructed here. */
  start(): void {
    if (this.closing || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 1000);
    this.timer.unref?.();
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    if (this.closing) return Promise.resolve();
    this.ticking = this.performTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }
  private async performTick(): Promise<void> {
    for (const item of this.sources) {
      if (this.closing) break;
      await item.source.drainLifecycle(
        "notification-runtime-1",
        async (event) => {
          if (
            event.kind !== "result" ||
            event.result?.target === "dot" ||
            !["AUTH_REQUIRED", "CAPTCHA_OR_CHALLENGE"].includes(event.result?.error?.code ?? "")
          )
            return;
          const actor = event.origin === "hosted" ? event.requesterActorId : item.directActorId;
          if (!actor) error("notification_actor_unavailable");
          await this.enqueue(actor, event);
        },
        32,
      );
    }
    if (!this.closing) await this.drain();
  }
  async enqueue(actor: string, event: NotificationLifecycleEvent): Promise<void> {
    validateNotificationActor(actor);
    if (this.closing) error("notification_runtime_closed");
    if (
      event.version !== 1 ||
      event.kind !== "result" ||
      event.result?.target === "dot" ||
      !OPAQUE.test(event.sourceId) ||
      !OPAQUE.test(event.eventId) ||
      !REQUEST.test(event.requestId) ||
      !instant(event.observedAt) ||
      !["AUTH_REQUIRED", "CAPTCHA_OR_CHALLENGE"].includes(event.result?.error?.code ?? "") ||
      (event.origin === "hosted"
        ? !event.attemptId || !UUID.test(event.attemptId) || event.requesterActorId !== actor
        : event.origin !== "direct" || !event.runId || !UUID.test(event.runId))
    )
      error("notification_event_invalid");
    event = {
      version: event.version,
      sourceId: event.sourceId,
      eventId: event.eventId,
      origin: event.origin,
      kind: event.kind,
      requestId: event.requestId,
      requesterActorId: event.requesterActorId ?? null,
      runId: event.runId,
      attemptId: event.attemptId,
      observedAt: event.observedAt,
      result: {
        error: { code: event.result?.error?.code ?? "" },
        conversationUrl: event.result?.conversationUrl ?? null,
      },
    };
    const eventKey = hash([
      event.origin,
      event.requestId,
      event.origin === "hosted" ? event.attemptId : event.runId,
      event.result?.error?.code,
    ]);
    const already = this.transaction(
      (db) =>
        !!db
          .prepare("SELECT 1 FROM notification_seen WHERE actor=? AND event_key=?")
          .get(actor, eventKey),
    );
    if (already) return;
    const before = this.preferences.snapshot(actor);
    const values = before.authBlocked.enabled ? await this.bindings(actor) : [];
    const content: Content = {
      kind: "human_check",
      requestId: event.requestId,
      category: event.result?.error?.code as "AUTH_REQUIRED" | "CAPTCHA_OR_CHALLENGE",
      conversationUrl: event.result?.conversationUrl
        ? canonicalChatReference(event.result.conversationUrl)
        : null,
    };
    this.transaction((db, now) => {
      if (
        db
          .prepare("SELECT 1 FROM notification_seen WHERE actor=? AND event_key=?")
          .get(actor, eventKey)
      )
        return;
      this.capacity(db, "notification_seen");
      const current = this.preferences.snapshot(actor);
      const eligible =
        current.revision === before.revision &&
        current.authBlocked.enabled &&
        current.updatedAt !== null &&
        event.observedAt > current.updatedAt &&
        Date.parse(event.observedAt) <= now;
      for (const destination of eligible ? current.authBlocked.destinationIds : []) {
        const binding = values.find((value) => value.destinationId === destination);
        if (binding?.credentialState !== "configured" || event.observedAt <= binding.activatedAt)
          continue;
        const registered = this.binding(db, actor, destination);
        if (
          registered?.state !== "ready" ||
          registered.generation !== binding.generation ||
          registered.revision !== binding.revision
        )
          continue;
        this.insert(db, {
          key: hash([actor, eventKey, destination]),
          actor,
          destination,
          generation: binding.generation,
          bindingRevision: binding.revision,
          preferenceRevision: current.revision,
          preferenceDigest: hash(current),
          content,
          now,
          actionId: null,
        });
      }
      db.prepare("INSERT INTO notification_seen VALUES(?,?,?,?)").run(
        actor,
        eventKey,
        event.observedAt,
        eligible ? "processed" : "suppressed",
      );
    });
  }
  private insert(
    db: DatabaseSync,
    value: {
      key: string;
      actor: string;
      destination: string;
      generation: string;
      bindingRevision: number;
      preferenceRevision: number;
      preferenceDigest: string;
      content: Content;
      now: number;
      actionId: string | null;
    },
  ): void {
    this.capacity(db, "notification_outbox");
    const body = JSON.stringify(value.content);
    db.prepare("INSERT INTO notification_outbox VALUES(?,?,?,?,?,?,?,?,?,'queued',0,?,NULL,?)").run(
      value.key,
      value.actor,
      value.destination,
      value.generation,
      value.bindingRevision,
      value.preferenceRevision,
      value.preferenceDigest,
      body,
      hash({
        key: value.key,
        actor: value.actor,
        destination: value.destination,
        generation: value.generation,
        bindingRevision: value.bindingRevision,
        preferenceRevision: value.preferenceRevision,
        preferenceDigest: value.preferenceDigest,
        content: value.content,
        actionId: value.actionId,
      }),
      value.now,
      value.actionId,
    );
  }
  private action(
    db: DatabaseSync,
    actor: string,
    value: ReturnType<typeof actionInput>,
    kind: "test" | "credential",
  ): { exists: boolean; view: NotificationActionView } {
    const fingerprint = hash({ kind, ...value });
    const previous = db
      .prepare(
        "SELECT kind,destination,fingerprint,state,owner FROM notification_actions WHERE actor=? AND action_id=?",
      )
      .get(actor, value.actionId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) error("notification_action_conflict");
      return {
        exists: true,
        view: {
          actionId: value.actionId,
          kind,
          destinationId: value.destinationId,
          state:
            previous.state === "sending" && previous.owner !== this.owner
              ? "uncertain"
              : (previous.state as NotificationActionView["state"]),
        },
      };
    }
    if (this.preferences.snapshot(actor).revision !== value.expectedRevision)
      error("stale_notification_preferences");
    this.capacity(db, "notification_actions");
    db.prepare("INSERT INTO notification_actions VALUES(?,?,?,?,?,'queued',?)").run(
      actor,
      value.actionId,
      kind,
      value.destinationId,
      fingerprint,
      this.owner,
    );
    return {
      exists: false,
      view: { actionId: value.actionId, kind, destinationId: value.destinationId, state: "queued" },
    };
  }
  async test(actor: string, input: unknown): Promise<NotificationActionView> {
    const value = actionInput(input);
    const existing = this.status(actor, value.actionId);
    if (existing) return this.transaction((db) => this.action(db, actor, value, "test").view);
    const binding = (await this.bindings(actor)).find(
      (row) => row.destinationId === value.destinationId,
    );
    if (binding?.credentialState !== "configured") error("notification_destination_unavailable");
    this.transaction((db, now) => {
      const registered = this.binding(db, actor, value.destinationId);
      if (
        registered?.state !== "ready" ||
        registered.generation !== binding.generation ||
        registered.revision !== binding.revision
      )
        error("notification_destination_unavailable");
      const action = this.action(db, actor, value, "test");
      if (!action.exists)
        this.insert(db, {
          key: hash([actor, value.actionId]),
          actor,
          destination: value.destinationId,
          generation: binding.generation,
          bindingRevision: binding.revision,
          preferenceRevision: value.expectedRevision,
          preferenceDigest: hash(this.preferences.snapshot(actor)),
          content: { kind: "test" },
          now,
          actionId: value.actionId,
        });
    });
    await this.drain();
    return this.closed
      ? {
          actionId: value.actionId,
          kind: "test",
          destinationId: value.destinationId,
          state: "uncertain",
        }
      : (this.status(actor, value.actionId) ?? error("notification_action_unavailable"));
  }
  status(actor: string, actionId: string): NotificationActionView | null {
    validateNotificationActor(actor);
    if (!UUID.test(actionId)) error("notification_action_invalid");
    return this.transaction((db) => {
      const row = db
        .prepare(
          "SELECT kind,destination,state,owner FROM notification_actions WHERE actor=? AND action_id=?",
        )
        .get(actor, actionId);
      return row
        ? {
            actionId,
            kind: row.kind as "test" | "credential",
            destinationId: String(row.destination),
            state:
              row.state === "sending" && row.owner !== this.owner
                ? "uncertain"
                : (row.state as NotificationActionView["state"]),
          }
        : null;
    });
  }
  async credentials(actor: string, input: unknown): Promise<NotificationActionView> {
    const value = actionInput(input);
    const existing = this.status(actor, value.actionId);
    if (existing) return this.transaction((db) => this.action(db, actor, value, "credential").view);
    const interact = this.options.registry.beginCredentialInteraction;
    if (!interact) error("notification_secure_provider_unavailable");
    const binding = (await this.bindings(actor)).find(
      (row) => row.destinationId === value.destinationId,
    );
    if (!binding) error("notification_destination_unavailable");
    const acquired = this.transaction((db) => {
      const registered = this.binding(db, actor, value.destinationId);
      if (registered?.state === "credential_pending")
        error("notification_credential_interaction_pending");
      if (
        !registered ||
        registered.generation !== binding.generation ||
        registered.revision !== binding.revision ||
        registered.activated_at !== binding.activatedAt ||
        this.options.registry.isCurrent(
          actor,
          value.destinationId,
          binding.generation,
          binding.revision,
        ) !== true
      )
        error("notification_destination_unavailable");
      const action = this.action(db, actor, value, "credential");
      if (action.exists) return false;
      db.prepare(
        "UPDATE notification_bindings SET state='credential_pending',action_id=? WHERE actor=? AND destination=?",
      ).run(value.actionId, actor, value.destinationId);
      db.prepare(
        "UPDATE notification_outbox SET state='cancelled' WHERE actor=? AND destination=? AND state='queued'",
      ).run(actor, value.destinationId);
      this.syncCancelledActions(db);
      db.prepare(
        "UPDATE notification_actions SET state='sending' WHERE actor=? AND action_id=?",
      ).run(actor, value.actionId);
      return true;
    });
    if (!acquired)
      return this.status(actor, value.actionId) ?? error("notification_action_unavailable");
    const abort = new AbortController();
    const key = `credential:${actor}:${value.actionId}`;
    this.active.set(key, abort);
    let outcome: "saved" | "cancelled" | "rejected" | "uncertain" = "uncertain";
    let fresh: NotificationBinding | undefined;
    try {
      outcome = await this.bounded(
        (signal) =>
          interact.call(this.options.registry, {
            actorId: actor,
            destinationId: value.destinationId,
            actionId: value.actionId,
            signal,
          }),
        abort,
      );
      if (!["saved", "cancelled", "rejected", "uncertain"].includes(outcome)) outcome = "uncertain";
      if (outcome !== "uncertain" && !this.closing)
        fresh = (await this.bindings(actor, abort)).find(
          (row) => row.destinationId === value.destinationId,
        );
    } catch {
      outcome = "uncertain";
    } finally {
      this.active.delete(key);
    }
    if (!this.closed)
      this.transaction((db) => {
        if (this.closing || abort.signal.aborted) outcome = "uncertain";
        const owner = db
          .prepare("SELECT owner,state FROM notification_actions WHERE actor=? AND action_id=?")
          .get(actor, value.actionId);
        if (owner?.owner !== this.owner || owner.state !== "sending") return;
        db.prepare(
          "UPDATE notification_actions SET state=? WHERE actor=? AND action_id=? AND owner=? AND state='sending'",
        ).run(outcome, actor, value.actionId, this.owner);
        const current = this.binding(db, actor, value.destinationId);
        if (current?.action_id !== value.actionId) return;
        if (
          fresh &&
          outcome !== "uncertain" &&
          fresh.revision >= binding.revision &&
          fresh.activatedAt >= binding.activatedAt &&
          (fresh.revision !== binding.revision ||
            (fresh.generation === binding.generation &&
              fresh.activatedAt === binding.activatedAt)) &&
          this.options.registry.isCurrent(
            actor,
            value.destinationId,
            fresh.generation,
            fresh.revision,
          ) === true &&
          (outcome !== "saved" ||
            (fresh.generation !== binding.generation && fresh.revision > binding.revision))
        ) {
          db.prepare(
            "UPDATE notification_bindings SET state='ready',generation=?,revision=?,activated_at=?,action_id=NULL WHERE actor=? AND destination=?",
          ).run(fresh.generation, fresh.revision, fresh.activatedAt, actor, value.destinationId);
        } else {
          db.prepare(
            "UPDATE notification_bindings SET state='unavailable',action_id=NULL WHERE actor=? AND destination=?",
          ).run(actor, value.destinationId);
          if (outcome === "saved")
            db.prepare(
              "UPDATE notification_actions SET state='uncertain' WHERE actor=? AND action_id=?",
            ).run(actor, value.actionId);
        }
      });
    return this.closed
      ? {
          actionId: value.actionId,
          kind: "credential",
          destinationId: value.destinationId,
          state: "uncertain",
        }
      : (this.status(actor, value.actionId) ?? error("notification_action_unavailable"));
  }
  /** Preference save calls this after its CAS. No network. Re-enable cannot revive old queue rows. */
  invalidate(actor: string): void {
    if (this.closed) error("notification_runtime_closed");
    this.preferences.withRuntimeTransaction((db) => {
      const preferences = this.preferences.snapshot(actor);
      db.prepare(
        "UPDATE notification_outbox SET state='cancelled' WHERE actor=? AND state='queued' AND (preference_revision<>? OR preference_digest<>?)",
      ).run(actor, preferences.revision, hash(preferences));
      db.prepare(
        "UPDATE notification_actions SET state='cancelled' WHERE actor=? AND kind='test' AND state='queued' AND action_id IN (SELECT action_id FROM notification_outbox WHERE actor=? AND state='cancelled')",
      ).run(actor, actor);
    });
  }
  private content(row: QueueRow): string {
    if (
      !HASH.test(row.key) ||
      !ID.test(row.actor) ||
      !ID.test(row.destination) ||
      !OPAQUE.test(row.generation) ||
      row.content.length > 2048 ||
      !HASH.test(row.content_hash)
    )
      error("notification_outbox_unavailable");
    let value: Content;
    try {
      value = JSON.parse(row.content) as Content;
    } catch {
      return error("notification_outbox_unavailable");
    }
    if (
      hash({
        key: row.key,
        actor: row.actor,
        destination: row.destination,
        generation: row.generation,
        bindingRevision: row.binding_revision,
        preferenceRevision: row.preference_revision,
        preferenceDigest: row.preference_digest,
        content: value,
        actionId: row.action_id,
      }) !== row.content_hash
    )
      error("notification_outbox_unavailable");
    const text =
      value.kind === "test" && Object.keys(value).join() === "kind"
        ? buildNotificationText({ kind: "test" })
        : value.kind === "human_check" &&
            value.requestId &&
            value.category &&
            Object.keys(value).sort().join() === "category,conversationUrl,kind,requestId"
          ? buildNotificationText({
              kind: "human_check",
              category: value.category,
              requestId: value.requestId,
              conversationUrl: value.conversationUrl ?? null,
            })
          : null;
    return text ?? error("notification_outbox_unavailable");
  }
  private finish(row: QueueRow, outcome: NotificationSendOutcome): void {
    if (this.closed) return;
    this.transaction((db, now) => {
      const current = db
        .prepare("SELECT state,owner,attempts FROM notification_outbox WHERE key=?")
        .get(row.key);
      if (current?.state !== "sending" || current.owner !== this.owner) return;
      const preferences = this.preferences.snapshot(row.actor);
      const binding = this.binding(db, row.actor, row.destination);
      const retry =
        outcome === "not_sent_retryable" &&
        Number(current.attempts) < 3 &&
        !this.closing &&
        preferences.revision === row.preference_revision &&
        hash(preferences) === row.preference_digest &&
        binding?.state === "ready" &&
        binding.generation === row.generation &&
        binding.revision === row.binding_revision;
      const state: NotificationDeliveryState = retry
        ? "queued"
        : outcome === "delivered"
          ? "delivered"
          : ["not_sent", "not_sent_retryable"].includes(outcome)
            ? "not_sent"
            : "uncertain";
      db.prepare(
        "UPDATE notification_outbox SET state=?,next_at=?,owner=NULL WHERE key=? AND owner=? AND state='sending'",
      ).run(
        state,
        now + 60000 * 2 ** Math.max(0, Number(current.attempts) - 1),
        row.key,
        this.owner,
      );
      if (row.action_id)
        db.prepare("UPDATE notification_actions SET state=? WHERE actor=? AND action_id=?").run(
          state,
          row.actor,
          row.action_id,
        );
    });
  }
  private settleUnsent(row: QueueRow, state: "not_sent" | "cancelled" = "not_sent"): void {
    if (this.closed) return;
    this.transaction((db) => {
      const updated = db
        .prepare("UPDATE notification_outbox SET state=? WHERE key=? AND state='queued'")
        .run(state, row.key);
      if (updated.changes === 1 && row.action_id)
        db.prepare(
          "UPDATE notification_actions SET state=? WHERE actor=? AND action_id=? AND state='queued'",
        ).run(state, row.actor, row.action_id);
    });
  }
  async drain(): Promise<void> {
    if (this.closing) return;
    const rows = this.transaction(
      (db, now) =>
        db
          .prepare(
            "SELECT * FROM notification_outbox WHERE state='queued' AND next_at<=? ORDER BY next_at,key LIMIT 16",
          )
          .all(now) as unknown as QueueRow[],
    );
    for (const row of rows) {
      if (this.closing) break;
      const abort = new AbortController();
      if (this.active.has(row.key)) continue;
      this.active.set(row.key, abort);
      const deadline = performance.now() + this.timeoutMs;
      let claimed = false;
      try {
        const text = this.content(row);
        const binding = (await this.bindings(row.actor, abort, deadline)).find(
          (value) => value.destinationId === row.destination,
        );
        if (
          !binding ||
          binding.generation !== row.generation ||
          binding.revision !== row.binding_revision ||
          binding.credentialState !== "configured"
        ) {
          this.transaction((db) =>
            db
              .prepare(
                "UPDATE notification_outbox SET state='cancelled' WHERE key=? AND state='queued'",
              )
              .run(row.key),
          );
          this.transaction((db) => this.syncCancelledActions(db));
          continue;
        }
        const prepared = await this.bounded((signal) => binding.prepare(signal), abort, deadline);
        if (
          !prepared ||
          prepared.generation !== row.generation ||
          prepared.revision !== binding.revision ||
          typeof prepared.transport?.send !== "function" ||
          abort.signal.aborted ||
          this.closing ||
          performance.now() >= deadline
        ) {
          this.settleUnsent(row);
          continue;
        }
        const currentBinding = (await this.bindings(row.actor, abort, deadline)).find(
          (value) => value.destinationId === row.destination,
        );
        if (
          currentBinding?.credentialState !== "configured" ||
          currentBinding.generation !== prepared.generation ||
          currentBinding.revision !== prepared.revision
        ) {
          this.settleUnsent(row, "cancelled");
          continue;
        }
        claimed = this.transaction((db, now) => {
          const current = db
            .prepare("SELECT * FROM notification_outbox WHERE key=?")
            .get(row.key) as unknown as QueueRow | undefined;
          const preferences = this.preferences.snapshot(row.actor);
          const registered = this.binding(db, row.actor, row.destination);
          const content = JSON.parse(row.content) as Content;
          if (current?.state !== "queued" || current.next_at > now) return false;
          const allowed =
            preferences.revision === row.preference_revision &&
            hash(preferences) === row.preference_digest &&
            registered?.state === "ready" &&
            registered.generation === row.generation &&
            registered.revision === row.binding_revision &&
            registered.revision === prepared.revision &&
            (content.kind === "test" ||
              (preferences.authBlocked.enabled &&
                preferences.authBlocked.destinationIds.includes(row.destination))) &&
            this.options.authorizeSend(row.actor, row.destination, content.kind) === true &&
            !this.closing &&
            !abort.signal.aborted &&
            performance.now() < deadline &&
            (prepared.transport.deadlineAt === undefined ||
              prepared.transport.deadlineAt > Date.now()) &&
            this.options.registry.isCurrent(
              row.actor,
              row.destination,
              prepared.generation,
              prepared.revision,
            ) === true;
          if (!allowed) {
            db.prepare(
              "UPDATE notification_outbox SET state='cancelled' WHERE key=? AND state='queued'",
            ).run(row.key);
            if (row.action_id)
              db.prepare(
                "UPDATE notification_actions SET state='cancelled' WHERE actor=? AND action_id=?",
              ).run(row.actor, row.action_id);
            return false;
          }
          const rate = db
            .prepare(
              "SELECT COUNT(*) AS n,MAX(attempt_at) AS latest FROM notification_rates WHERE actor=? AND destination=? AND attempt_at>?",
            )
            .get(row.actor, row.destination, now - 3600000);
          if (
            Number(rate?.n ?? 0) >= 3 ||
            (rate?.latest !== null &&
              rate?.latest !== undefined &&
              now - Number(rate.latest) < 60000)
          )
            return false;
          this.capacity(db, "notification_rates");
          db.prepare(
            "INSERT INTO notification_rates(actor,destination,attempt_at) VALUES(?,?,?)",
          ).run(row.actor, row.destination, now);
          db.prepare(
            "UPDATE notification_outbox SET state='sending',attempts=attempts+1,owner=? WHERE key=? AND state='queued'",
          ).run(this.owner, row.key);
          if (row.action_id)
            db.prepare(
              "UPDATE notification_actions SET state='sending',owner=? WHERE actor=? AND action_id=?",
            ).run(this.owner, row.actor, row.action_id);
          return true;
        });
        if (!claimed) continue;
        // Effect linearization: no await or user-supplied asynchronous callback between claim and invocation.
        const sending = prepared.transport.send(text, abort.signal);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let outcome: NotificationSendOutcome;
        try {
          outcome = await Promise.race([
            sending,
            new Promise<NotificationSendOutcome>((resolve) => {
              timer = setTimeout(
                () => {
                  abort.abort();
                  resolve("uncertain");
                },
                Math.max(1, deadline - performance.now()),
              );
            }),
          ]);
          if (!["delivered", "not_sent_retryable", "not_sent", "uncertain"].includes(outcome))
            outcome = "uncertain";
        } catch {
          outcome = "uncertain";
        } finally {
          if (timer) clearTimeout(timer);
        }
        this.finish(row, outcome);
      } catch {
        if (claimed) this.finish(row, "uncertain");
        else this.settleUnsent(row);
      } finally {
        abort.abort();
        this.active.delete(row.key);
      }
    }
  }
  async view(actor: string): Promise<NotificationControlsView> {
    const bindings = await this.bindings(actor);
    return this.transaction((db) => ({
      version: "bridge-notification-controls-1",
      credentialInteractionAvailable: !!this.options.registry.beginCredentialInteraction,
      destinations: bindings.map((value) => {
        const registered = this.binding(db, actor, value.destinationId);
        const state =
          registered?.state === "ready" &&
          registered.generation === value.generation &&
          registered.revision === value.revision
            ? value.credentialState
            : "unavailable";
        return {
          destinationId: value.destinationId,
          credentialState: state,
          masked: state === "configured" ? ("••••••••" as const) : null,
        };
      }),
      recent: db
        .prepare(
          "SELECT destination,content,state,attempts,owner FROM notification_outbox WHERE actor=? ORDER BY rowid DESC LIMIT 16",
        )
        .all(actor)
        .map((row) => ({
          destinationId: String(row.destination),
          kind: (JSON.parse(String(row.content)) as Content).kind,
          state:
            row.state === "sending" && row.owner !== this.owner
              ? "uncertain"
              : (row.state as NotificationDeliveryState),
          attempts: Number(row.attempts),
        })),
    }));
  }
  async close(): Promise<void> {
    if (this.closeSettled) return;
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    for (const abort of this.active.values()) abort.abort();
    if (!this.closed) {
      // Settlement is allowed even if the clock regressed: it can only remove send authority.
      this.preferences.withRuntimeTransaction((db) => {
        db.prepare(
          "UPDATE notification_outbox SET state='uncertain',owner=NULL WHERE owner=? AND state='sending'",
        ).run(this.owner);
        db.prepare(
          "UPDATE notification_actions SET state='uncertain' WHERE owner=? AND state='sending'",
        ).run(this.owner);
        db.prepare(
          "UPDATE notification_bindings SET state='unavailable',action_id=NULL WHERE action_id IN (SELECT action_id FROM notification_actions WHERE owner=? AND kind='credential' AND state='uncertain')",
        ).run(this.owner);
      });
      this.closed = true; // Fence late completions before the underlying store may be closed.
    }
    if (this.ticking) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.ticking.catch(() => undefined),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("notification_shutdown_pending")),
              this.timeoutMs + 100,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.closeSettled = true;
  }
}
