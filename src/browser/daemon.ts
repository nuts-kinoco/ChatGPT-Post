/**
 * Control plane for the optional background browser daemon (A-103): a long-lived, minimized
 * Chrome that stays logged in and is reused across commands via CDP, instead of every `run` /
 * `doctor` / `login` / `inspect-ui` launching and closing its own automated browser. Frequent
 * launch/close churn against the same account was the leading suspect for the session instability
 * (repeated Cloudflare/Google re-challenges) reported in A-101/A-102; this reduces that churn.
 * Opt-in and best-effort: any command still falls back to its own fresh launch when no daemon
 * (or a stale one) is found, so nothing regresses for users who never run `daemon start`.
 *
 * Codex review of the first cut (reviews/daemon-mode-codex.md, adjudicated in
 * reviews/daemon-mode-adjudication.md): the CDP port is unauthenticated, so anything bound to it
 * is trusted. Mitigations here: bind 127.0.0.1 only, pick a random free port per start instead of
 * a fixed one, and guard PID reuse the same way lock.ts does before ever killing or trusting a
 * recorded pid. A full authenticated control channel (named pipe + ACL) is out of scope — accepted
 * given the single-user-PC assumption this was built for (A-103).
 *
 * A-105: an idle daemon page was still observed going AUTH_REQUIRED after enough elapsed time,
 * even though Playwright/CDP keeps `document.visibilityState` "visible" while minimized (measured
 * live — Chrome's background-tab timer throttling was ruled out as the cause). ChatGPT's own
 * support guidance says an idle session needs interaction roughly every 15–30 minutes, so the
 * worker now does a periodic `page.reload()` (see daemon-worker.ts) as a real activity signal,
 * skipped whenever the bridge lock is held so it can't collide with a command in flight.
 *
 * A-108: if `runtime/` sits on storage shared between hosts (observed live: this repo mounted on
 * both a Windows machine and a Mac over the same SMB share), a single shared daemon.json is a
 * write conflict waiting to happen — whichever host writes last wins, silently stranding the
 * other's real, running daemon. Each host now owns a separate state file
 * (`daemon.<hostname>.json`); no host ever writes, renames, or unlinks a path derived from any
 * hostname but its own, which removes the read-modify-write race entirely rather than just
 * detecting it after the fact. Detecting another host's daemon (to avoid launching a second,
 * conflicting browser against the same profile) is a directory scan, never a write.
 *
 * Accepted residual risk (Codex review of A-108, reviews/cross-host-fix-codex.md): anyone who can
 * write into a shared `runtime/` can drop a `daemon.<anyhost>.json` naming this host and matching
 * this host's real pid, which this host's own `checkDaemon()` would then treat as "foreign,
 * profile busy" — a denial of service, not a code-execution or data-exfiltration risk. There is no
 * capability/token system guarding these files, matching the same single-trusted-user-PC
 * assumption already accepted for the unauthenticated CDP port in A-103/A-104. This tool is built
 * for one person's own machines, not a multi-tenant environment; do not extend it to one without
 * revisiting this.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLockDeps } from "../state/lock.js";

export interface DaemonState {
  pid: number;
  port: number;
  startedAt: string;
  profileDir: string;
  hostname: string;
  profileId: string;
}

const PROFILE_ID_FILE = ".chatgpt-bridge-profile-id";

/**
 * A stable identity for a profile directory that survives being seen through different mount
 * points (Codex review of A-108's cross-host fix, 2026-09-18: dropping the `profileDir` string
 * comparison entirely — needed so Windows `S:\...` and macOS `/Volumes/Share/...` for the *same*
 * shared directory are recognized as the same profile — meant two genuinely *different* profiles
 * that happen to share one `runtimeDir` via CHATGPT_BRIDGE_PROFILE_DIR would now falsely block
 * each other). The ID lives inside the profile directory itself, so reading it always reflects
 * the actual target directory regardless of the path string used to reach it. Created lazily,
 * race-safe (O_EXCL create; on a lost race, read back whatever the winner wrote).
 *
 * A-118 (Phase 0-B-2, ChatGPT Pro redesign review §3.7, reproduced live): the previous version
 * fell back to a fresh, non-persisted `randomUUID()` when every read/write/re-read attempt failed,
 * so a persistently unreadable/unwritable profile directory got a *different* profileId on every
 * call — silently defeating cross-host and cross-profile identity checks (fail-open) instead of
 * refusing to proceed. Throws instead; callers must treat this as "cannot verify this profile's
 * identity" and refuse rather than guess.
 */
export async function getOrCreateProfileId(profileDir: string): Promise<string> {
  const idPath = join(profileDir, PROFILE_ID_FILE);
  try {
    const existing = (await readFile(idPath, "utf8")).trim();
    if (existing) return existing;
  } catch {
    /* doesn't exist yet */
  }
  await mkdir(profileDir, { recursive: true });
  const id = randomUUID();
  try {
    await writeFile(idPath, id, { flag: "wx" });
    return id;
  } catch (writeErr) {
    try {
      const existing = (await readFile(idPath, "utf8")).trim();
      if (existing) return existing;
    } catch {
      /* fall through */
    }
    throw new Error(
      `could not read or create a stable profile id at ${idPath}: ${(writeErr as Error).message}`,
    );
  }
}

