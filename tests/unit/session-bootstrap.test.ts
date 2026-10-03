/** Synthetic only: no model invocation, credentials, global settings or live browser. */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionBootstrap,
  MAX_BOOTSTRAP_ACK_BYTES,
  MAX_BOOTSTRAP_BYTES,
  type PrepareSessionBootstrap,
  parseSessionBootstrap,
  type SessionBootstrapDecision,
  type SessionBootstrapIdentity,
  SessionBootstrapStore,
} from "../../src/adapters/session-bootstrap.js";
import { sha256Bytes } from "../../src/contracts/task.js";

const stores: SessionBootstrapStore[] = [];
const directories: string[] = [];
function store(options: ConstructorParameters<typeof SessionBootstrapStore>[0] = {}) {
  const result = new SessionBootstrapStore(options);
  stores.push(result);
  return result;
}
function close(s: SessionBootstrapStore) {
  s.close();
  stores.splice(stores.indexOf(s), 1);
}
function database() {
  const path = mkdtempSync(join(tmpdir(), "bridge-bootstrap-"));
  chmodSync(path, 0o700);
  directories.push(path);
  return join(path, "bootstrap.db");
}
function session(overrides: Partial<SessionBootstrapIdentity> = {}): SessionBootstrapIdentity {
  return {
    sessionId: randomUUID(),
    provider: "codex",
    role: "issuer",
    repoId: "fixture-repo",
    contextEpoch: 1,
    ...overrides,
  };
}
function launch(identity = session()): PrepareSessionBootstrap {
  return {
    session: identity,
    bridgeLaunched: true,
    startup:
      identity.provider === "claude"
        ? "claude-print-stdin"
        : identity.provider === "codex"
          ? "codex-exec-stdin"
          : "ordinary-chat-prompt",
    mode: "new",
    context: "retained",
  };
}
function confirmation(decision: SessionBootstrapDecision) {
  if (decision.kind !== "confirm") throw new Error("Expected short bootstrap confirmation");
  return decision;
}
function ack(s: SessionBootstrapStore, input: PrepareSessionBootstrap) {
  const decision = confirmation(s.prepare(input));
  return s.acknowledge(input.session, Buffer.from(JSON.stringify(decision.plan.ack)));
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("bounded model-session bootstrap", () => {
  it.each([
    ["claude", "issuer"],
    ["codex", "issuer"],
    ["chatgpt", "response_producer"],
    ["claude", "response_producer"],
  ] as const)("generates strict, short role-aware JSON for %s/%s", (provider, role) => {
    const identity = session({ provider, role });
    const plan = createSessionBootstrap(identity);
    expect(Buffer.byteLength(plan.reminderJson)).toBeLessThan(MAX_BOOTSTRAP_BYTES);
    expect(parseSessionBootstrap(Buffer.from(plan.reminderJson), plan.reminderSha256)).toEqual(
      plan.reminder,
    );
    expect(plan.reminder.session).toEqual(identity);
    expect(plan.reminder.reexecute).toBe(false);
    expect(plan.reminder.instructions.at(-1)).toMatch(
      role === "issuer" ? /^Issuer:/ : /^Response producer:/,
    );
    expect(plan.reminderJson).toContain("Unknown outcome");
    expect(plan.reminderJson).toContain("transport only");
    expect(plan.reminderJson).toContain("hosted-response-1");
    expect(plan.reminderJson).not.toContain("CLAUDE.md");
  });
  it("checks exact reminder bytes, fixed guidance and JSON shape", () => {
    const plan = createSessionBootstrap(session());
    expect(() =>
      parseSessionBootstrap(Buffer.from(`${plan.reminderJson}\n`), plan.reminderSha256),
    ).toThrow("hash_mismatch");
    for (const change of [
      { ...plan.reminder, bootstrapSha256: "f".repeat(64) },
      { ...plan.reminder, instructions: ["untrusted instructions"] },
      { ...plan.reminder, reexecute: true },
      { ...plan.reminder, version: 1 },
      { ...plan.reminder, unexpected: true },
    ]) {
      const bytes = Buffer.from(JSON.stringify(change));
      expect(() => parseSessionBootstrap(bytes, sha256Bytes(bytes))).toThrow();
    }
    const duplicate = Buffer.from(
      plan.reminderJson.replace('"reexecute":false', '"reexecute":false,"reexecute":false'),
    );
    expect(() => parseSessionBootstrap(duplicate, sha256Bytes(duplicate))).toThrow(
      "Duplicate JSON key",
    );
    const oversized = Buffer.alloc(MAX_BOOTSTRAP_BYTES + 1, " ");
    expect(() => parseSessionBootstrap(oversized, sha256Bytes(oversized))).toThrow();
  });
  it("requires bootstrap for every new model session despite the same installation", () => {
    const s = store();
    const first = launch();
    const receipt = ack(s, first);
    const second = launch(session({ repoId: first.session.repoId }));
    const next = confirmation(s.prepare(second));
    expect(next.reason).toBe("new_session");
    expect(next.plan.ack.sessionId).not.toBe(receipt.session.sessionId);
    expect(() => s.prepare(first)).toThrow("session_id_reused");
  });
  it("reuses only a matching trusted retained-session receipt and deduplicates pending planning", () => {
    const s = store();
    const input = launch();
    const pending = confirmation(s.prepare(input));
    const repeated = confirmation(s.prepare(input));
    expect(repeated.alreadyPending).toBe(true);
    expect(repeated.plan).toEqual(pending.plan);
    const bytes = Buffer.from(JSON.stringify(pending.plan.ack));
    const receipt = s.acknowledge(input.session, bytes);
    expect(s.acknowledge(input.session, bytes)).toEqual(receipt);
    expect(s.prepare({ ...input, mode: "resume", receiptId: receipt.receiptId })).toEqual({
      kind: "reuse",
      receipt,
    });
    const missing = confirmation(s.prepare({ ...input, mode: "resume", receiptId: randomUUID() }));
    expect(missing.reason).toBe("receipt_missing");
    expect(() => s.acknowledge(input.session, bytes)).toThrow("ack_mismatch");
  });
  it("persists acknowledged versions across store restart and reconfirms changed versions", () => {
    const dbPath = database();
    const input = launch();
    const first = store({ dbPath });
    const receipt = ack(first, input);
    close(first);
    const resumed = store({ dbPath });
    expect(resumed.prepare({ ...input, mode: "resume", receiptId: receipt.receiptId }).kind).toBe(
      "reuse",
    );
    close(resumed);
    const updated = store({ dbPath, version: "bridge-v2-session/2" });
    const changed = confirmation(
      updated.prepare({ ...input, mode: "resume", receiptId: receipt.receiptId }),
    );
    expect(changed.reason).toBe("version_changed");
    expect(changed.plan.bootstrapSha256).not.toBe(receipt.bootstrapSha256);
    expect(changed.plan.version).toBe("bridge-v2-session/2");
  });
  it("requires a short reconfirmation and rejects stale ACKs after compaction/context loss", () => {
    const s = store();
    const input = launch(session({ provider: "chatgpt", role: "response_producer" }));
    const old = confirmation(s.prepare(input));
    const receipt = s.acknowledge(input.session, Buffer.from(JSON.stringify(old.plan.ack)));
    expect(() =>
      s.prepare({ ...input, mode: "resume", context: "lost", receiptId: receipt.receiptId }),
    ).toThrow("context_epoch_required");
    const changed = {
      ...input,
      mode: "resume" as const,
      context: "lost" as const,
      session: { ...input.session, contextEpoch: 2 },
      receiptId: receipt.receiptId,
    };
    const reconfirm = confirmation(s.prepare(changed));
    expect(reconfirm.reason).toBe("context_lost");
    expect(reconfirm.plan.bootstrapSha256).toBe(old.plan.bootstrapSha256);
    expect(reconfirm.plan.challengeId).not.toBe(old.plan.challengeId);
    expect(() => s.acknowledge(input.session, Buffer.from(JSON.stringify(old.plan.ack)))).toThrow(
      "ack_mismatch",
    );
    expect(confirmation(s.prepare(changed)).alreadyPending).toBe(true);
    const next = s.acknowledge(changed.session, Buffer.from(JSON.stringify(reconfirm.plan.ack)));
    expect(s.prepare({ ...changed, context: "retained", receiptId: next.receiptId }).kind).toBe(
      "reuse",
    );
    expect(() => s.prepare({ ...input, mode: "resume", receiptId: next.receiptId })).toThrow(
      "session_conflict",
    );
  });
  it("does not let a pre-loss pending ACK acknowledge a new context", () => {
    const s = store();
    const input = launch();
    s.prepare(input);
    expect(() => s.prepare({ ...input, mode: "resume", context: "lost" })).toThrow(
      "context_epoch_required",
    );
    const changed = confirmation(
      s.prepare({
        ...input,
        session: { ...input.session, contextEpoch: 2 },
        mode: "resume",
        context: "lost",
      }),
    );
    expect(changed.reason).toBe("context_lost");
  });
  it("rejects malformed, replayed and mismatched ACKs without acknowledging pending state", () => {
    const s = store();
    const input = launch();
    const pending = confirmation(s.prepare(input));
    for (const invalid of [
      { ...pending.plan.ack, sessionId: randomUUID() },
      { ...pending.plan.ack, challengeId: randomUUID() },
      { ...pending.plan.ack, contextEpoch: 2 },
      { ...pending.plan.ack, version: "untrusted/2" },
      { ...pending.plan.ack, bootstrapSha256: "f".repeat(64) },
      { ...pending.plan.ack, protocol: "resultACK" },
      { ...pending.plan.ack, success: true },
      {},
      null,
    ])
      expect(() => s.acknowledge(input.session, Buffer.from(JSON.stringify(invalid)))).toThrow(
        "ack_mismatch",
      );
    const duplicate = Buffer.from(
      JSON.stringify(pending.plan.ack).replace(
        '"contextEpoch":1',
        '"contextEpoch":1,"contextEpoch":1',
      ),
    );
    expect(() => s.acknowledge(input.session, duplicate)).toThrow("Duplicate JSON key");
    expect(() => s.acknowledge(input.session, Buffer.from("not JSON"))).toThrow();
    expect(() => s.acknowledge(input.session, Buffer.alloc(MAX_BOOTSTRAP_ACK_BYTES + 1))).toThrow(
      "ack_too_large",
    );
    expect(confirmation(s.prepare(input)).plan).toEqual(pending.plan);
  });
  it("cannot claim a Bridge bootstrap for arbitrary manual CLI startup or another session scope", () => {
    const s = store();
    const input = launch();
    expect(() =>
      s.prepare({ ...input, bridgeLaunched: false } as unknown as PrepareSessionBootstrap),
    ).toThrow("launch_invalid");
    expect(() => s.prepare({ ...input, startup: "claude-print-stdin" })).toThrow("launch_invalid");
    s.prepare(input);
    expect(() =>
      s.prepare({ ...input, session: { ...input.session, repoId: "other" }, mode: "resume" }),
    ).toThrow("session_conflict");
    expect(() => createSessionBootstrap(session({ provider: "chatgpt", role: "issuer" }))).toThrow(
      "session_invalid",
    );
    expect(() => createSessionBootstrap(session({ sessionId: "machine-installed" }))).toThrow(
      "session_invalid",
    );
  });
  it("expires and evicts receipts conservatively instead of treating them as knowledge", () => {
    let now = 1000;
    const s = store({ maxSessions: 1, ttlMs: 100, now: () => new Date(now) });
    const first = launch();
    const receipt = ack(s, first);
    now++;
    ack(s, launch());
    expect(
      confirmation(s.prepare({ ...first, mode: "resume", receiptId: receipt.receiptId })).reason,
    ).toBe("receipt_missing");
    const pending = confirmation(s.prepare({ ...first, mode: "resume" }));
    now += 100;
    expect(() =>
      s.acknowledge(first.session, Buffer.from(JSON.stringify(pending.plan.ack))),
    ).toThrow("ack_mismatch");
    expect(confirmation(s.prepare({ ...first, mode: "resume" })).reason).toBe("receipt_missing");
  });
  it("fails closed for invalid bounds and unsafe durable state paths", () => {
    for (const options of [
      { maxSessions: 0 },
      { maxSessions: 10001 },
      { ttlMs: 0 },
      { ttlMs: Number.POSITIVE_INFINITY },
      { version: "x\ninjection" },
    ])
      expect(() => new SessionBootstrapStore(options)).toThrow();
    const dbPath = database();
    const s = store({ dbPath });
    close(s);
    chmodSync(dbPath, 0o644);
    expect(() => new SessionBootstrapStore({ dbPath })).toThrow("state_file_not_private");
    chmodSync(dbPath, 0o600);
    symlinkSync(dbPath, `${dbPath}.link`);
    expect(() => new SessionBootstrapStore({ dbPath: `${dbPath}.link` })).toThrow(
      "state_file_not_private",
    );
  });
});
