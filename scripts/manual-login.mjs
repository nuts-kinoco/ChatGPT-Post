#!/usr/bin/env node
/**
 * Opens a normal (non-automated) Chrome window against the bridge's dedicated profile,
 * for the manual-login fallback documented in SKILL.md (Google SSO rejects automated browsers).
 * Close the window after logging in, then run `chatgpt-bridge doctor` to confirm.
 */
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const profileDir = process.env.CHATGPT_BRIDGE_PROFILE_DIR ?? join(repoRoot, "runtime", "profile");

const candidates =
  process.platform === "win32"
    ? [
        join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        join(
          process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        ),
        join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome"];

let chromePath;
for (const c of candidates) {
  try {
    await access(c, constants.X_OK);
    chromePath = c;
    break;
  } catch {
    /* next */
  }
}
if (!chromePath) {
  console.error("Chrome が見つかりませんでした。候補:\n" + candidates.map((c) => `  ${c}`).join("\n"));
  process.exit(1);
}

console.log(`起動: ${chromePath}`);
console.log(`プロファイル: ${profileDir}`);
console.log("ログイン後、このウィンドウを閉じてから `chatgpt-bridge doctor` で確認してください。");

const child = spawn(chromePath, [`--user-data-dir=${profileDir}`, "https://chatgpt.com/"], {
  detached: true,
  stdio: "ignore",
});
child.unref();
