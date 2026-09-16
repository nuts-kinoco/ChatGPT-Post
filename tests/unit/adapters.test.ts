import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonStatePath } from "../../src/browser/daemon.js";
import { playwrightBrowser } from "../../src/cli/adapters.js";
import type { BridgeConfig } from "../../src/cli/config.js";

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
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Codex review of A-108, High: a foreign daemon (another host, shared runtime/) must be treated
// as profile-busy — never silently falling through to a fresh local launch, which could collide
// with that host's real Chrome on the same profile (the exact class of incident A-101 was about).
describe("playwrightBrowser + foreign daemon (A-108)", () => {
  it("checkProfileFree() reports not-free when a foreign host's daemon owns this profile", async () => {
    await writeFile(
      daemonStatePath(
        { runtimeDir: cfg.runtimeDir, profileDir: cfg.profileDir, channel: "chrome" },
        "mac-mini.local",
      ),
      JSON.stringify({
        pid: 999999,
        port: 12345,
        startedAt: new Date().toISOString(),
        profileDir: cfg.profileDir,
        hostname: "mac-mini.local",
      }),
    );
    const browser = playwrightBrowser(cfg);
    const free = await browser.checkProfileFree();
    expect(free.free).toBe(false);
    if (free.free) return;
    expect(free.cause).toContain("mac-mini.local");
  });

  it("launch() refuses outright rather than starting a local browser against a foreign-owned profile", async () => {
    await writeFile(
      daemonStatePath(
        { runtimeDir: cfg.runtimeDir, profileDir: cfg.profileDir, channel: "chrome" },
        "mac-mini.local",
      ),
      JSON.stringify({
        pid: 999999,
        port: 12345,
        startedAt: new Date().toISOString(),
        profileDir: cfg.profileDir,
        hostname: "mac-mini.local",
      }),
    );
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
