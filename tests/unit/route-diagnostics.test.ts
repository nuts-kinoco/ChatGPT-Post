import { describe, expect, it } from "vitest";
import { exportRouteDiagnostics } from "../../src/archive/diagnostics.js";
import { sha256Bytes } from "../../src/contracts/task.js";

const action = { userAction: "export_sanitized_diagnostics" as const };
function input() {
  return {
    hosted: {
      requestId: "private-request",
      taskSpecHash: "a".repeat(64),
      attemptId: "private-attempt",
      revision: 7,
      state: "completed",
      payloadAcknowledged: true,
      fullDeliverySufficient: false,
      source: {
        identity: {
          conversationId: "private-conversation",
          userTurnId: "private-user-turn",
          assistantTurnId: "private-assistant-turn",
        },
        frame: { rawSha256: "b".repeat(64), bodySha256: "c".repeat(64) },
        rawPrompt: "private prompt sk-Secret123456789",
      },
      inventory: { enumerationKnown: false },
      stages: [
        { stage: "result", state: "observed", sequence: 7, observedAt: "2026-10-03T00:00:00.000Z" },
      ],
      bridgeVersion: "0.1.0",
      nodeVersion: process.version,
      platform: process.platform,
    },
    manifest: {
      schema: "artifact-archive-2",
      admissionHash: "d".repeat(64),
      admission: { requestId: "private-request", taskSpecHash: "a".repeat(64) },
      pin: {
        registryRevision: 3,
        registrySnapshotHash: "e".repeat(64),
        localPinnedRoot: "S:/private/root",
      },
      requiredSetKnown: false,
      complete: false,
      synthetic: false,
      items: [
        {
          artifactId: "private-output",
          logicalName: "private name",
          filename: "private.pdf",
          relativePath: "private-path",
          contentSha256: null,
          sizeBytes: null,
          required: true,
          state: "unavailable",
          unavailableReason: "archive_path_missing",
        },
      ],
    },
    archiveState: "incomplete",
    materialization: { state: "delivery_pending" },
  };
}
describe("route diagnostic 2: self-contained allowlist, no local-execution cast", () => {
  it("distinguishes hosted completion, payload-only ACK, incomplete archive and unknown inventory", () => {
    const result = exportRouteDiagnostics(input(), action);
    const text = Buffer.from(result.bytes).toString();
    expect(result.envelope.schema).toBe("bridge-diagnostic-2");
    expect(result.envelope.content.route).toMatchObject({
      kind: "hosted_delivery",
      status: "completed",
      payload_ack_observed: true,
      full_delivery_sufficient: false,
      artifact_enumeration_known: false,
      execution_verified: false,
    });
    expect(result.envelope.content.archive).toMatchObject({
      schema: "artifact-archive-2",
      registry_revision: 3,
      complete: false,
      required_set_known: false,
    });
    expect(result.envelope.content.readme).toContain("payload-only ACK");
    expect(text).not.toContain('"succeeded"');
  });
  it("omits every private path, name, prompt and raw identity while preserving digest correlation", () => {
    const result = exportRouteDiagnostics(input(), action);
    const text = Buffer.from(result.bytes).toString();
    for (const secret of [
      "private-request",
      "private-attempt",
      "private-conversation",
      "private-user-turn",
      "private-assistant-turn",
      "private prompt",
      "sk-Secret123456789",
      "S:/private/root",
      "private.pdf",
      "private-output",
      "private-path",
    ])
      expect(text).not.toContain(secret);
    expect(result.envelope.content.archive.task_spec_sha256).toBe("a".repeat(64));
    expect(result.sha256).toBe(sha256Bytes(result.bytes));
  });
  it("is stable and marks absent proof rather than inferring success", () => {
    const value = input();
    const a = exportRouteDiagnostics(value, action),
      b = exportRouteDiagnostics(value, action);
    expect(a.bytes).toEqual(b.bytes);
    const partial = exportRouteDiagnostics(
      { hosted: { requestId: "one", state: "unknown" } },
      action,
    );
    expect(partial.envelope.content.missing_data).toContain("materialization_proof_not_provided");
    expect(partial.envelope.content.materialization.state).toBeNull();
  });
  it("requires explicit action, one discriminated route, and rejects getters without calling them", () => {
    expect(() => exportRouteDiagnostics(input(), { userAction: "no" } as never)).toThrow();
    expect(() => exportRouteDiagnostics({ local: { record: {} }, hosted: {} }, action)).toThrow();
    let ran = false;
    const bad = {
      hosted: {
        get state() {
          ran = true;
          return "completed";
        },
      },
    };
    expect(() => exportRouteDiagnostics(bad, action)).toThrow();
    expect(ran).toBe(false);
  });
});
