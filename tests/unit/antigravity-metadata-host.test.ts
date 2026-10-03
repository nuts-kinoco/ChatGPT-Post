/** All provider operations are synthetic leases; SQLite and lifecycle are real. */
import { readFileSync } from "node:fs";
import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityMetadataHost } from "../../src/adapters/antigravity-metadata-host.js";
import {
  type AntigravityMetadataConfiguration,
  type AntigravityMetadataStore,
  metadataConfigurationHash,
  openAntigravityMetadataStore,
  readMetadataConfiguration,
  validateMetadataConfiguration,
} from "../../src/adapters/antigravity-metadata-store.js";
import type {
  AntigravityMetadataOperation,
  AntigravityProbeResult,
  MetadataProbeLease,
} from "../../src/adapters/antigravity-probe.js";
import { sha256Bytes } from "../../src/contracts/task.js";

const help = readFileSync(
  new URL("../fixtures/antigravity/help-1.2.15.txt", import.meta.url),
  "utf8",
);
const config: AntigravityMetadataConfiguration = {
  version: "bridge-antigravity-metadata-config-1",
  enabled: true,
  backgroundRefresh: false,
  contextId: "isolated-fixture",
  installation: {
    executable: "/fixture/agy",
    expectedSha256: "a".repeat(64),
    ownerUid: process.getuid?.() ?? 0,
  },
};
const at = Date.parse("2026-10-03T00:00:00.000Z"),
  DAY = 86400000;
