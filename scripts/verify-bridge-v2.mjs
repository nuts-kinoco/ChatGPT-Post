#!/usr/bin/env node
/** Fixed, offline development checks only. No install, model, login, GitHub write or merge. */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let strict = false;
let output = join(root, "runtime", "verification", new Date().toISOString().replace(/[:.]/g, "-"));
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--strict") strict = true;
  else if (args[i] === "--output" && args[i + 1]) output = resolve(args[++i]);
  else { process.stderr.write("Usage: node scripts/verify-bridge-v2.mjs [--strict] [--output NEW_DIRECTORY]\n"); process.exit(2); }
}
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
mkdirSync(output, { mode: 0o700 }); // Refuse to replace an existing run's evidence.
const startedAt = new Date().toISOString();
const phases = ["typecheck", "lint", "build", "test"].flatMap(command => [{ scope: "root", command }, { scope: "gui", command }]);
const results = [];
for (const phase of phases) {
  const cwd = phase.scope === "root" ? root : join(root, "gui");
  const start = new Date().toISOString();
  // Windows npm is an official .cmd launcher; the command and every argument are fixed literals.
  // No task text, model command, secret or user-provided shell fragment enters this invocation.
  const child = spawnSync("npm", ["run", phase.command], { cwd, shell: process.platform === "win32", encoding: "utf8", timeout: 300000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  const text = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  const skipped = phase.command === "test" ? Number(text.match(/(\d+) skipped/)?.[1] ?? text.match(/skipped (\d+)/)?.[1] ?? 0) : 0;
  const passed = phase.command === "test" ? Number(text.match(/Tests\s+(\d+) passed/)?.[1] ?? text.match(/pass (\d+)/)?.[1] ?? 0) : null;
  const log = `${phase.scope}-${phase.command}.log`;
  writeFileSync(join(output, log), text, { flag: "wx", mode: 0o600 });
  results.push({ ...phase, startedAt: start, finishedAt: new Date().toISOString(), exitCode: child.status, signal: child.signal, state: child.error ? "blocked" : child.status !== 0 ? "failed" : skipped ? "passed_with_skips" : "passed", passed, skipped, error: child.error?.code ?? null, log });
  process.stdout.write(`${phase.scope} ${phase.command}: ${results.at(-1).state}\n`);
}
const failed = results.some(item => ["failed", "blocked"].includes(item.state));
const skipped = results.some(item => item.skipped > 0);
const report = { schema: "bridge-verification-1", startedAt, finishedAt: new Date().toISOString(), environment: { platform: process.platform, node: process.version }, sourceHead: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() ?? null, dirty: Boolean(spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout?.trim()), result: failed ? "failed_or_blocked" : skipped ? "passed_with_skips" : "passed", liveModelRun: false, results };
writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`Report: ${join(output, "report.json")}\n`);
process.exitCode = failed ? 1 : strict && skipped ? 2 : 0;