export interface DaemonCfg {
  runtimeDir: string;
  profileDir: string;
  channel: "chrome" | "chromium";
}

/** Filesystem-safe encoding of a hostname for use in a filename. */
function sanitizeHostname(h: string): string {
  return h.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown-host";
}

const DAEMON_FILE_RE = /^daemon\.(.+)\.json$/;

/** This host's own daemon state file — the only one this process ever writes or deletes. */
export function daemonStatePath(cfg: DaemonCfg, hostname: string = osHostname()): string {
  return join(cfg.runtimeDir, `daemon.${sanitizeHostname(hostname)}.json`);
}

function isValidState(parsed: Partial<DaemonState>): parsed is DaemonState {
  return (
    typeof parsed.pid === "number" &&
    Number.isSafeInteger(parsed.pid) &&
    parsed.pid > 0 &&
    typeof parsed.port === "number" &&
    Number.isInteger(parsed.port) &&
    parsed.port > 0 &&
    parsed.port <= 65535 &&
    typeof parsed.startedAt === "string" &&
    typeof parsed.profileDir === "string" &&
    typeof parsed.hostname === "string" &&
    parsed.hostname.length > 0 &&
    typeof parsed.profileId === "string" &&
    parsed.profileId.length > 0
  );
}

async function readStateFile(path: string): Promise<DaemonState | null> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as Partial<DaemonState>;
    return isValidState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** This host's own state only. */
export async function readDaemonState(cfg: DaemonCfg): Promise<DaemonState | null> {
  return readStateFile(daemonStatePath(cfg));
}

/**
 * Read-only directory scan for another host's daemon file — never reads (let alone writes) a
 * specific other host's path directly, since the hostname on a shared drive isn't known in
 * advance.
 *
 * Compares `state.profileId`, not `state.profileDir` (AGY/Antigravity second-opinion review,
 * 2026-09-18): each host resolves its own profileDir in its own path notation (Windows
 * `S:\...\runtime\profile` vs. macOS `/Volumes/Share/.../runtime/profile` for the exact same
 * shared directory over the same SMB mount), so an absolute-string comparison between hosts can
 * never match — it silently defeated this entire cross-host check, exactly the class of incident
 * A-108 exists to prevent. `profileId` (getOrCreateProfileId) lives inside the profile directory
 * itself, so it reads the same regardless of which path was used to reach it, and — unlike
 * dropping the comparison outright — still correctly distinguishes two genuinely different
 * profiles that happen to share one `runtimeDir`.
 */
async function findForeignDaemon(cfg: DaemonCfg): Promise<DaemonState | null> {
  const own = sanitizeHostname(osHostname());
  const profileId = await getOrCreateProfileId(cfg.profileDir);
  let entries: string[];
  try {
    entries = await readdir(cfg.runtimeDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const m = DAEMON_FILE_RE.exec(name);
    if (!m || m[1] === own) continue;
    const state = await readStateFile(join(cfg.runtimeDir, name));
    if (state && state.profileId === profileId) return state;
  }
  return null;
}

export type DaemonHealth =
  | { alive: true; state: DaemonState }
  | { alive: false; foreign: false; reason: string; staleState: DaemonState | null }
  // A-108: another host's daemon file names this profile. Its PID can't be checked remotely, so
  // this is never "safe to start/attach here" — callers must treat the profile as busy.
  | { alive: false; foreign: true; reason: string; state: DaemonState };

/**
 * C-2 (Codex High): a bare `isProcessAlive(pid)` trusts PID reuse — some unrelated process that
 * happens to reclaim the recorded PID would be treated as "our daemon". Guard it the same way
 * lock.ts's judgeStale() does: the live process's own creation time must not postdate what we
 * recorded when the daemon started. A-122 (Phase 0-B-6): processStartedAt() now works on
 * macOS/Linux too (via `ps -o lstart=`), not just Windows (WMI) — it still returns null on a
 * genuine lookup failure, in which case we fall back to the plain liveness check.
 */
async function verifyOwnedProcess(state: DaemonState): Promise<boolean> {
  if (!defaultLockDeps.isProcessAlive(state.pid)) return false;
  const created = await defaultLockDeps.processStartedAt(state.pid);
  if (!created) return true; // lookup failed: best effort, can't rule out reuse
  const recorded = new Date(state.startedAt);
  if (Number.isNaN(recorded.getTime())) return true;
  return created.getTime() <= recorded.getTime() + 2000;
}

export async function checkDaemon(cfg: DaemonCfg): Promise<DaemonHealth> {
  const state = await readDaemonState(cfg);
  if (state) {
    if (state.profileDir !== cfg.profileDir) {
      return {
        alive: false,
        foreign: false,
        reason: "daemon.json is for a different profile",
        staleState: state,
      };
    }
    if (await verifyOwnedProcess(state)) return { alive: true, state };
    // fall through: our own record is stale (dead/reused pid) — still check for a foreign one
    // below before declaring the profile fully free.
  }
  const foreign = await findForeignDaemon(cfg);
  if (foreign) {
    return {
      alive: false,
      foreign: true,
      reason: `a daemon on host "${foreign.hostname}" already uses this profile`,
      state: foreign,
    };
  }
  return {
    alive: false,
    foreign: false,
    reason: state ? `pid ${state.pid} not running (or reused)` : "no daemon.json",
    staleState: state,
  };
}

/** A free loopback TCP port chosen by the OS, so `daemon start` never collides with (or blindly
 * trusts) a fixed, well-known port another local process might already be listening on. */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("could not determine a free port"));
      });
    });
  });
}

