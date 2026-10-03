/** All provider output below is synthetic. Help fixture alone was captured without authentication. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_ADAPTER_CAPABILITIES,
  ANTIGRAVITY_REQUIRED_FLAGS,
  AntigravityOutputParser,
  inspectAntigravityHelp,
  parseAntigravityOutput,
} from "../../src/adapters/antigravity.js";
import {
  type CliInstallation,
  createCliLaunchPlan,
  validateInstallation,
} from "../../src/adapters/cli-launch.js";
import {
  createSessionBootstrap,
  parseSessionBootstrap,
  SessionBootstrapStore,
} from "../../src/adapters/session-bootstrap.js";
import { encodeResponseFrame } from "../../src/contracts/response-frame.js";
import {
  parseStrictJsonBytes,
  parseStrictProviderJsonBytes,
  sha256Bytes,
} from "../../src/contracts/task.js";
import type { TaskSpec } from "../../src/contracts/task-types.js";
import { agentLabel } from "../../src/ui/public/app.js";

const help = readFileSync(
  new URL("../fixtures/antigravity/help-1.2.15.txt", import.meta.url),
  "utf8",
);
const capabilities = inspectAntigravityHelp(help, "1.2.15");
const context = {
  responseFrame: { requestId: randomUUID(), taskSpecHash: "a".repeat(64), attemptId: randomUUID() },
  requestedModel: "fixture-model",
  cwd: "/srv/repo",
};
const conversationId = randomUUID();
const response = encodeResponseFrame(
  "完全な回答。\nThe command may have failed.",
  context.responseFrame,
);
const init = () => ({
  event: "init",
  conversation_id: conversationId,
  init: {
    cwd: context.cwd,
    model: context.requestedModel,
    tools: ["read_file"],
    permission_mode: "request-review",
  },
});
const step = () => ({
  event: "step_update",
  step_update: {
    conversation_id: conversationId,
    step_index: 1,
    state: "DONE",
    step_type: "agent_response",
    text_delta: "partial text is not the final response",
  },
});
const result = (status = "SUCCESS") => ({
  event: "result",
  result: {
    conversation_id: conversationId,
    status,
    response,
    duration_seconds: 1.2,
    num_turns: 1,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 30,
    },
  },
});
const wire = (events: unknown[] = [init(), step(), result()]) =>
  Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
const text = Buffer.from("Inspect only. Do not start another model.\n");
const install: CliInstallation = {
  agent: "antigravity",
  executable: "/opt/bridge/agy",
  executableSha256: "b".repeat(64),
  version: "1.2.15",
  models: ["fixture-model"],
  repoId: "fixture-repo",
  repoRoot: "/srv/repo",
  homeRoot: "/srv/homes",
  authentication: "subscription",
  antigravity: capabilities,
};
function task(): TaskSpec {
  const t = JSON.parse(
    readFileSync(
      new URL("../../docs/bridge-v2/protocol/task_example.json", import.meta.url),
      "utf8",
    ),
  ) as TaskSpec;
  return {
    ...t,
    mode: "read_only",
    base_commit: "b".repeat(40),
    policy_snapshot_sha256: "c".repeat(64),
    allowed_paths: [{ path: "src", scope: "subtree", permissions: ["read"] }],
    agent: "antigravity",
    requested_model: "fixture-model",
    repo: "fixture-repo",
    task_file_hash: sha256Bytes(text),
  };
}
function plan(t = task(), registered = install) {
  const identity = {
    requestId: t.request_id,
    runId: randomUUID(),
    taskSpecHash: sha256Bytes(Buffer.from(JSON.stringify(t))),
    fencingToken: 1,
  };
  return createCliLaunchPlan(
    t,
    text,
    identity,
    {
      runId: identity.runId,
      fencingToken: 1,
      startSequence: 1,
      approvalId: randomUUID(),
      deadlineAt: "2026-10-03T00:00:10.000Z",
      sessionId: "fixture-session",
      executorId: "fixture-broker",
      resourceKeys: ["repo:fixture-repo"],
      cancelAt: null,
      cancelReason: null,
    },
    registered,
    new Date("2026-10-03T00:00:00.000Z"),
  );
}
describe("Antigravity verified CLI plan", () => {
  it("observes flags and five efforts from installed help without inferring TaskSpec effort", () => {
    expect(capabilities.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(ANTIGRAVITY_ADAPTER_CAPABILITIES.effort.supported).toBe(false);
    expect(ANTIGRAVITY_ADAPTER_CAPABILITIES.productionExecution).toBe(false);
  });
  it.each(ANTIGRAVITY_REQUIRED_FLAGS)("fails closed without %s", (flag) => {
    expect(() =>
      inspectAntigravityHelp(
        help
          .split("\n")
          .filter((line) => !line.trimStart().startsWith(`${flag} `))
          .join("\n"),
        "1.2.15",
      ),
    ).toThrow("capability_unavailable");
  });
  it("does not assume other installed versions or unobserved capabilities work", () => {
    expect(() => inspectAntigravityHelp(help, "1.2.16")).toThrow("version_unsupported");
    const missing = { ...install };
    delete missing.antigravity;
    expect(() => validateInstallation(missing)).toThrow("capability_unavailable");
    expect(() => validateInstallation({ ...install, agent: "codex" })).toThrow(
      "installation_invalid",
    );
  });
  it("uses one fresh stdin event, explicit flags, and the existing frame identities", () => {
    const p = plan();
    expect(p.argv).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      "fixture-model",
      "--print-timeout",
      "10s",
      "--disable-slash-commands",
      "--sandbox",
    ]);
    const input = Buffer.from(p.stdinBase64, "base64").toString();
    expect(input.trim().split("\n")).toHaveLength(1);
    const event = JSON.parse(input);
    expect(event.event).toBe("user");
    expect(event.message.content).toContain(text.toString());
    expect(event.message.content).toContain(p.identity.runId);
    expect(event.message.content).toContain(p.bootstrap.reminderJson);
    expect(p.bootstrap.reminder.session).toEqual({
      sessionId: p.identity.runId,
      provider: "antigravity",
      role: "response_producer",
      repoId: "fixture-repo",
      contextEpoch: 1,
    });
    expect(
      parseSessionBootstrap(Buffer.from(p.bootstrap.reminderJson), p.bootstrap.reminderSha256),
    ).toEqual(p.bootstrap.reminder);
    expect(event.message.content.indexOf(p.bootstrap.reminderJson)).toBeLessThan(
      event.message.content.indexOf("Bridge transport framing metadata"),
    );
    expect(p.task.task_file_hash).toBe(sha256Bytes(text));
    expect(plan().bootstrap.reminder.session.sessionId).not.toBe(
      p.bootstrap.reminder.session.sessionId,
    );
    expect(p.argv.join(" ")).not.toMatch(/continue|conversation|skip-permissions|effort|--print /);
    expect(p.io).toEqual({
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      tty: false,
      shell: false,
    });
    expect(p.environment).not.toHaveProperty("GEMINI_API_KEY");
    expect(p.authentication).toBe("subscription");
  });
  it("rejects unregistered models and schema effort rather than guessing defaults", () => {
    expect(() => plan({ ...task(), requested_model: "unknown" })).toThrow(
      "cli_agent_model_repo_denied",
    );
    expect(() => plan({ ...task(), effort: "high" } as TaskSpec)).toThrow("cli_task_invalid");
  });
});
describe("Antigravity strict one-turn output", () => {
  it("handles arbitrary byte fragmentation including UTF-8, and extracts only final response", () => {
    const p = new AntigravityOutputParser(context);
    for (const byte of wire()) p.push(Uint8Array.of(byte));
    const parsed = p.finish(0);
    expect(parsed.frame?.markdown).toContain("完全な回答");
    expect(parsed.response).not.toContain("partial text");
    expect(parsed.conversationId).toBe(conversationId);
    expect(parsed.streamSha256).toBe(sha256Bytes(wire()));
    expect(parsed.authoritativeExecutionEvidence).toBe(false);
    expect(parsed).not.toHaveProperty("receipt");
    expect(() => p.finish(0)).toThrow("parser_closed");
    expect(() => p.push(Buffer.from("x"))).toThrow("parser_closed");
  });
  it.each(["ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING"])(
    "keeps %s as provider data without termination proof",
    (status) => {
      const parsed = parseAntigravityOutput(wire([init(), result(status)]), context, 1);
      expect(parsed.providerStatus).toBe(status);
      expect(parsed.authoritativeExecutionEvidence).toBe(false);
      expect(parsed.frame).toBeNull();
    },
  );
  it("records a pre-init provider error without fabricating a session", () => {
    const event = result("ERROR");
    event.result.conversation_id = "";
    event.result.num_turns = 0;
    expect(parseAntigravityOutput(wire([event]), context, 1).reportedModel).toBeNull();
  });
  it.each([1, null])("rejects SUCCESS without a clean process exit (%s)", (exit) => {
    expect(() => parseAntigravityOutput(wire(), context, exit)).toThrow("success_unconfirmed");
  });
  it.each([
    [],
    [init()],
    [step(), result()],
    [init(), init(), result()],
    [init(), result(), result()],
    [init(), result(), step()],
    [{ event: "future_event" }],
    [result()],
  ])("rejects missing, reordered, repeated or unsupported events", (...events) => {
    expect(() => parseAntigravityOutput(wire(events), context, 0)).toThrow();
  });
  it.each([
    { label: "array DONE", state: ["DONE"] },
    { label: "array ACTIVE", state: ["ACTIVE"] },
    { label: "nested array", state: [["DONE"]] },
    { label: "object", state: {} },
    { label: "null", state: null },
    { label: "boolean", state: true },
    { label: "number", state: 0 },
    { label: "missing", state: undefined },
    { label: "unknown string", state: "DONE2" },
  ])("rejects progress state $label without coercion", ({ state }) => {
    const event = step();
    (event.step_update as Record<string, unknown>).state = state;
    expect(() => parseAntigravityOutput(wire([init(), event, result()]), context, 0)).toThrow(
      "antigravity_step_invalid",
    );
  });
  it.each(["ACTIVE", "DONE"])("accepts string progress state %s", (state) => {
    const event = step();
    event.step_update.state = state;
    expect(parseAntigravityOutput(wire([init(), event, result()]), context, 0).providerStatus).toBe(
      "SUCCESS",
    );
  });
  it.each(["cwd", "model", "permission_mode"])("rejects mismatched init %s", (field) => {
    const event = init();
    (event.init as Record<string, unknown>)[field] = "wrong";
    expect(() => parseAntigravityOutput(wire([event, result()]), context, 0)).toThrow(
      "init_mismatch",
    );
  });
  it("rejects custom agent, conversation changes, multiple turns, invalid usage and wrong frame", () => {
    const custom = init();
    Object.assign(custom.init, { agent: "unregistered-agent" });
    expect(() => parseAntigravityOutput(wire([custom, result()]), context, 0)).toThrow(
      "init_mismatch",
    );
    const changed = result();
    changed.result.conversation_id = randomUUID();
    expect(() => parseAntigravityOutput(wire([init(), changed]), context, 0)).toThrow(
      "conversation_mismatch",
    );
    const turns = result();
    turns.result.num_turns = 2;
    expect(() => parseAntigravityOutput(wire([init(), turns]), context, 0)).toThrow(
      "result_invalid",
    );
    const usage = result();
    usage.result.usage.total_tokens = -1;
    expect(() => parseAntigravityOutput(wire([init(), usage]), context, 0)).toThrow(
      "usage_invalid",
    );
    const wrong = result();
    wrong.result.response = "done";
    expect(() => parseAntigravityOutput(wire([init(), wrong]), context, 0)).toThrow(
      "frame_mismatch",
    );
  });
  it("allows fractional provider durations without loosening Bridge strict JSON", () => {
    expect(parseStrictProviderJsonBytes(Buffer.from('{"duration_seconds":1.25}'))).toEqual({
      duration_seconds: 1.25,
    });
    expect(() => parseStrictJsonBytes(Buffer.from('{"duration_seconds":1.25}'))).toThrow(
      "safe integer",
    );
    for (const raw of [
      '{"x":1e999}',
      '{"x":9007199254740992}',
      '{"x":"\\ud800"}',
      '{"x":1,"\\u0078":2}',
    ])
      expect(() => parseStrictProviderJsonBytes(Buffer.from(raw))).toThrow();
  });
  it("rejects duplicate JSON keys, malformed bytes and truncated stdout", () => {
    expect(() =>
      parseAntigravityOutput(Buffer.from('{"event":"init","event":"result"}\n'), context, 0),
    ).toThrow();
    expect(() => parseAntigravityOutput(Buffer.from([0xff, 10]), context, 0)).toThrow();
    expect(() =>
      parseAntigravityOutput(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), wire()]), context, 0),
    ).toThrow();
    expect(() => parseAntigravityOutput(wire().subarray(0, -1), context, 0)).toThrow(
      "stream_truncated",
    );
  });
  it("fails closed on excessive output and cannot recover by appending bytes", () => {
    const p = new AntigravityOutputParser(context);
    expect(() => p.push(Buffer.alloc(8 * 1024 * 1024 + 1))).toThrow("output_limit");
    expect(() => p.finish(0)).toThrow("parser_closed");
  });
});
describe("Antigravity issuer and recipient onboarding", () => {
  it.each(["issuer", "response_producer"] as const)(
    "uses the same versioned bootstrap for %s",
    (role) => {
      const session = {
        sessionId: randomUUID(),
        provider: "antigravity" as const,
        role,
        repoId: "fixture-repo",
        contextEpoch: 1,
      };
      const reminder = createSessionBootstrap(session);
      expect(reminder.reminder.docs).toContain("docs/bridge-v2/ANTIGRAVITY.md");
      expect(Buffer.byteLength(reminder.reminderJson)).toBeLessThan(8192);
      const store = new SessionBootstrapStore();
      try {
        const input = {
          session,
          bridgeLaunched: true as const,
          startup: "antigravity-stream-stdin" as const,
          mode: "new" as const,
          context: "retained" as const,
        };
        const prepared = store.prepare(input);
        expect(prepared.kind).toBe("confirm");
        if (prepared.kind !== "confirm") throw new Error("fixture");
        const receipt = store.acknowledge(session, Buffer.from(JSON.stringify(prepared.plan.ack)));
        expect(receipt.evidence).toBe("bootstrap-ack-only");
        expect(store.prepare({ ...input, mode: "resume", receiptId: receipt.receiptId }).kind).toBe(
          "reuse",
        );
      } finally {
        store.close();
      }
    },
  );
  it("reconfirms AGY bootstrap version changes and lost context without enabling task resume", () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-bootstrap-"));
    const dbPath = join(dir, "bootstrap.db");
    const session = {
      sessionId: randomUUID(),
      provider: "antigravity" as const,
      role: "issuer" as const,
      repoId: "fixture-repo",
      contextEpoch: 1,
    };
    const input = {
      session,
      bridgeLaunched: true as const,
      startup: "antigravity-stream-stdin" as const,
      mode: "new" as const,
      context: "retained" as const,
    };
    let store = new SessionBootstrapStore({ dbPath, version: "fixture-v1" });
    try {
      const first = store.prepare(input);
      if (first.kind !== "confirm") throw new Error("fixture");
      const receipt = store.acknowledge(session, Buffer.from(JSON.stringify(first.plan.ack)));
      store.close();
      store = new SessionBootstrapStore({ dbPath, version: "fixture-v2" });
      const updated = store.prepare({ ...input, mode: "resume", receiptId: receipt.receiptId });
      expect(updated.kind).toBe("confirm");
      if (updated.kind !== "confirm") throw new Error("fixture");
      expect(updated.reason).toBe("version_changed");
      expect(updated.plan.bootstrapSha256).not.toBe(first.plan.bootstrapSha256);
      expect(() => store.acknowledge(session, Buffer.from(JSON.stringify(first.plan.ack)))).toThrow(
        "ack_mismatch",
      );
      store.acknowledge(session, Buffer.from(JSON.stringify(updated.plan.ack)));
      const lost = store.prepare({
        ...input,
        session: { ...session, contextEpoch: 2 },
        mode: "resume",
        context: "lost",
      });
      expect(lost.kind).toBe("confirm");
      if (lost.kind !== "confirm") throw new Error("fixture");
      expect(lost.reason).toBe("context_lost");
      expect(ANTIGRAVITY_ADAPTER_CAPABILITIES.resume).toBe(false);
      expect(plan().argv).not.toContain("--conversation");
      expect(plan().argv).not.toContain("--continue");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("renders a human-readable provider label without treating it as authorization", () => {
    expect(agentLabel("antigravity")).toBe("Antigravity");
    expect(agentLabel("unregistered-agent")).toBe("unregistered-agent");
    expect(agentLabel("constructor")).toBe("constructor");
    expect(agentLabel("__proto__")).toBe("__proto__");
  });
});
