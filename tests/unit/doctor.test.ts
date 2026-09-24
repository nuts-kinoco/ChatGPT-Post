import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeConfig } from "../../src/cli/config.js";
import { checkLock } from "../../src/diagnostics/doctor.js";
import { slotPath } from "../../src/state/slot-lock.js";

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "bridge-doctor-"));
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

function cfg(maxConcurrency: number): BridgeConfig {
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
    maxConcurrency,
  };
}

async function writeLock(path: string, pid: number, command: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      pid,
      startedAt: new Date().toISOString(),
      token: "test-token",
      command,
      requestId: null,
      hostname: hostname(),
    }),
  );
}

describe("checkLock pooled mode (Phase 3 MVP, A-136)", () => {
  it("reports every unused slot as free", async () => {
    const result = await checkLock(cfg(3));

    expect(result).toEqual({
      name: "lock",
      ok: true,
      detail: "slot0 free; slot1 free; slot2 free",
    });
  });

  it("reports a genuinely held slot with its pid and command", async () => {
    const config = cfg(2);
    const path = slotPath(join(config.locksDir, "bridge.lock"), 0);
    await writeLock(path, process.pid, "run");

    const result = await checkLock(config);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain(`slot0 held: pid=${process.pid} command=run`);
    expect(result.detail).toContain("slot1 free");
  });

  it("reports a reclaimable stale slot and its explicit unlock path", async () => {
    const config = cfg(2);
    const path = slotPath(join(config.locksDir, "bridge.lock"), 1);
    await writeLock(path, 2_147_483_647, "run");

    const result = await checkLock(config);

    expect(result.ok).toBe(true);
    expect(result.warn).toBe(true);
    expect(result.detail).toContain("slot1 abandoned");
    expect(result.detail).toContain(`safe to run unlock --stale for ${path}`);
  });

  it("keeps a held slot failing even when the other pool slots are free", async () => {
    const config = cfg(3);
    const path = slotPath(join(config.locksDir, "bridge.lock"), 1);
    await writeLock(path, process.pid, "submit");

    const result = await checkLock(config);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain(`slot1 held: pid=${process.pid} command=submit`);
    expect(result.detail).toContain("slot0 free");
    expect(result.detail).toContain("slot2 free");
  });

  it("reports heartbeat age for the default single bridge.lock", async () => {
    const config = cfg(1);
    const path = join(config.locksDir, "bridge.lock");
    await writeLock(path, process.pid, "run");

    await expect(checkLock(config)).resolves.toMatchObject({
      name: "lock",
      ok: false,
      detail: expect.stringContaining(`held: pid=${process.pid} command=run heartbeatAge=`),
    });
  });
});
