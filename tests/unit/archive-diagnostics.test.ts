import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DIAGNOSTIC_DISCLOSURE,
  DIAGNOSTIC_LIMITS,
  DiagnosticExportError,
  type DiagnosticInput,
  exportSanitizedDiagnostics,
} from "../../src/archive/diagnostics.js";
import type { ArchiveManifest } from "../../src/archive/types.js";
import type { TaskRecord } from "../../src/state/task-store.js";

const action = { userAction: "export_sanitized_diagnostics" } as const;
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const secrets = {
  prompt: "PRIVATE PROMPT: discuss confidential launch plans",
  github: "github_pat_11SECRET_PRIVATE_GITHUB_TOKEN_0123456789",
  openai: "sk-proj-PRIVATE_OPENAI_TOKEN_0123456789",
  url: "https://internal.example.invalid/task?access_token=PRIVATE_QUERY#PRIVATE_FRAGMENT",
  cookie: "__Secure-next-auth.session-token=PRIVATE_SESSION_COOKIE",
  windows: "C:\\Users\\PrivatePerson\\Confidential\\tasks\\plan.md",
  unix: "/home/private-person/work/confidential/task.md",
  functionError:
    "Error: privateFunction(PRIVATE_FUNCTION_ERROR) at secretHandler (/private/app.js:19:3)",
};

function record(): TaskRecord {
  return {
    rawSpec: JSON.stringify({ instructions: secrets.prompt, environment: secrets }),
    taskBytesBase64: Buffer.from(secrets.prompt).toString("base64"),
    intent: null,
    transportRequestId: secrets.github,
    bridgeId: secrets.url,
    requesterId: secrets.openai,
    sessionId: secrets.cookie,
    workflowId: null,
    result: {
      protocol_version: "2.0",
      request_id: secrets.github,
      task_spec_hash: "a".repeat(64),
      task_file_hash: "b".repeat(64),
      synthetic: true,
      status: "succeeded",
      last_confirmed_status: "succeeded",
      observation_seq: 3,
      observed_at: "2026-10-03T00:00:00Z",
      outcome_known: true,
      started_at: null,
      finished_at: null,
      actual_agent: secrets.openai,
      actual_model: secrets.prompt,
      base_commit: "c".repeat(40),
      resulting_commit: null,
      run_id: secrets.url,
      fencing_token: 1,
      process_identity: null,
      commands_run: [
        {
          invocation_id: secrets.github,
          command_id: secrets.openai,
          executable_id: secrets.windows,
          resolved_binary_sha256: "d".repeat(64),
          argv_sha256: "e".repeat(64),
          cwd: secrets.unix,
          started_at: "2026-10-03T00:00:00Z",
          finished_at: null,
          exit_code: 0,
          termination: "exited",
          stdout_ref: null,
          stderr_ref: null,
        },
      ],
      tests: [
        {
          test_id: secrets.prompt,
          criterion_id: secrets.cookie,
          outcome: "passed",
          command_invocation_ids: [secrets.github],
          evidence_ref: null,
        },
      ],
      exit_codes: [{ invocation_id: secrets.github, exit_code: 0 }],
      changed_files: [
        { path: secrets.windows, change: "modified", before_sha256: null, after_sha256: null },
      ],
      diff: { kind: "none", complete: true, artifact_ref: null },
      stdout_ref: null,
      stderr_ref: null,
      error: { code: secrets.openai, message: secrets.functionError, retryable: false },
      receipt: null,
      verification: { state: "synthetic", checked_at: null, evidence_ref: null },
    },
  };
}

function manifest(): ArchiveManifest {
  return {
    schema: "artifact-archive-1",
    requestId: secrets.github,
    taskSpecHash: "a".repeat(64),
    runId: secrets.url,
    projectId: secrets.cookie,
    localPinnedRoot: secrets.windows,
    relativeDirectory: secrets.unix,
    resultSha256: "f".repeat(64),
    synthetic: true,
    completeness: "complete",
    entries: [
      {
        logicalName: secrets.prompt,
        filename: secrets.openai,
        relativePath: secrets.unix,
        contentSha256: "c".repeat(64),
        sizeBytes: 99,
        artifactId: secrets.github,
        complete: true,
      },
    ],
  };
}

