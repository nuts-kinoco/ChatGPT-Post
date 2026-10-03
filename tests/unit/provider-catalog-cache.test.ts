/** Normalized provider rows here are synthetic fixtures, never a claim about live model availability. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CatalogRefreshResult,
  ProviderCatalogCache,
} from "../../src/adapters/provider-catalog-cache.js";
import type {
  ProviderCatalogScope,
  ProviderCatalogSnapshot,
} from "../../src/contracts/provider-catalog.js";

const at = Date.parse("2026-10-03T00:00:00.000Z");
const scope: ProviderCatalogScope = {
  providerId: "antigravity",
  routeId: "antigravity_cli",
  contextId: "isolated-fixture",
  revision: { kind: "cli_binary", id: "a".repeat(64), version: "1.2.15" },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function source() {
  const leases: {
    result: ReturnType<typeof deferred<CatalogRefreshResult>>;
    exited: ReturnType<typeof deferred<void>>;
    cancel: ReturnType<typeof vi.fn>;
  }[] = [];
  const start = vi.fn(() => {
    const lease = {
      result: deferred<CatalogRefreshResult>(),
      exited: deferred<void>(),
      cancel: vi.fn(),
    };
    leases.push(lease);
    return { result: lease.result.promise, exited: lease.exited.promise, cancel: lease.cancel };
  });
  return { start, leases };
}
function snapshot(now = at): ProviderCatalogSnapshot {
  return {
    schema: "bridge-provider-catalog-1",
    scope: structuredClone(scope),
    observedAt: new Date(now).toISOString(),
    source: {
      kind: "cli_metadata",
      operation: "fixture-model-list",
      formatId: "synthetic-normalized/1",
      contentSha256: null,
    },
    complete: true,
    reason: "none",
    options: ["Gemini example", "Claude example"].map((label, i) => ({
      observationKey: `row-${i}`,
      label,
      providerModelId: null,
      identitySource: "unverified_label",
      checked: null,
      enabled: null,
      ambiguity: "none",
      effort: { scope: "unknown", values: [], source: null },
    })),
    effortSyntax: { scope: "cli_global", values: ["low", "high"], source: "fixture-help" },
    accountAvailability: "unknown",
    cost: "unknown",
    executionAuthorized: false,
  };
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}
afterEach(() => vi.useRealTimers());
describe("read-only provider catalog cache", () => {
  it("coalesces first-startup refresh, retains nullable IDs and never turns syntax into per-model effort", async () => {
    const s = source();
    const cache = new ProviderCatalogCache({ scope, source: s, now: () => new Date(at) });
    const first = cache.refreshIfDue();
    const second = cache.refreshIfDue();
    expect(s.start).toHaveBeenCalledTimes(1);
    s.leases[0]?.result.resolve({ kind: "snapshot", snapshot: snapshot() });
    s.leases[0]?.exited.resolve();
    await first;
    await second;
    const view = cache.view();
    expect(view.state).toBe("fresh");
    expect(view.scope.providerId).toBe("antigravity");
    expect(view.catalog?.options.map((o) => o.label)).toEqual(["Gemini example", "Claude example"]);
    expect(
      view.catalog?.options.every(
        (o) => o.providerModelId === null && o.effort.scope === "unknown",
      ),
    ).toBe(true);
    expect(view.catalog?.executionAuthorized).toBe(false);
    await cache.refreshIfDue();
    expect(s.start).toHaveBeenCalledTimes(1);
    if (view.catalog) view.catalog.options.length = 0;
    expect(cache.view().catalog?.options).toHaveLength(2);
  });
  it("preserves complete-but-ambiguous browser observations with exact multiline labels", async () => {
    const browserScope: ProviderCatalogScope = {
      providerId: "chatgpt",
      routeId: "ordinary_chat_browser",
      contextId: "fixture-browser",
      revision: { kind: "dom_profile", id: "fixture-profile", version: "1" },
    };
    const s = source();
    const cache = new ProviderCatalogCache({
      scope: browserScope,
      source: s,
      now: () => new Date(at),
    });
    const p = cache.refreshIfDue();
    const browser: ProviderCatalogSnapshot = {
      ...snapshot(),
      scope: browserScope,
      source: {
        kind: "browser_dom",
        operation: "inspect-ui",
        formatId: "fixture-dom/1",
        contentSha256: null,
      },
      complete: true,
      reason: "ambiguous",
      options: snapshot().options.map((row, i) => ({
        ...row,
        observationKey: `browser-${i}`,
        label: "GPT-5.5\nRetirement notice",
        ambiguity: "duplicate_label",
      })),
      effortSyntax: { scope: "unknown", values: [], source: null },
    };
    s.leases[0]?.result.resolve({ kind: "snapshot", snapshot: browser });
    s.leases[0]?.exited.resolve();
    await p;
    expect(cache.view()).toMatchObject({
      state: "fresh",
      stale: false,
      catalog: { complete: true, reason: "ambiguous", executionAuthorized: false },
    });
    expect(cache.view().catalog?.options[0]?.label).toBe("GPT-5.5\nRetirement notice");
    expect(cache.view().catalog?.options[0]?.providerModelId).toBeNull();
  });
  it("returns timeout promptly but holds process ownership through late success and cancellation", async () => {
    vi.useFakeTimers();
    let now = at;
    const s = source();
    const cache = new ProviderCatalogCache({
      scope,
      source: s,
      now: () => new Date(now),
      refreshTimeoutMs: 10,
    });
    const first = cache.refreshIfDue();
    await vi.advanceTimersByTimeAsync(10);
    expect((await first).refresh.error).toBe("timeout");
    expect(s.leases[0]?.cancel).toHaveBeenCalledTimes(1);
    now += 2 * 86400000;
    await cache.refreshIfDue(true);
    expect(s.start).toHaveBeenCalledTimes(1);
    expect(cache.view().refresh.ownershipHeld).toBe(true);
    s.leases[0]?.result.resolve({ kind: "snapshot", snapshot: snapshot(now) });
    await settle();
    expect(cache.view().catalog).toBeNull();
    s.leases[0]?.exited.resolve();
    await settle();
    expect(cache.view().refresh.ownershipHeld).toBe(false);
    const next = cache.refreshIfDue();
    expect(s.start).toHaveBeenCalledTimes(2);
    s.leases[1]?.result.resolve({ kind: "failed", reason: "auth_required" });
    s.leases[1]?.exited.resolve();
    await next;
  });
  it("retains last-good data as stale after auth failure with bounded backoff", async () => {
    let now = at;
    const s = source();
    const cache = new ProviderCatalogCache({
      scope,
      source: s,
      now: () => new Date(now),
      initialSnapshot: snapshot(),
    });
    now += 86400001;
    const refresh = cache.refreshIfDue();
    s.leases[0]?.result.resolve({ kind: "failed", reason: "auth_required" });
    s.leases[0]?.exited.resolve();
    await refresh;
    expect(cache.view()).toMatchObject({
      state: "stale",
      stale: true,
      fetchedAt: new Date(at).toISOString(),
      refresh: { error: "auth_required" },
    });
    expect(cache.view().catalog?.options).toHaveLength(2);
    await cache.refreshIfDue(true);
    expect(s.start).toHaveBeenCalledTimes(1);
  });
  it("keeps unverified list format unknown while showing separately observed CLI effort syntax", async () => {
    const s = source();
    const cache = new ProviderCatalogCache({ scope, source: s, now: () => new Date(at) });
    const p = cache.refreshIfDue();
    s.leases[0]?.result.resolve({
      kind: "snapshot",
      snapshot: { ...snapshot(), complete: false, reason: "format_unverified", options: [] },
    });
    s.leases[0]?.exited.resolve();
    await p;
    expect(cache.view()).toMatchObject({
      state: "unknown",
      stale: true,
      refresh: { error: "format_unverified" },
    });
    expect(cache.view().catalog?.effortSyntax.scope).toBe("cli_global");
  });
  it.each(["providerId", "routeId", "contextId"] as const)("rejects another %s scope", (key) => {
    const wrong = snapshot();
    wrong.scope[key] = "other";
    expect(
      () =>
        new ProviderCatalogCache({
          scope,
          source: source(),
          now: () => new Date(at),
          initialSnapshot: wrong,
        }),
    ).toThrow("snapshot_invalid");
  });
  it("does not reuse another binary/profile revision", () => {
    const wrong = snapshot();
    wrong.scope.revision.id = "b".repeat(64);
    expect(
      () =>
        new ProviderCatalogCache({
          scope,
          source: source(),
          now: () => new Date(at),
          initialSnapshot: wrong,
        }),
    ).toThrow("snapshot_invalid");
  });
  it("clock rollback remains stale and cannot trigger a premature metadata refresh", async () => {
    let now = at;
    const s = source();
    const cache = new ProviderCatalogCache({
      scope,
      source: s,
      now: () => new Date(now),
      initialSnapshot: snapshot(),
    });
    now--;
    expect(cache.view().refresh.error).toBe("clock_rollback");
    await cache.refreshIfDue(true);
    expect(s.start).not.toHaveBeenCalled();
  });
  it.each([
    { executionAuthorized: true },
    { options: [{ ...snapshot().options[0], label: "bad\0label" }] },
    { options: [{ ...snapshot().options[0], label: "\ud800" }] },
    { cost: "free" },
    { accountAvailability: "available" },
    { observedAt: new Date(at + 1).toISOString() },
    { complete: true, reason: "auth_required" },
    { options: [{ ...snapshot().options[0], providerModelId: "guessed-from-label" }] },
    { effortSyntax: { scope: "unknown", values: ["high"], source: null } },
  ])("rejects invented capabilities or malformed metadata %#", async (change) => {
    const s = source();
    const cache = new ProviderCatalogCache({ scope, source: s, now: () => new Date(at) });
    const p = cache.refreshIfDue();
    s.leases[0]?.result.resolve({
      kind: "snapshot",
      snapshot: { ...snapshot(), ...change } as ProviderCatalogSnapshot,
    });
    s.leases[0]?.exited.resolve();
    await p;
    expect(cache.view().catalog).toBeNull();
    expect(cache.view().refresh.error).toBe("malformed_output");
  });
  it("marks an accepted snapshot stale if process exit later becomes unknown, without replacement", async () => {
    const s = source();
    const cache = new ProviderCatalogCache({ scope, source: s, now: () => new Date(at) });
    const p = cache.refreshIfDue();
    s.leases[0]?.result.resolve({ kind: "snapshot", snapshot: snapshot() });
    await p;
    expect(cache.view().state).toBe("fresh");
    s.leases[0]?.exited.reject(new Error("lost exit evidence"));
    await settle();
    expect(cache.view()).toMatchObject({
      state: "stale",
      stale: true,
      refresh: { error: "process_failed", ownershipHeld: true },
    });
    expect(cache.view().catalog?.options).toHaveLength(2);
    await cache.refreshIfDue(true);
    expect(s.start).toHaveBeenCalledTimes(1);
  });
  it("does not replace a prior timeout when exit also rejects", async () => {
    vi.useFakeTimers();
    const s = source();
    const cache = new ProviderCatalogCache({
      scope,
      source: s,
      now: () => new Date(at),
      refreshTimeoutMs: 1,
    });
    const p = cache.refreshIfDue();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    s.leases[0]?.exited.reject(new Error("unknown"));
    await settle();
    expect(cache.view().refresh).toMatchObject({ error: "timeout", ownershipHeld: true });
  });
  it("retains ownership after rejected exit observation", async () => {
    const s = source();
    const cache = new ProviderCatalogCache({ scope, source: s, now: () => new Date(at) });
    const p = cache.refreshIfDue();
    s.leases[0]?.exited.reject(new Error("unknown exit"));
    await p;
    expect(cache.view().refresh.ownershipHeld).toBe(true);
    await cache.refreshIfDue(true);
    expect(s.start).toHaveBeenCalledTimes(1);
  });
  it("does not bypass minimum metadata cadence when hydrating a recent snapshot", async () => {
    const s = source();
    const cache = new ProviderCatalogCache({
      scope,
      source: s,
      now: () => new Date(at),
      initialSnapshot: snapshot(),
    });
    await cache.refreshIfDue(true);
    expect(s.start).not.toHaveBeenCalled();
  });
  it("retains unknown ownership when source startup throws instead of assuming no process exists", async () => {
    const start = vi.fn(() => {
      throw new Error("lost handle after possible spawn");
    });
    const cache = new ProviderCatalogCache({ scope, source: { start }, now: () => new Date(at) });
    expect((await cache.refreshIfDue()).refresh.error).toBe("process_failed");
    await cache.refreshIfDue(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(cache.view().refresh.ownershipHeld).toBe(true);
  });
  it("does not activate refresh merely by construction or view reads", () => {
    const s = source();
    const cache = new ProviderCatalogCache({ scope, source: s });
    cache.view();
    expect(s.start).not.toHaveBeenCalled();
  });
  it("requires explicit active-host loop and never refreshes every UI read or job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const s = source();
    const cache = new ProviderCatalogCache({ scope, source: s });
    cache.startRefreshLoop();
    cache.startRefreshLoop();
    expect(s.start).toHaveBeenCalledTimes(1);
    s.leases[0]?.result.resolve({ kind: "snapshot", snapshot: snapshot() });
    s.leases[0]?.exited.resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(s.start).toHaveBeenCalledTimes(1);
    cache.stopRefreshLoop();
    await vi.advanceTimersByTimeAsync(2 * 86400000);
    expect(s.start).toHaveBeenCalledTimes(1);
  });
});
