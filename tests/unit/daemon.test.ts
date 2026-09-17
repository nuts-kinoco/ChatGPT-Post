import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkDaemon,
  type DaemonCfg,
  daemonStatePath,
  getOrCreateProfileId,
  readDaemonState,
  startDaemon,
  stopDaemon,
} from "../../src/browser/daemon.js";

let dir: string;
let cfg: DaemonCfg;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-daemon-"));
  cfg = { runtimeDir: dir, profileDir: join(dir, "profile"), channel: "chrome" };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes a state file as if a different host had started a daemon (A-108: each host owns a
 * `daemon.<hostname>.json`, never a shared `daemon.json`). Defaults `profileId` to match this
 * test's own `cfg.profileDir` (as a genuine same-profile foreign host would); pass a different
 * `profileId` in `over` to simulate a distinct profile sharing this runtimeDir. */
async function writeForeignState(
  hostname: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const p = daemonStatePath(cfg, hostname);
  await writeFile(
    p,
    JSON.stringify({
      pid: 999999,
      port: 12345,
      startedAt: new Date().toISOString(),
      profileDir: cfg.profileDir,
      hostname,
      profileId: await getOrCreateProfileId(cfg.profileDir),
      ...over,
    }),
  );
  return p;
}

describe("daemon per-host state files (A-108)", () => {
  it("checkDaemon: another host's file naming the same profile is reported as foreign, not alive", async () => {
    await writeForeignState("mac-mini.local");
    const h = await checkDaemon(cfg);
    expect(h.alive).toBe(false);
    if (h.alive) return;
    expect(h.foreign).toBe(true);
    if (!h.foreign) return;
    expect(h.reason).toContain("mac-mini.local");
  });

  it("checkDaemon: a foreign file counts even if its recorded profileDir string differs, as long as profileId matches (AGY review, 2026-09-18)", async () => {
    // Each host resolves profileDir in its own path notation (Windows vs. macOS mount point for
    // the same shared directory), so an absolute-string profileDir comparison across hosts can
    // never match. profileId lives inside the profile directory itself and is compared instead —
    // must NOT be ignored just because the profileDir *string* differs.
    await writeForeignState("mac-mini.local", {
      profileDir: "/Volumes/Share/chatgpt-web-bridge/runtime/profile",
    });
    const h = await checkDaemon(cfg);
    expect(h.alive).toBe(false);
    if (h.alive) return;
    expect(h.foreign).toBe(true);
  });

  it("checkDaemon: a foreign file for a genuinely different profileId (distinct profile sharing this runtimeDir) is correctly ignored (Codex review of the profileDir-string removal, 2026-09-18)", async () => {
    // Dropping the profileDir-string comparison entirely (instead of switching to profileId)
    // would have falsely blocked two independent profiles that happen to share one runtimeDir via
    // CHATGPT_BRIDGE_PROFILE_DIR. profileId correctly tells them apart.
    await writeForeignState("mac-mini.local", { profileId: "totally-different-profile-uuid" });
    const h = await checkDaemon(cfg);
    expect(h.alive).toBe(false);
    if (h.alive) return;
    expect(h.foreign).toBe(false);
  });

  it("startDaemon: refuses to start when a foreign host already has one for this profile, and never writes its own file", async () => {
    const foreignPath = await writeForeignState("mac-mini.local");
    const before = await readFile(foreignPath, "utf8");
    const r = await startDaemon(cfg);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.cause).toContain("mac-mini.local");
    // the foreign file is untouched...
    expect(await readFile(foreignPath, "utf8")).toBe(before);
    // ...and this host never wrote its own file either (never even attempted to spawn)
    expect(await readDaemonState(cfg)).toBeNull();
  });

  it("stopDaemon: only ever touches this host's own path, never a foreign one (by construction)", async () => {
    const foreignPath = await writeForeignState("mac-mini.local");
    const r = await stopDaemon(cfg);
    // nothing of ours to stop; the foreign file is a different path entirely and is left alone
    expect(r.ok).toBe(true);
    expect(await readFile(foreignPath, "utf8")).toMatch(/mac-mini\.local/);
  });

  it("this host's own state file (matching os.hostname()) is read normally, not as foreign", async () => {
    await writeForeignState(osHostname(), { pid: 999999 });
    const h = await checkDaemon(cfg);
    // not foreign — it's ours; just not verifiably alive (pid 999999 shouldn't exist)
    expect(h.alive).toBe(false);
    if (h.alive) return;
    expect(h.foreign).toBe(false);
  });
});
