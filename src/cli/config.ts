import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ExperimentalStealthMode,
  parseExperimentalStealthMode,
} from "../browser/stealth-signals.js";
import { REPO_ROOT } from "../contracts/schema.js";
import type { LogLevel } from "../diagnostics/logger.js";

export const MAX_CONCURRENCY = 8;

export interface BridgeConfig {
  repoRoot: string;
  runtimeDir: string;
  profileDir: string;
  locksDir: string;
  stateDir: string;
  artifactsDir: string;
  channel: "chrome" | "chromium";
  traceOnSuccess: boolean;
  imageViaViewer: boolean;
  logLevel: LogLevel;
  bridgeVersion: string;
  /** Phase 3 MVP (A-136): number of concurrent generation slots against a shared daemon browser.
   * 1 (default) is the pre-Phase-3 behavior: `run` keeps its exclusive `bridge.lock` and reuses the
   * daemon's single page, byte-for-byte unchanged. >1 switches `run` (never `login`/`doctor`) to a
   * slot pool (`state/slot-lock.ts`) and a dedicated Page per slot; see `docs/23-DURABLE-BRIDGE-PHASES.md`
   * Phase 3. On Windows, without a daemon a second concurrent slot holder is stopped by the profile
   * guard before launch with `PROFILE_IN_USE`; other platforms can instead report a browser launch
   * failure when their browser rejects the already-used profile. */
  maxConcurrency: number;
  /** A-140 follow-up experiment only. Off unless explicitly selected through its env var. */
  experimentalStealth: ExperimentalStealthMode;
}

export interface CliOverrides {
  profileDir?: string | undefined;
  logLevel?: string | undefined;
}

/** 10-ARCHITECTURE §9: env vars, overridden by CLI options. No config file. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: CliOverrides = {},
): BridgeConfig {
  // A-108: lets each host keep its own profile/lock/daemon state when the repo itself is on a
  // shared drive (observed live: a Mac session on the same SMB share reclaimed a Windows host's
  // live bridge.lock, since PIDs aren't comparable across machines). Set this to a host-local
  // path whenever runtimeDir would otherwise live on shared/network storage.
  const runtimeDir = resolve(env.CHATGPT_BRIDGE_RUNTIME_DIR ?? join(REPO_ROOT, "runtime"));
  const profileDir = resolve(
    overrides.profileDir ?? env.CHATGPT_BRIDGE_PROFILE_DIR ?? join(runtimeDir, "profile"),
  );
  const channel = env.CHATGPT_BRIDGE_CHANNEL === "chromium" ? "chromium" : "chrome";
  const levelRaw = overrides.logLevel ?? env.CHATGPT_BRIDGE_LOG_LEVEL ?? "info";
  const logLevel: LogLevel = (["debug", "info", "warn", "error"] as const).includes(
    levelRaw as LogLevel,
  )
    ? (levelRaw as LogLevel)
    : "info";
  const maxConcurrencyEnv = env.CHATGPT_BRIDGE_MAX_CONCURRENCY;
  const maxConcurrencyRaw = Number(maxConcurrencyEnv ?? "1");
  let maxConcurrency = 1;
  if (!Number.isInteger(maxConcurrencyRaw) || maxConcurrencyRaw < 1) {
    if (maxConcurrencyEnv !== undefined) {
      process.stderr.write(
        `warning: CHATGPT_BRIDGE_MAX_CONCURRENCY=${JSON.stringify(maxConcurrencyEnv)} is not a positive integer; using 1\n`,
      );
    }
  } else if (maxConcurrencyRaw > MAX_CONCURRENCY) {
    maxConcurrency = MAX_CONCURRENCY;
    process.stderr.write(
      `warning: CHATGPT_BRIDGE_MAX_CONCURRENCY=${maxConcurrencyRaw} exceeds the maximum ${MAX_CONCURRENCY}; using ${MAX_CONCURRENCY}\n`,
    );
  } else {
    maxConcurrency = maxConcurrencyRaw;
  }
  const experimentalStealth = parseExperimentalStealthMode(env.CHATGPT_BRIDGE_EXPERIMENTAL_STEALTH);
  if (experimentalStealth.warning) process.stderr.write(experimentalStealth.warning);
  let bridgeVersion = "0.0.0";
  try {
    bridgeVersion =
      (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string })
        .version ?? bridgeVersion;
  } catch {
    /* keep default */
  }
  return {
    repoRoot: REPO_ROOT,
    runtimeDir,
    profileDir,
    locksDir: join(runtimeDir, "locks"),
    stateDir: join(runtimeDir, "state"),
    artifactsDir: join(runtimeDir, "artifacts"),
    channel,
    traceOnSuccess: env.CHATGPT_BRIDGE_TRACE_ON_SUCCESS === "1",
    imageViaViewer: env.CHATGPT_BRIDGE_IMAGE_VIA_VIEWER === "1",
    logLevel,
    bridgeVersion,
    maxConcurrency,
    experimentalStealth: experimentalStealth.mode,
  };
}
