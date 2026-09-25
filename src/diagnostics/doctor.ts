import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { access, constants, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkDaemon, type DaemonHealth } from "../browser/daemon.js";
import { checkProfileFree, checkProfilePath } from "../browser/profile-guard.js";
import type { BridgeConfig } from "../cli/config.js";
import { defaultLockDeps, judgeStale, readLockRecord } from "../state/lock.js";
import { slotPath } from "../state/slot-lock.js";

const run = promisify(execFile);
const TEMP_ARTIFACT_MAX_FILES = 1_000;
const TEMP_ARTIFACT_SCAN_BUDGET_MS = 250;

export interface DoctorItem {
  name: string;
  ok: boolean;
  detail: string;
  /** true = informational warning, does not fail doctor */
  warn?: boolean;
  /** Present only for a successfully parsed single-slot bridge lock. */
  lock?: DoctorLock;
}

/** Machine-readable single-slot lock state for `doctor --json` consumers. */
export interface DoctorLock {
  pid: number;
  requestId: string | null;
  command: string;
  heldSinceMs: number | null;
  heartbeatAgeMs: number | null;
  stale: boolean;
  reclaimable: boolean;
}

export interface DoctorDeps {
  cfg: BridgeConfig;
  /** Launches the browser to check login state; null skips (unit tests). */
  loginProbe: (() => Promise<{ ok: boolean; detail: string }>) | null;
}

export async function checkNode(): Promise<DoctorItem> {
  const major = Number(process.versions.node.split(".")[0]);
  return { name: "node", ok: major >= 20, detail: `v${process.versions.node}` };
}

export async function checkPlaywright(): Promise<DoctorItem> {
  try {
    const pkg = (await import("playwright/package.json", { with: { type: "json" } })) as {
      default?: { version?: string };
    };
    return { name: "playwright", ok: true, detail: pkg.default?.version ?? "unknown" };
  } catch (err) {
    return { name: "playwright", ok: false, detail: (err as Error).message };
  }
}

export async function checkBrowserExecutable(cfg: BridgeConfig): Promise<DoctorItem> {
  try {
    const { chromium } = await import("playwright");
    const path = cfg.channel === "chrome" ? chromium.executablePath() : chromium.executablePath();
    if (cfg.channel === "chrome") {
      const candidates =
        process.platform === "win32"
          ? [
              join(
                process.env.PROGRAMFILES ?? "C:\\Program Files",
                "Google",
                "Chrome",
                "Application",
                "chrome.exe",
              ),
              join(
                process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
                "Google",
                "Chrome",
                "Application",
                "chrome.exe",
              ),
              join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
            ]
          : [
              "/usr/bin/google-chrome",
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            ];
      for (const c of candidates) {
        try {
          await access(c, constants.X_OK);
          return { name: "browser", ok: true, detail: `channel=chrome ${c}` };
        } catch {
          /* next */
        }
      }
      return {
        name: "browser",
        ok: false,
        detail: "Google Chrome not found (set CHATGPT_BRIDGE_CHANNEL=chromium or install Chrome)",
      };
    }
    await access(path, constants.X_OK);
    return { name: "browser", ok: true, detail: `channel=chromium ${path}` };
  } catch (err) {
    return { name: "browser", ok: false, detail: (err as Error).message };
  }
}

