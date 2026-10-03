/** One host-owned metadata cache per registered scope. Never an execution registry. */
import { isDeepStrictEqual } from "node:util";
import type {
  CatalogReason,
  ProviderCatalogScope,
  ProviderCatalogSnapshot,
  ProviderCatalogView,
} from "../contracts/provider-catalog.js";
import type { MetadataProbeLease } from "./antigravity-probe.js";
export type CatalogRefreshResult =
  | { kind: "snapshot"; snapshot: ProviderCatalogSnapshot }
  | { kind: "failed"; reason: Exclude<CatalogReason, "none"> };
export interface CatalogMetadataSource {
  /** No inference, authentication setup, settings change or arbitrary prompt is allowed here. */
  start(scope: ProviderCatalogScope): MetadataProbeLease<CatalogRefreshResult>;
}
export interface CatalogCacheOptions {
  scope: ProviderCatalogScope;
  source: CatalogMetadataSource;
  now?: () => Date;
  ttlMs?: number;
  minRefreshIntervalMs?: number;
  refreshTimeoutMs?: number;
  /** A previously verified read-only cache snapshot; never a policy or execution grant. */
  initialSnapshot?: ProviderCatalogSnapshot;
}
const MIN_INTERVAL = 15 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const REASONS = new Set<CatalogReason>([
  "none",
  "auth_required",
  "format_unverified",
  "unavailable",
  "timeout",
  "output_limit",
  "process_failed",
  "malformed_output",
  "version_unsupported",
  "binary_untrusted",
  "ambiguous",
  "incomplete",
  "context_changed",
  "clock_rollback",
]);
function text(value: unknown, max = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}
function label(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    }) &&
    !/[\uD800-\uDFFF]/u.test(value)
  );
}
function time(value: string): number {
  const at = Date.parse(value);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== value)
    throw new Error("catalog_timestamp_invalid");
  return at;
}
function scopeValid(s: ProviderCatalogScope): void {
  if (
    !s ||
    !text(s.providerId, 64) ||
    !text(s.routeId, 64) ||
    !text(s.contextId, 128) ||
    !s.revision ||
    !["cli_binary", "dom_profile"].includes(s.revision.kind) ||
    !text(s.revision.id, 128) ||
    !text(s.revision.version, 128) ||
    (s.revision.kind === "cli_binary" && !/^[a-f0-9]{64}$/.test(s.revision.id))
  )
    throw new Error("catalog_scope_invalid");
}
function snapshotValid(
  s: ProviderCatalogSnapshot,
  expected: ProviderCatalogScope,
  now: number,
): void {
  if (
    s?.schema !== "bridge-provider-catalog-1" ||
    !isDeepStrictEqual(s.scope, expected) ||
    !Number.isFinite(time(s.observedAt)) ||
    time(s.observedAt) > now ||
    typeof s.complete !== "boolean" ||
    !REASONS.has(s.reason) ||
    (s.complete ? !["none", "ambiguous"].includes(s.reason) : s.reason === "none") ||
    s.executionAuthorized !== false ||
    s.accountAvailability !== "unknown" ||
    s.cost !== "unknown" ||
    !s.source ||
    !["cli_metadata", "browser_dom"].includes(s.source.kind) ||
    !text(s.source.operation, 128) ||
    !text(s.source.formatId, 128) ||
    (s.source.contentSha256 !== null && !/^[a-f0-9]{64}$/.test(s.source.contentSha256)) ||
    !Array.isArray(s.options) ||
    s.options.length > 256 ||
    !s.effortSyntax ||
    !["cli_global", "unknown"].includes(s.effortSyntax.scope) ||
    !Array.isArray(s.effortSyntax.values) ||
    s.effortSyntax.values.length > 32 ||
    s.effortSyntax.values.some((v) => !text(v, 64)) ||
    (s.effortSyntax.source !== null && !text(s.effortSyntax.source, 128)) ||
    (s.effortSyntax.scope === "unknown" && s.effortSyntax.values.length !== 0)
  )
    throw new Error("catalog_snapshot_invalid");
  const keys = new Set<string>();
  for (const row of s.options) {
    if (
      !row ||
      !text(row.observationKey) ||
      keys.has(row.observationKey) ||
      !label(row.label) ||
      (row.providerModelId !== null && !text(row.providerModelId)) ||
      !["provider_reported", "unverified_label"].includes(row.identitySource) ||
      (row.providerModelId === null) !== (row.identitySource === "unverified_label") ||
      (row.checked !== null && typeof row.checked !== "boolean") ||
      (row.enabled !== null && typeof row.enabled !== "boolean") ||
      !["none", "duplicate_label", "duplicate_id", "unknown"].includes(row.ambiguity) ||
      !row.effort ||
      !["model_reported", "unknown"].includes(row.effort.scope) ||
      !Array.isArray(row.effort.values) ||
      row.effort.values.length > 32 ||
      row.effort.values.some((v) => !text(v, 64)) ||
      (row.effort.source !== null && !text(row.effort.source, 128)) ||
      (row.effort.scope === "unknown" && row.effort.values.length !== 0)
    )
      throw new Error("catalog_option_invalid");
    keys.add(row.observationKey);
  }
}
export class ProviderCatalogCache {
  private readonly scope: ProviderCatalogScope;
  private readonly source: CatalogMetadataSource;
  private readonly now: () => Date;
  private readonly ttl: number;
  private readonly interval: number;
  private readonly timeout: number;
  private catalog: ProviderCatalogSnapshot | null = null;
  private attemptedAt: number | null = null;
  private nextAt: number | null = null;
  private error: CatalogReason | null = null;
  private lastClock: number;
  private failures = 0;
  private active: { promise: Promise<ProviderCatalogView>; cancel(): void } | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  constructor(options: CatalogCacheOptions) {
    scopeValid(options.scope);
    this.scope = structuredClone(options.scope);
    this.source = options.source;
    this.now = options.now ?? (() => new Date());
    this.lastClock = this.now().getTime();
    this.ttl = options.ttlMs ?? DAY;
    this.interval = options.minRefreshIntervalMs ?? MIN_INTERVAL;
    this.timeout = options.refreshTimeoutMs ?? 5000;
    if (
      !Number.isSafeInteger(this.lastClock) ||
      this.lastClock < 0 ||
      !Number.isSafeInteger(this.interval) ||
      this.interval < MIN_INTERVAL ||
      this.interval > 7 * DAY ||
      !Number.isSafeInteger(this.ttl) ||
      this.ttl < this.interval ||
      this.ttl > 7 * DAY ||
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 10000
    )
      throw new Error("catalog_cache_configuration_invalid");
    if (options.initialSnapshot) {
      snapshotValid(options.initialSnapshot, this.scope, this.lastClock);
      this.catalog = structuredClone(options.initialSnapshot);
      this.nextAt = time(options.initialSnapshot.observedAt) + this.interval;
    }
  }
  private clock(): number {
    const now = this.now().getTime();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("catalog_clock_invalid");
    if (now < this.lastClock) this.error = "clock_rollback";
    else if (this.error === "clock_rollback") this.error = "unavailable";
    this.lastClock = Math.max(this.lastClock, now);
    return now;
  }
  view(): ProviderCatalogView {
    const now = this.clock();
    const fetched = this.catalog ? time(this.catalog.observedAt) : null;
    const stale =
      !!this.catalog &&
      (this.error !== null || fetched === null || now < fetched || now >= fetched + this.ttl);
    return {
      schema: "bridge-provider-catalog-cache-1",
      scope: structuredClone(this.scope),
      catalog: this.catalog ? structuredClone(this.catalog) : null,
      fetchedAt: this.catalog?.observedAt ?? null,
      expiresAt: fetched === null ? null : new Date(fetched + this.ttl).toISOString(),
      stale,
      state: !this.catalog?.complete ? "unknown" : stale ? "stale" : "fresh",
      refresh: {
        lastAttemptAt: this.attemptedAt === null ? null : new Date(this.attemptedAt).toISOString(),
        nextAllowedAt: this.nextAt === null ? null : new Date(this.nextAt).toISOString(),
        error: this.error,
        ownershipHeld: this.active !== null,
      },
    };
  }
  /** Startup, active-host periodic refresh or explicit refresh. Never exceeds the minimum interval. */
  refreshIfDue(explicit = false): Promise<ProviderCatalogView> {
    if (this.active) return this.active.promise.then(() => this.view());
    const now = this.clock();
    if (
      this.error === "clock_rollback" ||
      (this.nextAt !== null && now < this.nextAt) ||
      (!explicit && this.catalog && !this.view().stale)
    )
      return Promise.resolve(this.view());
    this.attemptedAt = now;
    this.nextAt = now + this.interval;
    let resolve!: (value: ProviderCatalogView) => void;
    const promise = new Promise<ProviderCatalogView>((done) => {
      resolve = done;
    });
    const active = { promise, cancel: () => {} };
    this.active = active;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failure = (reason: Exclude<CatalogReason, "none">) => {
      this.error = reason;
      this.failures++;
      this.nextAt =
        this.clock() +
        Math.min(Math.max(DAY, this.interval), this.interval * 2 ** Math.min(6, this.failures - 1));
    };
    const finish = (result: CatalogRefreshResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!result || !["snapshot", "failed"].includes(result.kind)) {
        failure("malformed_output");
      } else if (result.kind === "snapshot") {
        try {
          snapshotValid(result.snapshot, this.scope, this.clock());
          if (!result.snapshot.complete) {
            if (!this.catalog?.complete) this.catalog = structuredClone(result.snapshot);
            failure(result.snapshot.reason as Exclude<CatalogReason, "none">);
          } else {
            this.catalog = structuredClone(result.snapshot);
            this.error = null;
            this.failures = 0;
            this.nextAt = this.clock() + this.interval;
          }
        } catch {
          failure("malformed_output");
        }
      } else if (!REASONS.has(result.reason) || result.reason === ("none" as string))
        failure("malformed_output");
      else failure(result.reason);
      resolve(this.view());
    };
    try {
      const lease = this.source.start(structuredClone(this.scope));
      active.cancel = () => lease.cancel();
      timer = setTimeout(() => {
        finish({ kind: "failed", reason: "timeout" });
        try {
          lease.cancel();
        } catch {
          /* Ownership retained. */
        }
      }, this.timeout);
      void lease.result.then(finish, () => finish({ kind: "failed", reason: "process_failed" }));
      void lease.exited.then(
        () => {
          if (!settled) finish({ kind: "failed", reason: "process_failed" });
          if (this.active === active) this.active = null;
        },
        () => {
          if (!settled) finish({ kind: "failed", reason: "process_failed" });
          else if (this.error === null) failure("process_failed");
          // A completed metadata result does not prove process exit. Unknown exit keeps ownership;
          // preserve an earlier timeout/error instead of replacing it with a late observation.
        },
      );
    } catch {
      // A source may have created a process before throwing. Unknown ownership cannot authorize retry.
      finish({ kind: "failed", reason: "process_failed" });
    }
    return promise;
  }
  /** Explicit opt-in by the active host. This schedules metadata checks, never model requests. */
  startRefreshLoop(): void {
    if (this.loop) return;
    void this.refreshIfDue();
    this.loop = setInterval(() => {
      void this.refreshIfDue();
    }, this.interval);
    this.loop.unref();
  }
  stopRefreshLoop(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }
}
