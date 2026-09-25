import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

export interface CliRun { stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null; }
export type CliRunResult = { ok: true; run: CliRun } | { ok: false; reason: string };

export interface RunBridgeCliOptions {
  execPath: string;
  cliPath: string;
  args: string[];
  timeoutMs: number;
  /** Used in failure messages, e.g. "doctor". */
  label: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs the bridge CLI with the GUI's own executable acting as Node (ELECTRON_RUN_AS_NODE).
 * Always collects stderr and the exit status: when the CLI cannot even load (a wrong
 * CHATGPT_BRIDGE_ROOT, an unbuilt checkout) Node reports that only on stderr and stdout stays
 * empty, so a caller that reads stdout alone can only say "returned no JSON".
 */
export async function runBridgeCli(options: RunBridgeCliOptions): Promise<CliRunResult> {
  const { execPath, cliPath, args, timeoutMs, label } = options;
  try { await access(cliPath, constants.R_OK); }
  catch {
    return { ok: false, reason: `Bridge CLI not found at ${cliPath}. Check CHATGPT_BRIDGE_ROOT and run "npm run build" in that checkout.` };
  }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(execPath, [cliPath, ...args], { env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
    } catch (error) {
      resolve({ ok: false, reason: `Could not start ${label}: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CliRunResult) => { if (!settled) { settled = true; clearTimeout(timeout); resolve(result); } };
    const timeout = setTimeout(() => { child.kill(); finish({ ok: false, reason: `${label} timed out` }); }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ ok: false, reason: `Could not start ${label}: ${error.message}` }));
    child.on("close", (exitCode, signal) => finish({ ok: true, run: { stdout, stderr, exitCode, signal } }));
  });
}

const STDERR_SUMMARY_MAX = 300;

/** The most useful stderr line: Node prints the stack header (`node:internal/...`) before the actual error. */
export function summarizeStderr(stderr: string): string {
  const lines = stderr.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const line = lines.find((candidate) => /^(?:[A-Z]\w*Error\b|Error\b|INTERNAL_ERROR\b)/u.test(candidate)) ?? lines[0] ?? "";
  return line.length > STDERR_SUMMARY_MAX ? `${line.slice(0, STDERR_SUMMARY_MAX)}…` : line;
}

/** Exit status and stderr, for appending to an output-parsing failure. */
export function describeCliRun(run: CliRun): string {
  const status = run.exitCode !== null ? `exit ${run.exitCode}` : `killed by ${run.signal ?? "unknown signal"}`;
  const stderr = summarizeStderr(run.stderr);
  return stderr ? `${status}: ${stderr}` : `${status}, no stderr`;
}