export async function checkProfileDir(
  cfg: BridgeConfig,
  daemon: DaemonHealth,
): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  const guard = await checkProfilePath(cfg.profileDir);
  items.push({
    name: "profile.path",
    ok: guard.ok,
    detail: guard.ok ? guard.canonical : guard.cause,
  });
  try {
    await stat(cfg.profileDir);
    items.push({ name: "profile.exists", ok: true, detail: cfg.profileDir });
  } catch {
    items.push({
      name: "profile.exists",
      ok: false,
      detail: `${cfg.profileDir} (run: chatgpt-bridge login)`,
    });
  }
  const occ = await checkProfileFree(cfg.profileDir);
  // A-103/A-108: with a daemon running — ours or, on shared storage, another host's — the profile
  // lockfile is expected to be held. That's not contention, it's the daemon doing its job.
  const daemonExpected = daemon.alive || daemon.foreign;
  const daemonNote = daemon.alive
    ? `pid=${daemon.state.pid}, expected`
    : daemon.foreign
      ? `host="${daemon.state.hostname}" daemon, expected`
      : null;
  items.push({
    name: "profile.free",
    ok: occ.free || daemonExpected,
    detail: occ.free
      ? "not held by another process"
      : daemonNote
        ? `held by daemon (${daemonNote})`
        : occ.cause,
  });
  if (process.platform === "win32") {
    try {
      const { stdout } = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe' OR Name='chromium.exe'\" | Select-Object -ExpandProperty CommandLine",
        ],
        { timeout: 8000, windowsHide: true },
      );
      const needle = cfg.profileDir.toLowerCase();
      const hits = stdout.split(/\r?\n/).filter((l) => l.toLowerCase().includes(needle));
      items.push({
        name: "profile.processes",
        ok: hits.length === 0 || daemonExpected,
        detail:
          hits.length === 0
            ? "no browser process uses this profile"
            : daemonNote
              ? `${hits.length} browser process(es) use this profile (${daemonNote})`
              : `${hits.length} browser process(es) use this profile`,
      });
    } catch {
      items.push({
        name: "profile.processes",
        ok: true,
        warn: true,
        detail: "WMI query unavailable",
      });
    }
  }
  return items;
}

export async function checkDaemonStatus(
  cfg: BridgeConfig,
): Promise<{ item: DoctorItem; health: DaemonHealth }> {
  const health = await checkDaemon({
    runtimeDir: cfg.runtimeDir,
    profileDir: cfg.profileDir,
    channel: cfg.channel,
  });
  return {
    health,
    item: health.alive
      ? {
          name: "daemon",
          ok: true,
          detail: `running: pid=${health.state.pid} port=${health.state.port} pool=${health.state.maxConcurrency} (this process=${cfg.maxConcurrency})`,
        }
      : health.foreign
        ? {
            name: "daemon",
            ok: true,
            warn: true,
            detail: `not running here (${health.reason}); this host treats the profile as busy and refuses to launch its own browser until that daemon is gone`,
          }
        : { name: "daemon", ok: true, warn: true, detail: `not running (${health.reason})` },
  };
}

export async function checkLock(cfg: BridgeConfig): Promise<DoctorItem> {
  const path = join(cfg.locksDir, "bridge.lock");
  if (cfg.maxConcurrency > 1) {
    const details: string[] = [];
    let hasHeld = false;
    let hasStale = false;
    for (let index = 0; index < cfg.maxConcurrency; index++) {
      const slot = slotPath(path, index);
      try {
        await stat(slot);
      } catch {
        details.push(`slot${index} free`);
        continue;
      }
      const rec = await readLockRecord(slot);
      const verdict = await judgeStale(slot, rec, defaultLockDeps);
      if (verdict.stale) {
        hasStale = true;
        details.push(
          `slot${index} abandoned: ${lockDetail(rec, verdict.reason)}; ${verdict.reclaimable ? `safe to run unlock --stale for ${slot}` : "owner is still alive; do not auto-reclaim"}`,
        );
      } else {
        hasHeld = true;
        details.push(`slot${index} held: ${lockDetail(rec, verdict.reason)}`);
      }
    }
    if (hasHeld) return { name: "lock", ok: false, detail: details.join("; ") };
    if (hasStale) return { name: "lock", ok: true, warn: true, detail: details.join("; ") };
    return { name: "lock", ok: true, detail: details.join("; ") };
  }
  try {
    await stat(path);
  } catch {
    return { name: "lock", ok: true, detail: "no lock file" };
  }
  const rec = await readLockRecord(path);
  const verdict = await judgeStale(path, rec, defaultLockDeps);
  const lock = rec ? structuredLock(rec, verdict) : undefined;
  if (verdict.stale) {
    return {
      name: "lock",
      ok: true,
      warn: true,
      detail: `abandoned lock: ${lockDetail(rec, verdict.reason)}; ${verdict.reclaimable ? "safe to run unlock --stale" : "owner is still alive; do not auto-reclaim"}`,
      ...(lock ? { lock } : {}),
    };
  }
  return {
    name: "lock",
    ok: false,
    detail: `held: ${lockDetail(rec, verdict.reason)}`,
    ...(lock ? { lock } : {}),
  };
}

