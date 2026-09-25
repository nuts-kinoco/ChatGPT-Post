import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describeCliRun, runBridgeCli, summarizeStderr } from "../dist/main/cli-process.js";

const scratch = await mkdtemp(path.join(os.tmpdir(), "bridge-cli-"));
const script = async (name, body) => { const file = path.join(scratch, name); await writeFile(file, body); return file; };

test("a missing CLI is reported by path instead of as empty output", async () => {
  const cliPath = path.join(scratch, "missing", "dist", "cli", "main.js");
  const result = await runBridgeCli({ execPath: process.execPath, cliPath, args: ["doctor", "--json"], timeoutMs: 5000, label: "doctor" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /Bridge CLI not found at .*main\.js.*CHATGPT_BRIDGE_ROOT/);
});

test("stdout, stderr, exit code and arguments are all captured", async () => {
  const cliPath = await script("echo.mjs", "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE }) + '\\n'); process.stderr.write('warned\\n'); process.exitCode = 1;");
  const result = await runBridgeCli({ execPath: process.execPath, cliPath, args: ["doctor", "--json"], timeoutMs: 5000, label: "doctor" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(JSON.parse(result.run.stdout), { args: ["doctor", "--json"], node: "1" });
  assert.equal(result.run.stderr, "warned\n");
  assert.equal(result.run.exitCode, 1);
});

test("a CLI that crashes before printing JSON is described by exit code and its error line", async () => {
  const cliPath = await script("crash.mjs", "await import('./does-not-exist.mjs');");
  const result = await runBridgeCli({ execPath: process.execPath, cliPath, args: [], timeoutMs: 5000, label: "doctor" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.run.stdout, "");
  assert.match(describeCliRun(result.run), /^exit 1: Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module/);
});

test("a hung CLI times out", async () => {
  const cliPath = await script("hang.mjs", "setInterval(() => {}, 1000);");
  const result = await runBridgeCli({ execPath: process.execPath, cliPath, args: [], timeoutMs: 300, label: "doctor poll" });
  assert.deepEqual(result, { ok: false, reason: "doctor poll timed out" });
});

test("stderr summary skips Node's stack header and prefers the error line", () => {
  assert.equal(summarizeStderr("node:internal/modules/cjs/loader:1393\n  throw err;\n  ^\n\nError: Cannot find module 'C:\\x\\main.js'\n    at Module._resolveFilename"), "Error: Cannot find module 'C:\\x\\main.js'");
  assert.equal(summarizeStderr("something odd\nmore"), "something odd");
  assert.equal(summarizeStderr(""), "");
  assert.equal(describeCliRun({ stdout: "", stderr: "", exitCode: 0, signal: null }), "exit 0, no stderr");
});

test("a missing ICU data file next to the executable is reported instead of spawning a child that crashes", async () => {
  const cliPath = await script("never-run.mjs", "process.stdout.write('ran');");
  const result = await runBridgeCli({ execPath: process.execPath, execPathSiblings: ["icudtl-missing-for-test.dat"], cliPath, args: [], timeoutMs: 5000, label: "doctor poll" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /^Cannot start doctor poll: icudtl-missing-for-test\.dat is missing from .*Quit ChatGPT Bridge Control/);
});

test("present executable siblings do not block the run", async () => {
  const cliPath = await script("ok.mjs", "process.stdout.write('ran');");
  const sibling = path.basename(process.execPath);
  const result = await runBridgeCli({ execPath: process.execPath, execPathSiblings: [sibling], cliPath, args: [], timeoutMs: 5000, label: "doctor" });
  assert.equal(result.ok && result.run.stdout, "ran");
});
