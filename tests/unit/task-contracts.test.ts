import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashArgv,
  loadTaskSpec,
  MAX_TASK_FILE_BYTES,
  MAX_TASK_SPEC_BYTES,
  parseStrictJsonBytes,
  serializeTaskResult,
  sha256Bytes,
  taskResultArtifactRefs,
  validateApprovalEnvelope,
  validateTaskResult,
  validateTaskResultStructure,
  validateTaskSpec,
  verifyTaskFileBytes,
} from "../../src/contracts/task.js";
import type {
  ApprovalEnvelope,
  ArtifactRef,
  TaskResult,
  TaskSpec,
} from "../../src/contracts/task-types.js";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Fixture field unexpectedly missing");
  return value;
}
const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const commit = "a".repeat(40);
const requestId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const invocationId = "00000000-0000-4000-8000-000000000003";
const taskFileBytes = Buffer.from("Fixture task. Do not run any agent.\n");
const at = (seconds: number) => `2026-10-03T00:00:${String(seconds).padStart(2, "0")}Z`;
const artifact: ArtifactRef = {
  artifact_id: "evidence",
  sha256: hash,
  size_bytes: 10,
  media_type: "application/json",
};
function task(): TaskSpec {
  return {
    protocol_version: "2.0",
    request_id: requestId,
    agent: "fake-agent",
    requested_model: "fake-model",
    repo: "fixture-repo",
    base_commit: commit,
    mode: "edit",
    policy_snapshot_sha256: hash,
    allowed_paths: [{ path: "src", scope: "subtree", permissions: ["read", "write"] }],
    allowed_commands: [
      {
        command_id: "test",
        executable_id: "fake-test",
        executable_sha256: hash,
        argv: ["--check", "a b"],
        cwd: ".",
        max_runs: 1,
        accepted_exit_codes: [0],
      },
    ],
    task_file: "task.md",
    task_file_hash: sha256Bytes(taskFileBytes),
    approval: {
      tier: "manual",
      preauthorization: null,
      required: true,
      binding: "sha256-raw-task-spec",
      source: "detached-authoritative-record",
      max_age_seconds: 900,
      max_starts: 1,
    },
    timeout: { run_seconds: 60, cancel_grace_seconds: 5 },
    success_criteria: [
      {
        criterion_id: "works",
        description: "Fixture assertion passes",
        evaluator_id: "fake-evaluator",
      },
    ],
    task_network: "deny",
    environment: {},
    retry_policy: "no-automatic-reexecution",
  };
}
function result(): TaskResult {
  const spec = task();
  return {
    protocol_version: "2.0",
    request_id: requestId,
    task_spec_hash: hash,
    task_file_hash: spec.task_file_hash,
    synthetic: false,
    status: "succeeded",
    last_confirmed_status: "succeeded",
    observation_seq: 8,
    observed_at: at(6),
    outcome_known: true,
    started_at: at(1),
    finished_at: at(4),
    actual_agent: spec.agent,
    actual_model: spec.requested_model,
    base_commit: commit,
    resulting_commit: commit,
    run_id: runId,
    fencing_token: 1,
    process_identity: {
      host_id: "fake-host",
      boot_id: requestId,
      pid: 123,
      creation_time: at(1),
      executable_sha256: hash,
      process_group_id: "fake-group",
    },
    commands_run: [
      {
        invocation_id: invocationId,
        command_id: "test",
        executable_id: "fake-test",
        resolved_binary_sha256: hash,
        argv_sha256: hashArgv(required(spec.allowed_commands[0]).argv),
        cwd: ".",
        started_at: at(2),
        finished_at: at(3),
        exit_code: 0,
        termination: "exited",
        stdout_ref: null,
        stderr_ref: null,
      },
    ],
    tests: [
      {
        test_id: "test-works",
        criterion_id: "works",
        outcome: "passed",
        command_invocation_ids: [invocationId],
        evidence_ref: { ...artifact },
      },
    ],
    exit_codes: [{ invocation_id: invocationId, exit_code: 0 }],
    changed_files: [],
    diff: { kind: "none", complete: true, artifact_ref: null },
    stdout_ref: null,
    stderr_ref: null,
    error: null,
    receipt: {
      receipt_id: requestId,
      request_id: requestId,
      task_spec_sha256: hash,
      run_id: runId,
      fencing_token: 1,
      ledger_sequence: 8,
      terminal_status: "succeeded",
      process_state: "all_terminated",
      recorded_at: at(4),
      evidence_ref: { ...artifact },
    },
    verification: { state: "verified", checked_at: at(5), evidence_ref: { ...artifact } },
  };
}
function approval(): ApprovalEnvelope {
  return {
    protocol_version: "2.0",
    tier: "manual",
    preauthorization: null,
    usage_reservation_id: null,
    approval_id: requestId,
    request_id: requestId,
    decision: "approved",
    task_spec_sha256: hash,
    task_file_sha256: sha256Bytes(taskFileBytes),
    policy_snapshot_sha256: hash,
    bridge_id: "fake-bridge",
    executor_id: "fake-executor",
    approver_id: "fake-human",
    issued_at: at(0),
    expires_at: at(59),
    nonce: runId,
    max_starts: 1,
  };
}
function checked(r: TaskResult, t = task()) {
  return validateTaskResult(r, { task: t, taskSpecHash: hash });
}

