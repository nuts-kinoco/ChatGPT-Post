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
  const configured = configuredRoot?.trim();
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
