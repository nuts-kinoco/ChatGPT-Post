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
