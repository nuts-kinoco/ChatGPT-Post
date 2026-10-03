import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ open: vi.fn(), read: vi.fn() }));
vi.mock("../../src/adapters/antigravity-metadata-host.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openAntigravityMetadataHost: fixtures.open,
}));
vi.mock("../../src/adapters/antigravity-metadata-store.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readMetadataConfiguration: fixtures.read,
}));

import { unavailableMetadataView } from "../../src/adapters/antigravity-metadata-host.js";
import { runUiCli } from "../../src/cli/ui.js";
import { startUiServer, type UiServerHandle } from "../../src/ui/server.js";

const config = {
  version: "bridge-antigravity-metadata-config-1" as const,
  enabled: true,
  backgroundRefresh: true,
  contextId: "isolated-fixture",
  installation: { executable: "/fixture/agy", expectedSha256: "a".repeat(64), ownerUid: 0 },
};
const dirs: string[] = [],
  servers: UiServerHandle[] = [];
const host = () => ({
  start: vi.fn(),
  view: vi.fn(() => ({ ...unavailableMetadataView("auth_required"), configured: true })),
  refresh: vi.fn(async () => ({ ...unavailableMetadataView("auth_required"), configured: true })),
  beginShutdown: vi.fn(),
  close: vi.fn(async () => {}),
});
beforeEach(() => {
  fixtures.open.mockReset();
  fixtures.read.mockReset();
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function open(options: Partial<Parameters<typeof startUiServer>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "metadata-http-"));
  dirs.push(dir);
  const server = await startUiServer({ stateDir: dir, profile: "production", ...options });
  servers.push(server);
  return server;
}
function api(s: UiServerHandle, path: string, input?: unknown) {
  return fetch(s.origin + path, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${s.token}`,
      ...(input === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
describe("production metadata entrypoint and capability HTTP wiring", () => {
  it.each([
    {},
    { antigravityMetadata: { ...config, enabled: false } },
    { profile: "demo" as const, antigravityMetadata: config },
  ])("never constructs a probe for disabled/demo/unconfigured host", async (options) => {
    const s = await open(options);
    expect(fixtures.open).not.toHaveBeenCalled();
    expect((await (await api(s, "/api/provider-catalog")).json()).metadata.refreshAllowed).toBe(
      false,
    );
  });
  it("starts once after bind, GET only reads, and refresh has a fixed body", async () => {
    const h = host();
    fixtures.open.mockResolvedValue(h);
    const s = await open({ antigravityMetadata: config });
    expect(h.start).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) expect((await api(s, "/api/provider-catalog")).status).toBe(200);
    expect(h.refresh).not.toHaveBeenCalled();
    for (const input of [
      {},
      { ...config },
      { version: "bridge-antigravity-metadata-host-1", model: "injected" },
    ])
      expect((await api(s, "/api/provider-catalog/refresh", input)).status).toBe(400);
    expect(
      (
        await api(s, "/api/provider-catalog/refresh", {
          version: "bridge-antigravity-metadata-host-1",
        })
      ).status,
    ).toBe(200);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect((await fetch(`${s.origin}/api/provider-catalog`)).status).toBe(401);
    expect(
      (
        await fetch(`${s.origin}/api/provider-catalog/refresh`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${s.token}`,
            Origin: "https://foreign.test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ version: "bridge-antigravity-metadata-host-1" }),
        })
      ).status,
    ).toBe(403);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    await s.close();
    expect(h.beginShutdown).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
  });
  it("bind failure does not acquire a metadata owner or start a probe", async () => {
    const first = await open();
    await expect(
      open({ port: Number(new URL(first.origin).port), antigravityMetadata: config }),
    ).rejects.toThrow();
    expect(fixtures.open).not.toHaveBeenCalled();
  });
  it("shows storage/owner failures without paths, raw output or bypass", async () => {
    fixtures.open.mockRejectedValue(new Error("metadata_ownership_unknown"));
    const s = await open({ antigravityMetadata: config });
    const response = await (await api(s, "/api/provider-catalog")).json();
    expect(response.metadata.reason).toBe("ownership_unknown");
    expect(JSON.stringify(response)).not.toContain(config.installation.executable);
  });
  it("retryable shutdown fences before drain and preserves runtime until success", async () => {
    const h = host();
    let failed = true;
    h.close.mockImplementation(async () => {
      if (failed) throw new Error("metadata_shutdown_pending");
    });
    fixtures.open.mockResolvedValue(h);
    const s = await open({ antigravityMetadata: config });
    await expect(s.close()).rejects.toThrow("shutdown_pending");
    expect(h.beginShutdown).toHaveBeenCalled();
    expect(s.service.bootstrap().tasks).toEqual([]);
    failed = false;
    await s.close();
    expect(h.close).toHaveBeenCalledTimes(2);
  });
  it("CLI reads an explicit local config and hands data to the real server option", async () => {
    fixtures.read.mockResolvedValue(config);
    const start = vi.fn(async () => ({ url: "local", close: async () => {} }));
    expect(
      await runUiCli(["--antigravity-metadata", "/trusted/metadata.json"], {
        env: {},
        start,
        stdout: () => {},
        waitForStop: async () => {},
      }),
    ).toBe(0);
    expect(fixtures.read).toHaveBeenCalledWith("/trusted/metadata.json");
    expect(start.mock.calls[0]?.[0]).toMatchObject({ antigravityMetadata: config });
  });
});