function exported(input: DiagnosticInput = { record: record(), manifest: manifest() }) {
  return exportSanitizedDiagnostics(input, action);
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  return value;
}

describe("explicit local sanitized diagnostic export", () => {
  it("exports only allowlisted metadata and omits all sensitive nested content and field names", () => {
    const input = {
      record: {
        ...record(),
        environment: { OPENAI_API_KEY: secrets.openai, GITHUB_TOKEN: secrets.github },
        unknown: { deeply: { nested: { ...secrets, [secrets.openai]: secrets.prompt } } },
        result: {
          ...record().result,
          commands_run: [{ ...record().result.commands_run[0], argv: Object.values(secrets) }],
          stdout: secrets.prompt,
          stderr: secrets.functionError,
          artifact_content: secrets.prompt,
          cookie: secrets.cookie,
        },
      },
      manifest: { ...manifest(), extra: { [secrets.prompt]: secrets.github } },
    };
    const result = exported(input);
    const text = Buffer.from(result.bytes).toString("utf8");
    for (const secret of Object.values(secrets)) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(JSON.stringify(secret).slice(1, -1));
    }
    expect(text).not.toContain(Buffer.from(secrets.prompt).toString("base64"));
    expect(text).not.toContain("PRIVATE_");
    const content = result.envelope.content;
    expect(content.task.commands).toEqual({
      running: 0,
      exited: 1,
      killed: 0,
      unknown: 0,
      invalid: 0,
      total: 1,
    });
    expect(content.task.tests.passed).toBe(1);
    expect(content.task.changed_files.modified).toBe(1);
    expect(content.task.error_present).toBe(true);
    expect(content.manifest?.entries).toEqual([
      {
        artifact_id_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        complete: true,
        content_sha256: "c".repeat(64),
        size_bytes: 99,
      },
    ]);
    expect(content.disclosure).toEqual(DIAGNOSTIC_DISCLOSURE);
    expect(content.redaction_audit.scalar_values_omitted).toBeGreaterThan(50);
    expect(content.redaction_audit.identifiers_hashed).toBe(5);
    expect(content.redaction_audit.input_scalar_values).toBe(
      content.redaction_audit.scalar_values_used +
        content.redaction_audit.identifiers_hashed +
        content.redaction_audit.scalar_values_omitted,
    );
  });

  it("hashes arbitrary identifiers with domain separation and preserves cross-source correlation", () => {
    const result = exported().envelope.content;
    expect(result.task.request_id_sha256).toBe(result.manifest?.request_id_sha256);
    expect(result.task.run_id_sha256).toBe(result.manifest?.run_id_sha256);
    expect(result.task.request_id_sha256).not.toBe(result.manifest?.entries[0]?.artifact_id_sha256);
    expect(result.task.request_id_sha256).toBe(
      sha256(`bridge-diagnostic-id-v1\0request\0${secrets.github}`),
    );
  });

  it("is deterministic across object key order, and hashes canonical content and complete bytes separately", () => {
    const input = { record: record(), manifest: manifest() };
    const first = exported(input);
    expect(exported(input)).toEqual(first);
    expect(exported(reverseKeys(input) as DiagnosticInput)).toEqual(first);
    const text = Buffer.from(first.bytes).toString("utf8");
    const parsed = JSON.parse(text);
    expect(text.endsWith("\n")).toBe(true);
    expect(first.contentSha256).toBe(sha256(JSON.stringify(parsed.content)));
    expect(first.sha256).toBe(sha256(first.bytes));
    expect(first.sha256).not.toBe(first.contentSha256);
    expect(Object.keys(parsed)).toEqual(["content", "content_sha256", "schema"]);
    expect(Object.keys(parsed.content)).toEqual([
      "delivery_ack",
      "disclosure",
      "environment",
      "expected_vs_actual",
      "known_errors",
      "manifest",
      "missing_data",
      "readme",
      "redaction_audit",
      "stage_timeline",
      "task",
      "verification",
    ]);
  });

  it("does not hash discarded prompt/error contents into the diagnostic payload", () => {
    const input = record();
    const first = exported({ record: input });
    input.rawSpec = "Different secret specification";
    input.taskBytesBase64 = Buffer.from("A different private prompt").toString("base64");
    if (input.result.error) input.result.error.message = "different private stack";
    expect(exported({ record: input }).bytes).toEqual(first.bytes);
    input.result.status = "failed";
    expect(exported({ record: input }).contentSha256).not.toBe(first.contentSha256);
  });

  it("never upgrades synthetic or source-reported verification into provider proof", () => {
    const input = record();
    input.result.verification.state = "verified";
    const synthetic = exported({ record: input, archiveVerification: { state: "verified" } })
      .envelope.content;
    expect(synthetic.task.synthetic).toBe(true);
    expect(synthetic.verification).toEqual({
      execution_kind: "synthetic",
      source_result_state: "verified",
      provider_run: "not_verified_by_export",
      archive: { reported_state: "verified", verified_by_export: false },
    });
    input.result.synthetic = false;
    const realClaim = exported({ record: input }).envelope.content;
    expect(realClaim.verification.execution_kind).toBe("reported_non_synthetic_unverified");
    expect(realClaim.verification.provider_run).toBe("not_verified_by_export");
    expect(realClaim.verification.archive.reported_state).toBe("not_checked");
  });

  it("omits malformed supposedly safe fields and never copies malicious enum/digest values", () => {
    const input = {
      record: {
        result: {
          protocol_version: secrets.openai,
          status: secrets.prompt,
          synthetic: secrets.github,
          request_id: secrets.prompt.repeat(100),
          run_id: { token: secrets.github },
          task_spec_hash: `${"a".repeat(64)}\n${secrets.github}`,
          task_file_hash: secrets.url,
          observation_seq: -1,
          outcome_known: { secret: secrets.cookie },
          commands_run: [{ termination: secrets.openai }, null],
          tests: secrets.github,
          changed_files: [{ change: secrets.prompt }],
          verification: { state: secrets.url },
        },
      },
      manifest: {
        ...manifest(),
        entries: [
          {
            contentSha256: secrets.cookie,
            sizeBytes: -1,
            complete: secrets.github,
            artifactId: secrets.url,
          },
        ],
      },
    };
    const result = exported(input);
    expect(result.envelope.content.task.status).toBeNull();
    expect(result.envelope.content.task.synthetic).toBeNull();
    expect(result.envelope.content.task.request_id_sha256).toBeNull();
    expect(result.envelope.content.task.task_spec_sha256).toBeNull();
    expect(result.envelope.content.task.commands.invalid).toBe(2);
    expect(result.envelope.content.verification.execution_kind).toBe("unknown");
    expect(result.envelope.content.redaction_audit.invalid_allowlisted_fields).toBeGreaterThan(10);
    for (const secret of Object.values(secrets))
      expect(Buffer.from(result.bytes).toString()).not.toContain(secret);
  });

  it("requires an explicit export action before inspecting inputs", () => {
    const get = vi.fn(() => {
      throw new Error(secrets.functionError);
    });
    const input = {
      get record() {
        return get();
      },
    };
    expect(() => exportSanitizedDiagnostics(input, undefined as unknown as typeof action)).toThrow(
      "diagnostic_action_required",
    );
    expect(get).not.toHaveBeenCalled();
    const maliciousOption = Object.defineProperty({}, "userAction", { get });
    expect(() => exportSanitizedDiagnostics(input, maliciousOption as typeof action)).toThrow(
      "diagnostic_action_required",
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects getters, toJSON, functions, Error objects and proxies without executing or leaking them", () => {
    const callback = vi.fn(() => {
      throw new Error(secrets.functionError);
    });
    const cases = [
      Object.defineProperty({}, "secret", { enumerable: true, get: callback }),
      { toJSON: callback },
      { function: callback },
      new Error(secrets.functionError),
      new Proxy({}, { ownKeys: callback }),
      { [Symbol(secrets.github)]: secrets.prompt },
    ];
    for (const unknown of cases) {
      let error: unknown;
      try {
        exported({ record: { ...record(), unknown } });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DiagnosticExportError);
      expect((error as Error).message).toBe("diagnostic_input_invalid");
      expect((error as Error).stack).not.toContain(secrets.functionError);
    }
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects cycles, sparse arrays, non-JSON numbers and invalid root structures", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const unknown of [
      cycle,
      new Array(2),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      2n,
      undefined,
    ])
      expect(() => exported({ record: { ...record(), unknown } })).toThrow(
        "diagnostic_input_invalid",
      );
    expect(() => exported({ record: null })).toThrow("diagnostic_input_invalid");
    expect(() => exported({ record: {} })).toThrow("diagnostic_input_invalid");
  });

  it("enforces byte, collection, key and nesting caps even for discarded fields", () => {
    const withUnknown = (unknown: unknown) => () => exported({ record: { ...record(), unknown } });
    expect(withUnknown("x".repeat(DIAGNOSTIC_LIMITS.stringBytes + 1))).toThrow(
      "diagnostic_input_limit",
    );
    expect(
      withUnknown(Array.from({ length: DIAGNOSTIC_LIMITS.collectionItems + 1 }, () => null)),
    ).toThrow("diagnostic_input_limit");
    expect(
      withUnknown(
        Object.fromEntries(
          Array.from({ length: DIAGNOSTIC_LIMITS.objectFields + 1 }, (_, index) => [
            `key${index}`,
            null,
          ]),
        ),
      ),
    ).toThrow("diagnostic_input_limit");
    let deep: unknown = null;
    for (let index = 0; index < DIAGNOSTIC_LIMITS.depth + 1; index++) deep = { nested: deep };
    expect(withUnknown(deep)).toThrow("diagnostic_input_limit");
    expect(withUnknown(Array(5).fill("x".repeat(DIAGNOSTIC_LIMITS.stringBytes)))).toThrow(
      "diagnostic_input_limit",
    );
    expect(withUnknown("\u0001".repeat(DIAGNOSTIC_LIMITS.stringBytes))).toThrow(
      "diagnostic_input_limit",
    );
    expect(withUnknown(Array.from({ length: 50 }, () => Array(1024).fill(null)))).toThrow(
      "diagnostic_input_limit",
    );
  });

  it("leaves the supplied record and manifest unchanged", () => {
    const input = { record: record(), manifest: manifest() };
    const before = JSON.stringify(input);
    exported(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("is self-contained with explicit missing data rather than fabricated runtime or history", () => {
    const content = exported({ record: { result: {} } }).envelope.content;
    expect(content.readme).toContain("No prior conversation is required");
    expect(content.readme).toContain("Read-only reproduction conditions");
    expect(content.readme).toContain("without starting or retrying");
    expect(content.readme).toContain("never diagnoses a cause");
    expect(content.readme).toContain("not origin, execution or authenticity");
    expect(content.missing_data).toEqual([
      "task.synthetic",
      "task.status",
      "task.request_id_sha256",
      "task.task_spec_sha256",
      "manifest",
      "environment.bridge_version",
      "environment.node_version",
      "environment.platform",
      "environment.arch",
      "stage_timeline",
      "delivery_ack",
      "archive_verification",
    ]);
    expect(content.stage_timeline).toEqual({
      source: "not_provided",
      order: "reported_sequence_ascending_then_input_order",
      events: [],
    });
    expect(content.delivery_ack.observation).toBe("not_provided");
    expect(content.environment).toEqual({
      bridge_version: null,
      node_version: null,
      platform: null,
      arch: null,
    });
  });

  it("includes safe runtime metadata, sequence-ordered stages, linked ACK and static error codes", () => {
    const row = record();
    row.result.error = {
      code: "reconciliation_required",
      message: secrets.functionError,
      retryable: false,
    };
    const input = {
      record: row,
      manifest: manifest(),
      environment: {
        bridgeVersion: "0.1.0",
        nodeVersion: "v24.2.0",
        platform: "win32",
        arch: "x64",
      },
      archiveVerification: {
        state: "rejected",
        issue: "archive_windows_ownership_unverified",
      } as const,
      stages: [
        {
          stage: "result",
          state: "succeeded",
          sequence: 3,
          observedAt: "2026-10-03T01:02:03.004Z",
          message: secrets.prompt,
        },
        { stage: "receive", state: "observed", sequence: 1, observedAt: "2026-10-03T01:02:01Z" },
        { stage: "start", state: "observed", sequence: 2, observedAt: "2026-10-03T01:02:02.000Z" },
      ],
      ack: {
        stage: "result_ack",
        eventId: secrets.github,
        requestId: secrets.github,
        runId: secrets.url,
        taskSpecHash: "a".repeat(64),
        payloadSha256: "f".repeat(64),
        sequence: 3,
        actorId: secrets.openai,
        processIdentity: { executable: secrets.windows },
      },
    };
    const result = exported(input);
    const content = result.envelope.content;
    expect(content.environment).toEqual({
      bridge_version: "0.1.0",
      node_version: "v24.2.0",
      platform: "win32",
      arch: "x64",
    });
    expect(content.stage_timeline.events.map((event) => event.stage)).toEqual([
      "receive",
      "start",
      "result",
    ]);
    expect(content.stage_timeline.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(content.stage_timeline.events[2]?.observed_at).toBe("2026-10-03T01:02:03.004Z");
    expect(content.delivery_ack.request_id_sha256).toBe(content.task.request_id_sha256);
    expect(content.delivery_ack.run_id_sha256).toBe(content.task.run_id_sha256);
    expect(content.delivery_ack.event_id_sha256).not.toBe(content.task.request_id_sha256);
    expect(content.known_errors).toEqual({
      task: "reconciliation_required",
      archive: "archive_windows_ownership_unverified",
    });
    expect(content.missing_data).toEqual([]);
    expect(content.expected_vs_actual).toContainEqual({
      check: "ack_payload_binding",
      expected: "matching_reported_digests",
      actual: "match",
    });
    expect(content.expected_vs_actual).toContainEqual({
      check: "manifest_task_spec_binding",
      expected: "matching_reported_digests",
      actual: "match",
    });
    expect(exported(reverseKeys(input) as DiagnosticInput).bytes).toEqual(result.bytes);
    for (const secret of Object.values(secrets))
      expect(Buffer.from(result.bytes).toString()).not.toContain(secret);
  });

  it("does not confuse missing or malformed metadata with an absent ACK or a verified archive", () => {
    const input = {
      record: record(),
      manifest: { ...manifest(), taskSpecHash: "d".repeat(64) },
      environment: {
        bridgeVersion: secrets.openai,
        nodeVersion: secrets.url,
        platform: secrets.cookie,
        arch: secrets.windows,
      },
      archiveVerification: { state: "rejected", issue: secrets.functionError } as const,
      stages: [
        { stage: secrets.prompt, state: secrets.github, sequence: -1, observedAt: secrets.url },
        {
          stage: "receive",
          state: "observed",
          sequence: 1,
          observedAt: "2026-02-30T01:02:03.004Z",
        },
        {
          stage: "start",
          state: "observed",
          sequence: 2,
          observedAt: "2026-10-03T01:02:03.004Z\n",
        },
      ],
      ack: null,
    };
    const result = exported(input);
    const content = result.envelope.content;
    expect(content.delivery_ack.observation).toBe("absent");
    expect(content.missing_data).not.toContain("delivery_ack");
    expect(content.missing_data).toContain("stage_timeline.observed_at");
    expect(content.stage_timeline.events.every((event) => event.observed_at === null)).toBe(true);
    expect(content.known_errors).toEqual({
      task: "unrecognized_omitted",
      archive: "unrecognized_omitted",
    });
    expect(content.expected_vs_actual).toContainEqual({
      check: "manifest_task_spec_binding",
      expected: "matching_reported_digests",
      actual: "mismatch",
    });
    expect(content.verification.archive).toEqual({
      reported_state: "rejected",
      verified_by_export: false,
    });
    for (const secret of Object.values(secrets))
      expect(Buffer.from(result.bytes).toString()).not.toContain(secret);
  });
});