describe("Bridge v2 exact-byte JSON contract", () => {
  it("hashes the original bytes, including whitespace, and copies the input", () => {
    const raw = Buffer.from(`${JSON.stringify(task(), null, 2)}\n`);
    const loaded = loadTaskSpec(raw);
    expect(loaded.valid).toBe(true);
    if (!loaded.valid) return;
    expect(loaded.taskSpecHash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(loaded.taskSpecHash).not.toBe(sha256Bytes(Buffer.from(JSON.stringify(task()))));
    raw.fill(0);
    expect(loaded.rawBytes[0]).toBe(123);
  });
  it("accepts exactly 256 KiB TaskSpec bytes and rejects one extra padding byte before parsing", () => {
    const json = Buffer.from(JSON.stringify(task()));
    const boundary = Buffer.concat([json, Buffer.alloc(MAX_TASK_SPEC_BYTES - json.length, 0x20)]);
    expect(loadTaskSpec(boundary).valid).toBe(true);
    const tooLarge = Buffer.concat([boundary, Buffer.from(" ")]);
    expect(loadTaskSpec(tooLarge)).toEqual({
      valid: false,
      errors: [`TaskSpec exceeds ${MAX_TASK_SPEC_BYTES} byte limit`],
    });
    expect(loadTaskSpec(Buffer.alloc(MAX_TASK_SPEC_BYTES + 1, 0xff)).valid).toBe(false);
  });
  it("accepts exactly 1 MiB task file bytes and rejects oversize even with matching hash", () => {
    const bytes = Buffer.alloc(MAX_TASK_FILE_BYTES, 0x61);
    expect(
      verifyTaskFileBytes({ ...task(), task_file_hash: sha256Bytes(bytes) }, bytes).valid,
    ).toBe(true);
    const tooLarge = Buffer.concat([bytes, Buffer.from("a")]);
    expect(
      verifyTaskFileBytes(
        { ...task(), task_file_hash: sha256Bytes(tooLarge) },
        tooLarge,
      ).errors.join(" "),
    ).toMatch(/byte limit/);
  });
  it.each([
    Buffer.from([0xef, 0xbb, 0xbf, 0x61]),
    Buffer.from([0xff, 0xfe, 0x61, 0x00]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xed, 0xa0, 0x80]),
  ])("rejects malformed task file representation before accepting its matching hash", (bytes) => {
    expect(
      verifyTaskFileBytes({ ...task(), task_file_hash: sha256Bytes(bytes) }, bytes).errors.join(
        " ",
      ),
    ).toMatch(/UTF-8|BOM/);
  });
  it("rejects a raw spec digest mismatch", () => {
    expect(loadTaskSpec(Buffer.from(JSON.stringify(task())), otherHash).valid).toBe(false);
  });
  it("verifies the exact task_file bytes", () => {
    expect(verifyTaskFileBytes(task(), taskFileBytes).valid).toBe(true);
    expect(verifyTaskFileBytes(task(), Buffer.from(taskFileBytes.toString().trim())).valid).toBe(
      false,
    );
  });
  it.each([
    Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
    Buffer.from([0xff, 0xfe, 0x7b, 0x00]),
    Buffer.from([0xfe, 0xff, 0x00, 0x7b]),
  ])("rejects BOM bytes", (bytes) => {
    expect(() => parseStrictJsonBytes(bytes)).toThrow(/BOM/);
  });
  it.each([
    Buffer.from([0x22, 0xc0, 0xaf, 0x22]),
    Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22]),
    Buffer.from([0x22, 0xe2, 0x82, 0x22]),
  ])("rejects malformed UTF-8", (bytes) => {
    expect(() => parseStrictJsonBytes(bytes)).toThrow(/UTF-8/);
  });
  it.each([
    '{"a":1,"a":2}',
    '{"nested":{"x":1,"\\u0078":2}}',
    '[{"a":1,"a":2}]',
    '{"__proto__":0,"__proto__":1}',
  ])("rejects duplicate decoded keys: %s", (source) => {
    expect(() => parseStrictJsonBytes(Buffer.from(source))).toThrow(/Duplicate JSON key/);
  });
  it.each(['{"x":"\\ud800"}', '{"x":"\\udfff"}', '{"\\ud800":1}'])(
    "rejects decoded unpaired Unicode surrogates: %s",
    (source) => {
      expect(() => parseStrictJsonBytes(Buffer.from(source))).toThrow(/unpaired Unicode surrogate/);
    },
  );
  it("accepts a valid escaped surrogate pair", () => {
    expect(parseStrictJsonBytes(Buffer.from('"\\ud83d\\ude00"'))).toBe("😀");
  });
  it("accepts braces and escaped quotes inside strings and independent object keys", () => {
    const value = { value: '{"a":"b"}', list: [{ a: 1 }, { a: 2 }], unicode: "日本語" };
    expect(parseStrictJsonBytes(Buffer.from(JSON.stringify(value)))).toEqual(value);
  });
  it.each(['{"number":9007199254740992}', '{"number":1e400}', '{"number":1.5}'])(
    "rejects lossy or noninteger numbers: %s",
    (source) => {
      expect(() => parseStrictJsonBytes(Buffer.from(source))).toThrow(/safe integer/);
    },
  );
  it("rejects excessive nesting and malformed JSON", () => {
    expect(() =>
      parseStrictJsonBytes(Buffer.from(`${"[".repeat(258)}0${"]".repeat(258)}`)),
    ).toThrow(/nesting/);
    expect(() => parseStrictJsonBytes(Buffer.from('{"a":}'))).toThrow();
  });
});

