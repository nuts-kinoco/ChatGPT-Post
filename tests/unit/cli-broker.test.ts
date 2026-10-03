/** No live CLI, provider, credentials, or Windows operation. Process authority is fake. */

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectAntigravityHelp } from "../../src/adapters/antigravity.js";
import { CliBrokerService } from "../../src/adapters/cli-broker.js";
import {
  CLI_ISOLATION_REQUIREMENTS,
  type CliCapabilityRequest,
  type CliIsolationCapabilities,
  type CliIsolationRuntime,
} from "../../src/adapters/cli-isolation.js";
import {
  type CliInstallation,
  type CliLaunchPlan,
  createCliLaunchPlan,
} from "../../src/adapters/cli-launch.js";
import { decodeCliRpcBody, encodeCliRpcFrame } from "../../src/adapters/cli-rpc.js";
import { sha256Bytes, validateTaskResult } from "../../src/contracts/task.js";
import type { ArtifactRef, ResultSpec, TaskSpec } from "../../src/contracts/task-types.js";
import type { ExecutionIdentity, ExecutorObservation } from "../../src/state/task-executor.js";
import type { RunIntent } from "../../src/state/task-store.js";

const text = Buffer.from("Inspect source without any live model call.\n");
const at = "2026-10-03T00:00:00.000Z";
const install: CliInstallation = {
  agent: "claude",
  executable: "/opt/bridge/claude",
  executableSha256: "a".repeat(64),
  version: "fixture-version",
  models: ["fixture-model"],
  repoId: "fixture-repo",
  repoRoot: "/srv/repo",
  homeRoot: "/srv/homes",
  authentication: "subscription",
};
const agyInstall: CliInstallation = {
  ...install,
  agent: "antigravity",
  executable: "/opt/bridge/agy",
  version: "1.2.15",
  antigravity: inspectAntigravityHelp(
    readFileSync(new URL("../fixtures/antigravity/help-1.2.15.txt", import.meta.url), "utf8"),
    "1.2.15",
  ),
};
function task(): TaskSpec {
  return {
    protocol_version: "2.0",
    request_id: randomUUID(),
    agent: "claude",
    requested_model: "fixture-model",
    repo: "fixture-repo",
    base_commit: "b".repeat(40),
    mode: "read_only",
    policy_snapshot_sha256: "c".repeat(64),
    allowed_paths: [{ path: "src", scope: "subtree", permissions: ["read"] }],
    allowed_commands: [],
    task_file: "task.md",
    task_file_hash: sha256Bytes(text),
    approval: {
      required: true,
      tier: "manual",
      preauthorization: null,
      binding: "sha256-raw-task-spec",
      source: "detached-authoritative-record",
      max_age_seconds: 60,
      max_starts: 1,
    },
    timeout: { run_seconds: 10, cancel_grace_seconds: 1 },
    success_criteria: [
      { criterion_id: "inspect", description: "Inspect", evaluator_id: "fixture" },
    ],
    task_network: "deny",
    environment: {},
    retry_policy: "no-automatic-reexecution",
  };
}
function id(t: TaskSpec, fence = 1): ExecutionIdentity {
  return {
    requestId: t.request_id,
    taskSpecHash: sha256Bytes(Buffer.from(JSON.stringify(t))),
    runId: randomUUID(),
    fencingToken: fence,
  };
}
function intent(identity: ExecutionIdentity): RunIntent {
  return {
    runId: identity.runId,
    fencingToken: identity.fencingToken,
    startSequence: 1,
    approvalId: randomUUID(),
    deadlineAt: "2026-10-03T00:00:10.000Z",
    sessionId: "session",
    executorId: "broker",
    resourceKeys: ["repo:fixture-repo"],
    cancelAt: null,
    cancelReason: null,
  };
}
class FakeIsolation implements CliIsolationRuntime {
  starts = 0;
  cancels = 0;
  broken = false;
  rejectCheck = false;
  corrupt = false;
  pendingStart: (() => Promise<void>) | null = null;
  plans = new Map<string, CliLaunchPlan>();
  observations = new Map<string, ExecutorObservation>();
  tombstones = new Set<string>();
  evidence = Buffer.from("fixture-only trusted evidence");
  ref: ArtifactRef = {
    artifact_id: "fixture-evidence",
    sha256: sha256Bytes(this.evidence),
    size_bytes: this.evidence.length,
    media_type: "text/plain",
  };
  async check(p: CliCapabilityRequest): Promise<CliIsolationCapabilities> {
    return {
      protocol: "bridge-cli-isolation/1",
      platform: "linux",
      implementation: "FAKE-FOR-TESTS",
      enforced: this.rejectCheck ? [] : [...CLI_ISOLATION_REQUIREMENTS],
      executableSha256: p.executableSha256,
      actualBaseCommit: p.task.base_commit,
      actualVersion: p.version,
    };
  }
  async start(p: CliLaunchPlan): Promise<ExecutorObservation> {
    this.starts++;
    this.plans.set(p.identity.runId, p);
    if (this.pendingStart) await this.pendingStart();
    if (this.tombstones.has(p.identity.runId))
      return { kind: "unknown", identity: p.identity, reason: "tombstone" };
    const observation: ExecutorObservation = {
      kind: "running",
      identity: p.identity,
      startedAt: at,
      actualAgent: p.task.agent,
      actualModel: p.task.requested_model,
      process: {
        host_id: "fixture-host",
        boot_id: "00000000-0000-4000-8000-000000000001",
        pid: 42,
        creation_time: at,
        executable_sha256: p.executableSha256,
        process_group_id: `fixture-${p.identity.runId}`,
      },
    };
    this.observations.set(p.identity.runId, observation);
    if (this.broken) throw new Error("disconnect_after_spawn");
    return observation;
  }
  async status(identity: ExecutionIdentity): Promise<ExecutorObservation> {
    if (this.broken) throw new Error("fixture_disconnect");
    return (
      this.observations.get(identity.runId) ?? {
        kind: "unknown",
        identity,
        reason: "not_registered",
      }
    );
  }
  async cancel(
    identity: ExecutionIdentity,
    reason: "user" | "timeout",
  ): Promise<ExecutorObservation> {
    this.cancels++;
    this.tombstones.add(identity.runId);
    if (this.broken) throw new Error("fixture_disconnect");
    if (this.observations.get(identity.runId)?.kind === "running")
      this.finish(identity, reason === "user" ? "cancelled" : "failed");
    return this.status(identity);
  }
  async collect(identity: ExecutionIdentity): Promise<ExecutorObservation> {
    return this.status(identity);
  }
  async readArtifact(): Promise<Uint8Array> {
    return this.corrupt ? Buffer.from("bad") : this.evidence;
  }
  finish(
    identity: ExecutionIdentity,
    status: "succeeded" | "failed" | "cancelled" = "succeeded",
  ): void {
    const running = this.observations.get(identity.runId);
    const plan = this.plans.get(identity.runId);
    if (running?.kind !== "running" || !plan) throw new Error("fixture_not_running");
    const finished = "2026-10-03T00:00:01.000Z";
    const result: ResultSpec = {
      protocol_version: "2.0",
      request_id: identity.requestId,
      task_spec_hash: identity.taskSpecHash,
      task_file_hash: plan.task.task_file_hash,
      synthetic: false,
      status,
      last_confirmed_status: status,
      observation_seq: 2,
      observed_at: finished,
      outcome_known: true,
      started_at: at,
      finished_at: finished,
      actual_agent: plan.task.agent,
      actual_model: plan.task.requested_model,
      base_commit: plan.task.base_commit,
      resulting_commit: plan.task.base_commit,
      run_id: identity.runId,
      fencing_token: identity.fencingToken,
      process_identity: running.process,
      commands_run: [],
      tests:
        status === "succeeded"
          ? [
              {
                test_id: "inspect",
                criterion_id: "inspect",
                outcome: "passed",
                command_invocation_ids: [],
                evidence_ref: this.ref,
              },
            ]
          : [],
      exit_codes: [],
      changed_files: [],
      diff: { kind: "none", complete: true, artifact_ref: null },
      stdout_ref: this.ref,
      stderr_ref: this.ref,
      error:
        status === "succeeded"
          ? null
          : { code: "fixture_failure", message: "Fixture ended", retryable: false },
      receipt: {
        receipt_id: randomUUID(),
        request_id: identity.requestId,
        task_spec_sha256: identity.taskSpecHash,
        run_id: identity.runId,
        fencing_token: identity.fencingToken,
        ledger_sequence: 2,
        terminal_status: status,
        process_state: "all_terminated",
        recorded_at: finished,
        evidence_ref: this.ref,
      },
      verification: { state: "verified", checked_at: finished, evidence_ref: this.ref },
    };
    const checked = validateTaskResult(result, {
      task: plan.task,
      taskSpecHash: identity.taskSpecHash,
    });
    if (!checked.valid) throw new Error(checked.errors.join(";"));
    this.observations.set(identity.runId, {
      kind: "terminal",
      identity,
      result,
      allTerminated: true,
    });
  }
}

