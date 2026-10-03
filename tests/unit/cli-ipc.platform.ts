/** Explicit platform-only suite: npx vitest run --config tests/unit/cli-ipc.vitest.ts
 * Never included in the default mock suite. No provider or model process is launched. */
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliBrokerExecutor, listenCliBroker } from "../../src/adapters/cli-rpc.js";
import type { TaskExecutor } from "../../src/state/task-executor.js";

describe("actual Unix IPC platform fixtures", () => {
  it("authenticates a local socket and rejects wrong key/public permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-ipc-"));
    const key = randomBytes(32);
    const socketPath = join(dir, "rpc.sock");
    const identity = {
      requestId: randomUUID(),
      runId: randomUUID(),
      taskSpecHash: "a".repeat(64),
      fencingToken: 1,
    };
    const observation = { kind: "unknown" as const, identity, reason: "fixture" };
    const service: TaskExecutor = {
      executorId: "fixture",
      synthetic: false,
      checkCapabilities: async () => {},
      start: async () => observation,
      status: async () => observation,
      cancel: async () => observation,
      collect: async () => observation,
      readArtifact: async () => Buffer.alloc(0),
    };
    try {
      const listener = await listenCliBroker(service, { socketPath, key });
      try {
        const client = new CliBrokerExecutor("fixture", { socketPath, key, timeoutMs: 200 });
        expect(await client.status(identity)).toEqual(observation);
        await expect(
          new CliBrokerExecutor("fixture", {
            socketPath,
            key: randomBytes(32),
            timeoutMs: 200,
          }).status(identity),
        ).rejects.toThrow();
        await expect(listenCliBroker(service, { socketPath, key })).rejects.toThrow(
          "cli_rpc_socket_already_exists",
        );
        await chmod(socketPath, 0o666);
        await expect(client.status(identity)).rejects.toThrow("cli_rpc_socket_permissions");
      } finally {
        await listener.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
