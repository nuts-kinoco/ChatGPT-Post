/** Bridge-observed ordinary-Chat Pro usage only. This is never provider quota or execution authority. */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { sha256Bytes } from "../contracts/task.js";
import { UiError } from "../contracts/ui.js";

export interface ProCounterSettings {
  limit: number | null;
  warnRemaining: number | null;
  startsAt: string | null;
  endsAt: string | null;
  timeZone: string | null;
  otherUsage: number | null;
}
export interface ProCounterConfiguration {
  version: "bridge-pro-counter-config-1";
  revision: number;
  configuredAt: string;
  windowId: string | null;
  source: "user-reported-unverified";
  settings: ProCounterSettings;
}
export interface ProSubmissionObservation {
  requestId: string;
  attemptId: string;
  revision: number;
  attemptedAt: string;
  observedAt: string;
  submitted: "yes" | "no" | "unknown";
  observedPreset: "pro" | "other" | "unknown";
  source:
    | "trusted-ordinary-chat-observer"
    | "trusted-hosted-start-intent"
    | "trusted-direct-start-intent";
  synthetic: boolean;
}
type CountState = "confirmed_pro" | "possible_pro" | "not_pro";
interface StoredObservation extends ProSubmissionObservation {
  windowId: string | null;
  countState: CountState;
}
export interface ProCounterView {
  version: "bridge-pro-counter-1";
  synthetic: boolean;
  scope: "bridge-observed-ordinary-chat-only";
  wholeAccountKnown: false;
  providerQuotaKnown: false;
  configuration: ProCounterConfiguration | null;
  windowState: "unconfigured" | "active" | "not_started" | "expired";
  observedAt: string;
  confirmed: number;
  possible: number;
  /** In-range observations with no pin to the currently configured window remain uncertain. */
  unassignedInWindow: number;
  coverageGaps: number;
  coveragePending: boolean;
  observationScope: string | null;
  otherUsage: { value: number | null; source: "user-reported-unverified" };
  remaining: { lower: number; upper: number; source: "configured-reference-only" } | null;
  warning: { active: boolean; severity: "unknown" | "normal" | "warning"; text: string };
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const OBSERVATION_KEYS = [
  "requestId",
  "attemptId",
  "revision",
  "attemptedAt",
  "observedAt",
  "submitted",
  "observedPreset",
  "source",
  "synthetic",
];
const CONFIGURATION_KEYS = [
  "version",
  "revision",
  "configuredAt",
  "windowId",
  "source",
  "settings",
];
function exact(value: unknown, keys: readonly string[]): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join()
  );
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function bounded(value: unknown, maximum = 100000): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
const digest = (value: unknown) => sha256Bytes(Buffer.from(JSON.stringify(value)));
function integrity(): never {
  throw new UiError(
    "counter_integrity_unavailable",
    "Counter records cannot be verified; remaining usage is unknown",
    409,
  );
}
export function validateProSettings(value: unknown): asserts value is ProCounterSettings {
  if (!exact(value, ["limit", "warnRemaining", "startsAt", "endsAt", "timeZone", "otherUsage"]))
    throw new UiError(
      "invalid_counter_settings",
      "Counter settings must contain only the declared fields",
    );
  const settings = value as ProCounterSettings;
  if (
    (settings.limit !== null && (!bounded(settings.limit) || settings.limit < 1)) ||
    (settings.warnRemaining !== null &&
      (!bounded(settings.warnRemaining) ||
        settings.limit === null ||
        settings.warnRemaining > settings.limit)) ||
    (settings.otherUsage !== null && !bounded(settings.otherUsage))
  )
    throw new UiError(
      "invalid_counter_settings",
      "Configured counts and warning bounds are invalid",
    );
  const absent =
    settings.startsAt === null && settings.endsAt === null && settings.timeZone === null;
  if (!absent) {
    if (
      !instant(settings.startsAt) ||
      !instant(settings.endsAt) ||
      Date.parse(settings.endsAt) <= Date.parse(settings.startsAt) ||
      typeof settings.timeZone !== "string" ||
      !settings.timeZone ||
      settings.timeZone.length > 128
    )
      throw new UiError(
        "invalid_counter_window",
        "Provide an explicit UTC start/end and IANA timezone; no reset window is assumed",
      );
    try {
      new Intl.DateTimeFormat("en", { timeZone: settings.timeZone }).format();
    } catch {
      throw new UiError("invalid_counter_timezone", "Timezone was not recognized");
    }
  }
}
function classify(value: ProSubmissionObservation): CountState {
  if (value.submitted === "no" || value.observedPreset === "other") return "not_pro";
  return value.submitted === "yes" && value.observedPreset === "pro"
    ? "confirmed_pro"
    : "possible_pro";
}
/** Stable field order gives identical retries identical digests, independent of caller object order. */
function observation(input: ProSubmissionObservation): ProSubmissionObservation {
  return {
    requestId: input.requestId,
    attemptId: input.attemptId,
    revision: input.revision,
    attemptedAt: input.attemptedAt,
    observedAt: input.observedAt,
    submitted: input.submitted,
    observedPreset: input.observedPreset,
    source: input.source,
    synthetic: input.synthetic,
  };
}
function validObservation(input: ProSubmissionObservation, synthetic: boolean): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]$/.test(input.requestId) &&
    UUID.test(input.attemptId) &&
    bounded(input.revision, Number.MAX_SAFE_INTEGER) &&
    input.revision >= 1 &&
    instant(input.attemptedAt) &&
    instant(input.observedAt) &&
    input.observedAt >= input.attemptedAt &&
    (input.source === "trusted-ordinary-chat-observer" ||
      ((input.source === "trusted-hosted-start-intent" ||
        input.source === "trusted-direct-start-intent") &&
        input.submitted === "unknown" &&
        input.observedPreset === "unknown" &&
        input.observedAt === input.attemptedAt)) &&
    input.synthetic === synthetic &&
    ["yes", "no", "unknown"].includes(input.submitted) &&
    ["pro", "other", "unknown"].includes(input.observedPreset)
  );
}
interface ObservationRow {
  request_id: string;
  attempt_id: string;
  revision: number;
  digest: string;
  body: string;
}
export class ProObservationStore {
  private readonly db: DatabaseSync;
  readonly generationId: string;
  constructor(
    path: string,
    readonly synthetic: boolean,
    private readonly now: () => Date = () => new Date(),
    readonly scopeId: string | null = null,
  ) {
    this.db = new DatabaseSync(path);
    // A populated pre-scope database is never silently migrated or written by scoped open.
    if (
      scopeId !== null &&
      !this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pro_counter_scope'")
        .get()
    ) {
      const populated = ["pro_counter_settings", "pro_counter_observations"].some(
        (table) =>
          !!this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .get(table) &&
          Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n) > 0,
      );
      if (populated) {
        this.db.close();
        throw new UiError(
          "counter_scope_unavailable",
          "Counter observation scope cannot be verified",
          409,
        );
      }
    }
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS pro_counter_identity (id INTEGER PRIMARY KEY CHECK(id=1), synthetic INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS pro_counter_settings (revision INTEGER PRIMARY KEY, body TEXT NOT NULL, digest TEXT); CREATE TABLE IF NOT EXISTS pro_counter_observations (request_id TEXT NOT NULL,attempt_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL, PRIMARY KEY(request_id,attempt_id));",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS pro_counter_scope(id INTEGER PRIMARY KEY CHECK(id=1),scope_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pro_counter_gaps(id TEXT PRIMARY KEY,attempted_at TEXT); CREATE TABLE IF NOT EXISTS pro_counter_pending(source TEXT PRIMARY KEY,pending INTEGER NOT NULL);",
    );
    const scoped = this.db.prepare("SELECT scope_id FROM pro_counter_scope WHERE id=1").get();
    if (scopeId !== null) {
      if (
        !HASH.test(scopeId) ||
        (scoped && scoped.scope_id !== scopeId) ||
        (!scoped &&
          (Number(this.db.prepare("SELECT COUNT(*) AS n FROM pro_counter_observations").get()?.n) >
            0 ||
            Number(this.db.prepare("SELECT COUNT(*) AS n FROM pro_counter_settings").get()?.n) > 0))
      ) {
        this.db.close();
        throw new UiError(
          "counter_scope_unavailable",
          "Counter observation scope cannot be verified",
          409,
        );
      }
      this.db.prepare("INSERT OR IGNORE INTO pro_counter_scope VALUES(1,?)").run(scopeId);
    } else if (scoped) {
      this.db.close();
      throw new UiError(
        "counter_scope_unavailable",
        "Scoped counter requires its trusted host binding",
        409,
      );
    }
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS pro_counter_generation(id INTEGER PRIMARY KEY CHECK(id=1),generation_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pro_counter_projection_receipts(source_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL);",
    );
    this.db.prepare("INSERT OR IGNORE INTO pro_counter_generation VALUES(1,?)").run(randomUUID());
    this.generationId = String(
      this.db.prepare("SELECT generation_id FROM pro_counter_generation WHERE id=1").get()
        ?.generation_id,
    );
    if (!UUID.test(this.generationId)) {
      this.db.close();
      integrity();
    }
    // Add storage for integrity without rewriting/backfilling old unchecked configurations.
    if (
      !this.db
        .prepare("PRAGMA table_info(pro_counter_settings)")
        .all()
        .some((row) => row.name === "digest")
    )
      this.db.exec("ALTER TABLE pro_counter_settings ADD COLUMN digest TEXT");
    this.db
      .prepare("INSERT OR IGNORE INTO pro_counter_identity VALUES(1,?)")
      .run(synthetic ? 1 : 0);
    if (
      this.db.prepare("SELECT synthetic FROM pro_counter_identity WHERE id=1").get()?.synthetic !==
      (synthetic ? 1 : 0)
    ) {
      this.db.close();
      throw new UiError(
        "counter_profile_mismatch",
        "Synthetic and production observations must use separate stores",
        409,
      );
    }
  }
  private configurations(): ProCounterConfiguration[] {
    const rows = this.db
      .prepare(
        "SELECT revision,body,digest FROM pro_counter_settings ORDER BY revision LIMIT 10001",
      )
      .all() as { revision: number; body: string; digest: string | null }[];
    if (rows.length > 10000) integrity();
    const history: ProCounterConfiguration[] = [];
    const windows = new Map<string, ProCounterConfiguration>();
    try {
      for (const row of rows) {
        const config = JSON.parse(row.body) as ProCounterConfiguration;
        if (
          !exact(config, CONFIGURATION_KEYS) ||
          config.version !== "bridge-pro-counter-config-1" ||
          config.source !== "user-reported-unverified" ||
          config.revision !== row.revision ||
          config.revision !== history.length + 1 ||
          !instant(config.configuredAt) ||
          (config.windowId !== null && !UUID.test(config.windowId)) ||
          !row.digest ||
          !HASH.test(row.digest) ||
          digest(config) !== row.digest
        )
          integrity();
        validateProSettings(config.settings);
        if ((config.windowId === null) !== (config.settings.startsAt === null)) integrity();
        const previous = history.at(-1);
        if (previous && config.configuredAt < previous.configuredAt) integrity();
        const priorWindow = config.windowId === null ? undefined : windows.get(config.windowId);
        if (
          priorWindow &&
          (priorWindow.settings.startsAt !== config.settings.startsAt ||
            priorWindow.settings.endsAt !== config.settings.endsAt ||
            priorWindow.settings.timeZone !== config.settings.timeZone)
        )
          integrity();
        history.push(config);
        if (config.windowId !== null && !priorWindow) windows.set(config.windowId, config);
      }
    } catch {
      integrity();
    }
    return history;
  }
  configuration(): ProCounterConfiguration | null {
    return this.configurations().at(-1) ?? null;
  }
  configure(settings: unknown, expectedRevision: number): ProCounterConfiguration {
    validateProSettings(settings);
    if (!bounded(expectedRevision, 9999))
      throw new UiError("invalid_counter_revision", "Expected revision is invalid");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.configuration();
      if ((prior?.revision ?? 0) !== expectedRevision)
        throw new UiError(
          "stale_counter_settings",
          "Counter settings changed; refresh before saving",
          409,
        );
      const configuredAt = this.now().toISOString();
      if (prior && configuredAt < prior.configuredAt)
        throw new UiError(
          "counter_clock_regression",
          "Counter configuration clock moved backwards",
          409,
        );
      const sameWindow =
        prior?.settings.startsAt === settings.startsAt &&
        prior.settings.endsAt === settings.endsAt &&
        prior.settings.timeZone === settings.timeZone;
      const configuration: ProCounterConfiguration = {
        version: "bridge-pro-counter-config-1",
        revision: expectedRevision + 1,
        configuredAt,
        windowId: settings.startsAt === null ? null : sameWindow ? prior.windowId : randomUUID(),
        source: "user-reported-unverified",
        settings: structuredClone(settings),
      };
      this.db
        .prepare("INSERT INTO pro_counter_settings (revision,body,digest) VALUES(?,?,?)")
        .run(configuration.revision, JSON.stringify(configuration), digest(configuration));
      this.db.exec("COMMIT");
      return configuration;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private windows(history: ProCounterConfiguration[]): Map<string, ProCounterConfiguration> {
    const windows = new Map<string, ProCounterConfiguration>();
    for (const config of history)
      if (config.windowId !== null && !windows.has(config.windowId))
        windows.set(config.windowId, config);
    return windows;
  }
  private stored(
    row: ObservationRow,
    windows: Map<string, ProCounterConfiguration>,
  ): StoredObservation {
    try {
      const value = JSON.parse(row.body) as StoredObservation;
      if (
        !exact(value, [...OBSERVATION_KEYS, "windowId", "countState"]) ||
        !validObservation(value, this.synthetic) ||
        value.requestId !== row.request_id ||
        value.attemptId !== row.attempt_id ||
        value.revision !== row.revision ||
        !HASH.test(row.digest) ||
        digest(value) !== row.digest ||
        value.countState !== classify(value) ||
        (value.windowId !== null && !UUID.test(value.windowId))
      )
        integrity();
      if (value.windowId !== null) {
        const pin = windows.get(value.windowId);
        if (
          !pin?.settings.startsAt ||
          !pin.settings.endsAt ||
          pin.configuredAt > value.attemptedAt ||
          value.attemptedAt < pin.settings.startsAt ||
          value.attemptedAt >= pin.settings.endsAt
        )
          integrity();
      }
      return value;
    } catch {
      integrity();
    }
  }
  /** Trusted host observation hook only. There is intentionally no HTTP event-injection endpoint. */
  observe(input: ProSubmissionObservation): void {
    if (input.source !== "trusted-ordinary-chat-observer")
      throw new UiError(
        "invalid_pro_observation",
        "Only trusted ordinary-Chat submission observations are accepted",
      );
    this.record(input, false);
  }
  /** Called only for a newly durable hosted attempt. Repeated reads/cancellation revisions never advance it. */
  observeStartIntent(input: ProSubmissionObservation): void {
    if (
      input.source !== "trusted-hosted-start-intent" &&
      input.source !== "trusted-direct-start-intent"
    )
      throw new UiError("invalid_pro_observation", "Durable start intent provenance is required");
    this.record(input, true);
  }
  private record(input: ProSubmissionObservation, onlyIfAbsent: boolean): void {
    if (!exact(input, OBSERVATION_KEYS) || !validObservation(input, this.synthetic))
      throw new UiError(
        "invalid_pro_observation",
        "Only exact trusted ordinary-Chat submission observations are accepted",
      );
    const normalized = observation(input);
    const hash = digest(normalized);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const history = this.configurations();
      const row = this.db
        .prepare(
          "SELECT request_id,attempt_id,revision,digest,body FROM pro_counter_observations WHERE request_id=? AND attempt_id=?",
        )
        .get(input.requestId, input.attemptId) as ObservationRow | undefined;
      const previous = row ? this.stored(row, this.windows(history)) : null;
      if (onlyIfAbsent && previous) {
        this.db.exec("COMMIT");
        return;
      }
      if (row && row.revision > input.revision) {
        this.db.exec("COMMIT");
        return;
      }
      if (row && row.revision === input.revision) {
        if (!previous || digest(observation(previous)) !== hash)
          throw new UiError(
            "pro_observation_conflict",
            "Same observation revision has different content",
            409,
          );
        this.db.exec("COMMIT");
        return;
      }
      if (
        previous &&
        (previous.attemptedAt !== input.attemptedAt ||
          input.observedAt < previous.observedAt ||
          (previous.countState === "confirmed_pro" && classify(input) !== "confirmed_pro"))
      )
        throw new UiError(
          "pro_observation_conflict",
          "Confirmed submission identity cannot be rewritten or downgraded",
          409,
        );
      let windowId = previous?.windowId ?? null;
      if (!previous) {
        const count = Number(
          this.db.prepare("SELECT COUNT(*) AS count FROM pro_counter_observations").get()?.count ??
            0,
        );
        if (count >= 100000)
          throw new UiError(
            "counter_storage_limit",
            "Observation capacity reached; keep usage unknown until reviewed",
            409,
          );
        // Resolve configuration at the attempt. Late arrivals never adopt today's window.
        const atAttempt = [...history]
          .reverse()
          .find((entry) => entry.configuredAt <= input.attemptedAt);
        if (
          atAttempt?.windowId &&
          atAttempt.settings.startsAt &&
          atAttempt.settings.endsAt &&
          input.attemptedAt >= atAttempt.settings.startsAt &&
          input.attemptedAt < atAttempt.settings.endsAt
        )
          windowId = atAttempt.windowId;
      }
      const saved: StoredObservation = { ...normalized, windowId, countState: classify(input) };
      this.db
        .prepare(
          "INSERT INTO pro_counter_observations VALUES(?,?,?,?,?) ON CONFLICT(request_id,attempt_id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,body=excluded.body",
        )
        .run(
          input.requestId,
          input.attemptId,
          input.revision,
          digest(saved),
          JSON.stringify(saved),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  projectionPosition(sourceId: string): number {
    if (!UUID.test(sourceId))
      throw new UiError("invalid_counter_source", "Invalid projection source");
    const row = this.db
      .prepare("SELECT sequence FROM pro_counter_projection_receipts WHERE source_id=?")
      .get(sourceId);
    const value = row ? Number(row.sequence) : 0;
    if (!Number.isSafeInteger(value) || value < 0) integrity();
    return value;
  }
  /** Persist after idempotent projection and before the source consumer advances its cursor. */
  recordProjectionPosition(sourceId: string, sequence: number): void {
    if (!UUID.test(sourceId) || !Number.isSafeInteger(sequence) || sequence < 1)
      throw new UiError("invalid_counter_source", "Invalid projection receipt");
    this.projectionPosition(sourceId);
    this.db
      .prepare(
        "INSERT INTO pro_counter_projection_receipts VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)",
      )
      .run(sourceId, sequence);
  }
  recordCoverageGap(id: string, attemptedAt: string | null): void {
    if (!id || id.length > 256 || (attemptedAt !== null && !instant(attemptedAt)))
      throw new UiError("invalid_counter_gap", "Invalid coverage gap");
    this.db.prepare("INSERT OR IGNORE INTO pro_counter_gaps VALUES(?,?)").run(id, attemptedAt);
  }
  setSourcePending(source: string, pending: boolean): void {
    if (!source || source.length > 256)
      throw new UiError("invalid_counter_source", "Invalid source");
    this.db
      .prepare(
        "INSERT INTO pro_counter_pending VALUES(?,?) ON CONFLICT(source) DO UPDATE SET pending=excluded.pending",
      )
      .run(source, pending ? 1 : 0);
  }
  view(): ProCounterView {
    const history = this.configurations();
    const configuration = history.at(-1) ?? null,
      settings = configuration?.settings;
    const now = this.now().toISOString();
    const windowState =
      !configuration?.windowId || !settings?.startsAt || !settings.endsAt
        ? "unconfigured"
        : now < settings.startsAt
          ? "not_started"
          : now >= settings.endsAt
            ? "expired"
            : "active";
    const rows = this.db
      .prepare(
        "SELECT request_id,attempt_id,revision,digest,body FROM pro_counter_observations LIMIT 100001",
      )
      .all() as unknown as ObservationRow[];
    if (rows.length > 100000) integrity();
    const windows = this.windows(history);
    const records = rows.map((row) => this.stored(row, windows));
    const window = records.filter(
      (row) => configuration?.windowId && row.windowId === configuration.windowId,
    );
    const confirmed = window.filter((row) => row.countState === "confirmed_pro").length,
      possible = window.filter((row) => row.countState === "possible_pro").length;
    // Prior non-null pins are not reassigned when a new overlapping window is configured.
    // Their presence makes the current range uncertain, rather than restoring the full limit.
    const unassignedInWindow = records.filter(
      (row) =>
        row.windowId !== configuration?.windowId &&
        row.countState !== "not_pro" &&
        settings?.startsAt &&
        settings.endsAt &&
        row.attemptedAt >= settings.startsAt &&
        row.attemptedAt < settings.endsAt,
    ).length;
    const gaps = this.db.prepare("SELECT attempted_at FROM pro_counter_gaps").all();
    const coverageGaps = gaps.filter(
      (row) =>
        row.attempted_at === null ||
        !settings?.startsAt ||
        !settings.endsAt ||
        (String(row.attempted_at) >= settings.startsAt &&
          String(row.attempted_at) < settings.endsAt),
    ).length;
    const coveragePending = !!this.db
      .prepare("SELECT 1 FROM pro_counter_pending WHERE pending=1 LIMIT 1")
      .get();
    const remaining =
      windowState === "active" &&
      settings?.limit !== null &&
      settings?.limit !== undefined &&
      unassignedInWindow === 0 &&
      coverageGaps === 0 &&
      !coveragePending
        ? {
            lower: Math.max(0, settings.limit - confirmed - possible - (settings.otherUsage ?? 0)),
            upper: Math.max(0, settings.limit - confirmed - (settings.otherUsage ?? 0)),
            source: "configured-reference-only" as const,
          }
        : null;
    const active =
      !!remaining &&
      settings?.warnRemaining !== null &&
      settings?.warnRemaining !== undefined &&
      remaining.lower <= settings.warnRemaining;
    return {
      version: "bridge-pro-counter-1",
      synthetic: this.synthetic,
      scope: "bridge-observed-ordinary-chat-only",
      wholeAccountKnown: false,
      providerQuotaKnown: false,
      configuration,
      windowState,
      observedAt: now,
      confirmed,
      possible,
      unassignedInWindow,
      coverageGaps,
      coveragePending,
      observationScope: this.scopeId,
      otherUsage: { value: settings?.otherUsage ?? null, source: "user-reported-unverified" },
      remaining,
      warning: {
        active,
        severity: remaining ? (active ? "warning" : "normal") : "unknown",
        text: active
          ? "設定した残り回数の警告です。Bridgeで観測した利用だけの参考値で、公式・アカウント全体の残数ではありません"
          : remaining
            ? "Bridge記録と利用者設定からの参考範囲です。アカウント全体の利用枠は不明です"
            : "上限・時間枠・記録の対応を確認できないため残数は不明です。自動リセットしません",
      },
    };
  }
  close(): void {
    this.db.close();
  }
}
