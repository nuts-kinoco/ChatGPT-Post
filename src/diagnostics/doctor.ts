import { execFile } from "node:child_process";
import { access, constants, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkProfileFree, checkProfilePath } from "../browser/profile-guard.js";
import type { BridgeConfig } from "../cli/config.js";
import { defaultLockDeps, judgeStale, readLockRecord } from "../state/lock.js";

const run = promisify(execFile);

export interface DoctorItem {
  name: string;
  ok: boolean;
  detail: string;
  /** true = informational warning, does not fail doctor */
  warn?: boolean;
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

export async function checkProfileDir(cfg: BridgeConfig): Promise<DoctorItem[]> {
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
  items.push({
    name: "profile.free",
    ok: occ.free,
    detail: occ.free ? "not held by another process" : occ.cause,
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
        ok: hits.length === 0,
        detail:
          hits.length === 0
            ? "no browser process uses this profile"
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

export async function checkLock(cfg: BridgeConfig): Promise<DoctorItem> {
  const path = join(cfg.locksDir, "bridge.lock");
  try {
    await stat(path);
  } catch {
    return { name: "lock", ok: true, detail: "no lock file" };
  }
  const rec = await readLockRecord(path);
  const verdict = await judgeStale(path, rec, defaultLockDeps);
  if (verdict.stale) {
    return {
      name: "lock",
      ok: true,
      warn: true,
      detail: `stale lock (${verdict.reason}); safe to delete ${path}`,
    };
  }
  return {
    name: "lock",
    ok: false,
    detail: `held: pid=${rec?.pid ?? "?"} command=${rec?.command ?? "?"} (${verdict.reason})`,
  };
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

export async function runDoctor(deps: DoctorDeps): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  items.push(await checkNode());
  items.push(await checkPlaywright());
  items.push(await checkBrowserExecutable(deps.cfg));
  items.push(...(await checkProfileDir(deps.cfg)));
  items.push(await checkLock(deps.cfg));
  items.push(...(await checkRuntimeDirs(deps.cfg)));
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
