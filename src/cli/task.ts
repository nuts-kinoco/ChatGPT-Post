/** Offline Bridge v2 CLI. Never constructs an executor, authority, or browser. */
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../contracts/schema.js";
import {
  loadTaskSpec,
  parseStrictJsonBytes,
  validateTaskResult,
  verifyTaskFileBytes,
} from "../contracts/task.js";
import type { TaskResult } from "../contracts/task-types.js";
import { REQUESTED_MODELS, REQUESTED_PRESETS } from "../contracts/types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
export const TASK_HELP = `chatgpt-bridge task <command> [options]

  validate --request <TaskSpec.json> --task-file <task.md>
  status <request-UUID> [--json]
  result <request-UUID> [--json]
  capabilities [--json]
  schema task|result
  help

validate, capabilities, status, result and errors produce JSON; schema prints JSON Schema.
status/result read the host-local CHATGPT_BRIDGE_RUNTIME_DIR/jobs.db (default runtime/jobs.db).
No production executor or approval authority is configured in this implementation.
receive, submit, approve, start, cancel and reconcile are unavailable and fail closed.
Validation does not grant approval or execute a task. Effort selection is unsupported in v2.
If status is unknown, preserve the UUID and inspect/reconcile; never reexecute automatically.
Offline first trial: npm test -- tests/unit/task-runtime.test.ts
LLM entry: docs/bridge-v2/LLM-QUICKSTART.md
`;

export const TASK_CAPABILITIES = {
  protocol_version: "2.0",
  implementation: "offline-core",
  production_execution: false,
  commands: {
    supported: ["validate", "status", "result", "capabilities", "schema", "help"],
    unavailable: ["receive", "submit", "approve", "start", "cancel", "reconcile"],
  },
  contracts: {
    task: "schemas/task.schema.json",
    result: "schemas/task-result.schema.json",
    exact_raw_utf8_hashing: true,
    duplicate_json_keys: "rejected",
    evidence_authentication: "requires trusted runtime and artifact verification",
  },
  selection: {
    agent: "required protocol ID; no production adapters configured",
    model: "required requested_model protocol ID; no silent fallback",
    effort: { supported: false, reason: "TaskSpec has no effort field" },
  },
  approval: {
    tiers: ["manual", "automatic", "bypass"],
    authority_configured: false,
    policy_activation_from_task: false,
    task_json_is_authorization: false,
  },
  health: { state: "unconfigured", configured: false, verified: false, auth_needed: "unknown" },
  preflight: {
    live_probe: false,
    model_availability: "unverified",
    effort: "unsupported",
    filesystem_and_command_enforcement: "requires configured trusted runtime",
    usage_and_billing: { estimate: null, provenance: "unknown", limits_verified: false },
  },
  workflow: {
    dependency_graph: "detached workflow-1 manifest and workflow-grant-1 authority",
    library_enrollment: true,
    cli_admission: false,
    authority_configured: false,
  },
  destinations: {
    input: "local TaskSpec and task file",
    ledger: "host-local runtime/jobs.db",
    external_delivery: false,
    notifications: false,
    artifact_access: "caller must verify access, size, and SHA-256",
  },
  retry: { automatic_reexecution: false, unknown: "pause and reconcile the same request UUID" },
  legacy_browser_transport: {
    route: "existing run/submit/status/wait/result commands",
    ordinary_chatgpt: "chatgpt_browser",
    dot_work_events: "separate unconfigured notification candidate",
    unchanged: true,
    targets: ["chat", "dot"],
    requested_models: REQUESTED_MODELS,
    requested_presets: REQUESTED_PRESETS,
    note: "Schema 1.x transport completion does not establish Bridge v2 task completion",
  },
  offline_trial: "npm test -- tests/unit/task-runtime.test.ts",
  entry_document: "docs/bridge-v2/LLM-QUICKSTART.md",
} as const;

export type LedgerRead =
  | { kind: "missing-ledger" }
  | { kind: "missing-request" }
  | { kind: "snapshot"; snapshot: string; receiptSnapshot: string | null; sequence: number };
export interface TaskCliDependencies {
  readBytes?: (path: string) => Promise<Uint8Array>;
  readLedger?: (path: string, requestId: string) => Promise<LedgerRead>;
  stdout?: (text: string) => void;
  runtimeDir?: string;
}

