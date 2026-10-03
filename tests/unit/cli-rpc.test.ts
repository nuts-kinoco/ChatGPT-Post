/** Full client/server protocol over in-memory duplex sockets. No OS sockets or external network. */
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskExecutor } from "../../src/state/task-executor.js";

const net = vi.hoisted(() => ({ createConnection: vi.fn(), createServer: vi.fn() }));
const fs = vi.hoisted(() => ({
  chmod: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock("node:net", () => net);
vi.mock("node:fs/promises", () => fs);

import { CliBrokerExecutor, listenCliBroker } from "../../src/adapters/cli-rpc.js";
import type { TaskSpec } from "../../src/contracts/task-types.js";
import type { RunIntent } from "../../src/state/task-store.js";

class FakeDuplex extends EventEmitter {
  peer: FakeDuplex | null = null;
  closed = false;
  write(data: Uint8Array): boolean {
    const bytes = Buffer.from(data);
    queueMicrotask(() => {
      if (!this.closed && !this.peer?.closed) {
        // Exercise header/payload fragmentation on every request and response.
        this.peer?.emit("data", bytes.subarray(0, 2));
        this.peer?.emit("data", bytes.subarray(2, 17));
        this.peer?.emit("data", bytes.subarray(17));
      }
    });
    return true;
  }
  end(data?: Uint8Array): void {
    if (data) this.write(data);
    queueMicrotask(() => this.peer?.emit("end"));
  }
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
    queueMicrotask(() => this.peer?.emit("end"));
  }
}
const identity = {
  requestId: randomUUID(),
  runId: randomUUID(),
  taskSpecHash: "a".repeat(64),
  fencingToken: 1,
};
const observation = { kind: "unknown" as const, identity, reason: "fake-process" };
const socketPath = "/private/rpc.sock";
const ref = {
  artifact_id: "fixture",
  sha256: "b".repeat(64),
  size_bytes: 3,
  media_type: "text/plain" as const,
};
describe("CLI RPC over fake duplex network", () => {
  let service: TaskExecutor;
  let accept: (socket: FakeDuplex) => void;
  let exists: boolean;
  let socketMode: number;
  beforeEach(() => {
    vi.clearAllMocks();
    exists = false;
    socketMode = 0o600;
    service = {
      executorId: "broker",
      synthetic: false,
      checkCapabilities: vi.fn(async () => {}),
      start: vi.fn(async () => observation),
      status: vi.fn(async () => observation),
      cancel: vi.fn(async () => observation),
      collect: vi.fn(async () => observation),
      readArtifact: vi.fn(async () => Buffer.from("abc")),
    };
    fs.realpath.mockImplementation(async (path) => path);
    fs.lstat.mockImplementation(async (path) => {
      if (path === socketPath && !exists)
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return {
        isDirectory: () => path !== socketPath,
        isSocket: () => path === socketPath,
        isSymbolicLink: () => false,
        mode: path === socketPath ? socketMode : 0o700,
        uid: process.getuid?.(),
      };
    });
    fs.chmod.mockImplementation(async (_path, mode) => {
      socketMode = mode;
    });
    fs.unlink.mockImplementation(async () => {
      exists = false;
    });
    net.createServer.mockImplementation((callback) => {
      accept = callback;
      const server = new EventEmitter();
      return Object.assign(server, {
        listen: (_path: string, ready: () => void) => {
          exists = true;
          ready();
        },
        close: (done: () => void) => done(),
      });
    });
    net.createConnection.mockImplementation(() => {
      const a = new FakeDuplex();
      const b = new FakeDuplex();
      a.peer = b;
      b.peer = a;
      accept(b);
      return a;
    });
  });
  it("dispatches every operation with authenticated fragmented frames", async () => {
    const key = randomBytes(32);
    const server = await listenCliBroker(service, { socketPath, key });
    const client = new CliBrokerExecutor("broker", { socketPath, key, timeoutMs: 100 });
    try {
      const task = { test: "fixture" } as unknown as TaskSpec;
      const intent = { test: "fixture" } as unknown as RunIntent;
      await client.checkCapabilities(task);
      expect(service.checkCapabilities).toHaveBeenCalledWith(task);
      expect(await client.start(task, Buffer.from("prompt"), identity, intent)).toEqual(
        observation,
      );
      expect(service.start).toHaveBeenCalledWith(task, Buffer.from("prompt"), identity, intent);
      expect(await client.status(identity)).toEqual(observation);
      expect(await client.cancel(identity, "timeout", 3)).toEqual(observation);
      expect(service.cancel).toHaveBeenCalledWith(identity, "timeout", 3);
      expect(await client.collect(identity)).toEqual(observation);
      expect(Buffer.from(await client.readArtifact(ref))).toEqual(Buffer.from("abc"));
    } finally {
      await server.close();
    }
  });
  it("rejects wrong keys and mismatched executor before dispatch", async () => {
    const key = randomBytes(32);
    const server = await listenCliBroker(service, { socketPath, key });
    try {
      await expect(
        new CliBrokerExecutor("broker", {
          socketPath,
          key: randomBytes(32),
          timeoutMs: 100,
        }).status(identity),
      ).rejects.toThrow();
      await expect(
        new CliBrokerExecutor("other", { socketPath, key, timeoutMs: 100 }).status(identity),
      ).rejects.toThrow();
      expect(service.status).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  it("returns a precise safe permission denial without retry or fallback", async () => {
    service.checkCapabilities = vi.fn(async () => {
      throw new Error("sandbox_capability_unavailable: per-operation-path-scope");
    });
    const key = randomBytes(32);
    const server = await listenCliBroker(service, { socketPath, key });
    try {
      await expect(
        new CliBrokerExecutor("broker", { socketPath, key }).checkCapabilities({} as TaskSpec),
      ).rejects.toThrow("sandbox_capability_unavailable");
      expect(service.checkCapabilities).toHaveBeenCalledOnce();
      expect(service.start).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  it("bounds disconnected/hung requests as unknown without resend", async () => {
    service.status = vi.fn(() => new Promise(() => {}));
    const key = randomBytes(32);
    const server = await listenCliBroker(service, { socketPath, key });
    try {
      await expect(
        new CliBrokerExecutor("broker", { socketPath, key, timeoutMs: 10 }).status(identity),
      ).rejects.toThrow("cli_rpc_timeout_unknown");
      expect(service.status).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
  it("does not replace an existing service or accept permissive sockets", async () => {
    const key = randomBytes(32);
    const server = await listenCliBroker(service, { socketPath, key });
    try {
      await expect(listenCliBroker(service, { socketPath, key })).rejects.toThrow(
        "cli_rpc_socket_already_exists",
      );
      socketMode = 0o666;
      await expect(
        new CliBrokerExecutor("broker", { socketPath, key }).status(identity),
      ).rejects.toThrow("cli_rpc_socket_permissions");
      expect(net.createConnection).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
