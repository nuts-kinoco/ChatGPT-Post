import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { REPO_ROOT, type ValidationOutcome } from "./schema.js";
import type {
  ApprovalEnvelope,
  ArtifactRef,
  ProcessIdentity,
  TaskResult,
  TaskSpec,
} from "./task-types.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(ajv);
let taskValidator: ValidateFunction | undefined;
let resultValidator: ValidateFunction | undefined;
let approvalValidator: ValidateFunction | undefined;
const TASK_SCHEMA_ID = "https://example.invalid/bridge-v2/task.schema.json";
const RESERVED_PATH_COMPONENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const TERMINAL = new Set(["cancelled", "succeeded", "failed"]);

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** Protocol limits apply to the original byte sequences, before parsing or hashing. */
export const MAX_TASK_SPEC_BYTES = 256 * 1024;
export const MAX_TASK_FILE_BYTES = 1024 * 1024;

/** SHA-256(uint64BE(argc) || (uint64BE(UTF8(arg).length) || UTF8(arg))*). */
export function hashArgv(argv: readonly string[]): string {
  const digest = createHash("sha256");
  const frame = Buffer.alloc(8);
  frame.writeBigUInt64BE(BigInt(argv.length));
  digest.update(frame);
  for (const argument of argv) {
    if (/[\uD800-\uDFFF]/u.test(argument))
      throw new Error("argv contains an unpaired Unicode surrogate");
    const bytes = Buffer.from(argument, "utf8");
    frame.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(frame);
    digest.update(bytes);
  }
  return digest.digest("hex");
}

function decodeStrictUtf8(bytes: Uint8Array, label: string): string {
  if (
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  )
    throw new Error(`${label} must be UTF-8 without a BOM`);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label} contains invalid UTF-8`);
  }
}

/** Parse exactly the supplied UTF-8 bytes. No BOM stripping or normalization occurs. */
export function parseStrictJsonBytes(bytes: Uint8Array): unknown {
  return parseCheckedJsonBytes(bytes, false);
}
/** External provider telemetry may contain fractional durations. Never use this for Bridge wire records. */
export function parseStrictProviderJsonBytes(bytes: Uint8Array): unknown {
  return parseCheckedJsonBytes(bytes, true);
}
function parseCheckedJsonBytes(bytes: Uint8Array, allowFractions: boolean): unknown {
  const source = decodeStrictUtf8(bytes, "JSON");
  // JSON.parse checks grammar; the second pass rejects duplicate decoded member names.
  const parsed: unknown = JSON.parse(source);
  let cursor = 0;
  const whitespace = () => {
    while (source[cursor] !== undefined && /[\x20\t\r\n]/.test(source[cursor] as string)) cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    while (cursor < source.length) {
      const char = source[cursor++];
      if (char === "\\") cursor++;
      else if (char === '"') return JSON.parse(source.slice(start, cursor)) as string;
    }
    throw new Error("Unterminated JSON string");
  };
  const value = (depth: number): void => {
    if (depth > 256) throw new Error("JSON nesting exceeds 256 levels");
    whitespace();
    const char = source[cursor];
    if (char === '"') {
      string();
      return;
    }
    if (char === "{") {
      cursor++;
      whitespace();
      const keys = new Set<string>();
      if (source[cursor] === "}") {
        cursor++;
        return;
      }
      while (cursor < source.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error(`Duplicate JSON key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        cursor++; // colon; grammar was already validated
        value(depth + 1);
        whitespace();
        if (source[cursor++] === "}") return;
      }
    } else if (char === "[") {
      cursor++;
      whitespace();
      if (source[cursor] === "]") {
        cursor++;
        return;
      }
      while (cursor < source.length) {
        value(depth + 1);
        whitespace();
        if (source[cursor++] === "]") return;
      }
    } else {
      while (cursor < source.length && !/[\x20\t\r\n,\]}]/.test(source[cursor] as string)) cursor++;
    }
  };
  value(0);
  const numberErrors = safeNumbers(parsed, allowFractions);
  if (numberErrors.length) throw new Error(numberErrors.join("; "));
  return parsed;
}

