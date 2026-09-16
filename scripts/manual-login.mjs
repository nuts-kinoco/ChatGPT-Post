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
// Mirror cli/config.ts's derivation exactly (CHATGPT_BRIDGE_PROFILE_DIR, else
// <runtimeDir>/profile, where runtimeDir is CHATGPT_BRIDGE_RUNTIME_DIR or <repo>/runtime) — this
// script used to ignore CHATGPT_BRIDGE_RUNTIME_DIR entirely, so setting only that env var made it
// open a different profile than `doctor`/`run` use (reported live on a shared-runtime Mac setup).
const runtimeDir = process.env.CHATGPT_BRIDGE_RUNTIME_DIR ?? join(repoRoot, "runtime");
const profileDir = process.env.CHATGPT_BRIDGE_PROFILE_DIR ?? join(runtimeDir, "profile");

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

// A-108: macOS encrypts cookies with the OS Keychain by default, keyed to how Chrome was
// launched/signed; a mismatch between this manual login and the bridge's own automated Chrome
// launch (browser/launch.ts, daemon-worker.ts) makes the bridge see AUTH_REQUIRED right after a
// login that looked successful here. Both sides must use the same (non-Keychain) cookie storage.
const darwinArgs =
  process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : [];

console.log(`起動: ${chromePath}`);
console.log(`プロファイル: ${profileDir}`);
console.log(
  process.platform === "darwin"
    ? "ログイン後、このウィンドウを閉じ（Dock のアイコンを右クリック→終了、または Chrome を選択して ⌘Q。ウィンドウを閉じるだけでは Chrome プロセスが終了しません）てから `chatgpt-bridge doctor` で確認してください。"
    : "ログイン後、このウィンドウを閉じてから `chatgpt-bridge doctor` で確認してください。",
);

const child = spawn(
  chromePath,
  [`--user-data-dir=${profileDir}`, ...darwinArgs, "https://chatgpt.com/"],
  { detached: true, stdio: "ignore" },
);
child.unref();