describe("durable CLI broker, fake process authority only", () => {
  let dir: string;
  let fake: FakeIsolation;
  let broker: CliBrokerService;
  let now: number;
  const open = () =>
    new CliBrokerService({
      executorId: "broker",
      dbPath: join(dir, "broker.db"),
      installations: [install, agyInstall],
      runtime: fake,
      now: () => new Date(now),
      rpcTimeoutMs: 30,
    });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cli-broker-"));
    fake = new FakeIsolation();
    now = Date.parse(at);
    broker = open();
  });
  afterEach(async () => {
    broker.close();
    await rm(dir, { recursive: true, force: true });
  });
  it("runs Antigravity through the same broker identity, evidence, dedupe and collection gates", async () => {
    const t = { ...task(), agent: "antigravity" };
    const identity = id(t);
    expect((await broker.start(t, text, identity, intent(identity))).kind).toBe("running");
    expect(fake.plans.get(identity.runId)?.argv).toContain("--input-format");
    broker.close();
    broker = open();
    expect((await broker.start(t, text, identity, intent(identity))).kind).toBe("running");
    fake.finish(identity);
    const observed = await broker.collect(identity);
    expect(observed.kind).toBe("terminal");
    if (observed.kind === "terminal") expect(observed.result.actual_agent).toBe("antigravity");
    expect(fake.starts).toBe(1);
  });
  it("never treats Antigravity flags as the missing OS confinement", async () => {
    const t = { ...task(), agent: "antigravity" };
    const identity = id(t);
    fake.rejectCheck = true;
    await expect(broker.checkCapabilities(t)).rejects.toThrow("sandbox_capability_unavailable");
    expect((await broker.start(t, text, identity, intent(identity))).kind).toBe("unknown");
    expect(fake.starts).toBe(0);
  });
  it("keeps Antigravity cancellation on the durable broker, including pre-start tombstones", async () => {
    const t = { ...task(), agent: "antigravity" };
    const identity = id(t);
    await broker.cancel(identity, "user", 1);
    broker.close();
    broker = open();
    await broker.start(t, text, identity, intent(identity));
    expect(fake.starts).toBe(0);
    expect(fake.cancels).toBeGreaterThan(0);
  });
  it("uses exact direct argv, controlled home, stdin bytes and no shell", () => {
    const t = task();
    const identity = id(t);
    const p = createCliLaunchPlan(t, text, identity, intent(identity), install, new Date(at));
    expect(p.argv).toContain("--print");
    expect(p.argv).not.toContain(text.toString());
    expect(p.io.shell).toBe(false);
    expect(p.environment).not.toHaveProperty("PATH");
    expect(Buffer.from(p.stdinBase64, "base64").toString()).toContain(text.toString());
    expect(p.responseFrame.attemptId).toBe(identity.runId);
    expect(p.bootstrap.reminder.session.sessionId).toBe(identity.runId);
    expect(p.bootstrap.reminder.session.role).toBe("response_producer");
    expect(Buffer.from(p.stdinBase64, "base64").toString()).toContain(p.bootstrap.version);
    expect(p.authentication).toBe("subscription");
  });
  it("uses verified codex exec flags and rejects unregistered models", () => {
    const t = task();
    t.agent = "codex";
    const identity = id(t);
    const p = createCliLaunchPlan(
      t,
      text,
      identity,
      intent(identity),
      { ...install, agent: "codex" },
      new Date(at),
    );
    expect(p.argv).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--model",
      "fixture-model",
      "--cd",
      "/srv/repo",
      "-",
    ]);
    t.requested_model = "unapproved";
    expect(() =>
      createCliLaunchPlan(
        t,
        text,
        identity,
        intent(identity),
        { ...install, agent: "codex" },
        new Date(at),
      ),
    ).toThrow("cli_agent_model_repo_denied");
  });
  it("rejects task byte tampering and expired deadlines", async () => {
    const t = task();
    const identity = id(t);
    await expect(broker.start(t, Buffer.from("wrong"), identity, intent(identity))).rejects.toThrow(
      "cli_task_invalid",
    );
    now += 11000;
    await expect(broker.start(t, text, identity, intent(identity))).rejects.toThrow(
      "cli_deadline_invalid",
    );
    expect(fake.starts).toBe(0);
  });
  it("requires every confinement capability and does not infer one from allowlists", async () => {
    fake.rejectCheck = true;
    await expect(broker.checkCapabilities(task())).rejects.toThrow(
      "sandbox_capability_unavailable",
    );
    const t = task();
    const identity = id(t);
    expect((await broker.start(t, text, identity, intent(identity))).kind).toBe("unknown");
    expect(fake.starts).toBe(0);
  });
  it("rejects actual base-commit and provider-binary mismatches", async () => {
    const original = fake.check.bind(fake);
    const spy = vi.spyOn(fake, "check").mockImplementation(async (plan) => ({
      ...(await original(plan)),
      actualBaseCommit: "d".repeat(40),
    }));
    await expect(broker.checkCapabilities(task())).rejects.toThrow("base_commit_mismatch");
    spy.mockImplementation(async (plan) => ({
      ...(await original(plan)),
      executableSha256: "e".repeat(64),
    }));
    await expect(broker.checkCapabilities(task())).rejects.toThrow(
      "cli_binary_or_version_mismatch",
    );
    expect(fake.starts).toBe(0);
  });
  it("durably deduplicates start before and after reopen", async () => {
    const t = task();
    const identity = id(t);
    expect((await broker.start(t, text, identity, intent(identity))).kind).toBe("running");
    expect((await broker.start(t, text, identity, intent(identity))).kind).toBe("running");
    broker.close();
    broker = open();
    expect((await broker.start(t, text, identity, intent(identity))).kind).toBe("running");
    expect(fake.starts).toBe(1);
  });
  it("never repeats ambiguous dispatch after a crash/disconnect", async () => {
    const t = task();
    const identity = id(t);
    fake.broken = true;
    expect((await broker.start(t, text, identity, intent(identity))).kind).toBe("unknown");
    broker.close();
    broker = open();
    fake.broken = false;
    expect((await broker.start(t, text, identity, intent(identity))).kind).toBe("running");
    expect(fake.starts).toBe(1);
  });
  it("bounds a hung start and never reexecutes it", async () => {
    fake.pendingStart = () => new Promise(() => {});
    const t = task();
    const identity = id(t);
    expect((await broker.start(t, text, identity, intent(identity))).kind).toBe("unknown");
    await broker.start(t, text, identity, intent(identity));
    expect(fake.starts).toBe(1);
  });
  it("retains cancel-before-start tombstone across reopen", async () => {
    const t = task();
    const identity = id(t);
    fake.broken = true;
    expect((await broker.cancel(identity, "user", 1)).kind).toBe("unknown");
    broker.close();
    broker = open();
    fake.broken = false;
    await broker.start(t, text, identity, intent(identity));
    expect(fake.starts).toBe(0);
    expect(fake.cancels).toBeGreaterThanOrEqual(2);
  });
  it("collects verified success and log bytes without another execution", async () => {
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    fake.finish(identity);
    const observation = await broker.collect(identity);
    expect(observation.kind).toBe("terminal");
    if (observation.kind === "terminal") expect(observation.result.status).toBe("succeeded");
    expect(Buffer.from(await broker.readArtifact(fake.ref))).toEqual(fake.evidence);
    broker.close();
    broker = open();
    fake.broken = true;
    expect((await broker.collect(identity)).kind).toBe("terminal");
    expect(fake.starts).toBe(1);
  });
  it("collects verified failures without turning them into success", async () => {
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    fake.finish(identity, "failed");
    const observation = await broker.collect(identity);
    expect(observation.kind).toBe("terminal");
    if (observation.kind === "terminal") expect(observation.result.status).toBe("failed");
  });
  it("rejects corrupt log/evidence bytes and retains resource locks", async () => {
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    fake.finish(identity);
    fake.corrupt = true;
    expect((await broker.collect(identity)).kind).toBe("unknown");
    const next = task();
    const nextId = id(next, 2);
    await expect(broker.start(next, text, nextId, intent(nextId))).rejects.toThrow(
      "cli_resource_fenced_or_busy",
    );
  });
  it("rejects PID reuse and unproved descendant termination", async () => {
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    const observation = fake.observations.get(identity.runId);
    if (observation?.kind !== "running") throw new Error("fixture");
    observation.process.creation_time = "2026-10-03T00:00:00.001Z";
    expect((await broker.status(identity)).kind).toBe("unknown");
    fake.finish(identity);
    const terminal = fake.observations.get(identity.runId);
    if (terminal?.kind !== "terminal") throw new Error("fixture");
    terminal.allTerminated = false;
    expect((await broker.collect(identity)).kind).toBe("unknown");
  });
  it("reconciles deadlines after controller disconnect", async () => {
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    now += 11000;
    await broker.recover();
    const observation = await broker.status(identity);
    expect(fake.cancels).toBe(1);
    if (observation.kind !== "terminal") throw new Error("fixture");
    expect(observation.result.status).toBe("failed");
    expect(observation.result.error?.code).toBe("run_timeout");
  });
  it("cancels idempotently and frees locks only after terminal proof", async () => {
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    const observation = await broker.cancel(identity, "user", 1);
    if (observation.kind !== "terminal") throw new Error("fixture");
    expect(observation.result.status).toBe("cancelled");
    await broker.cancel(identity, "user", 1);
    expect(fake.cancels).toBe(1);
    const next = task();
    const nextId = id(next, 2);
    expect((await broker.start(next, text, nextId, intent(nextId))).kind).toBe("running");
  });
  it("rejects stale fences and mismatched immutable identity", async () => {
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    await expect(broker.status({ ...identity, fencingToken: 2 })).rejects.toThrow(
      "cli_identity_conflict",
    );
    await broker.cancel(identity, "user", 1);
    const next = task();
    const nextId = id(next, 1);
    await expect(broker.start(next, text, nextId, intent(nextId))).rejects.toThrow(
      "cli_resource_fenced_or_busy",
    );
  });
  it("rejects a task payload change even when the caller reuses its old hash", async () => {
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    await expect(
      broker.start({ ...t, requested_model: "other" }, text, identity, intent(identity)),
    ).rejects.toThrow("cli_start_payload_conflict");
  });
  it("keeps unknown unseen runs unknown and does not read arbitrary artifacts", async () => {
    expect((await broker.status(id(task()))).kind).toBe("unknown");
    await expect(broker.readArtifact(fake.ref)).rejects.toThrow("cli_artifact_not_collected");
  });
  it("encrypts payloads and rejects forgery, wrong key and reflected frames", () => {
    const key = randomBytes(32);
    const payload = { id: randomUUID(), task: "secret task bytes" };
    const frame = encodeCliRpcFrame(payload, key, "request");
    expect(frame.includes(Buffer.from("secret task bytes"))).toBe(false);
    expect(decodeCliRpcBody(frame.subarray(4), key, "request")).toEqual(payload);
    expect(() => decodeCliRpcBody(frame.subarray(4), randomBytes(32), "request")).toThrow();
    expect(() => decodeCliRpcBody(frame.subarray(4), key, "response")).toThrow();
    frame[20] = (frame[20] ?? 0) ^ 1;
    expect(() => decodeCliRpcBody(frame.subarray(4), key, "request")).toThrow();
  });
  it("requires a private durable state directory", async () => {
    await chmod(dir, 0o755);
    expect(() => open()).toThrow("cli_broker_state_directory_not_private");
    await chmod(dir, 0o700);
  });
});
