/** Concrete opt-in metadata lifecycle. Never a task executor or authenticated-account registry. */
import { isDeepStrictEqual } from "node:util";
import type {
  CatalogReason,
  ProviderCatalogScope,
  ProviderCatalogView,
} from "../contracts/provider-catalog.js";
import {
  ANTIGRAVITY_VERSION,
  type AntigravityCliCapabilities,
  validateAntigravityCapabilities,
} from "./antigravity.js";
import { AntigravityCatalogSource } from "./antigravity-catalog.js";
import {
  type AntigravityMetadataConfiguration,
  type AntigravityMetadataStore,
  metadataConfigurationHash,
  openAntigravityMetadataStore,
  validateMetadataConfiguration,
} from "./antigravity-metadata-store.js";
import {
  type AntigravityMetadataOperation,
  AntigravityMetadataProbe,
  type AntigravityProbeResult,
  inspectInstalledAntigravity,
  type MetadataProbeLease,
} from "./antigravity-probe.js";
import { type CatalogCacheCheckpoint, ProviderCatalogCache } from "./provider-catalog-cache.js";

const DAY = 86400000;
const ERRORS = new Set<CatalogReason>([
  "auth_required",
  "timeout",
  "output_limit",
  "process_failed",
  "malformed_output",
  "version_unsupported",
  "binary_untrusted",
  "unavailable",
  "format_unverified",
  "clock_rollback",
]);
interface HostRecord {
  schema: "bridge-antigravity-metadata-state-1";
  configHash: string;
  scope: ProviderCatalogScope;
  capabilities: { observedAt: string; value: AntigravityCliCapabilities } | null;
  cache: CatalogCacheCheckpoint | null;
  attemptedAt: number | null;
  nextAt: number | null;
  lastClock: number;
  error: CatalogReason | null;
  authLatched: boolean;
}
export interface AntigravityMetadataHostView {
  version: "bridge-antigravity-metadata-host-1";
  configured: boolean;
  context: "private_empty_home";
  accountAvailability: "unknown";
  reason: string | null;
  backgroundRefresh: boolean;
  refreshing: boolean;
  refreshAllowed: boolean;
  lastAttemptAt: string | null;
  nextAllowedAt: string | null;
  inspection: { version: string; observedAt: string; helpSha256: string } | null;
  catalog: ProviderCatalogView | null;
}
export interface AntigravityMetadataHostPort {
  start(): void;
  view(): AntigravityMetadataHostView;
  refresh(): Promise<AntigravityMetadataHostView>;
  beginShutdown(): void;
  close(): Promise<void>;
}
export function unavailableMetadataView(reason = "unconfigured"): AntigravityMetadataHostView {
  return {
    version: "bridge-antigravity-metadata-host-1",
    configured: false,
    context: "private_empty_home",
    accountAvailability: "unknown",
    reason,
    backgroundRefresh: false,
    refreshing: false,
    refreshAllowed: false,
    lastAttemptAt: null,
    nextAllowedAt: null,
    inspection: null,
    catalog: null,
  };
}
function recordValid(
  record: HostRecord,
  scope: ProviderCatalogScope,
  hash: string,
  now: number,
): void {
  const stamp = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  if (
    !record ||
    Object.keys(record).sort().join() !==
      "attemptedAt,authLatched,cache,capabilities,configHash,error,lastClock,nextAt,schema,scope" ||
    record.schema !== "bridge-antigravity-metadata-state-1" ||
    record.configHash !== hash ||
    !isDeepStrictEqual(record.scope, scope) ||
    !stamp(record.lastClock) ||
    record.lastClock > now ||
    typeof record.authLatched !== "boolean" ||
    (record.error !== null && !ERRORS.has(record.error)) ||
    (record.authLatched && record.error === null) ||
    (record.error === "auth_required" && !record.authLatched) ||
    (record.cache?.error === "auth_required" && !record.authLatched) ||
    (record.attemptedAt === null) !== (record.nextAt === null) ||
    (record.error !== null && record.attemptedAt === null) ||
    (record.attemptedAt !== null &&
      (!stamp(record.attemptedAt) || record.attemptedAt > record.lastClock)) ||
    (record.nextAt !== null && (!stamp(record.nextAt) || record.nextAt > record.lastClock + DAY)) ||
    (record.attemptedAt !== null && (record.nextAt === null || record.nextAt < record.attemptedAt))
  )
    throw new Error("metadata_storage_invalid");
  if (record.capabilities !== null) {
    const c = record.capabilities;
    if (
      Object.keys(c).sort().join() !== "observedAt,value" ||
      typeof c.observedAt !== "string" ||
      !Number.isFinite(Date.parse(c.observedAt)) ||
      new Date(c.observedAt).toISOString() !== c.observedAt ||
      Date.parse(c.observedAt) > record.lastClock
    )
      throw new Error("metadata_storage_invalid");
    if (typeof c.value?.helpSha256 !== "string") throw new Error("metadata_storage_invalid");
    validateAntigravityCapabilities(c.value, ANTIGRAVITY_VERSION);
    if (
      Object.keys(c.value).sort().join() !==
        "efforts,flags,helpSha256,inputFormats,outputFormats,protocol,version" ||
      [c.value.flags, c.value.inputFormats, c.value.outputFormats, c.value.efforts].some(
        (rows) =>
          rows.length > 128 || rows.some((v) => typeof v !== "string" || !/^[a-z-]{1,80}$/.test(v)),
      )
    )
      throw new Error("metadata_storage_invalid");
  } else if (record.cache !== null) throw new Error("metadata_storage_invalid");
}
export class AntigravityMetadataHost implements AntigravityMetadataHostPort {
  private readonly config: AntigravityMetadataConfiguration;
  private readonly record: HostRecord;
  private cache: ProviderCatalogCache | null = null;
  private readonly leases = new Set<MetadataProbeLease<AntigravityProbeResult>>();
  private readonly drain = new Set<Promise<void>>();
  private blocked: string | null = null;
  private started = false;
  private stopping = false;
  private closed = false;
  private loop: ReturnType<typeof setInterval> | null = null;
  private job: Promise<AntigravityMetadataHostView> | null = null;
  private closing: Promise<void> | null = null;
  private readonly tracked: Pick<AntigravityMetadataProbe, "start">;
  constructor(
    config: AntigravityMetadataConfiguration,
    private readonly store: AntigravityMetadataStore,
    private readonly probe: Pick<AntigravityMetadataProbe, "start">,
    private readonly now: () => Date = () => new Date(),
    private readonly drainTimeoutMs = 5000,
  ) {
    validateMetadataConfiguration(config);
    this.config = structuredClone(config);
    if (
      !config.enabled ||
      !Number.isSafeInteger(drainTimeoutMs) ||
      drainTimeoutMs < 1 ||
      drainTimeoutMs > 5000
    )
      throw new Error("metadata_configuration_invalid");
    const hash = metadataConfigurationHash(config);
    const scope: ProviderCatalogScope = {
      providerId: "antigravity",
      routeId: "antigravity_cli",
      contextId: config.contextId,
      revision: {
        kind: "cli_binary",
        id: config.installation.expectedSha256,
        version: ANTIGRAVITY_VERSION,
      },
    };
    this.record =
      store.initial === null
        ? {
            schema: "bridge-antigravity-metadata-state-1",
            configHash: hash,
            scope,
            capabilities: null,
            cache: null,
            attemptedAt: null,
            nextAt: null,
            lastClock: now().getTime(),
            error: null,
            authLatched: false,
          }
        : (structuredClone(store.initial) as HostRecord);
    recordValid(this.record, scope, hash, now().getTime());
    this.tracked = { start: (operation) => this.startProbe(operation) };
    if (this.record.capabilities) this.constructCache();
    this.persist();
  }
  private persist(): void {
    if (this.blocked === "storage_unavailable") throw new Error("metadata_storage_unavailable");
    try {
      this.store.save(this.record);
    } catch {
      this.blocked = "storage_unavailable";
      this.cache?.beginShutdown();
      this.cancel();
      throw new Error("metadata_storage_unavailable");
    }
  }
  private clock(): number {
    const at = this.now().getTime();
    if (!Number.isSafeInteger(at) || at < this.record.lastClock) {
      this.blocked = "clock_rollback";
      throw new Error("metadata_clock_rollback");
    }
    this.record.lastClock = at;
    return at;
  }
  private constructCache(): void {
    const capabilities = this.record.capabilities?.value;
    if (!capabilities) throw new Error("metadata_capabilities_missing");
    this.cache = new ProviderCatalogCache({
      scope: this.record.scope,
      source: new AntigravityCatalogSource(this.tracked, {
        contextId: this.config.contextId,
        binarySha256: this.config.installation.expectedSha256,
        capabilities,
      }),
      now: this.now,
      ttlMs: DAY,
      minRefreshIntervalMs: DAY,
      ...(this.record.cache ? { initialCheckpoint: this.record.cache } : {}),
      persist: (checkpoint) => {
        this.record.cache = checkpoint;
        this.record.lastClock = Math.max(this.record.lastClock, checkpoint.lastClock);
        this.record.error = checkpoint.error;
        if (checkpoint.error === "auth_required") this.record.authLatched = true;
        this.persist();
      },
    });
  }
  private startProbe(
    operation: AntigravityMetadataOperation,
  ): MetadataProbeLease<AntigravityProbeResult> {
    if (this.stopping || this.blocked || this.record.authLatched || this.leases.size)
      throw new Error("metadata_start_blocked");
    // The whole cycle's durable attempt/cooldown and owner marker exist before every stage.
    this.persist();
    let lease: MetadataProbeLease<AntigravityProbeResult>;
    try {
      lease = this.probe.start(operation);
    } catch {
      this.blocked = "ownership_unknown";
      throw new Error("metadata_start_ownership_unknown");
    }
    this.leases.add(lease);
    const exited = lease.exited.then(
      () => {
        this.leases.delete(lease);
        this.persist();
      },
      () => {
        this.blocked = "ownership_unknown";
        throw new Error("metadata_exit_unknown");
      },
    );
    this.drain.add(exited);
    void exited.then(
      () => this.drain.delete(exited),
      () => {},
    );
    const result = lease.result.then((value) => {
      // A late auth failure still suppresses future prompts, without replacing an earlier timeout.
      if (value.kind === "failed" && value.reason === "auth_required") {
        this.record.authLatched = true;
        this.record.error ??= "auth_required";
        this.persist();
      }
      return value;
    });
    return { result, exited, cancel: () => lease.cancel() };
  }
  view(): AntigravityMetadataHostView {
    const catalog = this.cache?.view() ?? null;
    const reason =
      this.blocked ??
      (this.stopping
        ? "shutting_down"
        : this.record.authLatched
          ? "auth_required"
          : this.record.error);
    const next = Math.max(
      this.record.nextAt ?? 0,
      catalog?.refresh.nextAllowedAt ? Date.parse(catalog.refresh.nextAllowedAt) : 0,
    );
    return {
      version: "bridge-antigravity-metadata-host-1",
      configured: true,
      context: "private_empty_home",
      accountAvailability: "unknown",
      reason,
      backgroundRefresh: this.config.backgroundRefresh,
      refreshing: this.job !== null || this.leases.size > 0,
      refreshAllowed:
        this.started &&
        !this.stopping &&
        !this.blocked &&
        !this.record.authLatched &&
        this.leases.size === 0 &&
        this.job === null &&
        !catalog?.refresh.ownershipHeld &&
        this.now().getTime() >= next,
      lastAttemptAt:
        this.record.attemptedAt === null ? null : new Date(this.record.attemptedAt).toISOString(),
      nextAllowedAt: next ? new Date(next).toISOString() : null,
      inspection: this.record.capabilities
        ? {
            version: this.record.capabilities.value.version,
            observedAt: this.record.capabilities.observedAt,
            helpSha256: this.record.capabilities.value.helpSha256,
          }
        : null,
      catalog,
    };
  }
  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    void this.refresh(false);
    if (this.config.backgroundRefresh) {
      this.loop = setInterval(() => {
        void this.refresh(false);
      }, DAY);
      this.loop.unref();
    }
  }
  refresh(explicit = true): Promise<AntigravityMetadataHostView> {
    if (this.stopping) return Promise.resolve(this.view());
    if (this.job) return this.job;
    if (
      !this.started ||
      this.stopping ||
      this.blocked ||
      this.record.authLatched ||
      this.leases.size
    )
      return Promise.resolve(this.view());
    let at: number;
    try {
      at = this.clock();
    } catch {
      return Promise.resolve(this.view());
    }
    const view = this.cache?.view();
    if (
      (this.record.nextAt !== null && at < this.record.nextAt) ||
      (view?.refresh.nextAllowedAt && at < Date.parse(view.refresh.nextAllowedAt)) ||
      (!explicit && view?.catalog && !view.stale)
    )
      return Promise.resolve(this.view());
    this.record.attemptedAt = at;
    this.record.nextAt = at + DAY;
    try {
      this.persist();
    } catch {
      return Promise.resolve(this.view());
    }
    // Defer execution so every concurrent caller observes the same admitted cycle.
    this.job = Promise.resolve()
      .then(async () => {
        try {
          if (!this.record.capabilities) {
            const observation = await inspectInstalledAntigravity(this.tracked);
            if (this.stopping) return this.view();
            this.record.capabilities = {
              observedAt: new Date(this.clock()).toISOString(),
              value: observation.capabilities,
            };
            this.record.error = null;
            this.persist();
            this.constructCache();
          }
          if (!this.stopping && !this.blocked) await this.cache?.refreshIfDue(explicit);
        } catch (error) {
          if (!this.blocked) {
            const code = error instanceof Error ? error.message : "";
            const name = code.replace(/^antigravity_(?:probe_)?/, "") as CatalogReason;
            this.record.error = ERRORS.has(name) ? name : "process_failed";
            if (this.record.error === "auth_required") this.record.authLatched = true;
            try {
              this.persist();
            } catch {
              /* Store remains blocked. */
            }
          }
        }
        return this.view();
      })
      .finally(() => {
        this.job = null;
      });
    return this.job;
  }
  private cancel(): void {
    for (const lease of this.leases) {
      try {
        lease.cancel();
      } catch {
        /* Retain unknown ownership. */
      }
    }
  }
  beginShutdown(): void {
    this.stopping = true;
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.cache?.beginShutdown();
    this.cancel();
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    this.beginShutdown();
    this.closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([this.job, ...this.drain, this.cache?.waitForIdle()]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("metadata_shutdown_pending")),
              this.drainTimeoutMs,
            );
          }),
        ]);
        if (
          this.leases.size ||
          this.cache?.view().refresh.ownershipHeld ||
          this.blocked === "ownership_unknown"
        )
          throw new Error("metadata_shutdown_pending");
        this.persist();
        this.store.release();
        this.closed = true;
      } catch {
        throw new Error("metadata_shutdown_pending");
      } finally {
        if (timer) clearTimeout(timer);
      }
    })().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }
}
export async function openAntigravityMetadataHost(
  config: AntigravityMetadataConfiguration,
  stateDir: string,
): Promise<AntigravityMetadataHostPort> {
  validateMetadataConfiguration(config);
  if (!config.enabled) throw new Error("metadata_disabled");
  const store = await openAntigravityMetadataStore(stateDir, metadataConfigurationHash(config));
  try {
    return new AntigravityMetadataHost(
      config,
      store,
      new AntigravityMetadataProbe(config.installation),
    );
  } catch (error) {
    store.abandon();
    throw error;
  }
}
