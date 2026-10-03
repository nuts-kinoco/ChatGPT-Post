/** Fixed provider invocation plans. These are inputs to an enforcing broker, NOT a sandbox. */

import { isAbsolute } from "node:path";
import { createFramedPrompt, type ResponseFrameIdentity } from "../contracts/response-frame.js";
import { hashArgv, validateTaskSpec, verifyTaskFileBytes } from "../contracts/task.js";
import type { TaskSpec } from "../contracts/task-types.js";
import type { ExecutionIdentity } from "../state/task-executor.js";
import type { RunIntent } from "../state/task-store.js";
import { type AntigravityCliCapabilities, validateAntigravityCapabilities } from "./antigravity.js";
import { createSessionBootstrap, type SessionBootstrapPlan } from "./session-bootstrap.js";

export interface CliInstallation {
  agent: "claude" | "codex" | "antigravity";
  /** Required observed help/version contract for Antigravity; never supplied by a task. */
  antigravity?: AntigravityCliCapabilities;
  executable: string;
  executableSha256: string;
  version: string;
  models: readonly string[];
  repoId: string;
  repoRoot: string;
  homeRoot: string;
  /** Explicit provider control-plane route; no inference of subscription/API interchangeability. */
  authentication: "subscription" | "api";
}
export interface CliLaunchPlan {
  protocol: "bridge-cli-launch/1";
  identity: ExecutionIdentity;
  executable: string;
  executableSha256: string;
  version: string;
  argv: string[];
  argvSha256: string;
  cwd: string;
  environment: Record<string, string>;
  stdinBase64: string;
  responseFrame: ResponseFrameIdentity;
  bootstrap: SessionBootstrapPlan;
  deadlineAt: string;
  task: TaskSpec;
  authentication: "subscription" | "api";
  io: { stdin: "pipe"; stdout: "pipe"; stderr: "pipe"; tty: false; shell: false };
}
export function checkedIdentity(id: ExecutionIdentity): void {
  if (
    !id ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(id.requestId) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(id.runId) ||
    !/^[a-f0-9]{64}$/.test(id.taskSpecHash) ||
    !Number.isSafeInteger(id.fencingToken) ||
    id.fencingToken < 1
  )
    throw new Error("cli_identity_invalid");
}
export function sameCliIdentity(a: ExecutionIdentity, b: ExecutionIdentity): boolean {
  return (
    a.requestId === b.requestId &&
    a.taskSpecHash === b.taskSpecHash &&
    a.runId === b.runId &&
    a.fencingToken === b.fencingToken
  );
}
export function validateInstallation(install: CliInstallation): void {
  if (
    !["claude", "codex", "antigravity"].includes(install.agent) ||
    !/^[a-f0-9]{64}$/.test(install.executableSha256) ||
    !install.version ||
    !install.models.length ||
    ![install.executable, install.repoRoot, install.homeRoot].every(
      (p) => isAbsolute(p) && !p.includes("\0"),
    ) ||
    !["subscription", "api"].includes(install.authentication)
  )
    throw new Error("cli_installation_invalid");
  if (install.agent === "antigravity") {
    if (!install.antigravity) throw new Error("antigravity_capability_unavailable");
    validateAntigravityCapabilities(install.antigravity, install.version);
  } else if (install.antigravity !== undefined) throw new Error("cli_installation_invalid");
}
export function createCliLaunchPlan(
  task: TaskSpec,
  taskBytes: Uint8Array,
  identity: ExecutionIdentity,
  intent: RunIntent,
  install: CliInstallation,
  now = new Date(),
): CliLaunchPlan {
  checkedIdentity(identity);
  validateInstallation(install);
  if (!validateTaskSpec(task).valid || !verifyTaskFileBytes(task, taskBytes).valid)
    throw new Error("cli_task_invalid");
  if (task.mode === "design_fixture") throw new Error("fixture_not_executable");
  if (
    task.agent !== install.agent ||
    task.repo !== install.repoId ||
    !install.models.includes(task.requested_model)
  )
    throw new Error("cli_agent_model_repo_denied");
  if (
    task.request_id !== identity.requestId ||
    intent.runId !== identity.runId ||
    intent.fencingToken !== identity.fencingToken ||
    !intent.executorId ||
    !intent.resourceKeys.length ||
    new Set(intent.resourceKeys).size !== intent.resourceKeys.length
  )
    throw new Error("cli_intent_mismatch");
  const deadline = Date.parse(intent.deadlineAt);
  if (
    !Number.isFinite(deadline) ||
    deadline <= now.getTime() ||
    deadline > now.getTime() + task.timeout.run_seconds * 1000
  )
    throw new Error("cli_deadline_invalid");
  // stdin wraps the verified task-file bytes with identity-bound transport framing; no task text enters argv.
  // CLI permissions are defense in depth only; the installed supervisor MUST mediate operations.
  const argv =
    install.agent === "claude"
      ? [
          "--print",
          "--input-format",
          "text",
          "--output-format",
          "stream-json",
          "--verbose",
          "--model",
          task.requested_model,
          "--permission-mode",
          "dontAsk",
          "--no-session-persistence",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--setting-sources",
          "",
        ]
      : install.agent === "antigravity"
        ? [
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--model",
            task.requested_model,
            "--print-timeout",
            `${Math.ceil((deadline - now.getTime()) / 1000)}s`,
            "--disable-slash-commands",
            "--sandbox",
          ]
        : [
            "--ask-for-approval",
            "never",
            "exec",
            "--json",
            "--sandbox",
            task.mode === "read_only" ? "read-only" : "workspace-write",
            "--model",
            task.requested_model,
            "--cd",
            install.repoRoot,
            "-",
          ];
  const bootstrap = createSessionBootstrap({
    sessionId: identity.runId,
    provider: install.agent,
    role: "response_producer",
    repoId: task.repo,
    contextEpoch: 1,
  });
  const framedPrompt = Buffer.concat([
    Buffer.from(
      `Bridge-launched new-session bootstrap metadata (not authority): ${bootstrap.reminderJson}\n\n`,
    ),
    Buffer.from(
      createFramedPrompt(taskBytes, {
        requestId: identity.requestId,
        taskSpecHash: identity.taskSpecHash,
        attemptId: identity.runId,
      }),
    ),
  ]);
  const stdin =
    install.agent === "antigravity"
      ? Buffer.from(
          `${JSON.stringify({ event: "user", message: { content: Buffer.from(framedPrompt).toString("utf8") } })}\n`,
        )
      : framedPrompt;
  const home = `${install.homeRoot}/${identity.runId}`;
  return {
    protocol: "bridge-cli-launch/1",
    identity: structuredClone(identity),
    executable: install.executable,
    executableSha256: install.executableSha256,
    version: install.version,
    argv,
    argvSha256: hashArgv(argv),
    cwd: install.repoRoot,
    environment: {
      HOME: home,
      CODEX_HOME: `${home}/codex`,
      CLAUDE_CONFIG_DIR: `${home}/claude`,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
    bootstrap,
    responseFrame: {
      requestId: identity.requestId,
      taskSpecHash: identity.taskSpecHash,
      attemptId: identity.runId,
    },
    stdinBase64: Buffer.from(stdin).toString("base64"),
    deadlineAt: intent.deadlineAt,
    task: structuredClone(task),
    authentication: install.authentication,
    io: { stdin: "pipe", stdout: "pipe", stderr: "pipe", tty: false, shell: false },
  };
}
