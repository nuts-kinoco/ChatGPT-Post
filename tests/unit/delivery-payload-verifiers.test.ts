import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostedResponse } from "../../src/adapters/browser-delivery.js";
import type { HostedEvent } from "../../src/adapters/github-transport.js";
import { ExactHostedSourceResolver } from "../../src/archive/hosted-source.js";
import type { VerifiedDeliveryArtifactV1 } from "../../src/archive/materializer.js";
import {
  buildHostedSourceProof,
  HostedDeliveryPayloadVerifier,
  LocalDeliveryPayloadVerifier,
} from "../../src/archive/payload-verifiers.js";
import { buildRecoveredResult } from "../../src/cli/collect.js";
import type { DeliveryBindingV1 } from "../../src/contracts/materialization.js";
import {
  createFramedPrompt,
  encodeResponseFrame,
  parseResponseFrame,
} from "../../src/contracts/response-frame.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { demoTask } from "../../src/ui/demo.js";
import { openUiService } from "../../src/ui/service.js";
import { adapterTask, adapterTaskBytes } from "../helpers/adapter-fixture.js";

const dirs: string[] = [],
  closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function local() {
  const dir = mkdtempSync(join(tmpdir(), "delivery-local-"));
  dirs.push(dir);
  const service = await openUiService({ stateDir: dir, profile: "production" });
  closers.push(() => service.close());
  const input = demoTask({});
  const task = service.import(input);
  const id = task.task.result.request_id;
  await service.runtime.controller.cancel(id);
  const payload = service.runtime.store.deliveryPayload(id),
    event = service.runtime.store.handshake(id, "terminal_result");
  if (!event) throw new Error("fixture terminal missing");
  const binding: DeliveryBindingV1 = {
    requesterActorId: "local-ui-requester",
    recipientActorId: event.actorId,
    requestId: id,
    taskSpecHash: event.taskSpecHash,
    execution: { kind: "local_execution", runId: null },
    terminalEventId: event.eventId,
    payloadSha256: event.payloadSha256,
  };
  const verifier = new LocalDeliveryPayloadVerifier(async () => ({
    rawTaskSpec: Buffer.from(input.rawSpec),
    taskFileBytes: Buffer.from(input.taskMarkdown),
    terminalEvent: event,
  }));
  const checked = await verifier.validatePayload(payload, binding);
  const artifacts: VerifiedDeliveryArtifactV1[] = checked.artifacts.map((descriptor) => {
    const ref = service.runtime.store.get(id)?.result.receipt?.evidence_ref;
    if (!ref) throw new Error("fixture evidence missing");
    const bytes = service.runtime.store.readLocalEvidence(ref);
    if (!bytes) throw new Error("fixture bytes missing");
    return { descriptor, bytes };
  });
  return { verifier, payload, binding, artifacts, event };
}
async function hosted() {
  const task = Object.assign(adapterTask(), {
      agent: "chatgpt-browser",
      requested_model: "current",
    }),
    raw = Buffer.from(JSON.stringify(task)),
    taskSpecHash = sha256Bytes(raw),
    attemptId = randomUUID(),
    identity = { requestId: task.request_id, taskSpecHash, attemptId };
  const prompt = Buffer.from(createFramedPrompt(adapterTaskBytes, identity)).toString("utf8"),
    framed = encodeResponseFrame("synthetic exact answer", identity),
    frame = parseResponseFrame(framed, identity);
  const resolver = new ExactHostedSourceResolver({
    read: async () => ({
      state: "available",
      conversationId: "fixture",
      turns: [
        { messageId: "user", role: "user", text: prompt, markdown: prompt, artifacts: [] },
        {
          messageId: "assistant",
          role: "assistant",
          text: framed,
          markdown: framed,
          artifacts: [],
          artifactEnumerationKnown: true,
        },
      ],
    }),
  });
  const source = await resolver.pin({
    conversationId: "fixture",
    promptText: prompt,
    promptSha256: sha256Bytes(Buffer.from(prompt)),
    frame: { identity, rawSha256: frame.rawSha256, bodySha256: frame.bodySha256 },
  });
  if (source.state !== "available") throw new Error(source.reason);
  const result = buildRecoveredResult(
    {
      requestId: task.request_id,
      conversationUrl: "https://chatgpt.com/c/fixture",
      submittedAt: "2026-10-03T00:00:00.000Z",
    },
    { markdown: frame.markdown, method: "dom", quality: "full", modelSlug: null },
    "response.md",
    "test",
    new Date("2026-10-03T00:00:01.000Z"),
  );
  const response: HostedResponse = {
    version: "hosted-response-1",
    requestId: task.request_id,
    taskSpecHash,
    attemptId,
    evidence: "ordinary-chat-browser-dom",
    localExecution: false,
    result,
    markdown: frame.markdown,
    framing: { identity, rawSha256: frame.rawSha256, bodySha256: frame.bodySha256 },
  };
  const payload = Buffer.from(`${JSON.stringify(response)}\n`),
    binding: DeliveryBindingV1 = {
      requesterActorId: "requester",
      recipientActorId: "recipient",
      requestId: task.request_id,
      taskSpecHash,
      execution: { kind: "hosted_delivery", attemptId },
      terminalEventId: randomUUID(),
      payloadSha256: sha256Bytes(payload),
    };
  const event: HostedEvent = {
    version: "hosted-response-1",
    requestId: task.request_id,
    taskSpecHash,
    eventId: binding.terminalEventId,
    actorId: "recipient",
    payloadSha256: binding.payloadSha256,
    stage: "hosted_result",
  };
  const proof = buildHostedSourceProof(response, source);
  const context = {
    rawTaskSpec: raw,
    taskFileBytes: adapterTaskBytes,
    terminalEvent: event,
    claimedArtifacts: proof.artifacts,
    expectedConversationId: "fixture",
    synthetic: true,
    allowSynthetic: true,
  };
  const verifier = new HostedDeliveryPayloadVerifier(async () => context);
  const artifacts: VerifiedDeliveryArtifactV1[] = proof.artifacts.map((descriptor) => ({
    descriptor,
    bytes:
      descriptor.artifactId === "hosted-source-proof"
        ? proof.bytes
        : Buffer.from(source.rawMarkdown),
  }));
  return { source, response, payload, binding, proof, context, verifier, artifacts };
}
describe("concrete requester payload/evidence gates (synthetic hosted browser proof)", () => {
  it("validates authoritative never-started local receipt bytes, not executor-provided paths", async () => {
    const x = await local();
    expect((await x.verifier.validatePayload(x.payload, x.binding)).payloadVerification).toBe(
      "local_result_and_receipt",
    );
    await expect(
      x.verifier.validateReceiptEvidence(x.payload, x.artifacts, x.binding),
    ).resolves.toBeUndefined();
  });
  it("local missing evidence, wrong run/event/requester-signer binding reject", async () => {
    const x = await local();
    await expect(x.verifier.validateReceiptEvidence(x.payload, [], x.binding)).rejects.toThrow();
    for (const binding of [
      { ...x.binding, terminalEventId: randomUUID() },
      { ...x.binding, recipientActorId: "other" },
      { ...x.binding, execution: { kind: "local_execution" as const, runId: randomUUID() } },
    ])
      await expect(x.verifier.validatePayload(x.payload, binding)).rejects.toThrow();
  });
  it("verifies hosted source proof, exact frame, prompt ownership and explicit known artifact set", async () => {
    const x = await hosted();
    expect((await x.verifier.validatePayload(x.payload, x.binding)).synthetic).toBe(true);
    await expect(
      x.verifier.validateReceiptEvidence(x.payload, x.artifacts, x.binding),
    ).resolves.toBeUndefined();
  });
  it("does not accept source-free empty hosted references or unknown enumeration", async () => {
    const x = await hosted();
    x.context.claimedArtifacts = [];
    await expect(x.verifier.validatePayload(x.payload, x.binding)).rejects.toThrow(
      "delivery_hosted_source_incomplete",
    );
    expect(() =>
      buildHostedSourceProof(x.response, {
        ...x.source,
        artifactInventory: {
          enumerationKnown: false,
          contradictionCheck: "unavailable",
          readerVersion: null,
          artifacts: [],
        },
      }),
    ).toThrow("delivery_hosted_source_incomplete");
  });
  it("rejects mismatched exact conversation, source bytes and wrong attempt", async () => {
    const x = await hosted();
    x.context.expectedConversationId = "wrong";
    await expect(
      x.verifier.validateReceiptEvidence(x.payload, x.artifacts, x.binding),
    ).rejects.toThrow("delivery_hosted_source_mismatch");
    x.context.expectedConversationId = "fixture";
    await expect(
      x.verifier.validateReceiptEvidence(
        x.payload,
        x.artifacts.map((a) => ({ ...a, bytes: Buffer.from("other") })),
        x.binding,
      ),
    ).rejects.toThrow();
    await expect(
      x.verifier.validatePayload(x.payload, {
        ...x.binding,
        execution: { kind: "hosted_delivery", attemptId: randomUUID() },
      }),
    ).rejects.toThrow();
  });
  it("synthetic hosted proof is explicitly denied without synthetic authorization", async () => {
    const x = await hosted();
    x.context.allowSynthetic = false;
    await expect(x.verifier.validatePayload(x.payload, x.binding)).rejects.toThrow(
      "delivery_synthetic_not_authorized",
    );
  });
});

