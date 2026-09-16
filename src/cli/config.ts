import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../contracts/schema.js";
import type { LogLevel } from "../diagnostics/logger.js";

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
  };
}