/** A snapshot read must not initialize an empty database or mutate the task tables. */
export async function readTaskLedger(path: string, requestId: string): Promise<LedgerRead> {
  try {
    if (!(await stat(path)).isFile()) throw new Error("ledger_path_is_not_a_file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing-ledger" };
    throw error;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_jobs'")
      .get();
    if (!table) return { kind: "missing-ledger" };
    const row = db
      .prepare("SELECT snapshot,sequence FROM task_jobs WHERE request_id=?")
      .get(requestId) as { snapshot: string; sequence: number } | undefined;
    if (!row) return { kind: "missing-request" };
    const receiptTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_receipts'")
      .get();
    const receipt = receiptTable
      ? (db.prepare("SELECT snapshot FROM task_receipts WHERE request_id=?").get(requestId) as
          | { snapshot: string }
          | undefined)
      : undefined;
    return {
      kind: "snapshot",
      snapshot: row.snapshot,
      sequence: row.sequence,
      receiptSnapshot: receipt?.snapshot ?? null,
    };
  } finally {
    db.close();
  }
}

export async function runTaskCli(
  argv: string[],
  dependencies: TaskCliDependencies = {},
): Promise<number> {
  const stdout =
    dependencies.stdout ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const readBytes = dependencies.readBytes ?? readFile;
  const print = (value: unknown) => stdout(`${JSON.stringify(value)}\n`);
  const fail = (code: string, message: string, nextAction: string, exitCode = 2) => {
    print({
      ok: false,
      code,
      message,
      retryable: false,
      reexecute: false,
      next_action: nextAction,
    });
    return exitCode;
  };
  let args: ReturnType<
    typeof parseArgs<{
      options: {
        request: { type: "string" };
        "task-file": { type: "string" };
        json: { type: "boolean" };
        help: { type: "boolean" };
      };
      allowPositionals: true;
    }>
  >;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        request: { type: "string" },
        "task-file": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    return fail(
      "invalid_arguments",
      error instanceof Error ? error.message : String(error),
      "Run task help; remove unsupported arguments",
    );
  }
  const { values, positionals } = args;
  const command = positionals[0];
  if (values.help || command === "help" || !command) {
    stdout(TASK_HELP);
    return 0;
  }
  if (["receive", "submit", "approve", "start", "cancel", "reconcile"].includes(command))
    return fail(
      "capability_unavailable",
      `task ${command} requires a configured trusted authority/runtime adapter; this CLI has none`,
      "Use task validate and the offline test trial. Do not switch to legacy submit to execute a v2 TaskSpec",
      4,
    );
  if (command !== "validate" && (values.request !== undefined || values["task-file"] !== undefined))
    return fail(
      "invalid_arguments",
      "--request and --task-file apply only to task validate",
      "Run task help",
    );
  if (command === "capabilities") {
    if (positionals.length !== 1)
      return fail(
        "invalid_arguments",
        "capabilities accepts no positional arguments",
        "Run task capabilities",
      );
    print(TASK_CAPABILITIES);
    return 0;
  }
  if (command === "schema") {
    if (positionals.length !== 2 || !["task", "result"].includes(positionals[1] ?? ""))
      return fail(
        "invalid_arguments",
        "schema requires task or result",
        "Run task schema task or task schema result",
      );
    try {
      const name = positionals[1] === "task" ? "task.schema.json" : "task-result.schema.json";
      stdout(
        `${Buffer.from(await readBytes(join(REPO_ROOT, "schemas", name)))
          .toString("utf8")
          .trimEnd()}\n`,
      );
      return 0;
    } catch (error) {
      return fail(
        "schema_unreadable",
        error instanceof Error ? error.message : String(error),
        "Restore the schemas directory from this exact repository revision",
        1,
      );
    }
  }
  if (command === "validate") {
    if (positionals.length !== 1 || !values.request || !values["task-file"])
      return fail(
        "invalid_arguments",
        "validate requires --request <TaskSpec.json> --task-file <task.md>",
        "Run task help",
      );
    try {
      const loaded = loadTaskSpec(await readBytes(resolve(values.request)));
      if (!loaded.valid)
        return fail(
          "invalid_task",
          loaded.errors.join("; "),
          "Fix TaskSpec against task schema task; preserve original bytes when hashing",
        );
      const verified = verifyTaskFileBytes(
        loaded.task,
        await readBytes(resolve(values["task-file"])),
      );
      if (!verified.valid)
        return fail(
          "task_file_hash_mismatch",
          verified.errors.join("; "),
          "Set task_file_hash to SHA-256 of the exact task file bytes before obtaining approval",
        );
      print({
        ok: true,
        command: "validate",
        request_id: loaded.task.request_id,
        task_spec_hash: loaded.taskSpecHash,
        task_file_hash: loaded.task.task_file_hash,
        mode: loaded.task.mode,
        schema_valid: true,
        task_file_hash_valid: true,
        approved: false,
        executable: false,
        reason:
          loaded.task.mode === "design_fixture"
            ? "fixture_not_executable"
            : "production_executor_and_authority_not_configured",
      });
      return 0;
    } catch (error) {
      return fail(
        "input_unreadable",
        error instanceof Error ? error.message : String(error),
        "Check the two local paths and file permissions",
        2,
      );
    }
  }
  if (command !== "status" && command !== "result")
    return fail("unknown_task_command", `Unknown task command: ${command}`, "Run task help");
  const requestId = positionals[1];
  if (positionals.length !== 2 || !requestId || !UUID.test(requestId))
    return fail(
      "invalid_request_id",
      "status/result require one canonical lowercase request UUID",
      "Use the original TaskSpec request_id",
    );
  try {
    const runtimeDir =
      dependencies.runtimeDir ??
      resolve(process.env.CHATGPT_BRIDGE_RUNTIME_DIR ?? join(REPO_ROOT, "runtime"));
    const row = await (dependencies.readLedger ?? readTaskLedger)(
      join(runtimeDir, "jobs.db"),
      requestId,
    );
    if (row.kind === "missing-ledger")
      return fail(
        "ledger_not_initialized",
        "No Bridge v2 task ledger exists at this runtime location",
        "Check CHATGPT_BRIDGE_RUNTIME_DIR. Validation alone does not create a task",
        4,
      );
    if (row.kind === "missing-request")
      return fail(
        "request_not_found",
        "The request UUID is not in this task ledger",
        "Check the original UUID and host-local runtime directory; do not create a replacement request",
        4,
      );
    const record = parseStrictJsonBytes(Buffer.from(row.snapshot)) as {
      rawSpec?: unknown;
      taskBytesBase64?: unknown;
      result?: unknown;
    } | null;
    if (!record || typeof record.rawSpec !== "string" || typeof record.taskBytesBase64 !== "string")
      return fail(
        "ledger_invalid",
        "Stored task snapshot is malformed",
        "Preserve the ledger and investigate; do not rerun",
        4,
      );
    const task = loadTaskSpec(Buffer.from(record.rawSpec));
    if (!task.valid)
      return fail(
        "ledger_invalid",
        task.errors.join("; "),
        "Preserve the ledger and investigate its task bytes",
        4,
      );
    if (!verifyTaskFileBytes(task.task, Buffer.from(record.taskBytesBase64, "base64")).valid)
      return fail(
        "ledger_invalid",
        "Stored task file hash is inconsistent",
        "Preserve the ledger; reconcile through a trusted runtime",
        4,
      );
    const checked = validateTaskResult(record.result, {
      task: task.task,
      taskSpecHash: task.taskSpecHash,
    });
    if (!checked.valid)
      return fail(
        "ledger_invalid",
        checked.errors.join("; "),
        "Preserve the ledger; reconcile through a trusted runtime",
        4,
      );
    const result = record.result as TaskResult;
    if (result.request_id !== requestId || row.sequence !== result.observation_seq)
      return fail(
        "ledger_invalid",
        "Ledger row identity or sequence does not match the snapshot",
        "Preserve the ledger; do not trust this result or rerun",
        4,
      );
    const terminal = TERMINAL.has(result.status);
    if (
      terminal &&
      (row.receiptSnapshot !== row.snapshot ||
        (!result.synthetic && result.receipt?.ledger_sequence !== result.observation_seq))
    )
      return fail(
        "terminal_receipt_missing_or_mismatched",
        "The terminal snapshot is not matched by its durable receipt row",
        "Do not report completion; reconcile the original UUID through a trusted runtime",
        4,
      );
    if (command === "result" && !terminal)
      return fail(
        result.status === "unknown" ? "outcome_unknown" : "result_not_terminal",
        `Task status is ${result.status}; no terminal result is established`,
        result.status === "unknown"
          ? "Pause and reconcile the same UUID through a trusted runtime; never retry execution"
          : `Poll task status ${requestId}; do not resubmit`,
        6,
      );
    print({
      ok: true,
      command,
      source: "local-ledger",
      structural_and_semantic_validation: "passed",
      evidence_authentication: "not_performed_by_cli",
      reexecute: false,
      result,
    });
    return 0;
  } catch (error) {
    return fail(
      "ledger_unreadable",
      error instanceof Error ? error.message : String(error),
      "Check Node >=22.13, runtime access and ledger integrity; preserve the UUID and do not rerun",
      4,
    );
  }
}
