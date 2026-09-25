import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeConfig } from "../../src/cli/config.js";
import { checkLock, formatDoctor } from "../../src/diagnostics/doctor.js";

let runtimeDir: string;

function cfg(): BridgeConfig {
  return {
    repoRoot: runtimeDir,
    runtimeDir,
    profileDir: join(runtimeDir, "profile"),
    locksDir: join(runtimeDir, "locks"),
    stateDir: join(runtimeDir, "state"),
    artifactsDir: join(runtimeDir, "artifacts"),
    channel: "chrome",
    traceOnSuccess: false,
    imageViaViewer: false,
    logLevel: "info",
    bridgeVersion: "test",
    maxConcurrency: 1,
  };
}

async function writeLock(
  pid: number,
  requestId: string | null,
  startedAt = "2026-09-25T00:00:00.000Z",
): Promise<void> {
  const path = join(runtimeDir, "locks", "bridge.lock");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      pid,
      startedAt,
      token: "test-token",
      command: "run",
      requestId,
      hostname: hostname(),
      heartbeatAt: "2026-09-25T00:00:01.000Z",
    }),
  );
}

afterEach(async () => {
  if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true });
});

describe("doctor structured lock JSON", () => {
  it("includes held lock fields without changing the human-readable format", async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), "bridge-doctor-json-"));
    await writeLock(process.pid, "request-held");

    const item = await checkLock(cfg());

    expect(item).toMatchObject({
      name: "lock",
      ok: false,
      lock: {
        pid: process.pid,
        requestId: "request-held",
        command: "run",
        heldSinceMs: Date.parse("2026-09-25T00:00:00.000Z"),
        heartbeatAgeMs: expect.any(Number),
        stale: false,
        reclaimable: false,
      },
    });
    expect(formatDoctor([item])).toEqual({
      text: `NG   lock               ${item.detail}`,
      ok: false,
    });
  });

  it("includes stale and reclaimable fields for a stale lock", async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), "bridge-doctor-json-"));
    await writeLock(2_147_483_647, null);

    await expect(checkLock(cfg())).resolves.toMatchObject({
      name: "lock",
      ok: true,
      warn: true,
      lock: { pid: 2_147_483_647, requestId: null, stale: true, reclaimable: true },
    });
  });

  it("omits lock fields when no lock file exists", async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), "bridge-doctor-json-"));
    await expect(checkLock(cfg())).resolves.toEqual({
      name: "lock",
      ok: true,
      detail: "no lock file",
    });
  });

  it("represents malformed persisted timestamps explicitly as null", async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), "bridge-doctor-json-"));
    await writeLock(process.pid, "request-held", "not-a-timestamp");

    await expect(checkLock(cfg())).resolves.toMatchObject({
      name: "lock",
      lock: { heldSinceMs: null },
    });
  });
});
