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

export function resolveBridgePaths(isPackaged: boolean, configuredRoot: string | undefined, mainDirectory: string): BridgePaths | BridgePathsError {
  const configured = configuredRoot?.trim();
  const root = configured ? path.resolve(configured) : isPackaged ? null : path.resolve(mainDirectory, "../../..");
  if (!root) {
    return {
      ok: false,
      error: "Set CHATGPT_BRIDGE_ROOT to the chatgpt-web-bridge repository path, then restart ChatGPT Bridge Control.",
    };
  }
  return {
    ok: true,
    root,
    cliPath: path.join(root, "dist", "cli", "main.js"),
    requestsPath: path.join(root, "runtime", "requests"),
    profileDir: path.join(root, "runtime", "profile"),
  };
}
