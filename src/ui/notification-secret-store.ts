/** Versioned ciphertext-only repository in the verified notification transaction domain. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import type { NotificationPreferencesStore } from "./notification-preferences.js";
export interface NotificationSecretSlot {
  actor: string;
  destination: string;
  channel: "discord" | "email";
  label: string;
  registration: string;
  generation: string;
  revision: number;
  activatedAt: string;
  target: string | null;
  consent: string | null;
}
export interface NotificationSecretPlaintext {
  version: "bridge-notification-secret-1";
  store: string;
  scope: string;
  profile: string;
  actor: string;
  destination: string;
  registration: string;
  generation: string;
  revision: number;
  channel: "discord" | "email";
  target: string;
  consent: string;
  consentVersion: "bridge-notification-consent-1";
  secret: string;
}
export interface NotificationCipherRecord {
  plaintext: Omit<NotificationSecretPlaintext, "secret">;
  ciphertext: Uint8Array;
}
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function fail(): never {
  throw new Error("notification_secret_store_unavailable");
}
function stamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function slotRow(row: Record<string, unknown>): NotificationSecretSlot {
  const slot: NotificationSecretSlot = {
    actor: String(row.actor),
    destination: String(row.destination),
    channel: row.channel as "discord" | "email",
    label: String(row.label),
    registration: String(row.registration),
    generation: String(row.generation),
    revision: Number(row.revision),
    activatedAt: String(row.activated_at),
    target: row.target === null ? null : String(row.target),
    consent: row.consent === null ? null : String(row.consent),
  };
  if (
    !ID.test(slot.actor) ||
    !ID.test(slot.destination) ||
    !["discord", "email"].includes(slot.channel) ||
    !slot.label.trim() ||
    slot.label.length > 128 ||
    /[\0\r\n@]|https?:\/\//i.test(slot.label) ||
    !UUID.test(slot.registration) ||
    !UUID.test(slot.generation) ||
    !Number.isSafeInteger(slot.revision) ||
    slot.revision < 1 ||
    !stamp(slot.activatedAt) ||
    (slot.target !== null &&
      (!slot.target || slot.target.length > 256 || /[\0\r\n]/.test(slot.target))) ||
    (slot.consent !== null && !UUID.test(slot.consent)) ||
    (slot.target !== null &&
      (slot.channel === "discord"
        ? !/^[0-9]{1,24}$/.test(slot.target)
        : !/^[A-Za-z0-9_.:-]{1,128}$/.test(slot.target))) ||
    (slot.target === null) !== (slot.consent === null)
  )
    fail();
  return slot;
}
export class NotificationSecretStore {
  readonly incarnation: string;
  constructor(
    readonly preferences: NotificationPreferencesStore,
    actor: string,
    slots: readonly { destinationId: string; channel: "discord" | "email"; label: string }[],
    now: Date,
  ) {
    if (
      !preferences.runtimeScopeId ||
      !ID.test(actor) ||
      slots.length > 64 ||
      new Set(slots.map((s) => s.destinationId)).size !== slots.length
    )
      fail();
    this.incarnation = preferences.withRuntimeTransaction((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS notification_secret_identity(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,incarnation TEXT NOT NULL,scope TEXT NOT NULL,profile TEXT NOT NULL,principal INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_secret_slots(actor TEXT NOT NULL,destination TEXT NOT NULL,channel TEXT NOT NULL,label TEXT NOT NULL,registration TEXT NOT NULL,generation TEXT NOT NULL,revision INTEGER NOT NULL,activated_at TEXT NOT NULL,target TEXT,consent TEXT,PRIMARY KEY(actor,destination));
      CREATE TABLE IF NOT EXISTS notification_secret_records(actor TEXT NOT NULL,destination TEXT NOT NULL,metadata TEXT NOT NULL,ciphertext BLOB NOT NULL,digest TEXT NOT NULL,cipher_kind TEXT NOT NULL,PRIMARY KEY(actor,destination));`);
      db.prepare("INSERT OR IGNORE INTO notification_secret_identity VALUES(1,1,?,?,?,?)").run(
        randomUUID(),
        preferences.runtimeScopeId,
        preferences.profile,
        process.getuid?.() ?? -1,
      );
      const identity = db.prepare("SELECT * FROM notification_secret_identity WHERE id=1").get();
      if (
        identity?.version !== 1 ||
        identity.scope !== preferences.runtimeScopeId ||
        identity.profile !== preferences.profile ||
        identity.principal !== process.getuid?.() ||
        typeof identity.incarnation !== "string" ||
        !UUID.test(identity.incarnation)
      )
        fail();
      if (
        !db.prepare("SELECT 1 FROM notification_secret_slots WHERE actor=?").get(actor) &&
        Number(
          db.prepare("SELECT count(DISTINCT actor) AS n FROM notification_secret_slots").get()?.n,
        ) >= 256
      )
        fail();
      for (const spec of slots) {
        const old = this.get(actor, spec.destinationId, db);
        if (old) {
          if (old.channel !== spec.channel || old.label !== spec.label) fail();
          continue;
        }
        if (!ID.test(spec.destinationId)) fail();
        const hasBindings = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='notification_bindings'",
          )
          .get();
        if (
          (hasBindings &&
            db
              .prepare("SELECT 1 FROM notification_bindings WHERE actor=? AND destination=?")
              .get(actor, spec.destinationId)) ||
          preferences.snapshot(actor).authBlocked.destinationIds.includes(spec.destinationId)
        )
          throw new Error("notification_registration_migration_required");
        if (
          Number(db.prepare("SELECT count(*) AS n FROM notification_secret_slots").get()?.n) >=
          16384
        )
          fail();
        const fresh: NotificationSecretSlot = {
          actor,
          destination: spec.destinationId,
          channel: spec.channel,
          label: spec.label,
          registration: randomUUID(),
          generation: randomUUID(),
          revision: 1,
          activatedAt: now.toISOString(),
          target: null,
          consent: null,
        };
        slotRow({ ...fresh, activated_at: fresh.activatedAt });
        db.prepare("INSERT INTO notification_secret_slots VALUES(?,?,?,?,?,?,?,?,?,?)").run(
          actor,
          fresh.destination,
          fresh.channel,
          fresh.label,
          fresh.registration,
          fresh.generation,
          fresh.revision,
          fresh.activatedAt,
          null,
          null,
        );
      }
      return identity.incarnation;
    });
  }
  get(actor: string, destination: string, db?: DatabaseSync): NotificationSecretSlot | null {
    const read = (database: DatabaseSync) => {
      const row = database
        .prepare("SELECT * FROM notification_secret_slots WHERE actor=? AND destination=?")
        .get(actor, destination);
      return row ? slotRow(row) : null;
    };
    return db ? read(db) : this.preferences.withRuntimeRead(read);
  }
  metadata(slot: NotificationSecretSlot): Omit<NotificationSecretPlaintext, "secret"> {
    if (!slot.target || !slot.consent) fail();
    return {
      version: "bridge-notification-secret-1",
      store: this.incarnation,
      scope: this.preferences.runtimeScopeId ?? fail(),
      profile: this.preferences.profile,
      actor: slot.actor,
      destination: slot.destination,
      registration: slot.registration,
      generation: slot.generation,
      revision: slot.revision,
      channel: slot.channel,
      target: slot.target,
      consent: slot.consent,
      consentVersion: "bridge-notification-consent-1",
    };
  }
  readRecord(slot: NotificationSecretSlot): NotificationCipherRecord | null {
    return this.preferences.withRuntimeRead((db) => {
      const row = db
        .prepare(
          "SELECT metadata,ciphertext,digest,cipher_kind FROM notification_secret_records WHERE actor=? AND destination=?",
        )
        .get(slot.actor, slot.destination);
      if (!row) {
        if (slot.target !== null) fail();
        return null;
      }
      if (
        row.cipher_kind !== "electron-safe-storage-39" ||
        typeof row.metadata !== "string" ||
        Buffer.byteLength(row.metadata) > 4096 ||
        !(row.ciphertext instanceof Uint8Array) ||
        row.ciphertext.byteLength < 1 ||
        row.ciphertext.byteLength > 32768 ||
        row.digest !== sha256Bytes(Buffer.from(row.ciphertext))
      )
        fail();
      const expected = this.metadata(slot);
      if (
        JSON.stringify(parseStrictJsonBytes(Buffer.from(row.metadata))) !== JSON.stringify(expected)
      )
        fail();
      return { plaintext: expected, ciphertext: Buffer.from(row.ciphertext) };
    });
  }
  decode(slot: NotificationSecretSlot, plaintext: string): string {
    if (typeof plaintext !== "string" || Buffer.byteLength(plaintext) > 8192) fail();
    const value = parseStrictJsonBytes(Buffer.from(plaintext)) as NotificationSecretPlaintext;
    const keys = Object.keys(this.metadata(slot)).concat("secret").sort().join();
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join() !== keys ||
      typeof value.secret !== "string" ||
      !value.secret ||
      Buffer.byteLength(value.secret) > 4096
    )
      fail();
    const { secret, ...metadata } = value;
    if (JSON.stringify(metadata) !== JSON.stringify(this.metadata(slot))) fail();
    return secret;
  }
  commit(
    db: DatabaseSync,
    before: NotificationSecretSlot,
    next: NotificationSecretSlot,
    ciphertext: Uint8Array,
  ): void {
    const current = this.get(before.actor, before.destination, db);
    if (
      !current ||
      JSON.stringify(current) !== JSON.stringify(before) ||
      next.registration !== before.registration ||
      next.actor !== before.actor ||
      next.destination !== before.destination ||
      next.channel !== before.channel ||
      next.label !== before.label ||
      next.generation === before.generation ||
      next.revision !== before.revision + 1 ||
      next.activatedAt < before.activatedAt ||
      (before.target !== null &&
        (next.target !== before.target || next.consent !== before.consent)) ||
      ciphertext.byteLength < 1 ||
      ciphertext.byteLength > 32768
    )
      fail();
    slotRow({ ...next, activated_at: next.activatedAt });
    const changed = db
      .prepare(
        "UPDATE notification_secret_slots SET generation=?,revision=?,activated_at=?,target=?,consent=? WHERE actor=? AND destination=? AND generation=? AND revision=?",
      )
      .run(
        next.generation,
        next.revision,
        next.activatedAt,
        next.target,
        next.consent,
        before.actor,
        before.destination,
        before.generation,
        before.revision,
      );
    if (changed.changes !== 1) fail();
    db.prepare(
      "INSERT INTO notification_secret_records VALUES(?,?,?,?,?,?) ON CONFLICT(actor,destination) DO UPDATE SET metadata=excluded.metadata,ciphertext=excluded.ciphertext,digest=excluded.digest,cipher_kind=excluded.cipher_kind",
    ).run(
      next.actor,
      next.destination,
      JSON.stringify(this.metadata(next)),
      Buffer.from(ciphertext),
      sha256Bytes(Buffer.from(ciphertext)),
      "electron-safe-storage-39",
    );
  }
}
