import path from "node:path";

export interface BridgePaths {
  ok: true;
  root: string;
  cliPath: string;
  requestsPath: string;
  profileDir: string;
}

export interface BridgePathsError {
  ok: false;
  error: string;
}

export function resolveBridgePaths(isPackaged: boolean, configuredRoot: string | undefined, mainDirectory: string, env: NodeJS.ProcessEnv = process.env): BridgePaths | BridgePathsError {
  // `set CHATGPT_BRIDGE_ROOT="C:\path"` in cmd.exe keeps the quotes in the value.
  const configured = configuredRoot?.trim().replace(/^"(.*)"$/su, "$1").trim();
  if (configured && !path.isAbsolute(configured)) {
    // The portable build runs from a temporary extraction directory, so a relative root would resolve there.
    return {
      ok: false,
      error: `CHATGPT_BRIDGE_ROOT must be an absolute path (got "${configured}"). Set it to the chatgpt-web-bridge repository path, then restart ChatGPT Bridge Control.`,
    };
  }
  const root = configured ? path.resolve(configured) : isPackaged ? null : path.resolve(mainDirectory, "../../..");
  if (!root) {
    return {
      ok: false,
      error: "Set CHATGPT_BRIDGE_ROOT to the chatgpt-web-bridge repository path, then restart ChatGPT Bridge Control.",
    };
  }
  const runtimeDir = path.resolve(env.CHATGPT_BRIDGE_RUNTIME_DIR ?? path.join(root, "runtime"));
  const profileDir = path.resolve(env.CHATGPT_BRIDGE_PROFILE_DIR ?? path.join(runtimeDir, "profile"));
  return {
    ok: true,
    root,
    cliPath: path.join(root, "dist", "cli", "main.js"),
    requestsPath: path.join(runtimeDir, "requests"),
    profileDir,
  };
}