describe("Bridge v2 structural contracts", () => {
  it("accepts strict TaskSpec and ResultSpec", () => {
    expect(validateTaskSpec(task())).toEqual({ valid: true, errors: [] });
    expect(validateTaskResultStructure(result())).toEqual({ valid: true, errors: [] });
  });
  it("rejects missing or unknown properties", () => {
    expect(validateTaskSpec({ ...task(), unexpected: true }).valid).toBe(false);
    expect(validateTaskResultStructure({ ...result(), requested_model: "wrong" }).valid).toBe(
      false,
    );
    expect(validateTaskSpec({ ...task(), task_file_hash: undefined }).valid).toBe(false);
  });
  it("rejects duplicate command and criterion IDs even when object values differ", () => {
    const t = task();
    t.allowed_commands.push({ ...required(t.allowed_commands[0]), argv: ["different"] });
    t.success_criteria.push({
      ...required(t.success_criteria[0]),
      description: "Different description",
    });
    expect(validateTaskSpec(t).errors.join(" ")).toMatch(/duplicate/);
  });
  it.each(["../outside", "/absolute", "src\\file", "C:secret", "src/NUL.txt"])(
    "rejects unsafe task path %s",
    (path) => {
      expect(validateTaskSpec({ ...task(), task_file: path }).valid).toBe(false);
    },
  );
  it("rejects read-only write permissions and executable design fixtures", () => {
    expect(validateTaskSpec({ ...task(), mode: "read_only" }).valid).toBe(false);
    expect(validateTaskSpec({ ...task(), mode: "design_fixture" }).valid).toBe(false);
  });
  it("rejects unsafe integer observations", () => {
    expect(
      validateTaskResultStructure({ ...result(), observation_seq: Number.MAX_SAFE_INTEGER + 1 })
        .valid,
    ).toBe(false);
  });
  it("validates detached approval separately", () => {
    expect(validateApprovalEnvelope(approval()).valid).toBe(true);
    expect(validateApprovalEnvelope({ ...approval(), signature: "invented" }).valid).toBe(false);
    expect(
      validateApprovalEnvelope({ ...approval(), decision: "denied", max_starts: 1 }).valid,
    ).toBe(false);
    expect(validateApprovalEnvelope({ ...approval(), expires_at: at(0) }).valid).toBe(false);
  });
  it("requires policy-bound preauthorization and usage reservation for automatic approval", () => {
    const binding = {
      policy_id: "policy",
      policy_version: 1,
      policy_sha256: hash,
      session_id: requestId,
    };
    const t = task();
    t.approval.tier = "automatic";
    expect(validateTaskSpec(t).valid).toBe(false);
    t.approval.preauthorization = binding;
    expect(validateTaskSpec(t).valid).toBe(true);
    const a = approval();
    a.tier = "automatic";
    a.preauthorization = binding;
    expect(validateApprovalEnvelope(a).valid).toBe(false);
    a.usage_reservation_id = invocationId;
    expect(validateApprovalEnvelope(a).valid).toBe(true);
    a.preauthorization.policy_version = 0;
    expect(validateApprovalEnvelope(a).valid).toBe(false);
  });
  it("does not treat bypass tier as missing approval or unlimited starts", () => {
    const a = approval();
    a.tier = "bypass";
    expect(validateApprovalEnvelope(a).valid).toBe(false);
    a.preauthorization = {
      policy_id: "policy",
      policy_version: 1,
      policy_sha256: hash,
      session_id: requestId,
    };
    a.usage_reservation_id = invocationId;
    expect(validateApprovalEnvelope(a).valid).toBe(true);
    expect(validateApprovalEnvelope({ ...a, max_starts: 2 }).valid).toBe(false);
  });
});