function structuredLock(
  rec: NonNullable<Awaited<ReturnType<typeof readLockRecord>>>,
  verdict: Awaited<ReturnType<typeof judgeStale>>,
): DoctorLock {
  // Preserve malformed persisted timestamps as an explicit null rather than
  // letting JSON.stringify silently turn NaN into null.
  const parseTimestamp = (value: string | undefined): number | null => {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const heartbeatAt = parseTimestamp(rec.heartbeatAt);
  return {
    pid: rec.pid,
    requestId: rec.requestId,
    command: rec.command,
    heldSinceMs: parseTimestamp(rec.startedAt),
    heartbeatAgeMs: heartbeatAt === null ? null : Math.max(0, Date.now() - heartbeatAt),
    stale: verdict.stale,
    reclaimable: verdict.stale && verdict.reclaimable,
  };
}

function lockDetail(rec: Awaited<ReturnType<typeof readLockRecord>>, verdict: string): string {
  const heartbeat = rec?.heartbeatAt ?? rec?.startedAt;
  const at = heartbeat ? new Date(heartbeat).getTime() : Number.NaN;
  const age = Number.isNaN(at) ? "unknown" : `${Math.max(0, Date.now() - at)} ms`;
  return `pid=${rec?.pid ?? "?"} command=${rec?.command ?? "?"} heartbeatAge=${age} (${verdict})`;
}

/**
 * A-108: best-effort, informational only. Detects the common shapes of a network-mounted path
 * (macOS/Linux mounts under /Volumes, /net, /mnt; a raw Windows UNC path) so a human notices
 * before hitting the cross-host lock/daemon/profile corruption this was built to guard against —
 * it cannot detect every case (e.g. a Windows drive letter mapped to a share it itself re-exports,
 * as observed live 2026-09-16) and never fails doctor on its own.
 */
export function looksNetworkMounted(path: string): boolean {
  if (/^[\\/]{2}/.test(path)) return true; // UNC: \\server\share or //server/share
  return /^[\\/](Volumes|net|mnt)[\\/]/i.test(path);
}

/** A-108 (Codex review, Medium): `looksNetworkMounted()` alone misses a mapped Windows drive
 * letter (e.g. `S:\`) that is itself backed by a network share re-exported to other hosts — the
 * exact real-world case reported. `Win32_LogicalDisk.DriveType` (4 = Network) or a non-empty
 * `ProviderName` catches that. Best-effort: any failure (no PowerShell, WMI unavailable, no drive
 * letter) is swallowed and treated as "can't tell", never as a false positive or a doctor failure. */
async function isWindowsMappedNetworkDrive(path: string): Promise<boolean> {
  const drive = /^([A-Za-z]):[\\/]/.exec(path)?.[1];
  if (!drive) return false;
  try {
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}:'"; "$($d.DriveType),$($d.ProviderName)"`,
      ],
      { timeout: 5000, windowsHide: true },
    );
    const [driveType, providerName] = stdout.trim().split(",");
    return driveType === "4" || Boolean(providerName?.trim());
  } catch {
    return false;
  }
}

export async function checkRuntimeLocation(runtimeDir: string): Promise<DoctorItem> {
  const suspect =
    looksNetworkMounted(runtimeDir) ||
    (process.platform === "win32" && (await isWindowsMappedNetworkDrive(runtimeDir)));
  return suspect
    ? {
        name: "runtime.location",
        ok: true,
        warn: true,
        detail: `${runtimeDir} looks network-mounted; if another host shares it, set CHATGPT_BRIDGE_RUNTIME_DIR to a host-local path (A-108)`,
      }
    : { name: "runtime.location", ok: true, detail: runtimeDir };
}

