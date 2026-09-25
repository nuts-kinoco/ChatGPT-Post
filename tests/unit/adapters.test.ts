import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonStatePath, getOrCreateProfileId } from "../../src/browser/daemon.js";
import { buildPorts, playwrightBrowser } from "../../src/cli/adapters.js";
import type { BridgeConfig } from "../../src/cli/config.js";
import { createLogger } from "../../src/diagnostics/logger.js";

let dir: string;
let cfg: BridgeConfig;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-adapters-"));
  const profileDir = join(dir, "profile");
  cfg = {
    repoRoot: dir,
    runtimeDir: dir,
    profileDir,
    locksDir: join(dir, "locks"),
    stateDir: join(dir, "state"),
    artifactsDir: join(dir, "artifacts"),
    channel: "chrome",
    traceOnSuccess: false,
    imageViaViewer: false,
    logLevel: "error",
    bridgeVersion: "test",
    maxConcurrency: 1,
    experimentalStealth: "off",
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeForeignDaemonState(): Promise<void> {
  await writeFile(
    daemonStatePath(
      {
        runtimeDir: cfg.runtimeDir,
        profileDir: cfg.profileDir,
        channel: "chrome",
        experimentalStealth: "off",
        stealthExtensionDir: join(dir, "experimental", "stealth-extension"),
      },
      "mac-mini.local",
    ),
    JSON.stringify({
      pid: 999999,
      port: 12345,
      startedAt: new Date().toISOString(),
      profileDir: cfg.profileDir,
      hostname: "mac-mini.local",
      profileId: await getOrCreateProfileId(cfg.profileDir),
    }),
  );
}

// Codex review of A-108, High: a foreign daemon (another host, shared runtime/) must be treated
// as profile-busy — never silently falling through to a fresh local launch, which could collide
// with that host's real Chrome on the same profile (the exact class of incident A-101 was about).
describe("playwrightBrowser + foreign daemon (A-108)", () => {
  it("checkProfileFree() reports not-free when a foreign host's daemon owns this profile", async () => {
    await writeForeignDaemonState();
    const browser = playwrightBrowser(cfg);
    const free = await browser.checkProfileFree();
    expect(free.free).toBe(false);
    if (free.free) return;
    expect(free.cause).toContain("mac-mini.local");
  });

  it("launch() refuses outright rather than starting a local browser against a foreign-owned profile", async () => {
    await writeForeignDaemonState();
    const browser = playwrightBrowser(cfg);
    const launched = await browser.launch({ copyCaptureShim: false, onCrash: () => undefined });
    expect(launched.ok).toBe(false);
    if (launched.ok) return;
    expect(launched.cause).toContain("mac-mini.local");
    // must not have actually opened a browser session
    expect(browser.session.isOpen).toBe(false);
  });

  it("checkProfileFree() is unaffected when there is no daemon at all (falls through to the plain lockfile check)", async () => {
    const browser = playwrightBrowser(cfg);
    const free = await browser.checkProfileFree();
    expect(free.free).toBe(true); // profile dir doesn't even exist yet — nothing holds it
  });
});

// Phase 3 MVP (A-136): buildPorts' `pooled` param only takes effect when combined with
// cfg.maxConcurrency > 1 -- every other combination must be the exact pre-Phase-3 single lock.
describe("buildPorts pool wiring (Phase 3 MVP, A-136)", () => {
  const logger = createLogger("error");

  it("pooled=false (login/doctor/inspect-ui) with maxConcurrency=1 keeps the plain bridge.lock", async () => {
    const ports = buildPorts({ ...cfg, maxConcurrency: 1 }, logger, true, false);
    expect(ports.lockRaw).not.toBeNull();
    expect(ports.lockRaw?.path).toBe(join(cfg.locksDir, "bridge.lock"));
  });

  // Opus review of A-136, High#1: pooled=false must NOT mean "untouched by the pool" once
  // maxConcurrency > 1 -- login/doctor/inspect-ui still need to be mutually exclusive against a
  // concurrently-running pooled `run`, so fileLock() itself barrier-locks every slot in that case.
  it("pooled=false (login/doctor/inspect-ui) with maxConcurrency>1 barrier-locks every slot instead of the plain bridge.lock", async () => {
    const ports = buildPorts({ ...cfg, maxConcurrency: 3 }, logger, true, false);
    expect(ports.lockRaw).toBeNull(); // no single ProcessLock -- it's a barrier over 3 slots now
    const acquired = await ports.lock.acquire("doctor", null);
    expect(acquired.kind).toBe("ok");
    // a concurrently-pooled run trying any one slot must now see it busy
    const poolPorts = buildPorts({ ...cfg, maxConcurrency: 3 }, logger, true, true);
    const poolAcquire = await poolPorts.lock.acquire("run", "req-1");
    expect(poolAcquire.kind).toBe("busy");
    await ports.lock.release();
  });

  it("pooled=true with maxConcurrency=1 (default) is unchanged: still the plain bridge.lock, not a slot", async () => {
    const ports = buildPorts({ ...cfg, maxConcurrency: 1 }, logger, true, true);
    expect(ports.lockRaw?.path).toBe(join(cfg.locksDir, "bridge.lock"));
  });

  it("pooled=true with maxConcurrency>1 switches to the slot pool (lockRaw is null; acquire lands on slot0)", async () => {
    const ports = buildPorts({ ...cfg, maxConcurrency: 2 }, logger, true, true);
    expect(ports.lockRaw).toBeNull();
    const res = await ports.lock.acquire("run", "req-1");
    expect(res.kind).toBe("ok");
    await ports.lock.release();
  });

  it("does not orphan a held slot when acquire is called twice on the same pool lock", async () => {
    const ports = buildPorts({ ...cfg, maxConcurrency: 2 }, logger, true, true);
    expect(await ports.lock.acquire("run", "req-1")).toMatchObject({
      kind: "ok",
      token: expect.any(String),
    });
    try {
      const second = await ports.lock.acquire("run", "req-2");
      expect(second.kind).toBe("busy");
      if (second.kind === "busy") expect(second.cause).toContain("already holds a slot");
      expect(await readdir(cfg.locksDir)).toEqual(["bridge.lock.slot0"]);
    } finally {
      await ports.lock.release();
    }
  });

  it("a pooled run holding one slot does not block login/doctor's barrier from the other slots being free -- barrier still refuses (all-or-nothing)", async () => {
    const poolPorts = buildPorts({ ...cfg, maxConcurrency: 2 }, logger, true, true);
    const poolAcquire = await poolPorts.lock.acquire("run", "req-1");
    expect(poolAcquire.kind).toBe("ok"); // takes slot0
    const doctorPorts = buildPorts({ ...cfg, maxConcurrency: 2 }, logger, true, false);
    const doctorAcquire = await doctorPorts.lock.acquire("doctor", null);
    expect(doctorAcquire.kind).toBe("busy"); // slot0 is held -> barrier can't complete
    await poolPorts.lock.release();
  });
});