describe("Bridge v2 result semantic checks (not evidence authentication)", () => {
  it("accepts coherent evidence metadata without authenticating it", () => {
    expect(checked(result())).toEqual({ valid: true, errors: [] });
    expect(taskResultArtifactRefs(result())).toHaveLength(3);
  });
  it.each([
    "request_id",
    "task_spec_hash",
    "task_file_hash",
    "base_commit",
    "actual_agent",
    "actual_model",
  ] as const)("rejects task binding mismatch in %s", (key) => {
    const r = result();
    r[key] =
      key === "request_id"
        ? runId
        : key.includes("hash")
          ? otherHash
          : key === "base_commit"
            ? "b".repeat(40)
            : "different";
    expect(checked(r).valid).toBe(false);
  });
  it.each([
    "request_id",
    "task_spec_sha256",
    "run_id",
    "fencing_token",
    "terminal_status",
  ] as const)("rejects receipt binding mismatch in %s", (key) => {
    const r = result();
    Object.assign(required(r.receipt), {
      [key]:
        key === "fencing_token"
          ? 2
          : key === "terminal_status"
            ? "failed"
            : key === "task_spec_sha256"
              ? otherHash
              : invocationId,
    });
    expect(checked(r).valid).toBe(false);
  });
  it("rejects a stale fencing token, reused PID identity, or wrong run", () => {
    const r = result();
    expect(
      validateTaskResult(r, { task: task(), taskSpecHash: hash, expectedRunId: requestId }).valid,
    ).toBe(false);
    expect(
      validateTaskResult(r, { task: task(), taskSpecHash: hash, expectedFencingToken: 2 }).valid,
    ).toBe(false);
    expect(
      validateTaskResult(r, {
        task: task(),
        taskSpecHash: hash,
        expectedProcessIdentity: { ...required(r.process_identity), creation_time: at(0) },
      }).valid,
    ).toBe(false);
  });
  it.each(["command_id", "executable_id", "resolved_binary_sha256", "argv_sha256", "cwd"] as const)(
    "rejects command allowlist mismatch in %s",
    (key) => {
      const r = result();
      required(r.commands_run[0])[key] = key.includes("sha256") ? otherHash : "different";
      expect(checked(r).valid).toBe(false);
    },
  );
  it("uses fixed uint64-BE framing vectors independently calculated with Python struct/hashlib", () => {
    // Frame: 0000000000000002 0000000000000001 78 0000000000000009 e697a5e69cace8aa9e
    expect(hashArgv(["x", "日本語"])).toBe(
      "4e8ab56cc29d3577d96dc21db71b0d33addb302a2c32dec9929fae0bb2878485",
    );
    expect(hashArgv([])).toBe("af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc");
    expect(hashArgv(["", "A", "日本語", "a b"])).toBe(
      "a05bb2255466b0ec62c925bb70f20d93aac2ae7283103f2f9804f647d4b15819",
    );
    expect(hashArgv(["a b", "c"])).not.toEqual(hashArgv(["a", "b c"]));
    expect(hashArgv(["x", "日本語"])).not.toBe(sha256Bytes(Buffer.from('["x","日本語"]')));
    expect(() => hashArgv(["\ud800"])).toThrow(/unpaired Unicode surrogate/);
  });
  it("rejects max_runs overrun and duplicate invocation IDs", () => {
    const r = result();
    r.commands_run.push({ ...required(r.commands_run[0]) });
    const errors = checked(r).errors.join(" ");
    expect(errors).toMatch(/max_runs/);
    expect(errors).toMatch(/duplicate/);
  });
  it("rejects an unaccepted success exit code but preserves a failed exit outcome", () => {
    const r = result();
    required(r.commands_run[0]).exit_code = 7;
    required(r.exit_codes[0]).exit_code = 7;
    expect(checked(r).errors.join(" ")).toMatch(/unaccepted/);
    r.status = "failed";
    r.last_confirmed_status = "failed";
    required(r.receipt).terminal_status = "failed";
    r.error = { code: "test-failed", message: "Test failed", retryable: false };
    expect(checked(r).valid).toBe(true);
  });
  it("requires exactly one matching exit observation per command", () => {
    const r = result();
    r.exit_codes = [];
    expect(checked(r).errors.join(" ")).toMatch(/exit_codes/);
    r.exit_codes = [{ invocation_id: requestId, exit_code: 0 }];
    expect(checked(r).errors.join(" ")).toMatch(/unknown invocation/);
  });
  it("requires all criteria on success and known unique test identities", () => {
    const r = result();
    const t = task();
    t.success_criteria.push({
      criterion_id: "another",
      description: "Another criterion",
      evaluator_id: "fake-evaluator",
    });
    expect(checked(r, t).errors.join(" ")).toMatch(/does not satisfy criterion/);
    required(r.tests[0]).criterion_id = "unknown";
    r.tests.push({ ...required(r.tests[0]) });
    const errors = checked(r).errors.join(" ");
    expect(errors).toMatch(/unknown criterion/);
    expect(errors).toMatch(/duplicate/);
  });
  it("requires test command references to exist", () => {
    const r = result();
    required(r.tests[0]).command_invocation_ids = [runId];
    expect(checked(r).errors.join(" ")).toMatch(/unknown invocation/);
  });
  it("rejects inconsistent changed files and diff metadata", () => {
    const r = result();
    r.changed_files = [
      { path: "src/main.ts", change: "modified", before_sha256: hash, after_sha256: otherHash },
    ];
    expect(checked(r).errors.join(" ")).toMatch(/diff/);
    r.diff = {
      kind: "git_binary_patch",
      complete: true,
      artifact_ref: {
        artifact_id: "patch",
        sha256: otherHash,
        size_bytes: 100,
        media_type: "text/x-diff",
      },
    };
    expect(checked(r).valid).toBe(true);
    required(r.changed_files[0]).path = "src-other/main.ts";
    expect(checked(r).errors.join(" ")).toMatch(/outside write-allowed/);
  });
  it("accepts mode-only modifications with identical content hashes and a complete binary patch", () => {
    const r = result();
    const patchBytes = Buffer.from(
      "diff --git a/src/tool.sh b/src/tool.sh\nold mode 100644\nnew mode 100755\n",
    );
    r.changed_files = [
      { path: "src/tool.sh", change: "modified", before_sha256: hash, after_sha256: hash },
    ];
    r.diff = {
      kind: "git_binary_patch",
      complete: true,
      artifact_ref: {
        artifact_id: "mode-patch",
        sha256: sha256Bytes(patchBytes),
        size_bytes: patchBytes.length,
        media_type: "text/x-diff",
      },
    };
    expect(checked(r)).toEqual({ valid: true, errors: [] });
    // The caller, not this metadata validator, verifies/applies the patch artifact bytes.
    r.diff.complete = false;
    expect(checked(r).valid).toBe(false);
  });
  it("rejects read-only edits and commit drift", () => {
    const t = task();
    t.mode = "read_only";
    required(t.allowed_paths[0]).permissions = ["read"];
    const r = result();
    r.resulting_commit = "b".repeat(40);
    expect(checked(r, t).errors.join(" ")).toMatch(/read_only/);
  });
  it("rejects conflicting artifact metadata sharing the same identity", () => {
    const r = result();
    required(required(r.tests[0]).evidence_ref).sha256 = otherHash;
    expect(checked(r).errors.join(" ")).toMatch(/conflicting artifact metadata/);
  });
  it.each(["finished_at", "observed_at"] as const)("rejects timestamp reversal in %s", (key) => {
    const r = result();
    r[key] = at(0);
    expect(checked(r).errors.join(" ")).toMatch(/out of order/);
  });
  it("does not lose microsecond ordering to Date millisecond rounding", () => {
    const r = result();
    required(r.commands_run[0]).started_at = "2026-10-03T00:00:02.000002Z";
    required(r.commands_run[0]).finished_at = "2026-10-03T00:00:02.000001Z";
    expect(checked(r).errors.join(" ")).toMatch(/out of order/);
  });
  it("rejects incomplete process identity and live commands in terminal results", () => {
    const r = result();
    r.status = "failed";
    r.last_confirmed_status = "failed";
    required(r.receipt).terminal_status = "failed";
    r.error = { code: "failed", message: "Failure", retryable: false };
    r.process_identity = null;
    expect(checked(r).errors.join(" ")).toMatch(/process.identity/);
    r.process_identity = result().process_identity;
    required(r.commands_run[0]).termination = "unknown";
    required(r.commands_run[0]).exit_code = null;
    required(r.commands_run[0]).finished_at = null;
    required(r.exit_codes[0]).exit_code = null;
    expect(checked(r).errors.join(" ")).toMatch(/termination|unknown command/);
  });
  it("preserves a fenced run allocated before process creation", () => {
    const r = result();
    r.status = "failed";
    r.last_confirmed_status = "failed";
    r.started_at = null;
    r.actual_agent = null;
    r.actual_model = null;
    r.process_identity = null;
    r.commands_run = [];
    r.tests = [];
    r.exit_codes = [];
    r.resulting_commit = null;
    r.error = { code: "spawn-failed", message: "No process was created", retryable: false };
    required(r.receipt).process_state = "never_started";
    required(r.receipt).terminal_status = "failed";
    expect(checked(r)).toEqual({ valid: true, errors: [] });
    r.fencing_token = 0;
    required(r.receipt).fencing_token = 0;
    expect(checked(r).valid).toBe(false);
  });
  it("accepts unknown actual identity on a terminated failed run, never on success", () => {
    const r = result();
    r.actual_agent = null;
    r.actual_model = null;
    expect(checked(r).valid).toBe(false);
    r.status = "failed";
    r.last_confirmed_status = "failed";
    required(r.receipt).terminal_status = "failed";
    r.error = {
      code: "identity-unverified",
      message: "Agent identity could not be verified",
      retryable: false,
    };
    expect(checked(r).valid).toBe(true);
  });
  it("rejects zero fencing for an allocated run and nonzero fencing without one", () => {
    const r = result();
    r.fencing_token = 0;
    expect(validateTaskResultStructure(r).valid).toBe(false);
    r.run_id = null;
    r.fencing_token = 2;
    expect(validateTaskResultStructure(r).valid).toBe(false);
  });
  it("supports clearly synthetic snapshots without a public receipt", () => {
    const r = result();
    r.synthetic = true;
    r.receipt = null;
    r.verification = { state: "synthetic", checked_at: null, evidence_ref: null };
    expect(checked(r).valid).toBe(true);
  });
  it("serializes a structurally valid result with newline and rejects invalid status", () => {
    const r = result();
    expect(JSON.parse(serializeTaskResult(r))).toEqual(r);
    expect(serializeTaskResult(r).endsWith("\n")).toBe(true);
    expect(() => serializeTaskResult({ ...r, status: "bogus" } as unknown as TaskResult)).toThrow(
      /Invalid task result/,
    );
  });
});
