/** No live CLI, provider, credentials, or Windows operation. Process authority is fake. */

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectAntigravityHelp } from "../../src/adapters/antigravity.js";
import {
  BOOTSTRAP_UNAVAILABLE_REASONS,
  type BootstrapResponseSource,
  extractBootstrapAck,
} from "../../src/adapters/bootstrap-extraction.js";
import { type CliBrokerOptions, CliBrokerService } from "../../src/adapters/cli-broker.js";
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
import {
  createSessionBootstrap,
  SessionBootstrapStore,
} from "../../src/adapters/session-bootstrap.js";
import { encodeResponseFrame } from "../../src/contracts/response-frame.js";
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
  const open = (overrides: Partial<CliBrokerOptions> = {}) =>
    new CliBrokerService({
      executorId: "broker",
      dbPath: join(dir, "broker.db"),
      bootstrap: { dbPath: join(dir, "bootstrap.db") },
      installations: [install, agyInstall],
      runtime: fake,
      now: () => new Date(now),
      rpcTimeoutMs: 30,
      ...overrides,
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
  const source = (identity: ExecutionIdentity): BootstrapResponseSource => ({
    protocol: "bridge-bootstrap-response-source-1",
    identity,
    provider: "claude",
    hostSessionId: identity.runId,
    artifact: fake.ref,
  });
  const reopen = (overrides: Partial<CliBrokerOptions> = {}) => {
    broker.close();
    broker = open(overrides);
  };
  function framed(identity: ExecutionIdentity, body?: string) {
    const plan = fake.plans.get(identity.runId);
    if (!plan) throw new Error("fixture_missing_plan");
    fake.evidence = Buffer.from(
      encodeResponseFrame(body ?? JSON.stringify(plan.bootstrap.ack), plan.responseFrame),
    );
    fake.ref = {
      ...fake.ref,
      sha256: sha256Bytes(fake.evidence),
      size_bytes: fake.evidence.length,
    };
    fake.finish(identity);
    const terminal = fake.observations.get(identity.runId);
    if (terminal?.kind !== "terminal") throw new Error("fixture_missing_terminal");
    return { plan, terminal };
  }
  function localDb<T>(filename: string, use: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(join(dir, filename));
    try {
      return use(db);
    } finally {
      db.close();
    }
  }
  it("requires explicit separate bootstrap file configuration, without a memory fallback", () => {
    expect(() => open({ bootstrap: undefined } as unknown as Partial<CliBrokerOptions>)).toThrow(
      "bootstrap_private_db_path_required",
    );
    expect(() => open({ bootstrap: { dbPath: join(dir, "broker.db") } })).toThrow(
      "bootstrap_private_db_path_required",
    );
    expect(() => open({ bootstrap: { dbPath: ":memory:" } })).toThrow(
      "bootstrap_state_directory_not_private",
    );
  });
  it("prepares exact durable bytes before the first dispatch and never prepares a persisted run again", async () => {
    const t = task();
    const identity = id(t);
    const prepared = vi.spyOn(SessionBootstrapStore.prototype, "prepare");
    const originalStart = fake.start.bind(fake);
    vi.spyOn(fake, "start").mockImplementation(async (plan) => {
      const saved = localDb("broker.db", (db) =>
        JSON.parse(
          String(
            db.prepare("SELECT row_json FROM cli_broker_runs WHERE run_id=?").get(identity.runId)
              ?.row_json,
          ),
        ),
      );
      expect(saved.plan).toEqual(plan);
      const advisory = new SessionBootstrapStore({
        dbPath: join(dir, "bootstrap.db"),
        now: () => new Date(now),
      });
      try {
        expect(advisory.inspect(plan.bootstrap)).toEqual({ receipt: null });
      } finally {
        advisory.close();
      }
      expect(Buffer.from(plan.stdinBase64, "base64").toString()).toContain(
        plan.bootstrap.reminderJson,
      );
      return originalStart(plan);
    });
    await broker.start(t, text, identity, intent(identity));
    const challenge = fake.plans.get(identity.runId)?.bootstrap.challengeId;
    reopen();
    await broker.start(t, text, identity, intent(identity));
    expect(prepared).toHaveBeenCalledTimes(1);
    expect(fake.plans.get(identity.runId)?.bootstrap.challengeId).toBe(challenge);
    expect(fake.starts).toBe(1);
    prepared.mockRestore();
  });
  it("retains prepare-before-admission orphan bytes for an unsent run", async () => {
    const t = task();
    const identity = id(t);
    await expect(
      broker.start(t, text, identity, { ...intent(identity), deadlineAt: at }),
    ).rejects.toThrow("deadline_invalid");
    const pending = localDb("bootstrap.db", (db) =>
      JSON.parse(
        String(
          db
            .prepare("SELECT row_json FROM bridge_session_bootstrap WHERE session_id=?")
            .get(identity.runId)?.row_json,
        ),
      ),
    ).plan;
    expect(fake.starts).toBe(0);
    reopen();
    await broker.start(t, text, identity, intent(identity));
    expect(fake.plans.get(identity.runId)?.bootstrap).toEqual(pending);
  });
  it("validates every supplied plan field and exact fresh identity without changing the pure planner", () => {
    const t = task();
    const identity = id(t);
    const saved = createSessionBootstrap({
      sessionId: identity.runId,
      provider: "claude",
      role: "response_producer",
      repoId: t.repo,
      contextEpoch: 1,
    });
    const launch = (b = saved) =>
      createCliLaunchPlan(t, text, identity, intent(identity), install, new Date(at), b);
    expect(launch().bootstrap).toEqual(saved);
    for (const change of [
      { version: "other" },
      { challengeId: randomUUID() },
      { bootstrapSha256: "a".repeat(64) },
      { reminderSha256: "b".repeat(64) },
      { reminderJson: `${saved.reminderJson} ` },
      { ack: { ...saved.ack, contextEpoch: 2 } },
      { reminder: { ...saved.reminder, docs: [] } },
    ])
      expect(() => launch({ ...saved, ...change })).toThrow();
    for (const change of [
      { sessionId: randomUUID() },
      { provider: "codex" as const },
      { role: "issuer" as const },
      { repoId: "different" },
      { contextEpoch: 2 },
    ])
      expect(() =>
        launch(createSessionBootstrap({ ...saved.reminder.session, ...change })),
      ).toThrow();
    expect(() =>
      launch(createSessionBootstrap(saved.reminder.session, { version: "bridge-v2-session/2" })),
    ).toThrow("version_unsupported");
    expect(
      createCliLaunchPlan(t, text, identity, intent(identity), install, new Date(at)).bootstrap
        .version,
    ).toBe("bridge-v2-session/1");
  });
  it.each(["paragraph", "fence"])(
    "captures one bound %s ACK only after terminal + artifacts commit",
    async (form) => {
      const select = vi.fn((accepted) => {
        const durable = localDb("broker.db", (db) =>
          JSON.parse(
            String(
              db
                .prepare("SELECT row_json FROM cli_broker_runs WHERE run_id=?")
                .get(accepted.identity.runId)?.row_json,
            ),
          ),
        );
        expect(durable.observation).toEqual(accepted);
        expect(durable.observation.kind).toBe("terminal");
        expect(
          localDb("broker.db", (db) =>
            db
              .prepare("SELECT bytes FROM cli_broker_artifacts WHERE artifact_id=?")
              .get(fake.ref.artifact_id),
          ),
        ).toBeDefined();
        return { ...source(accepted.identity), providerSessionId: "observed-provider-session" };
      });
      reopen({ selectBootstrapResponseSource: select });
      const t = task();
      const identity = id(t);
      await broker.start(t, text, identity, intent(identity));
      const ack = JSON.stringify(fake.plans.get(identity.runId)?.bootstrap.ack);
      const { terminal } = framed(
        identity,
        form === "fence" ? `Answer.\n\n\`\`\`json\n${ack}\n\`\`\`` : ack,
      );
      const expected = structuredClone(terminal);
      expect(await broker.collect(identity)).toEqual(expected);
      const projection = broker.bootstrapStatus(identity);
      expect(projection.state).toBe("confirmed");
      if (projection.state !== "confirmed") throw new Error("fixture_unconfirmed");
      expect(projection.sidecar.terminalPayloadSha256).toBe(
        sha256Bytes(Buffer.from(JSON.stringify(expected.result))),
      );
      expect(projection.sidecar.frameSha256).toBe(fake.ref.sha256);
      expect(projection.sidecar.source.providerSessionId).toBe("observed-provider-session");
      reopen({ selectBootstrapResponseSource: select });
      await broker.recover();
      expect(await broker.collect(identity)).toEqual(expected);
      expect(broker.bootstrapStatus(identity)).toEqual(projection);
      expect(select).toHaveBeenCalledTimes(1);
      expect(fake.starts).toBe(1);
    },
  );
  it.each(["missing", "expired", "evicted"])(
    "never regenerates %s advisory state for a persisted launch",
    async (kind) => {
      const prepare = vi.spyOn(SessionBootstrapStore.prototype, "prepare");
      reopen({
        bootstrap: {
          dbPath: join(dir, "bootstrap.db"),
          ttlMs: kind === "expired" ? 1 : 10000,
          maxSessions: 1,
        },
        selectBootstrapResponseSource: (accepted) => source(accepted.identity),
      });
      const t = task();
      const identity = id(t);
      await broker.start(t, text, identity, intent(identity));
      const original = structuredClone(fake.plans.get(identity.runId)?.bootstrap);
      if (kind === "expired") now += 2;
      else if (kind === "missing")
        localDb("bootstrap.db", (db) => db.prepare("DELETE FROM bridge_session_bootstrap").run());
      else {
        const s = new SessionBootstrapStore({
          dbPath: join(dir, "bootstrap.db"),
          maxSessions: 1,
          now: () => new Date(now),
        });
        try {
          s.prepare({
            session: {
              sessionId: randomUUID(),
              provider: "claude",
              role: "response_producer",
              repoId: t.repo,
              contextEpoch: 1,
            },
            bridgeLaunched: true,
            startup: "claude-print-stdin",
            mode: "new",
            context: "retained",
          });
        } finally {
          s.close();
        }
      }
      const count = prepare.mock.calls.length;
      await broker.start(t, text, identity, intent(identity));
      framed(identity);
      expect((await broker.collect(identity)).kind).toBe("terminal");
      expect(broker.bootstrapStatus(identity)).toEqual({
        state: "unavailable",
        reason: "bootstrap_state_missing_expired_or_changed",
      });
      expect(prepare).toHaveBeenCalledTimes(count);
      expect(fake.plans.get(identity.runId)?.bootstrap).toEqual(original);
      expect(fake.starts).toBe(1);
      prepare.mockRestore();
    },
  );
  it("keeps absent source unavailable even when later configuration could select one", async () => {
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    framed(identity);
    await broker.collect(identity);
    expect(broker.bootstrapStatus(identity)).toEqual({
      state: "unavailable",
      reason: "source_unavailable",
    });
    const select = vi.fn((accepted) => source(accepted.identity));
    reopen({ selectBootstrapResponseSource: select });
    await broker.recover();
    expect(select).not.toHaveBeenCalled();
  });
  it("recovers only the local projection after receipt succeeds and sidecar storage fails", async () => {
    const select = vi.fn((accepted) => source(accepted.identity));
    reopen({ selectBootstrapResponseSource: select });
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    framed(identity);
    localDb("broker.db", (db) =>
      db.exec(
        `CREATE TRIGGER fail_projection BEFORE UPDATE ON cli_broker_bootstrap WHEN json_extract(NEW.projection_json,'$.state')='confirmed' BEGIN SELECT RAISE(ABORT,'injected_sidecar_failure'); END;`,
      ),
    );
    const terminal = await broker.collect(identity);
    expect(terminal.kind).toBe("terminal");
    expect(broker.bootstrapStatus(identity).state).toBe("pending");
    const receipt = localDb("bootstrap.db", (db) =>
      JSON.parse(
        String(
          db
            .prepare("SELECT row_json FROM bridge_session_bootstrap WHERE session_id=?")
            .get(identity.runId)?.row_json,
        ),
      ),
    ).receipt;
    expect(receipt.receiptId).toBeTruthy();
    localDb("broker.db", (db) => db.exec("DROP TRIGGER fail_projection"));
    const calls = [
      vi.spyOn(fake, "start"),
      vi.spyOn(fake, "check"),
      vi.spyOn(fake, "status"),
      vi.spyOn(fake, "collect"),
      vi.spyOn(fake, "readArtifact"),
      vi.spyOn(fake, "cancel"),
    ];
    reopen({ selectBootstrapResponseSource: select });
    await broker.recover();
    expect(await broker.status(identity)).toEqual(terminal);
    const projection = broker.bootstrapStatus(identity);
    expect(projection.state).toBe("confirmed");
    if (projection.state === "confirmed") expect(projection.sidecar.receipt).toEqual(receipt);
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
  });
  it("never downgrades terminal status on source/sidecar failures and does not retry source selection", async () => {
    const select = vi.fn(() => {
      throw new Error("injected_source_failure");
    });
    reopen({ selectBootstrapResponseSource: select });
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    framed(identity);
    localDb("broker.db", (db) =>
      db.exec(
        "CREATE TRIGGER fail_all_projections BEFORE INSERT ON cli_broker_bootstrap BEGIN SELECT RAISE(ABORT,'injected_storage_failure'); END;",
      ),
    );
    const terminal = await broker.collect(identity);
    expect(terminal.kind).toBe("terminal");
    expect(broker.bootstrapStatus(identity)).toEqual({
      state: "unavailable",
      reason: "source_not_captured",
    });
    localDb("broker.db", (db) => db.exec("DROP TRIGGER fail_all_projections"));
    reopen({ selectBootstrapResponseSource: select });
    await broker.recover();
    expect(await broker.collect(identity)).toEqual(terminal);
    expect(select).toHaveBeenCalledTimes(1);
  });
  it.each([
    "quoted",
    "indented",
    "nested",
    "reminder",
    "template",
    "substring",
    "wrong_language",
    "duplicate",
    "duplicate_key",
    "malformed",
    "escaped_malformed",
    "wrong_session",
    "wrong_epoch",
    "wrong_version",
    "wrong_challenge",
    "wrong_hash",
    "unknown_field",
    "html",
    "unclosed",
    "interrupted_wrong_language",
    "interrupted_unclosed_fence",
    "interrupted_html_comment",
    "interrupted_tilde_fence",
    "interrupted_indented_fence",
    "interrupted_inline_html_comment",
  ])("rejects %s ACK candidates without changing terminal evidence", async (kind) => {
    reopen({ selectBootstrapResponseSource: (accepted) => source(accepted.identity) });
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    const plan = fake.plans.get(identity.runId) as CliLaunchPlan;
    const ack = JSON.stringify(plan.bootstrap.ack);
    const bodies: Record<string, string> = {
      quoted: `> ${ack}`,
      indented: `    ${ack}`,
      nested: JSON.stringify({ data: plan.bootstrap.ack }),
      reminder: plan.bootstrap.reminderJson,
      template: JSON.stringify({ protocol: "bridge-session-bootstrap/1", ack: plan.bootstrap.ack }),
      substring: `Acknowledged: ${ack}`,
      wrong_language: `\`\`\`javascript\n${ack}\n\`\`\``,
      duplicate: `${ack}\n\n${ack}`,
      duplicate_key: ack.replace('"contextEpoch":1', '"contextEpoch":1,"contextEpoch":1'),
      malformed: ack.slice(0, -1),
      escaped_malformed: `${ack.replace("bridge-session-bootstrap-ack/1", "\\u0062ridge-session-bootstrap-ack/1").slice(0, -1)}\n\n${ack}`,
      wrong_session: JSON.stringify({ ...plan.bootstrap.ack, sessionId: randomUUID() }),
      wrong_epoch: JSON.stringify({ ...plan.bootstrap.ack, contextEpoch: 2 }),
      wrong_version: JSON.stringify({ ...plan.bootstrap.ack, version: "bridge-v2-session/2" }),
      wrong_challenge: JSON.stringify({ ...plan.bootstrap.ack, challengeId: randomUUID() }),
      wrong_hash: JSON.stringify({ ...plan.bootstrap.ack, bootstrapSha256: "0".repeat(64) }),
      unknown_field: JSON.stringify({ ...plan.bootstrap.ack, extra: true }),
      html: `<blockquote>\n\n${ack}\n\n</blockquote>`,
      unclosed: `\`\`\`json\n${ack}`,
      interrupted_wrong_language: `Example:\n\`\`\`javascript\n\n${ack}\n\ntrailer\n\`\`\``,
      interrupted_unclosed_fence: `Example:\n\`\`\`javascript\n\n${ack}`,
      interrupted_html_comment: `Example:\n<!--\n\n${ack}\n\ntrailer\n-->`,
      interrupted_tilde_fence: `Example:\n~~~javascript\n\n${ack}\n\ntrailer\n~~~`,
      interrupted_indented_fence: `- Example:\n  \`\`\`javascript\n\n${ack}\n\ntrailer\n  \`\`\``,
      interrupted_inline_html_comment: `Example: <!--\n\n${ack}\n\ntrailer -->`,
    };
    const { terminal } = framed(identity, bodies[kind]);
    expect(await broker.collect(identity)).toEqual(terminal);
    expect(broker.bootstrapStatus(identity)).toEqual({
      state: "unconfirmed",
      reason: "no_unique_bound_v1_ack",
    });
    const calls = [
      vi.spyOn(fake, "start"),
      vi.spyOn(fake, "check"),
      vi.spyOn(fake, "status"),
      vi.spyOn(fake, "collect"),
      vi.spyOn(fake, "readArtifact"),
      vi.spyOn(fake, "cancel"),
    ];
    await broker.recover();
    expect(await broker.collect(identity)).toEqual(terminal);
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(fake.starts).toBe(1);
  });
  it.each([
    "request",
    "task_hash",
    "run",
    "fence",
    "provider",
    "host_session",
    "provider_session",
    "artifact_id",
    "artifact_hash",
    "artifact_size",
    "extra",
    "async",
  ])("rejects %s source substitution after committing terminal", async (kind) => {
    reopen({
      selectBootstrapResponseSource: (accepted) => {
        const selected = source(accepted.identity);
        switch (kind) {
          case "request":
            selected.identity = { ...selected.identity, requestId: randomUUID() };
            break;
          case "task_hash":
            selected.identity = { ...selected.identity, taskSpecHash: "0".repeat(64) };
            break;
          case "run":
            selected.identity = { ...selected.identity, runId: randomUUID() };
            break;
          case "fence":
            selected.identity = { ...selected.identity, fencingToken: 9 };
            break;
          case "provider":
            selected.provider = "codex";
            break;
          case "host_session":
            selected.hostSessionId = randomUUID();
            break;
          case "provider_session":
            selected.providerSessionId = "not actually observed\n";
            break;
          case "artifact_id":
            selected.artifact = { ...selected.artifact, artifact_id: "unselected" };
            break;
          case "artifact_hash":
            selected.artifact = { ...selected.artifact, sha256: "0".repeat(64) };
            break;
          case "artifact_size":
            selected.artifact = { ...selected.artifact, size_bytes: 1 };
            break;
          case "extra":
            return { ...selected, latest: true } as BootstrapResponseSource;
          case "async":
            return Promise.resolve(selected) as unknown as BootstrapResponseSource;
        }
        return selected;
      },
    });
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    const { terminal } = framed(identity);
    expect(await broker.collect(identity)).toEqual(terminal);
    expect(broker.bootstrapStatus(identity)).toEqual({
      state: "unavailable",
      reason: "source_capture_failed",
    });
  });
  it("rejects wrong full frame, bad UTF-8 and cached byte tampering; preserves exact CRLF hash", async () => {
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    const { plan, terminal } = framed(identity);
    const check = (bytes: Uint8Array) => {
      const ref = { ...fake.ref, sha256: sha256Bytes(bytes), size_bytes: bytes.length };
      const changed = structuredClone(terminal);
      changed.result.stdout_ref = ref;
      return extractBootstrapAck(plan, { ...source(identity), artifact: ref }, changed, bytes);
    };
    for (const bytes of [
      Buffer.from(fake.evidence.toString().replace(identity.runId, randomUUID())),
      Buffer.concat([fake.evidence, Buffer.from("extra")]),
      Buffer.concat([Buffer.from([0xff]), fake.evidence]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fake.evidence]),
      Buffer.alloc(1048577, "a"),
    ])
      expect(() => check(bytes)).toThrow();
    expect(() =>
      extractBootstrapAck(plan, source(identity), terminal, Buffer.from("corrupt")),
    ).toThrow("cached_artifact_mismatch");
    const crlf = Buffer.from(fake.evidence.toString().replace(/\n/g, "\r\n"));
    expect(check(crlf).frameSha256).toBe(sha256Bytes(crlf));
  });
  it("retries a local advisory store failure with no model/query or source replay", async () => {
    const select = vi.fn((accepted) => source(accepted.identity));
    reopen({ selectBootstrapResponseSource: select });
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    framed(identity);
    const fail = vi
      .spyOn(SessionBootstrapStore.prototype, "acknowledge")
      .mockImplementationOnce(() => {
        throw new Error("injected_advisory_store_failure");
      });
    const terminal = await broker.collect(identity);
    expect(terminal.kind).toBe("terminal");
    expect(broker.bootstrapStatus(identity).state).toBe("pending");
    fail.mockRestore();
    const runtime = [
      vi.spyOn(fake, "start"),
      vi.spyOn(fake, "check"),
      vi.spyOn(fake, "status"),
      vi.spyOn(fake, "collect"),
      vi.spyOn(fake, "readArtifact"),
      vi.spyOn(fake, "cancel"),
    ];
    await broker.recover();
    expect(broker.bootstrapStatus(identity).state).toBe("confirmed");
    expect(select).toHaveBeenCalledTimes(1);
    for (const call of runtime) expect(call).not.toHaveBeenCalled();
  });
  it("does not infer a provider session ID and rejects persisted sidecar tampering", async () => {
    reopen({ selectBootstrapResponseSource: (accepted) => source(accepted.identity) });
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    framed(identity);
    await broker.collect(identity);
    const projection = broker.bootstrapStatus(identity);
    if (projection.state !== "confirmed") throw new Error("fixture_unconfirmed");
    expect(projection.sidecar.source).not.toHaveProperty("providerSessionId");
    for (const change of [
      { frameSha256: "0".repeat(64) },
      { frameBodySha256: "0".repeat(64) },
      { terminalPayloadSha256: "0".repeat(64) },
      { extra: true },
      { receipt: { ...projection.sidecar.receipt, reminderSha256: "0".repeat(64) } },
      { source: { ...projection.sidecar.source, hostSessionId: randomUUID() } },
    ]) {
      localDb("broker.db", (db) =>
        db
          .prepare("UPDATE cli_broker_bootstrap SET projection_json=? WHERE run_id=?")
          .run(
            JSON.stringify({ state: "confirmed", sidecar: { ...projection.sidecar, ...change } }),
            identity.runId,
          ),
      );
      expect(broker.bootstrapStatus(identity)).toEqual({
        state: "unavailable",
        reason: "projection_invalid",
      });
      expect((await broker.status(identity)).kind).toBe("terminal");
    }
  });
  it("binds the cancellation-winning terminal digest and leaves its failure status untouched", async () => {
    reopen({ selectBootstrapResponseSource: (accepted) => source(accepted.identity) });
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    framed(identity);
    let release: (() => void) | undefined;
    const original = fake.readArtifact.bind(fake);
    vi.spyOn(fake, "readArtifact").mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original();
    });
    const collecting = broker.collect(identity);
    await Promise.resolve();
    const cancelled = await broker.cancel(identity, "user", 1);
    release?.();
    expect(await collecting).toEqual(cancelled);
    if (cancelled.kind !== "terminal") throw new Error("fixture_not_terminal");
    expect(cancelled.result.status).toBe("cancelled");
    const projection = broker.bootstrapStatus(identity);
    if (projection.state !== "confirmed") throw new Error("fixture_unconfirmed");
    expect(projection.sidecar.terminalPayloadSha256).toBe(
      sha256Bytes(Buffer.from(JSON.stringify(cancelled.result))),
    );
    expect(fake.starts).toBe(1);
  });
  it("fails closed before dispatch if durable bootstrap preparation fails", async () => {
    localDb("bootstrap.db", (db) =>
      db.exec(
        "CREATE TRIGGER fail_prepare BEFORE INSERT ON bridge_session_bootstrap BEGIN SELECT RAISE(ABORT,'injected_prepare_failure'); END;",
      ),
    );
    const t = task();
    const identity = id(t);
    await expect(broker.start(t, text, identity, intent(identity))).rejects.toThrow(
      "injected_prepare_failure",
    );
    expect(fake.starts).toBe(0);
    expect(
      localDb(
        "broker.db",
        (db) => db.prepare("SELECT count(*) AS n FROM cli_broker_runs").get()?.n,
      ),
    ).toBe(0);
  });
  it("cleans up the owned bootstrap handle when broker construction fails", () => {
    const closed = vi.spyOn(SessionBootstrapStore.prototype, "close");
    expect(() => open({ executorId: "different" })).toThrow("cli_broker_executor_changed");
    expect(closed).toHaveBeenCalledTimes(1);
    closed.mockRestore();
  });
  it("uses a finite state-specific projection diagnostic allowlist without echoing corrupt state", async () => {
    const t = task();
    const identity = id(t);
    await broker.start(t, text, identity, intent(identity));
    framed(identity);
    const terminal = await broker.collect(identity);
    const set = (projection: unknown) =>
      localDb("broker.db", (db) =>
        db
          .prepare("UPDATE cli_broker_bootstrap SET projection_json=? WHERE run_id=?")
          .run(JSON.stringify(projection), identity.runId),
      );
    for (const state of ["unavailable", "unconfirmed"])
      for (const reason of [
        "sk_test_secret_material",
        "a".repeat(64),
        "unexpected_internal_details",
        123,
        null,
        {},
        ["source_unavailable"],
      ]) {
        set({ state, reason });
        expect(broker.bootstrapStatus(identity)).toEqual({
          state: "unavailable",
          reason: "projection_invalid",
        });
        expect(await broker.status(identity)).toEqual(terminal);
      }
    for (const reason of BOOTSTRAP_UNAVAILABLE_REASONS) {
      set({ state: "unavailable", reason });
      expect(broker.bootstrapStatus(identity)).toEqual({ state: "unavailable", reason });
      set({ state: "unconfirmed", reason });
      expect(broker.bootstrapStatus(identity)).toEqual({
        state: "unavailable",
        reason: "projection_invalid",
      });
    }
    set({ state: "unconfirmed", reason: "no_unique_bound_v1_ack" });
    expect(broker.bootstrapStatus(identity)).toEqual({
      state: "unconfirmed",
      reason: "no_unique_bound_v1_ack",
    });
    set({ state: "unavailable", reason: "no_unique_bound_v1_ack" });
    expect(broker.bootstrapStatus(identity)).toEqual({
      state: "unavailable",
      reason: "projection_invalid",
    });
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
