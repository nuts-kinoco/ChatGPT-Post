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
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLockDeps } from "../state/lock.js";

export interface DaemonState {
  pid: number;
  port: number;
  startedAt: string;
  profileDir: string;
}

export interface DaemonCfg {
  runtimeDir: string;
  profileDir: string;
  channel: "chrome" | "chromium";
}

export function daemonStatePath(cfg: DaemonCfg): string {
  return join(cfg.runtimeDir, "daemon.json");
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
    typeof parsed.profileDir === "string"
  );
}

export async function readDaemonState(cfg: DaemonCfg): Promise<DaemonState | null> {
  try {
    const text = await readFile(daemonStatePath(cfg), "utf8");
    const parsed = JSON.parse(text) as Partial<DaemonState>;
    return isValidState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export type DaemonHealth =
  | { alive: true; state: DaemonState }
  | { alive: false; reason: string; staleState: DaemonState | null };

/**
 * C-2 (Codex High): a bare `isProcessAlive(pid)` trusts PID reuse — some unrelated process that
 * happens to reclaim the recorded PID would be treated as "our daemon". Guard it the same way
 * lock.ts's judgeStale() does: the live process's own creation time must not postdate what we
 * recorded when the daemon started (Windows-only; processStartedAt() returns null elsewhere, in
 * which case we fall back to the plain liveness check).
 */
async function verifyOwnedProcess(state: DaemonState): Promise<boolean> {
  if (!defaultLockDeps.isProcessAlive(state.pid)) return false;
  const created = await defaultLockDeps.processStartedAt(state.pid);
  if (!created) return true; // unknown (non-Windows): best effort, can't rule out reuse
  const recorded = new Date(state.startedAt);
  if (Number.isNaN(recorded.getTime())) return true;
  return created.getTime() <= recorded.getTime() + 2000;
}

export async function checkDaemon(cfg: DaemonCfg): Promise<DaemonHealth> {
  const state = await readDaemonState(cfg);
  if (!state) return { alive: false, reason: "no daemon.json", staleState: null };
  if (state.profileDir !== cfg.profileDir)
    return { alive: false, reason: "daemon.json is for a different profile", staleState: state };
  if (!(await verifyOwnedProcess(state)))
    return { alive: false, reason: `pid ${state.pid} not running (or reused)`, staleState: state };
  return { alive: true, state };
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

  const port = Number(process.env.CHATGPT_BRIDGE_DAEMON_PORT ?? (await pickFreePort()));
  await mkdir(cfg.runtimeDir, { recursive: true });
  const workerPath = fileURLToPath(new URL("./daemon-worker.js", import.meta.url));
  const logPath = join(cfg.runtimeDir, "daemon.log");
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
      daemonStatePath(cfg),
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
