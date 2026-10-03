/** Configured lifecycle tests use a stub worker and real loopback/server/store only. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../src/adapters/deployment-loader.js", () => ({ openTrustedDeployment: fixture.load }));

import { BridgeResidentWorker } from "../../src/adapters/resident-worker.js";
import { startUiServer, type UiServerHandle } from "../../src/ui/server.js";
import { openUiService } from "../../src/ui/service.js";

const dirs: string[] = [],
  servers: UiServerHandle[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true });
});
async function setup(worker?: { start(): void; close(): Promise<void> }) {
  const path = await mkdtemp(join(tmpdir(), "bridge-ui-worker-"));
  dirs.push(path);
  const service = await openUiService({ stateDir: path, profile: "production" });
  const close = vi.fn(async () => {
    service.close();
  });
  fixture.load.mockResolvedValueOnce({
    uiRuntime: service.runtime,
    close,
    ...(worker ? { residentWorker: worker } : {}),
  });
  return {
    path,
    service,
    close,
    open: (port = 0) =>
      startUiServer({
        stateDir: path,
        profile: "production",
        deploymentModule: "/synthetic/trusted.mjs",
        port,
      }),
  };
}
describe("explicit configured resident worker lifecycle", () => {
  it("starts once only after a successful bind; reads/settings never start it again", async () => {
    const events: string[] = [];
    const worker = {
      start: vi.fn(() => {
        events.push("start");
      }),
      close: vi.fn(async () => {
        events.push("worker-close");
      }),
    };
    const x = await setup(worker),
      server = await x.open();
    servers.push(server);
    expect(server.server.listening).toBe(true);
    expect(worker.start).toHaveBeenCalledTimes(1);
    const headers = { Authorization: `Bearer ${server.token}` };
    for (const path of ["/api/setup", "/api/operations", "/api/presentation"])
      expect((await fetch(server.origin + path, { headers })).status).toBe(200);
    expect(worker.start).toHaveBeenCalledTimes(1);
    x.close.mockImplementation(async () => {
      events.push("stores-close");
      x.service.close();
    });
    await server.close();
    await server.close();
    expect(events).toEqual(["start", "worker-close", "stores-close"]);
    expect(x.close).toHaveBeenCalledTimes(1);
  });
  it("a bind failure never starts the worker or a second runtime", async () => {
    const first = await setup(),
      active = await first.open();
    servers.push(active);
    const worker = { start: vi.fn(), close: vi.fn(async () => {}) },
      second = await setup(worker);
    await expect(second.open(Number(new URL(active.origin).port))).rejects.toThrow();
    expect(worker.start).not.toHaveBeenCalled();
    expect(second.close).toHaveBeenCalledTimes(1);
  });
  it("failed drain retains stores, permits one explicit retry, and shares concurrent close", async () => {
    let fail = true,
      release!: () => void;
    const future = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = {
      start: vi.fn(),
      close: vi.fn(async () => {
        if (fail) throw new Error("resident_worker_drain_pending");
        await future;
      }),
    };
    const x = await setup(worker),
      server = await x.open();
    servers.push(server);
    await expect(server.close()).rejects.toThrow("drain_pending");
    expect(x.close).not.toHaveBeenCalled();
    expect(x.service.bootstrap().tasks).toEqual([]);
    fail = false;
    const a = server.close(),
      b = server.close();
    await vi.waitFor(() => expect(worker.close).toHaveBeenCalledTimes(2));
    expect(x.close).not.toHaveBeenCalled();
    release();
    await Promise.all([a, b]);
    expect(x.close).toHaveBeenCalledTimes(1);
  });
  it("worker startup failure drains before store cleanup", async () => {
    const events: string[] = [];
    const worker = {
      start: () => {
        throw new Error("resident_start_failed");
      },
      close: async () => {
        events.push("drained");
      },
    };
    const x = await setup(worker);
    x.close.mockImplementation(async () => {
      events.push("closed");
      x.service.close();
    });
    await expect(x.open()).rejects.toThrow("resident_start_failed");
    expect(events).toEqual(["drained", "closed"]);
  });
  it("the configured entrypoint owns the concrete portable worker without starting it on construction", async () => {
    const tick = vi.fn(async (_signal: AbortSignal) => undefined);
    const worker = new BridgeResidentWorker({
      enabled: true,
      lanes: [{ id: "cli:synthetic", tick }],
      intervalMs: 1000,
      drainTimeoutMs: 100,
    });
    expect(tick).not.toHaveBeenCalled();
    const x = await setup(worker),
      server = await x.open();
    servers.push(server);
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(1));
    expect(worker.snapshot().state).toBe("running");
    await server.close();
    expect(worker.snapshot().state).toBe("closed");
    expect(x.close).toHaveBeenCalledTimes(1);
  });
});