describe("independent allocated never-started result review", () => {
  it("allows an admitted run identity on verified never-started receipt", async () => {
    const x = await local();
    const result = JSON.parse(Buffer.from(x.payload).toString("utf8"));
    const run = randomUUID();
    result.run_id = run;
    result.fencing_token = 1;
    result.receipt.run_id = run;
    result.receipt.fencing_token = 1;
    const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
    x.binding.execution = { kind: "local_execution", runId: run };
    x.binding.payloadSha256 = sha256Bytes(bytes);
    x.event.runId = run;
    x.event.fencingToken = 1;
    x.event.payloadSha256 = x.binding.payloadSha256;
    await expect(x.verifier.validatePayload(bytes, x.binding)).resolves.toBeDefined();
    await expect(
      x.verifier.validateReceiptEvidence(bytes, x.artifacts, x.binding),
    ).resolves.toBeUndefined();
  });
});

describe("allocated supervisor no-launch evidence", () => {
  it("preserves authenticated supervisor evidence without imposing pre-admission ledger JSON", async () => {
    const x = await local(),
      result = JSON.parse(Buffer.from(x.payload).toString("utf8")),
      run = randomUUID();
    result.run_id = run;
    result.fencing_token = 1;
    result.receipt.run_id = run;
    result.receipt.fencing_token = 1;
    const opaque = Buffer.from("supervisor-confirmed no process launched: exact retained evidence"),
      ref = result.receipt.evidence_ref;
    ref.sha256 = sha256Bytes(opaque);
    ref.size_bytes = opaque.length;
    result.verification.evidence_ref = { ...ref };
    const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
    x.binding.execution = { kind: "local_execution", runId: run };
    x.binding.payloadSha256 = sha256Bytes(bytes);
    x.event.runId = run;
    x.event.fencingToken = 1;
    x.event.payloadSha256 = x.binding.payloadSha256;
    const checked = await x.verifier.validatePayload(bytes, x.binding);
    await expect(
      x.verifier.validateReceiptEvidence(
        bytes,
        checked.artifacts.map((descriptor) => ({ descriptor, bytes: opaque })),
        x.binding,
      ),
    ).resolves.toBeUndefined();
  });
});
