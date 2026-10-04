#!/usr/bin/env node
/** Fixed, offline development checks only. No install, model, login, GitHub write or merge. */
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OFFLINE_VERIFICATION_ENV,
  captureSourceStatus,
  combinedSourceFields,
  parseTestSummary,
  phaseOutcome,
  repositoryRootIdentity,
  runWithSourceEvidence,
  sourceMetadata,
  verificationExitCode,
} from "./verification-summary.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let strict = false;
let output = join(root, "runtime", "verification", new Date().toISOString().replace(/[:.]/g, "-"));
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--strict") strict = true;
  else if (args[i] === "--output" && args[i + 1]) output = resolve(args[++i]);
  else {
    process.stderr.write(
      "Usage: node scripts/verify-bridge-v2.mjs [--strict] [--output NEW_DIRECTORY]\n",
    );
    process.exit(2);
  }
}
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
mkdirSync(output, { mode: 0o700 }); // Refuse to replace an existing run's evidence.
const startedAt = new Date().toISOString();
const phases = ["typecheck", "lint", "build", "test"].flatMap((command) =>
  ["root", "gui"].map((scope) => ({
    scope,
    command,
    program: "npm",
    args: ["run", command],
    testSummary: command === "test",
  })),
);
phases.push(
  {
    scope: "root",
    command: "verification-summary",
    program: "node",
    args: ["--test", "scripts/verification-summary.test.mjs"],
    testSummary: true,
  },
  {
    scope: "root",
    command: "issuer-cli",
    program: "node",
    args: ["scripts/test-issuer-cli.mjs"],
    testSummary: true,
  },
  {
    scope: "root",
    command: "sdk-cli-lifecycle",
    program: "node",
    args: ["scripts/test-sdk-cli-lifecycle.mjs"],
    testSummary: true,
  },
);
const gitOptions = {
  cwd: root,
  encoding: "utf8",
  timeout: 10000,
  maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
};
const captureSource = () => {
  const identity = repositoryRootIdentity(
    root,
    spawnSync("git", ["rev-parse", "--show-toplevel"], gitOptions),
    realpathSync,
  );
  return {
    capturedAt: new Date().toISOString(),
    ...sourceMetadata(
      spawnSync("git", ["rev-parse", "HEAD"], gitOptions),
      captureSourceStatus(root, output, (args) => spawnSync("git", args, gitOptions)),
      identity,
    ),
  };
};
const runPhase = (phase) => {
  const cwd = phase.scope === "root" ? root : join(root, "gui");
  const start = new Date().toISOString();
  // Windows npm is an official .cmd launcher; the command and every argument are fixed literals.
  // No task text, model command, secret or user-provided shell fragment enters this invocation.
  const child = spawnSync(phase.program === "node" ? process.execPath : "npm", phase.args, {
    cwd,
    shell: phase.program === "npm" && process.platform === "win32",
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...OFFLINE_VERIFICATION_ENV },
  });
  const text = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  const summary = phase.testSummary ? parseTestSummary(text) : null;
  const outcome = phaseOutcome(child.status, child.error?.code ?? null, phase.testSummary, summary);
  const log = `${phase.scope}-${phase.command}.log`;
  writeFileSync(join(output, log), text, { flag: "wx", mode: 0o600 });
  const result = {
    ...phase,
    startedAt: start,
    finishedAt: new Date().toISOString(),
    exitCode: child.status,
    signal: child.signal,
    ...outcome,
    log,
  };
  process.stdout.write(`${phase.scope} ${phase.command}: ${result.state}\n`);
  return result;
};
// The start snapshot is taken inside this call, before the first phase begins.
const { sourceBefore, results, sourceAfter, evidence } = runWithSourceEvidence(phases, {
  capture: captureSource,
  runPhase,
});
const failed = results.some((item) => ["failed", "blocked"].includes(item.state));
const skipped = results.some((item) => item.skipped > 0 || item.todo > 0);
const report = {
  schema: "bridge-verification-3",
  startedAt,
  finishedAt: new Date().toISOString(),
  environment: { platform: process.platform, node: process.version },
  // Schema-2 field names, now conservative: sourceHead is set only when the start and end
  // snapshots agree, and sourceState/dirty are never cleaner than either snapshot.
  ...combinedSourceFields(sourceBefore, sourceAfter),
  sourceBefore,
  sourceAfter,
  // Phase pass/fail/skip stays separate from whether the results tie to one fixed head.
  sourceEvidence: evidence,
  result: failed ? "failed_or_blocked" : skipped ? "passed_with_skips" : "passed",
  liveModelRun: false,
  testSelection: "offline_BRIDGE_LIVE_0",
  results,
};
writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(`Report: ${join(output, "report.json")}\n`);
process.stdout.write(
  evidence.status === "established"
    ? `Source evidence: established at ${evidence.pinnedHead}\n`
    : `Source evidence: NOT established (${evidence.reasons.join(", ")}); results do not prove a fixed head\n`,
);
process.exitCode = verificationExitCode({
  failed,
  skipped,
  strict,
  evidenceEstablished: evidence.status === "established",
});
