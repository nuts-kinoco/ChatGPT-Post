/** Auth-block notification preferences only. This module has no sender, webhook, credential or task authority. */
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import { UiError, type UiProfile } from "../contracts/ui.js";

export interface AuthBlockNotificationPreferences {
  enabled: boolean;
  destinationIds: string[];
}
export interface NotificationPreferenceSnapshot {
  version: "bridge-notification-preferences-1";
  profile: UiProfile;
  actorId: string;
  revision: number;
  updatedAt: string | null;
  authBlocked: AuthBlockNotificationPreferences;
}
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
export const NOTIFICATION_DEFAULTS: Readonly<{
  enabled: boolean;
  destinationIds: readonly string[];
}> = Object.freeze({ enabled: false, destinationIds: Object.freeze([]) });
export function validateNotificationActor(actorId: unknown): asserts actorId is string {
  if (typeof actorId !== "string" || !ID.test(actorId))
    throw new UiError(
      "notification_actor_unavailable",
      "A trusted authenticated actor is required",
      409,
    );
}
export function validateNotificationPreferences(
  value: unknown,
): asserts value is AuthBlockNotificationPreferences {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "destinationIds,enabled"
  )
    throw new UiError(
      "invalid_notification_preferences",
      "Only enabled and registered destination IDs are accepted",
    );
  const settings = value as AuthBlockNotificationPreferences;
  if (
    typeof settings.enabled !== "boolean" ||
    !Array.isArray(settings.destinationIds) ||
    settings.destinationIds.length > 8 ||
    settings.destinationIds.some((id) => typeof id !== "string" || !ID.test(id)) ||
    new Set(settings.destinationIds).size !== settings.destinationIds.length ||
    (settings.enabled && settings.destinationIds.length === 0)
  )
    throw new UiError(
      "invalid_notification_preferences",
      "Select at most eight exact registered destination IDs; enabled notifications require a destination",
    );
}
function corrupt(): never {
  throw new UiError(
    "notification_preferences_unavailable",
    "Stored notification preferences cannot be verified",
    409,
  );
}
function hash(value: unknown): string {
  return sha256Bytes(Buffer.from(JSON.stringify(value)));
}
const VERIFIED_STORES = new WeakMap<NotificationPreferencesStore, string>();
/** Only the verified opener can mint this host-private storage proof. */
export function verifiedNotificationStorePath(
  store: NotificationPreferencesStore,
): string | undefined {
  return VERIFIED_STORES.get(store);
}
export class NotificationPreferencesStore {
  /** Canonical local store scope, not an account identity. In-memory stores cannot own a durable sink. */
  readonly runtimeScopeId: string | null;
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(
    path: string,
    readonly profile: UiProfile,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!["production", "demo"].includes(profile))
      throw new UiError(
        "notification_profile_invalid",
        "An explicit production or demo profile is required",
        500,
      );
    this.db = new DatabaseSync(path);
    this.runtimeScopeId =
      path === ":memory:"
        ? null
        : hash({
            path: realpathSync(path),
            principal: process.getuid?.() ?? "platform-unverified",
            profile,
          });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS notification_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), profile TEXT NOT NULL); CREATE TABLE IF NOT EXISTS notification_preferences (actor_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS notification_clock(id INTEGER PRIMARY KEY CHECK(id=1),last_at INTEGER NOT NULL);",
    );
    this.db.prepare("INSERT OR IGNORE INTO notification_identity VALUES(1,?)").run(profile);
    if (
      this.db.prepare("SELECT profile FROM notification_identity WHERE singleton=1").get()
        ?.profile !== profile
    ) {
      this.db.close();
      throw new UiError(
        "notification_profile_mismatch",
        "Demo and production notification preferences must use separate stores",
        409,
      );
    }
  }
  snapshot(actorId: string): NotificationPreferenceSnapshot {
    validateNotificationActor(actorId);
    const row = this.db
      .prepare("SELECT revision,digest,body FROM notification_preferences WHERE actor_id=?")
      .get(actorId) as { revision: number; digest: string; body: string } | undefined;
    if (!row)
      return {
        version: "bridge-notification-preferences-1",
        profile: this.profile,
        actorId,
        revision: 0,
        updatedAt: null,
        authBlocked: { enabled: false, destinationIds: [] },
      };
    try {
      if (
        Buffer.byteLength(row.body) > 4096 ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 1 ||
        row.revision > 10000 ||
        !HASH.test(row.digest)
      )
        corrupt();
      const value = parseStrictJsonBytes(Buffer.from(row.body)) as NotificationPreferenceSnapshot;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join() !==
          "actorId,authBlocked,profile,revision,updatedAt,version" ||
        value.version !== "bridge-notification-preferences-1" ||
        value.profile !== this.profile ||
        value.actorId !== actorId ||
        value.revision !== row.revision ||
        typeof value.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(value.updatedAt)) ||
        new Date(value.updatedAt).toISOString() !== value.updatedAt ||
        hash(value) !== row.digest
      )
        corrupt();
      validateNotificationPreferences(value.authBlocked);
      return value;
    } catch {
      corrupt();
    }
  }
  /** Trusted settings service supplies the actor and validates recipients against its host catalogue. */
  update(
    actorId: string,
    expectedRevision: number,
    preferences: AuthBlockNotificationPreferences,
  ): NotificationPreferenceSnapshot {
    validateNotificationActor(actorId);
    validateNotificationPreferences(preferences);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= 10000
    )
      throw new UiError(
        "invalid_notification_revision",
        "Expected revision must be an integer below 10000",
      );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.snapshot(actorId);
      if (previous.revision !== expectedRevision)
        throw new UiError(
          "stale_notification_preferences",
          "Notification preferences changed; refresh before saving",
          409,
        );
      if (
        previous.revision === 0 &&
        Number(
          this.db.prepare("SELECT COUNT(*) AS count FROM notification_preferences").get()?.count ??
            0,
        ) >= 256
      )
        throw new UiError(
          "notification_user_limit",
          "Notification preference capacity has been reached",
          409,
        );
      const observed = this.now().getTime();
      const highWater = Number(
        this.db.prepare("SELECT last_at FROM notification_clock WHERE id=1").get()?.last_at ?? 0,
      );
      if (!Number.isSafeInteger(observed) || !Number.isSafeInteger(highWater))
        throw new UiError(
          "notification_clock_regression",
          "Notification clock cannot be verified",
          409,
        );
      const minimum = Math.max(highWater, previous.updatedAt ? Date.parse(previous.updatedAt) : 0);
      if (preferences.enabled && observed < minimum)
        throw new UiError(
          "notification_clock_regression",
          "Notification settings clock moved backwards",
          409,
        );
      // Turning OFF only removes authority and remains available during rollback. It retains the
      // prior logical high-water boundary so a later enable cannot admit an old OFF-era event.
      const savedTime = Math.max(observed, minimum);
      const updatedAt = new Date(savedTime).toISOString();
      this.db
        .prepare(
          "INSERT INTO notification_clock VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_at=excluded.last_at",
        )
        .run(savedTime);
      const value: NotificationPreferenceSnapshot = {
        version: "bridge-notification-preferences-1",
        profile: this.profile,
        actorId,
        revision: expectedRevision + 1,
        updatedAt,
        authBlocked: {
          enabled: preferences.enabled,
          destinationIds: [...preferences.destinationIds].sort(),
        },
      };
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > 4096)
        throw new UiError(
          "notification_preferences_too_large",
          "Notification preference size limit exceeded",
        );
      this.db
        .prepare(
          "INSERT INTO notification_preferences VALUES(?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,body=excluded.body",
        )
        .run(actorId, value.revision, hash(value), body);
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Synchronous host-only reads also work inside an existing transaction. */
  withRuntimeRead<T>(operation: (database: DatabaseSync) => T): T {
    if (this.closed) throw new Error("notification_store_closed");
    return operation(this.db);
  }
  /** Trusted local notification runtime only. This never crosses the HTTP boundary.
   * Keeping preferences, outbox claims and rate reservations in one DB gives cross-process CAS. */
  withRuntimeTransaction<T>(operation: (database: DatabaseSync) => T): T {
    if (this.closed) throw new Error("notification_store_closed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(this.db);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
/** Host lifecycle only. HTTP callers cannot choose the state directory or profile. */
export async function openNotificationPreferencesStore(options: {
  stateDir: string;
  profile: UiProfile;
  now?: () => Date;
}): Promise<NotificationPreferencesStore> {
  if (!["production", "demo"].includes(options.profile))
    throw new UiError(
      "notification_profile_invalid",
      "An explicit production or demo profile is required",
      500,
    );
  if (process.platform === "win32")
    throw new UiError(
      "notification_storage_verifier_unavailable",
      "Native private-state verification is unavailable",
      409,
    );
  const directory = resolve(options.stateDir, "notification-preferences", options.profile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    realpathSync(directory) !== directory ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new UiError(
      "notification_storage_untrusted",
      "Private notification state directory is required",
      409,
    );
  const path = join(directory, "preferences.db");
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const file = lstatSync(path);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1 ||
    file.uid !== process.getuid?.() ||
    (file.mode & 0o077) !== 0
  )
    throw new UiError(
      "notification_storage_untrusted",
      "Private notification state file is required",
      409,
    );
  const store = new NotificationPreferencesStore(path, options.profile, options.now);
  VERIFIED_STORES.set(store, path);
  return store;
}
