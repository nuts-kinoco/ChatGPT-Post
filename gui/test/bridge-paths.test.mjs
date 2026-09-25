import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveBridgePaths } from "../dist/main/bridge-paths.js";
import { portableExecutablePath } from "../dist/main/login-item.js";

test("configured bridge root wins in development and packaged builds", () => {
  const configuredRoot = path.resolve("configured-bridge");
  for (const isPackaged of [false, true]) {
    assert.deepEqual(resolveBridgePaths(isPackaged, configuredRoot, path.resolve("gui", "dist", "main")), {
      ok: true,
      root: configuredRoot,
      cliPath: path.join(configuredRoot, "dist", "cli", "main.js"),
      requestsPath: path.join(configuredRoot, "runtime", "requests"),
      profileDir: path.join(configuredRoot, "runtime", "profile"),
    });
  }
});

test("development falls back to the repository relative to the compiled main directory", () => {
  const repositoryRoot = path.resolve("repo");
  const result = resolveBridgePaths(false, undefined, path.join(repositoryRoot, "gui", "dist", "main"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.root, repositoryRoot);
});

test("runtime and profile environment overrides use the CLI's precedence", () => {
  const root = path.resolve("configured-bridge");
  const runtime = path.resolve("custom-runtime");
  const profile = path.resolve("custom-profile");
  const main = path.resolve("gui", "dist", "main");
  const runtimeOnly = resolveBridgePaths(false, root, main, { CHATGPT_BRIDGE_RUNTIME_DIR: runtime });
  assert.equal(runtimeOnly.ok, true);
  if (runtimeOnly.ok) {
    assert.equal(runtimeOnly.requestsPath, path.join(runtime, "requests"));
    assert.equal(runtimeOnly.profileDir, path.join(runtime, "profile"));
  }
  const profileOnly = resolveBridgePaths(false, root, main, { CHATGPT_BRIDGE_PROFILE_DIR: profile });
  assert.equal(profileOnly.ok, true);
  if (profileOnly.ok) {
    assert.equal(profileOnly.requestsPath, path.join(root, "runtime", "requests"));
    assert.equal(profileOnly.profileDir, profile);
  }
  const both = resolveBridgePaths(false, root, main, { CHATGPT_BRIDGE_RUNTIME_DIR: runtime, CHATGPT_BRIDGE_PROFILE_DIR: profile });
  assert.equal(both.ok, true);
  if (both.ok) {
    assert.equal(both.requestsPath, path.join(runtime, "requests"));
    assert.equal(both.profileDir, profile);
  }
});

test("packaged builds reject a missing or blank configured bridge root", () => {
  for (const configuredRoot of [undefined, "   "]) {
    const result = resolveBridgePaths(true, configuredRoot, path.resolve("resources", "app.asar", "dist", "main"));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /CHATGPT_BRIDGE_ROOT/);
  }
});

test("portable executable path is used only when the environment value is meaningful", () => {
  assert.equal(portableExecutablePath(" C:\\Tools\\ChatGPT Bridge Control.exe "), "C:\\Tools\\ChatGPT Bridge Control.exe");
  assert.equal(portableExecutablePath(undefined), undefined);
  assert.equal(portableExecutablePath("  "), undefined);
});

test("configured bridge root tolerates surrounding quotes kept by cmd.exe `set`", () => {
  const configuredRoot = path.resolve("configured-bridge");
  const result = resolveBridgePaths(true, ` "${configuredRoot}" `, path.resolve("resources", "app.asar", "dist", "main"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.cliPath, path.join(configuredRoot, "dist", "cli", "main.js"));
});

test("configured bridge root must be absolute because the portable build runs from a temp directory", () => {
  for (const isPackaged of [false, true]) {
    const result = resolveBridgePaths(isPackaged, "..\\chatgpt-web-bridge", path.resolve("gui", "dist", "main"));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /absolute/);
  }
});