export async function checkRuntimeDirs(cfg: BridgeConfig): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  for (const [name, dir] of [
    ["runtime.locks", cfg.locksDir],
    ["runtime.state", cfg.stateDir],
    ["runtime.artifacts", cfg.artifactsDir],
  ] as const) {
    try {
      await mkdir(dir, { recursive: true });
      await access(dir, constants.W_OK);
      items.push({ name, ok: true, detail: dir });
    } catch (err) {
      items.push({ name, ok: false, detail: `${dir}: ${(err as Error).message}` });
    }
  }
  return items;
}

/** Informational only: killed Playwright runs can leave multi-GB folders under %TEMP%. */
export async function checkTemporaryArtifacts(
  tempRoot = tmpdir(),
  now = Date.now(),
): Promise<DoctorItem> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(tempRoot, { withFileTypes: true });
  } catch (err) {
    return {
      name: "temp.artifacts",
      ok: true,
      warn: true,
      detail: `unable to inspect ${tempRoot}: ${(err as Error).message}`,
    };
  }
  const candidates = entries.filter(
    (entry) => entry.isDirectory() && /^(playwright-artifacts-|bridge-trace-)/i.test(entry.name),
  );
  if (candidates.length === 0)
    return {
      name: "temp.artifacts",
      ok: true,
      detail: "no leftover playwright-artifacts-* or bridge-trace-* folders",
    };
  let bytes = 0;
  let oldest = now;
  let filesSeen = 0;
  let capped = false;
  const deadline = Date.now() + TEMP_ARTIFACT_SCAN_BUDGET_MS;
  const sizeOf = async (dir: string): Promise<void> => {
    if (capped) return;
    let children: Dirent<string>[];
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (filesSeen >= TEMP_ARTIFACT_MAX_FILES || Date.now() >= deadline) {
        capped = true;
        return;
      }
      filesSeen++;
      const path = join(dir, child.name);
      try {
        const info = await stat(path);
        oldest = Math.min(oldest, info.mtimeMs);
        if (child.isDirectory()) await sizeOf(path);
        else bytes += info.size;
      } catch {
        /* raced with a cleanup; omit the entry */
      }
    }
  };
  for (const entry of candidates) await sizeOf(join(tempRoot, entry.name));
  const ageHours = Math.max(0, Math.floor((now - oldest) / 3_600_000));
  const gib = (bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 1 : 2);
  return {
    name: "temp.artifacts",
    ok: true,
    warn: true,
    detail: `${candidates.length} leftover folder(s), ${gib} GiB${capped ? ` minimum from first ${filesSeen} entries (scan capped)` : ""}, oldest ${ageHours}h; inspect then clean ${tempRoot} manually (doctor never deletes them)`,
  };
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  items.push(await checkNode());
  items.push(await checkPlaywright());
  items.push(await checkBrowserExecutable(deps.cfg));
  const { item: daemonItem, health: daemonHealth } = await checkDaemonStatus(deps.cfg);
  items.push(daemonItem);
  items.push(...(await checkProfileDir(deps.cfg, daemonHealth)));
  items.push(await checkLock(deps.cfg));
  items.push(...(await checkRuntimeDirs(deps.cfg)));
  items.push(await checkRuntimeLocation(deps.cfg.runtimeDir));
  items.push(await checkTemporaryArtifacts());
  if (deps.loginProbe) {
    const lockOk = items.find((i) => i.name === "lock")?.ok;
    const profileOk = items.find((i) => i.name === "profile.exists")?.ok;
    if (lockOk && profileOk) {
      const r = await deps.loginProbe();
      items.push({ name: "login", ok: r.ok, detail: r.detail });
    } else {
      items.push({ name: "login", ok: false, detail: "skipped (lock held or profile missing)" });
    }
  }
  return items;
}

export function formatDoctor(items: DoctorItem[]): { text: string; ok: boolean } {
  const lines = items.map(
    (i) => `${i.ok ? (i.warn ? "WARN" : "OK  ") : "NG  "} ${i.name.padEnd(18)} ${i.detail}`,
  );
  return { text: lines.join("\n"), ok: items.every((i) => i.ok) };
}