const dirs: string[] = [],
  stores: AntigravityMetadataStore[] = [],
  hosts: AntigravityMetadataHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) {
    try {
      await h.close();
    } catch {}
  }
  for (const s of stores.splice(0)) s.abandon();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  vi.useRealTimers();
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "agy-host-"));
  dirs.push(dir);
  return dir;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function completed(operation: AntigravityMetadataOperation, time = at): AntigravityProbeResult {
  return {
    kind: "completed",
    operation,
    stdout:
      operation === "version"
        ? "1.2.15\n"
        : operation === "help"
          ? help
          : "unverified fixture rows",
    stderr: "",
    observedAt: new Date(time).toISOString(),
    binarySha256: config.installation.expectedSha256,
  };
}
function probe(result?: (op: AntigravityMetadataOperation) => AntigravityProbeResult) {
  return {
    start: vi.fn(
      (op: AntigravityMetadataOperation): MetadataProbeLease<AntigravityProbeResult> => ({
        result: Promise.resolve(result?.(op) ?? completed(op)),
        exited: Promise.resolve(),
        cancel: vi.fn(),
      }),
    ),
  };
}
async function setup(dir: string, p = probe(), now = () => new Date(at), c = config) {
  const store = await openAntigravityMetadataStore(dir, metadataConfigurationHash(c));
  stores.push(store);
  const host = new AntigravityMetadataHost(c, store, p, now, 10);
  hosts.push(host);
  return { host, store, p };
}
async function run(host: AntigravityMetadataHost) {
  host.start();
  await host.refresh();
  await Promise.resolve();
}
describe("concrete isolated metadata host", () => {
  it("runs one admitted version/help/models cycle, persists capabilities, and warm restart does no probe", async () => {
    const dir = await directory(),
      x = await setup(dir);
    await run(x.host);
    expect(x.p.start.mock.calls.map((c) => c[0])).toEqual(["version", "help", "models"]);
    expect(x.host.view()).toMatchObject({
      context: "private_empty_home",
      accountAvailability: "unknown",
      reason: "format_unverified",
      catalog: { state: "unknown", catalog: { options: [], executionAuthorized: false } },
    });
    await x.host.close();
    const y = await setup(dir);
    await run(y.host);
    expect(y.p.start).not.toHaveBeenCalled();
    expect(y.host.view().inspection?.version).toBe("1.2.15");
  });
  it("expires once, reuses capabilities, coalesces refreshes and runs only models", async () => {
    let time = at;
    const x = await setup(
      await directory(),
      probe((op) => completed(op, time)),
      () => new Date(time),
    );
    await run(x.host);
    time += DAY;
    await Promise.all([x.host.refresh(), x.host.refresh(), x.host.refresh()]);
    expect(x.p.start.mock.calls.map((c) => c[0])).toEqual(["version", "help", "models", "models"]);
  });
  it.each(["version", "help", "models"] as const)(
    "latches %s auth across restart without inferring ordinary account sign-in",
    async (stage) => {
      const dir = await directory(),
        x = await setup(
          dir,
          probe((op) =>
            op === stage
              ? { kind: "failed", operation: op, reason: "auth_required" }
              : completed(op),
          ),
        );
      await run(x.host);
      expect(x.host.view()).toMatchObject({
        reason: "auth_required",
        refreshAllowed: false,
        accountAvailability: "unknown",
      });
      await x.host.close();
      const y = await setup(dir, probe(), () => new Date(at + 2 * DAY));
      await run(y.host);
      await y.host.refresh();
      expect(y.p.start).not.toHaveBeenCalled();
    },
  );
  it("persists inspection failure cooldown across restart", async () => {
    const dir = await directory(),
      x = await setup(
        dir,
        probe((op) => ({ kind: "failed", operation: op, reason: "process_failed" })),
      );
    await run(x.host);
    await x.host.close();
    const y = await setup(dir);
    await run(y.host);
    expect(y.p.start).not.toHaveBeenCalled();
    expect(y.host.view().reason).toBe("process_failed");
  });
  it("fences pre-start persistence failure and retains its owner marker", async () => {
    const dir = await directory(),
      x = await setup(dir);
    vi.spyOn(x.store, "save").mockImplementation(() => {
      throw new Error("disk failed");
    });
    await run(x.host);
    expect(x.p.start).not.toHaveBeenCalled();
    expect(x.host.view().reason).toBe("storage_unavailable");
    await expect(x.host.close()).rejects.toThrow("shutdown_pending");
    x.store.abandon();
    await expect(
      openAntigravityMetadataStore(dir, metadataConfigurationHash(config)),
    ).rejects.toThrow("ownership_unknown");
  });
  it("fences a later stage when persistence fails after version", async () => {
    const dir = await directory(),
      p = probe(),
      x = await setup(dir, p);
    const save = x.store.save.bind(x.store);
    let writes = 0;
    vi.spyOn(x.store, "save").mockImplementation((record) => {
      if (++writes >= 3) throw new Error("disk");
      save(record);
    });
    await run(x.host);
    expect(p.start.mock.calls.map((c) => c[0])).toEqual(["version"]);
    expect(x.host.view().reason).toBe("storage_unavailable");
  });
  it.each(["version", "help", "models"] as const)(
    "shutdown owns an unfinished %s lease and retries drain without relaunch",
    async (stage) => {
      const result = deferred<AntigravityProbeResult>(),
        exited = deferred<void>(),
        cancel = vi.fn();
      const p = probe();
      p.start.mockImplementation((op) =>
        op === stage
          ? { result: result.promise, exited: exited.promise, cancel }
          : { result: Promise.resolve(completed(op)), exited: Promise.resolve(), cancel: vi.fn() },
      );
      const x = await setup(await directory(), p);
      x.host.start();
      await vi.waitFor(() => expect(p.start.mock.calls.some((c) => c[0] === stage)).toBe(true));
      const before = p.start.mock.calls.length;
      await expect(x.host.close()).rejects.toThrow("shutdown_pending");
      expect(cancel).toHaveBeenCalled();
      await x.host.refresh();
      expect(p.start).toHaveBeenCalledTimes(before);
      result.resolve({ kind: "failed", operation: stage, reason: "cancelled" });
      exited.resolve();
      await x.host.close();
      expect(p.start).toHaveBeenCalledTimes(before);
    },
  );
  it("does not overlap after timeout and discards late successful rows", async () => {
    const result = deferred<AntigravityProbeResult>(),
      exited = deferred<void>();
    const p = probe((op) => completed(op));
    p.start.mockImplementation((op) =>
      op === "models"
        ? { result: result.promise, exited: exited.promise, cancel: vi.fn() }
        : { result: Promise.resolve(completed(op)), exited: Promise.resolve(), cancel: vi.fn() },
    );
    let time = at;
    const x = await setup(await directory(), p, () => new Date(time));
    x.host.start();
    await vi.waitFor(() => expect(p.start).toHaveBeenCalledTimes(3));
    result.resolve({ kind: "failed", operation: "models", reason: "timeout" });
    await x.host.refresh();
    time += 2 * DAY;
    await x.host.refresh();
    expect(p.start).toHaveBeenCalledTimes(3);
    expect(x.host.view().reason).toBe("timeout");
    exited.resolve();
    await x.host.close();
  });
  it("blocks concurrent ownership, crash restart and changed config at the fixed store", async () => {
    const dir = await directory(),
      x = await setup(dir);
    await expect(
      openAntigravityMetadataStore(dir, metadataConfigurationHash(config)),
    ).rejects.toThrow("ownership_unknown");
    await expect(
      openAntigravityMetadataStore(
        dir,
        metadataConfigurationHash({ ...config, contextId: "other" }),
      ),
    ).rejects.toThrow("context_changed");
    x.store.abandon();
    await expect(
      openAntigravityMetadataStore(dir, metadataConfigurationHash(config)),
    ).rejects.toThrow("ownership_unknown");
  });
  it("rejects corrupted, future and wrong-scope state without clearing ownership or reprobe", async () => {
    for (const change of [
      (r: Record<string, unknown>) => {
        r.lastClock = at + DAY;
      },
      (r: Record<string, unknown>) => {
        r.scope = {};
      },
      (r: Record<string, unknown>) => {
        r.cache = {};
      },
    ]) {
      const dir = await directory(),
        x = await setup(dir);
      await run(x.host);
      await x.host.close();
      const db = new DatabaseSync(join(dir, "antigravity-metadata/production/catalog.db"));
      const row = db.prepare("SELECT body FROM metadata_host").get() as { body: string };
      const r = JSON.parse(row.body);
      change(r);
      const body = JSON.stringify(r);
      db.prepare("UPDATE metadata_host SET body=?,digest=?").run(
        body,
        sha256Bytes(Buffer.from(body)),
      );
      db.close();
      const store = await openAntigravityMetadataStore(dir, metadataConfigurationHash(config));
      stores.push(store);
      const p = probe();
      expect(() => new AntigravityMetadataHost(config, store, p, () => new Date(at), 10)).toThrow();
      expect(p.start).not.toHaveBeenCalled();
      store.abandon();
    }
  });
  it("rejects extra configuration authority, writable storage and hardlinked database", async () => {
    expect(() =>
      validateMetadataConfiguration({ ...config, env: { TOKEN: "forbidden" } }),
    ).toThrow();
    const dir = await directory(),
      x = await setup(dir);
    await x.host.close();
    const path = join(dir, "antigravity-metadata/production/catalog.db");
    await link(path, join(dir, "other.db"));
    await expect(
      openAntigravityMetadataStore(dir, metadataConfigurationHash(config)),
    ).rejects.toThrow("storage_untrusted");
    const other = await directory(),
      y = await setup(other);
    await y.host.close();
    await chmod(join(other, "antigravity-metadata/production"), 0o777);
    await expect(
      openAntigravityMetadataStore(other, metadataConfigurationHash(config)),
    ).rejects.toThrow("storage_untrusted");
  });
  it.each(["completed", "auth_required"] as const)(
    "retains timeout through late %s normalization and remembers any auth latch",
    async (outcome) => {
      vi.useFakeTimers();
      const result = deferred<AntigravityProbeResult>(),
        exited = deferred<void>();
      const p = probe();
      p.start.mockImplementation((op) =>
        op === "models"
          ? { result: result.promise, exited: exited.promise, cancel: vi.fn() }
          : { result: Promise.resolve(completed(op)), exited: Promise.resolve(), cancel: vi.fn() },
      );
      const dir = await directory(),
        x = await setup(dir, p);
      x.host.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(p.start).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(5000);
      expect(x.host.view().catalog?.refresh.error).toBe("timeout");
      await x.host.refresh();
      expect(p.start).toHaveBeenCalledTimes(3);
      result.resolve(
        outcome === "completed"
          ? completed("models")
          : { kind: "failed", operation: "models", reason: "auth_required" },
      );
      exited.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(x.host.view().catalog?.catalog).toBeNull();
      expect(x.host.view().catalog?.refresh.error).toBe("timeout");
      if (outcome === "auth_required") expect(x.host.view().reason).toBe("auth_required");
      await x.host.close();
      if (outcome === "auth_required") {
        const y = await setup(dir, probe(), () => new Date(at + 2 * DAY));
        await run(y.host);
        expect(y.p.start).not.toHaveBeenCalled();
        expect(y.host.view().catalog?.refresh.error).toBe("timeout");
      }
      vi.useRealTimers();
    },
  );
  it("background checks are opt-in, honor 24h cadence, and stop at shutdown", async () => {
    vi.useFakeTimers();
    let time = at;
    const x = await setup(
      await directory(),
      probe((op) => completed(op, time)),
      () => new Date(time),
      { ...config, backgroundRefresh: true },
    );
    await run(x.host);
    expect(x.p.start).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(x.p.start).toHaveBeenCalledTimes(3);
    time += DAY;
    await vi.advanceTimersByTimeAsync(1);
    expect(x.p.start).toHaveBeenCalledTimes(4);
    await x.host.close();
    time += DAY;
    await vi.advanceTimersByTimeAsync(DAY);
    expect(x.p.start).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
  it("keeps ownership when a probe start throws before returning a lease", async () => {
    const dir = await directory(),
      p = probe();
    p.start.mockImplementation(() => {
      throw new Error("unknown start");
    });
    const x = await setup(dir, p);
    await run(x.host);
    expect(x.host.view().reason).toBe("ownership_unknown");
    await x.host.refresh();
    expect(p.start).toHaveBeenCalledTimes(1);
    await expect(x.host.close()).rejects.toThrow("shutdown_pending");
    x.store.abandon();
    await expect(
      openAntigravityMetadataStore(dir, metadataConfigurationHash(config)),
    ).rejects.toThrow("ownership_unknown");
  });
  it("reads only the explicit bounded trusted config and rejects digest coercion and symlinks", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".metadata-config-test-"));
    dirs.push(dir);
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    expect(await readMetadataConfiguration(file)).toEqual(config);
    await symlink(file, join(dir, "alias.json"));
    await expect(readMetadataConfiguration(join(dir, "alias.json"))).rejects.toThrow(
      "configuration_untrusted",
    );
    expect(() =>
      validateMetadataConfiguration({
        ...config,
        installation: {
          ...config.installation,
          expectedSha256: [config.installation.expectedSha256],
        },
      }),
    ).toThrow("configuration_invalid");
    await writeFile(file, "x".repeat(8193));
    await expect(readMetadataConfiguration(file)).rejects.toThrow("configuration_untrusted");
  });
});