function safeNumbers(data: unknown, allowFractions = false): string[] {
  const errors: string[] = [];
  const pending: { value: unknown; path: string }[] = [{ value: data, path: "" }];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    const { value, path } = current;
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        Math.abs(value) > Number.MAX_SAFE_INTEGER ||
        (!allowFractions && !Number.isSafeInteger(value)))
    ) {
      errors.push(`${path || "/"} must be a safe integer`);
    } else if (typeof value === "string" && /[\uD800-\uDFFF]/u.test(value)) {
      errors.push(`${path || "/"} contains an unpaired Unicode surrogate`);
    } else if (value !== null && typeof value === "object") {
      if (seen.has(value)) continue;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (/[\uD800-\uDFFF]/u.test(key))
          errors.push("JSON member name contains an unpaired Unicode surrogate");
        pending.push({ value: child, path: `${path}/${key}` });
      }
    }
  }
  return errors;
}
function compileTask(): ValidateFunction {
  if (!taskValidator) {
    const schema: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, "schemas/task.schema.json"), "utf8"),
    );
    taskValidator = ajv.compile(schema as object);
  }
  return taskValidator;
}
function structural(validator: ValidateFunction, data: unknown): ValidationOutcome {
  const valid = validator(data) as boolean;
  const errors = valid
    ? safeNumbers(data)
    : (validator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
  return { valid: errors.length === 0, errors };
}
function outcome(errors: string[]): ValidationOutcome {
  return { valid: errors.length === 0, errors };
}
/** UTC wire timestamps sort exactly after padding their optional microseconds. */
function orderedTimestamp(value: string): string {
  return value.replace(
    /(?:\.(\d{1,6}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(6, "0")}Z`,
  );
}
function unique(values: string[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) errors.push(`${label} contains duplicate identity ${value}`);
    seen.add(value);
  }
}
function checkPath(path: string, label: string, errors: string[]): void {
  if (path !== "." && path.split("/").some((part) => RESERVED_PATH_COMPONENT.test(part))) {
    errors.push(`${label} contains a reserved device path component`);
  }
}
export function validateTaskSpec(data: unknown): ValidationOutcome {
  const checked = structural(compileTask(), data);
  if (!checked.valid) return checked;
  const task = data as TaskSpec;
  const errors: string[] = [];
  unique(
    task.allowed_commands.map((c) => c.command_id),
    "/allowed_commands",
    errors,
  );
  unique(
    task.success_criteria.map((c) => c.criterion_id),
    "/success_criteria",
    errors,
  );
  unique(
    task.allowed_paths.map((p) => `${p.path.toLowerCase()}:${p.scope}`),
    "/allowed_paths",
    errors,
  );
  checkPath(task.task_file, "/task_file", errors);
  task.allowed_paths.forEach((p, i) => {
    checkPath(p.path, `/allowed_paths/${i}/path`, errors);
  });
  task.allowed_commands.forEach((c, i) => {
    checkPath(c.cwd, `/allowed_commands/${i}/cwd`, errors);
  });
  return outcome(errors);
}
/** Validates an envelope's structure and time ordering, never its authority or freshness. */
export function validateApprovalEnvelope(data: unknown): ValidationOutcome {
  compileTask();
  approvalValidator ??= ajv.compile({ $ref: `${TASK_SCHEMA_ID}#/$defs/approvalEnvelope` });
  const checked = structural(approvalValidator, data);
  if (!checked.valid) return checked;
  const approval = data as ApprovalEnvelope;
  return outcome(
    orderedTimestamp(approval.expires_at) > orderedTimestamp(approval.issued_at)
      ? []
      : ["/expires_at must be after /issued_at"],
  );
}
export type LoadTaskSpecOutcome =
  | { valid: true; task: TaskSpec; taskSpecHash: string; rawBytes: Uint8Array }
  | { valid: false; errors: string[] };

export function loadTaskSpec(
  rawTaskBytes: Uint8Array,
  expectedSha256?: string,
): LoadTaskSpecOutcome {
  if (rawTaskBytes.byteLength > MAX_TASK_SPEC_BYTES)
    return { valid: false, errors: [`TaskSpec exceeds ${MAX_TASK_SPEC_BYTES} byte limit`] };
  // Copy before decoding and hashing so caller mutation cannot change the accepted snapshot.
  const rawBytes = Uint8Array.from(rawTaskBytes);
  const taskSpecHash = sha256Bytes(rawBytes);
  if (expectedSha256 !== undefined && expectedSha256 !== taskSpecHash)
    return { valid: false, errors: ["task specification raw-byte SHA-256 mismatch"] };
  try {
    const raw = parseStrictJsonBytes(rawBytes);
    const checked = validateTaskSpec(raw);
    return checked.valid
      ? { valid: true, task: raw as TaskSpec, taskSpecHash, rawBytes }
      : { valid: false, errors: checked.errors };
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
export function verifyTaskFileBytes(task: TaskSpec, bytes: Uint8Array): ValidationOutcome {
  if (bytes.byteLength > MAX_TASK_FILE_BYTES)
    return outcome([`task_file exceeds ${MAX_TASK_FILE_BYTES} byte limit`]);
  try {
    decodeStrictUtf8(bytes, "task_file");
  } catch (error) {
    return outcome([error instanceof Error ? error.message : String(error)]);
  }
  return outcome(
    sha256Bytes(bytes) === task.task_file_hash ? [] : ["task_file raw-byte SHA-256 mismatch"],
  );
}
export function validateTaskResultStructure(data: unknown): ValidationOutcome {
  resultValidator ??= ajv.compile(
    JSON.parse(readFileSync(join(REPO_ROOT, "schemas/task-result.schema.json"), "utf8")) as object,
  );
  return structural(resultValidator, data);
}
export interface TaskResultValidationContext {
  task: TaskSpec;
  /** Digest of the immutable raw TaskSpec bytes, never a reserialization. */
  taskSpecHash: string;
  expectedRunId?: string | null;
  expectedFencingToken?: number;
  expectedProcessIdentity?: ProcessIdentity | null;
}
function sameProcess(left: ProcessIdentity | null, right: ProcessIdentity | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.host_id === right.host_id &&
    left.boot_id === right.boot_id &&
    left.pid === right.pid &&
    left.creation_time === right.creation_time &&
    left.executable_sha256 === right.executable_sha256 &&
    left.process_group_id === right.process_group_id
  );
}
function permitsWrite(task: TaskSpec, path: string): boolean {
  return task.allowed_paths.some(
    (rule) =>
      rule.permissions.includes("write") &&
      (rule.path === path || (rule.scope === "subtree" && path.startsWith(`${rule.path}/`))),
  );
}
/** Return every referenced artifact for caller-side size/hash/access verification. */
export function taskResultArtifactRefs(result: TaskResult): ArtifactRef[] {
  const refs = [
    result.stdout_ref,
    result.stderr_ref,
    result.diff.artifact_ref,
    result.receipt?.evidence_ref,
    result.verification.evidence_ref,
    ...result.commands_run.flatMap((c) => [c.stdout_ref, c.stderr_ref]),
    ...result.tests.map((t) => t.evidence_ref),
  ];
  return refs.filter((ref): ref is ArtifactRef => ref !== null && ref !== undefined);
}
/**
 * Checks schema and internal consistency. The caller must separately authenticate the
 * authoritative ledger/receipt and verify each artifact's bytes. A successful return
 * is not proof of execution, approval, isolation, or completion.
 */
export function validateTaskResult(
  data: unknown,
  context?: TaskResultValidationContext,
): ValidationOutcome {
  const checked = validateTaskResultStructure(data);
  if (!checked.valid || !context) return checked;
  const taskChecked = validateTaskSpec(context.task);
  if (!taskChecked.valid) return outcome(taskChecked.errors.map((e) => `task: ${e}`));
  const result = data as TaskResult;
  const { task } = context;
  const errors: string[] = [];
  const equal = (actual: unknown, expected: unknown, label: string) => {
    if (actual !== expected) errors.push(`${label} does not match the bound task or run`);
  };
  equal(result.request_id, task.request_id, "/request_id");
  equal(result.task_spec_hash, context.taskSpecHash, "/task_spec_hash");
  equal(result.task_file_hash, task.task_file_hash, "/task_file_hash");
  equal(result.base_commit, task.base_commit, "/base_commit");
  if (result.actual_agent !== null) equal(result.actual_agent, task.agent, "/actual_agent");
  if (result.actual_model !== null)
    equal(result.actual_model, task.requested_model, "/actual_model");
  if (context.expectedRunId !== undefined) equal(result.run_id, context.expectedRunId, "/run_id");
  if (context.expectedFencingToken !== undefined)
    equal(result.fencing_token, context.expectedFencingToken, "/fencing_token");
  if (
    context.expectedProcessIdentity !== undefined &&
    !sameProcess(result.process_identity, context.expectedProcessIdentity)
  )
    errors.push("/process_identity does not match the bound process");
  if (
    task.mode === "design_fixture" &&
    (!result.synthetic || result.started_at !== null || result.commands_run.length > 0)
  )
    errors.push("design_fixture cannot contain real execution or a started process");
  const terminal = TERMINAL.has(result.status);
  if (result.started_at === null) {
    if (
      result.process_identity !== null ||
      result.actual_agent !== null ||
      result.actual_model !== null ||
      result.commands_run.length ||
      result.tests.length ||
      result.exit_codes.length ||
      result.changed_files.length ||
      result.resulting_commit !== null
    )
      errors.push(
        "a never-started result cannot contain execution, tests, edits, or process identity",
      );
  } else if (
    result.run_id === null ||
    result.process_identity === null ||
    result.fencing_token < 1
  ) {
    errors.push("a started result requires run, fencing, and process identity");
  }
  if (
    result.status !== "unknown" &&
    result.last_confirmed_status !== null &&
    result.last_confirmed_status !== result.status
  )
    errors.push("/last_confirmed_status must be null or the current authoritative status");
  const before = (a: string | null, b: string | null, label: string) => {
    if (a !== null && b !== null && orderedTimestamp(a) > orderedTimestamp(b))
      errors.push(`${label} timestamps are out of order`);
  };
  before(result.started_at, result.finished_at, "start/finish");
  before(result.started_at, result.observed_at, "start/observation");
  before(result.finished_at, result.observed_at, "finish/observation");
  before(
    result.process_identity?.creation_time ?? null,
    result.observed_at,
    "process creation/observation",
  );
  before(
    result.started_at,
    result.process_identity?.creation_time ?? null,
    "start/process creation",
  );
  before(
    result.process_identity?.creation_time ?? null,
    result.finished_at,
    "process creation/finish",
  );
  before(result.finished_at, result.verification.checked_at, "finish/verification");
  before(result.verification.checked_at, result.observed_at, "verification/observation");
  if (result.receipt) {
    const receipt = result.receipt;
    equal(receipt.request_id, result.request_id, "/receipt/request_id");
    equal(receipt.task_spec_sha256, result.task_spec_hash, "/receipt/task_spec_sha256");
    equal(receipt.run_id, result.run_id, "/receipt/run_id");
    equal(receipt.fencing_token, result.fencing_token, "/receipt/fencing_token");
    equal(receipt.terminal_status, result.status, "/receipt/terminal_status");
    equal(
      receipt.process_state,
      result.started_at === null ? "never_started" : "all_terminated",
      "/receipt/process_state",
    );
    if (!terminal) errors.push("only a terminal result may have a receipt");
    before(result.finished_at, receipt.recorded_at, "finish/receipt");
    before(receipt.recorded_at, result.verification.checked_at, "receipt/verification");
    before(receipt.recorded_at, result.observed_at, "receipt/observation");
  }
  unique(
    result.commands_run.map((c) => c.invocation_id),
    "/commands_run",
    errors,
  );
  unique(
    result.exit_codes.map((c) => c.invocation_id),
    "/exit_codes",
    errors,
  );
  unique(
    result.tests.map((t) => t.test_id),
    "/tests",
    errors,
  );
  unique(
    result.changed_files.map((f) => f.path.toLowerCase()),
    "/changed_files",
    errors,
  );
  const commands = new Map(task.allowed_commands.map((c) => [c.command_id, c]));
  const invocations = new Map(result.commands_run.map((c) => [c.invocation_id, c]));
  const counts = new Map<string, number>();
  const exits = new Map(result.exit_codes.map((c) => [c.invocation_id, c.exit_code]));
  for (const command of result.commands_run) {
    const allowed = commands.get(command.command_id);
    counts.set(command.command_id, (counts.get(command.command_id) ?? 0) + 1);
    if (!allowed) errors.push(`/commands_run ${command.command_id} is not allowlisted`);
    else {
      equal(
        command.executable_id,
        allowed.executable_id,
        `/commands_run/${command.command_id}/executable_id`,
      );
      equal(
        command.resolved_binary_sha256,
        allowed.executable_sha256,
        `/commands_run/${command.command_id}/resolved_binary_sha256`,
      );
      equal(
        command.argv_sha256,
        hashArgv(allowed.argv),
        `/commands_run/${command.command_id}/argv_sha256`,
      );
      equal(command.cwd, allowed.cwd, `/commands_run/${command.command_id}/cwd`);
      if ((counts.get(command.command_id) ?? 0) > allowed.max_runs)
        errors.push(`/commands_run ${command.command_id} exceeds max_runs`);
      if (
        result.status === "succeeded" &&
        (command.exit_code === null || !allowed.accepted_exit_codes.includes(command.exit_code))
      )
        errors.push(`/commands_run ${command.command_id} has an unaccepted exit code`);
    }
    if (!exits.has(command.invocation_id) || exits.get(command.invocation_id) !== command.exit_code)
      errors.push(`/exit_codes missing or inconsistent for ${command.invocation_id}`);
    if (terminal && (command.termination === "running" || command.termination === "unknown"))
      errors.push("terminal result contains an unterminated or unknown command");
    before(result.started_at, command.started_at, "run/command start");
    before(
      result.process_identity?.creation_time ?? null,
      command.started_at,
      "process creation/command start",
    );
    before(command.started_at, command.finished_at, "command start/finish");
    before(command.started_at, result.observed_at, "command start/observation");
    before(command.finished_at, result.finished_at, "command/run finish");
    before(command.finished_at, result.observed_at, "command finish/observation");
  }
  for (const exit of result.exit_codes)
    if (!invocations.has(exit.invocation_id))
      errors.push(`/exit_codes contains unknown invocation ${exit.invocation_id}`);
  const criteria = new Set(task.success_criteria.map((c) => c.criterion_id));
  const covered = new Set<string>();
  for (const test of result.tests) {
    if (!criteria.has(test.criterion_id))
      errors.push(`/tests references unknown criterion ${test.criterion_id}`);
    if (test.outcome === "passed") covered.add(test.criterion_id);
    for (const id of test.command_invocation_ids)
      if (!invocations.has(id)) errors.push(`/tests references unknown invocation ${id}`);
    if (test.outcome === "passed" && test.evidence_ref === null)
      errors.push(`/tests/${test.test_id} passed without evidence`);
  }
  if (result.status === "succeeded")
    for (const id of criteria)
      if (!covered.has(id)) errors.push(`/tests does not satisfy criterion ${id}`);
  for (const file of result.changed_files) {
    checkPath(file.path, "/changed_files/path", errors);
    if (!permitsWrite(task, file.path))
      errors.push(`/changed_files ${file.path} is outside write-allowed paths`);
  }
  if (
    task.mode === "read_only" &&
    (result.changed_files.length > 0 ||
      result.diff.kind !== "none" ||
      (result.resulting_commit !== null && result.resulting_commit !== task.base_commit))
  )
    errors.push("read_only task cannot contain edits or a changed commit");
  if ((result.changed_files.length === 0) !== (result.diff.kind === "none"))
    errors.push("/diff kind is inconsistent with /changed_files");
  if (result.diff.artifact_ref && result.diff.artifact_ref.media_type !== "text/x-diff")
    errors.push("/diff artifact must have media type text/x-diff");
  const artifacts = new Map<string, ArtifactRef>();
  for (const ref of taskResultArtifactRefs(result)) {
    const earlier = artifacts.get(ref.artifact_id);
    if (
      earlier &&
      (earlier.sha256 !== ref.sha256 ||
        earlier.size_bytes !== ref.size_bytes ||
        earlier.media_type !== ref.media_type)
    )
      errors.push(`conflicting artifact metadata for ${ref.artifact_id}`);
    artifacts.set(ref.artifact_id, ref);
  }
  return outcome(errors);
}
/** Serialization does not bless the snapshot as authoritative evidence. */
export function serializeTaskResult(result: TaskResult): string {
  const checked = validateTaskResultStructure(result);
  if (!checked.valid) throw new Error(`Invalid task result: ${checked.errors.join("; ")}`);
  return `${JSON.stringify(result, null, 2)}\n`;
}