export async function stopDaemon(cfg: DaemonCfg): Promise<{ ok: boolean; detail: string }> {
  // A-108: only ever this host's own path — structurally impossible to touch another host's file.
  const state = await readDaemonState(cfg);
  if (!state) return { ok: true, detail: "no daemon running" };
  const owned = await verifyOwnedProcess(state);
  if (!owned) {
    // C-2: don't kill a PID we can no longer confirm is ours. Leave the (already stale) state
    // file for `doctor`/manual cleanup rather than guessing.
    return {
      ok: false,
      detail: `pid ${state.pid} is not verifiably the daemon we started (dead or reused); not killing it. If it's really gone, delete ${daemonStatePath(cfg)} manually`,
    };
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!defaultLockDeps.isProcessAlive(state.pid)) break;
  }
  if (defaultLockDeps.isProcessAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (!defaultLockDeps.isProcessAlive(state.pid)) break;
    }
  }
  // C-5 (Codex Medium): only report success, and only clean up the state file, once the process
  // has actually exited — otherwise a survived process silently orphans while callers believe
  // the profile is free.
  if (defaultLockDeps.isProcessAlive(state.pid)) {
    return {
      ok: false,
      detail: `pid ${state.pid} did not exit after SIGTERM/SIGKILL; leaving daemon.json so it isn't mistaken for stopped`,
    };
  }
  await unlink(daemonStatePath(cfg)).catch(() => undefined);
  return { ok: true, detail: `stopped pid ${state.pid}` };
}

export async function startDaemon(
  cfg: DaemonCfg,
): Promise<
  { ok: true; state: DaemonState; alreadyRunning: boolean } | { ok: false; cause: string }
> {
  const health = await checkDaemon(cfg);
  if (health.alive) return { ok: true, state: health.state, alreadyRunning: true };
  if (health.foreign) {
    // A-108: another host already has one for this profile — starting our own here would race
    // it for the same Chrome profile lock. Never write here in that case.
    return {
      ok: false,
      cause: `${health.reason}; refusing to start here (would race it for the same profile). If it's really gone, run "daemon stop" on that host, or set CHATGPT_BRIDGE_RUNTIME_DIR to a directory local to each host instead of sharing this one`,
    };
  }

  const hostname = osHostname();
  const profileId = await getOrCreateProfileId(cfg.profileDir);
  const port = Number(process.env.CHATGPT_BRIDGE_DAEMON_PORT ?? (await pickFreePort()));
  await mkdir(cfg.runtimeDir, { recursive: true });
  const workerPath = fileURLToPath(new URL("./daemon-worker.js", import.meta.url));
  const logPath = join(cfg.runtimeDir, `daemon.${sanitizeHostname(hostname)}.log`);
  const { open } = await import("node:fs/promises");
  const logFd = await open(logPath, "a");
  const child = spawn(
    process.execPath,
    [
      workerPath,
      "--profile-dir",
      cfg.profileDir,
      "--channel",
      cfg.channel,
      "--port",
      String(port),
      "--state-path",
      daemonStatePath(cfg, hostname),
      "--hostname",
      hostname,
      "--profile-id",
      profileId,
      "--lock-path",
      join(cfg.runtimeDir, "locks", "bridge.lock"),
      ...(process.env.CHATGPT_BRIDGE_DAEMON_KEEPALIVE_MS
        ? ["--keepalive-ms", process.env.CHATGPT_BRIDGE_DAEMON_KEEPALIVE_MS]
        : []),
    ],
    {
      detached: true,
      stdio: ["ignore", logFd.fd, logFd.fd],
      cwd: dirname(workerPath),
    },
  );
  child.unref();
  await logFd.close();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const state = await readDaemonState(cfg);
    if (state && (await verifyOwnedProcess(state)))
      return { ok: true, state, alreadyRunning: false };
  }
  return { ok: false, cause: `daemon did not become ready within 10s (see ${logPath})` };
}
