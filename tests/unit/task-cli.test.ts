import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli/main.js";
import { type LedgerRead, runTaskCli, type TaskCliDependencies } from "../../src/cli/task.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import type { TaskResult, TaskSpec } from "../../src/contracts/task-types.js";
import { syntheticAbsolute } from "../helpers/sdk-text-fixture.js";

const id = "00000000-0000-4000-8000-000000000001";
const offlineRuntimeDir = syntheticAbsolute("offline", "runtime");
const taskBytes = Buffer.from("Offline test fixture; do not execute.\n");
function spec(): TaskSpec {
  return {
    protocol_version: "2.0",
    request_id: id,
    agent: "fake-agent",
    requested_model: "fake-model",
    repo: "test-repo",
    base_commit: "a".repeat(40),
    mode: "read_only",
    policy_snapshot_sha256: "a".repeat(64),
    allowed_paths: [{ path: "src", scope: "subtree", permissions: ["read"] }],
    allowed_commands: [],
    task_file: "task.md",
    task_file_hash: sha256Bytes(taskBytes),
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
      { criterion_id: "check", description: "Offline fixture check", evaluator_id: "fake-check" },
    ],
    task_network: "deny",
    environment: {},
    retry_policy: "no-automatic-reexecution",
  };
}
function snapshot(status: "awaiting_approval" | "failed" | "unknown" = "awaiting_approval") {
  const task = spec();
  const rawSpec = JSON.stringify(task);
  const result: TaskResult = {
    protocol_version: "2.0",
    request_id: id,
    task_spec_hash: sha256Bytes(Buffer.from(rawSpec)),
    task_file_hash: task.task_file_hash,
    synthetic: true,
    status,
    last_confirmed_status: status === "unknown" ? "awaiting_approval" : status,
    observation_seq: 2,
    observed_at: "2026-10-03T00:00:05Z",
    outcome_known: status === "failed",
    started_at: null,
    finished_at: status === "failed" ? "2026-10-03T00:00:04Z" : null,
    actual_agent: null,
    actual_model: null,
    base_commit: task.base_commit,
    resulting_commit: null,
    run_id: null,
    fencing_token: 0,
    process_identity: null,
    commands_run: [],
    tests: [],
    exit_codes: [],
    changed_files: [],
    diff: { kind: "none", complete: false, artifact_ref: null },
    stdout_ref: null,
    stderr_ref: null,
    error:
      status === "awaiting_approval"
        ? null
        : { code: "offline-fixture", message: "Synthetic snapshot", retryable: false },
    receipt: null,
    verification: { state: "synthetic", checked_at: null, evidence_ref: null },
  };
  return {
    rawSpec,
    taskBytesBase64: taskBytes.toString("base64"),
    result,
    intent: null,
    transportRequestId: null,
  };
}
function harness(extra: TaskCliDependencies = {}) {
  const output: string[] = [];
  const reads = vi.fn(
    async (path: string): Promise<Uint8Array> =>
      path.endsWith("task.md") ? taskBytes : Buffer.from(JSON.stringify(spec())),
  );
  const ledger = vi.fn(async (): Promise<LedgerRead> => ({ kind: "missing-ledger" }));
  const dependencies: TaskCliDependencies = {
    stdout: (text) => {
      output.push(text);
    },
    readBytes: reads,
    readLedger: ledger,
    runtimeDir: offlineRuntimeDir,
    ...extra,
  };
  return {
    output,
    reads,
    ledger,
    run: (args: string[]) => runTaskCli(args, dependencies),
    json: () => JSON.parse(output.join("")),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Bridge v2 task CLI without executors", () => {
  it("reports machine-readable capabilities truthfully", async () => {
    const h = harness();
    expect(await h.run(["capabilities", "--json"])).toBe(0);
    const c = h.json();
    expect(c.production_execution).toBe(false);
    expect(c.selection.effort.supported).toBe(false);
    expect(c.approval.authority_configured).toBe(false);
    expect(c.health.state).toBe("unconfigured");
    expect(c.preflight.usage_and_billing.provenance).toBe("unknown");
    expect(c.legacy_browser_transport.unchanged).toBe(true);
    expect(h.reads).not.toHaveBeenCalled();
    expect(h.ledger).not.toHaveBeenCalled();
  });
  it("validates raw task and task file hashes without claiming approval", async () => {
    const h = harness();
    expect(await h.run(["validate", "--request", "request.json", "--task-file", "task.md"])).toBe(
      0,
    );
    expect(h.json()).toMatchObject({
      ok: true,
      request_id: id,
      approved: false,
      executable: false,
      schema_valid: true,
      task_file_hash_valid: true,
    });
    expect(h.ledger).not.toHaveBeenCalled();
  });
  it("rejects task file hash mismatch", async () => {
    const h = harness({
      readBytes: async (path) =>
        path.endsWith("task.md") ? Buffer.from("wrong") : Buffer.from(JSON.stringify(spec())),
    });
    expect(await h.run(["validate", "--request", "request.json", "--task-file", "task.md"])).toBe(
      2,
    );
    expect(h.json()).toMatchObject({ code: "task_file_hash_mismatch", reexecute: false });
  });
  it("rejects malformed or duplicated TaskSpec keys", async () => {
    const h = harness({
      readBytes: async () => Buffer.from('{"request_id":"one","request_id":"two"}'),
    });
    expect(await h.run(["validate", "--request", "request.json", "--task-file", "task.md"])).toBe(
      2,
    );
    expect(h.json()).toMatchObject({ code: "invalid_task", reexecute: false });
  });
  it("labels a valid design fixture as nonexecutable", async () => {
    const t = spec();
    t.mode = "design_fixture";
    t.allowed_paths = [];
    const h = harness({
      readBytes: async (path) =>
        path.endsWith("task.md") ? taskBytes : Buffer.from(JSON.stringify(t)),
    });
    expect(await h.run(["validate", "--request", "request.json", "--task-file", "task.md"])).toBe(
      0,
    );
    expect(h.json()).toMatchObject({ reason: "fixture_not_executable", executable: false });
  });
  it.each(["receive", "submit", "approve", "start", "cancel", "reconcile"])(
    "fails closed for %s with no file/store/process activity",
    async (command) => {
      const h = harness();
      expect(await h.run([command, id])).toBe(4);
      expect(h.json()).toMatchObject({
        code: "capability_unavailable",
        retryable: false,
        reexecute: false,
      });
      expect(h.reads).not.toHaveBeenCalled();
      expect(h.ledger).not.toHaveBeenCalled();
    },
  );
  it("fails closed for a submit with valid-looking input flags without reading them", async () => {
    const h = harness();
    expect(await h.run(["submit", "--request", "request.json", "--task-file", "task.md"])).toBe(4);
    expect(h.json().code).toBe("capability_unavailable");
    expect(h.reads).not.toHaveBeenCalled();
  });
  it.each([
    ["validate"],
    ["validate", "--request", "request.json"],
    ["status"],
    ["status", "../bad"],
    ["status", `${id}\n`],
    ["schema", "wrong"],
    ["capabilities", "extra"],
    ["validate", "--effort", "high"],
  ])("rejects unsupported/missing arguments: %s", async (...args) => {
    const h = harness();
    expect(await h.run(args)).toBe(2);
    expect(h.json().ok).toBe(false);
  });
  it("prints task help without looking up any external state", async () => {
    const h = harness();
    expect(await h.run(["help"])).toBe(0);
    expect(h.output.join("")).toContain("npm test -- tests/unit/task-runtime.test.ts");
    expect(h.ledger).not.toHaveBeenCalled();
  });
  it.each(["task", "result"])("reads only the fixed %s schema file", async (name) => {
    const reads = vi.fn(async () => Buffer.from('{"title":"schema fixture"}\n'));
    const h = harness({ readBytes: reads });
    expect(await h.run(["schema", name])).toBe(0);
    expect(h.json().title).toBe("schema fixture");
    expect(reads.mock.calls).toHaveLength(1);
  });
  it("reports missing ledger without initializing one", async () => {
    const h = harness();
    expect(await h.run(["status", id])).toBe(4);
    expect(h.json().code).toBe("ledger_not_initialized");
    expect(h.ledger).toHaveBeenCalledWith(join(offlineRuntimeDir, "jobs.db"), id);
  });
  it("reports missing UUID and preserves the original request", async () => {
    const h = harness({ readLedger: async () => ({ kind: "missing-request" }) });
    expect(await h.run(["status", id])).toBe(4);
    expect(h.json().code).toBe("request_not_found");
  });
  it("returns a validated current snapshot without calling it a terminal result", async () => {
    const record = snapshot();
    const h = harness({
      readLedger: async () => ({
        kind: "snapshot",
        snapshot: JSON.stringify(record),
        sequence: 2,
        receiptSnapshot: null,
      }),
    });
    expect(await h.run(["status", id])).toBe(0);
    expect(h.json()).toMatchObject({
      command: "status",
      evidence_authentication: "not_performed_by_cli",
      result: { status: "awaiting_approval" },
    });
  });
  it("does not manufacture a result while the task is pending", async () => {
    const h = harness({
      readLedger: async () => ({
        kind: "snapshot",
        snapshot: JSON.stringify(snapshot()),
        sequence: 2,
        receiptSnapshot: null,
      }),
    });
    expect(await h.run(["result", id])).toBe(6);
    expect(h.json()).toMatchObject({ code: "result_not_terminal", reexecute: false });
  });
  it("pauses on unknown rather than treating it as failed or retryable", async () => {
    const h = harness({
      readLedger: async () => ({
        kind: "snapshot",
        snapshot: JSON.stringify(snapshot("unknown")),
        sequence: 2,
        receiptSnapshot: null,
      }),
    });
    expect(await h.run(["result", id])).toBe(6);
    expect(h.json()).toMatchObject({ code: "outcome_unknown", retryable: false, reexecute: false });
  });
  it("requires a durable receipt row even for synthetic terminal snapshots", async () => {
    const h = harness({
      readLedger: async () => ({
        kind: "snapshot",
        snapshot: JSON.stringify(snapshot("failed")),
        sequence: 2,
        receiptSnapshot: null,
      }),
    });
    expect(await h.run(["result", id])).toBe(4);
    expect(h.json().code).toBe("terminal_receipt_missing_or_mismatched");
  });
  it("returns a matching synthetic terminal snapshot clearly labeled", async () => {
    const stored = JSON.stringify(snapshot("failed"));
    const h = harness({
      readLedger: async () => ({
        kind: "snapshot",
        snapshot: stored,
        sequence: 2,
        receiptSnapshot: stored,
      }),
    });
    expect(await h.run(["result", id])).toBe(0);
    expect(h.json().result).toMatchObject({ synthetic: true, status: "failed", receipt: null });
  });
  it("rejects a stale database row sequence", async () => {
    const h = harness({
      readLedger: async () => ({
        kind: "snapshot",
        snapshot: JSON.stringify(snapshot()),
        sequence: 3,
        receiptSnapshot: null,
      }),
    });
    expect(await h.run(["status", id])).toBe(4);
    expect(h.json().code).toBe("ledger_invalid");
  });
  it("rejects stored malformed raw task bytes", async () => {
    const record = snapshot();
    record.rawSpec = '{"request_id":1,"request_id":2}';
    const h = harness({
      readLedger: async () => ({
        kind: "snapshot",
        snapshot: JSON.stringify(record),
        sequence: 2,
        receiptSnapshot: null,
      }),
    });
    expect(await h.run(["status", id])).toBe(4);
    expect(h.json().code).toBe("ledger_invalid");
  });
  it("converts read failures into actionable machine errors", async () => {
    const h = harness({
      readLedger: async () => {
        throw new Error("database busy");
      },
    });
    expect(await h.run(["status", id])).toBe(4);
    expect(h.json()).toMatchObject({ code: "ledger_unreadable", reexecute: false });
  });
  it("routes task commands from the existing main entry point", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    expect(await main(["task", "capabilities"])).toBe(0);
    expect(JSON.parse(output.join("")).protocol_version).toBe("2.0");
  });
  it("keeps the legacy global help and points to task help", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    expect(await main(["--help"])).toBe(2);
    expect(output.join("")).toContain("task <subcommand>");
    expect(output.join("")).toContain("run --request");
  });
});
