import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostedResponse } from "../../src/adapters/browser-delivery.js";
import { ExactHostedSourceResolver } from "../../src/archive/hosted-source.js";
import { ArchiveDeliveryPersistence } from "../../src/archive/materialization-store.js";
import {
  buildHostedSourceProofV2,
  createOutputContractPrompt,
} from "../../src/archive/output-evidence.js";
import { HostedDeliveryPayloadVerifier } from "../../src/archive/payload-verifiers.js";
import { RouteArtifactArchive } from "../../src/archive/route-store.js";
import { buildRecoveredResult } from "../../src/cli/collect.js";
import {
  serializeDeliveryManifestV1,
  serializeMaterializationReceiptV1,
} from "../../src/contracts/materialization.js";
import {
  type OutputContractBindingV1,
  outputContractDigest,
  parseOutputContractV1,
} from "../../src/contracts/output-contract.js";
import { encodeResponseFrame, parseResponseFrame } from "../../src/contracts/response-frame.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";
import { adapterTask, adapterTaskBytes } from "../helpers/adapter-fixture.js";
import {
  fixtureHostedOutputPolicy,
  fixtureOutputContract,
  fixtureProjectRegistry,
} from "../helpers/output-contract-fixture.js";

async function fixture(registryHash?: string) {
  const task = Object.assign(adapterTask(), {
      agent: "chatgpt-browser",
      requested_model: "current",
    }),
    raw = Buffer.from(JSON.stringify(task)),
    contractRaw = registryHash
      ? Buffer.from(
          JSON.stringify({
            ...JSON.parse(Buffer.from(fixtureOutputContract(raw)).toString("utf8")),
            registrySnapshotSha256: registryHash,
          }),
        )
      : fixtureOutputContract(raw),
    contract = parseOutputContractV1(contractRaw),
    identity = {
      requestId: task.request_id,
      taskSpecHash: sha256Bytes(raw),
      attemptId: randomUUID(),
    },
    prompt = Buffer.from(
      createOutputContractPrompt(adapterTaskBytes, identity, contractRaw),
    ).toString("utf8");
  const declaration = {
    schema: "artifact-declaration-1",
    ...identity,
    outputContractSha256: outputContractDigest(contractRaw),
    outputs: [],
  };
  const framed = encodeResponseFrame(
      `BRIDGE ARTIFACT DECLARATION ${JSON.stringify(declaration)}\nActual answer`,
      identity,
    ),
    parsed = parseResponseFrame(framed, identity);
  const resolver = new ExactHostedSourceResolver({
    read: async () => ({
      state: "available",
      conversationId: "fixture",
      turns: [
        { messageId: "user-old", role: "user", text: prompt, markdown: prompt, artifacts: [] },
        {
          messageId: "assistant-old",
          role: "assistant",
          text: framed,
          markdown: framed,
          artifacts: [],
          artifactEnumerationKnown: false,
          artifactObservationChecked: true,
          artifactReaderVersion: "trusted-snapshot-1",
        },
      ],
    }),
  });
  const source = await resolver.pin({
    conversationId: "fixture",
    promptText: prompt,
    promptSha256: sha256Bytes(Buffer.from(prompt)),
    frame: { identity, rawSha256: parsed.rawSha256, bodySha256: parsed.bodySha256 },
  });
  if (source.state !== "available") throw new Error(source.reason);
  const result = buildRecoveredResult(
    {
      requestId: task.request_id,
      conversationUrl: "https://chatgpt.com/c/fixture",
      submittedAt: "2026-10-03T00:00:00.000Z",
    },
    { markdown: parsed.markdown, method: "dom", quality: "full", modelSlug: null },
    "response.md",
    "test",
    new Date("2026-10-03T00:00:01.000Z"),
  );
  const response: HostedResponse = {
    version: "hosted-response-1",
    requestId: task.request_id,
    taskSpecHash: identity.taskSpecHash,
    attemptId: identity.attemptId,
    evidence: "ordinary-chat-browser-dom",
    localExecution: false,
    result,
    markdown: parsed.markdown,
    framing: { identity, rawSha256: parsed.rawSha256, bodySha256: parsed.bodySha256 },
  };
  const proof = buildHostedSourceProofV2(response, source, contractRaw),
    payload = Buffer.from(`${JSON.stringify(response)}\n`),
    event = {
      version: "hosted-response-1" as const,
      requestId: task.request_id,
      taskSpecHash: identity.taskSpecHash,
      eventId: randomUUID(),
      actorId: "recipient",
      payloadSha256: sha256Bytes(payload),
      stage: "hosted_result" as const,
    };
  const binding = {
    requesterActorId: "requester",
    recipientActorId: "recipient",
    requestId: task.request_id,
    taskSpecHash: identity.taskSpecHash,
    execution: { kind: "hosted_delivery" as const, attemptId: identity.attemptId },
    terminalEventId: event.eventId,
    payloadSha256: event.payloadSha256,
  };
  const expected: OutputContractBindingV1 = {
    requestId: contract.requestId,
    taskSpecHash: contract.taskSpecHash,
    taskFileHash: contract.taskFileHash,
    route: contract.route,
    requesterActorId: contract.requesterActorId,
    recipientActorId: contract.recipientActorId,
    policySnapshotSha256: contract.policySnapshotSha256,
    registryRevision: contract.registryRevision,
    registrySnapshotSha256: contract.registrySnapshotSha256,
    projectId: contract.projectId,
    repoId: contract.repoId,
    storageSlug: contract.storageSlug,
    destination: contract.destination,
  };
  const context = {
    rawTaskSpec: raw,
    taskFileBytes: adapterTaskBytes,
    terminalEvent: event,
    claimedArtifacts: proof.artifacts,
    expectedConversationId: "fixture",
    synthetic: true,
    allowSynthetic: true,
    outputContractRaw: contractRaw,
    expectedOutputPolicy: fixtureHostedOutputPolicy(),
    outputContractBinding: expected,
  };
  const verifier = new HostedDeliveryPayloadVerifier(async () => context);
  const artifacts = proof.artifacts.map((descriptor) => ({
    descriptor,
    bytes:
      descriptor.artifactId === "hosted-source-proof"
        ? proof.bytes
        : descriptor.artifactId === "hosted-output-contract"
          ? contractRaw
          : Buffer.from(source.rawMarkdown),
  }));
  return { source, response, proof, contractRaw, context, verifier, artifacts, binding, payload };
}
describe("contract-scoped hosted source proof 2; synthetic exact DOM evidence", () => {
  it("accepts explicit authorized text-only zero without promoting unknown global inventory", async () => {
    const x = await fixture();
    expect(x.proof.proof.completenessScope).toBe("bound_output_contract");
    expect(x.proof.proof.contradictionCheck.globalEnumerationKnown).toBe(false);
    expect(x.proof.artifacts).toHaveLength(3);
    await expect(
      x.verifier.validateReceiptEvidence(x.payload, x.artifacts, x.binding),
    ).resolves.toBeUndefined();
  });
  it("fails on an observed undeclared attachment even though responder declares zero", async () => {
    const x = await fixture();
    const source = structuredClone(x.source);
    source.artifactInventory.artifacts.push({
      artifactId: null,
      contentSha256: null,
      sizeBytes: null,
      state: "unavailable",
      reason: "unsupported_artifact_ids",
    });
    expect(() => buildHostedSourceProofV2(x.response, source, x.contractRaw)).toThrow(
      "observed_attachment_mismatch",
    );
  });
  it("an unchecked/unsupported selected-message surface cannot become verified empty", async () => {
    const x = await fixture();
    expect(() =>
      buildHostedSourceProofV2(
        x.response,
        {
          ...x.source,
          artifactInventory: { ...x.source.artifactInventory, contradictionCheck: "unavailable" },
        },
        x.contractRaw,
      ),
    ).toThrow("output_observation_unsupported");
  });
  it("retains mandatory proof bytes despite zero generated-attachment budget", async () => {
    const x = await fixture();
    expect(x.proof.artifacts.every((a) => a.required)).toBe(true);
    expect(x.proof.artifacts.map((a) => a.artifactId)).toEqual([
      "hosted-output-contract",
      "hosted-response-body",
      "hosted-source-proof",
    ]);
    expect(x.proof.artifacts.reduce((n, a) => n + a.sizeBytes, 0)).toBeGreaterThan(0);
  });
  it("requires matching exact raw contract bytes and cannot retrofit a new policy", async () => {
    const x = await fixture();
    const changed = Buffer.from(`${Buffer.from(x.contractRaw)} `);
    expect(() => buildHostedSourceProofV2(x.response, x.source, changed)).toThrow();
    x.context.expectedOutputPolicy = {
      ...x.context.expectedOutputPolicy,
      destination: { ...x.context.expectedOutputPolicy.destination, conversationId: "other" },
    };
    await expect(x.verifier.validatePayload(x.payload, x.binding)).rejects.toThrow(
      "output_policy_out_of_scope",
    );
  });
  it("rejects source-proof alteration, missing contract artifact and wrong prompt ownership", async () => {
    const x = await fixture();
    await expect(
      x.verifier.validateReceiptEvidence(
        x.payload,
        x.artifacts.filter((a) => a.descriptor.artifactId !== "hosted-output-contract"),
        x.binding,
      ),
    ).rejects.toThrow();
    const modified = structuredClone(x.artifacts);
    const proof = modified.find((a) => a.descriptor.artifactId === "hosted-source-proof");
    if (!proof) throw new Error("fixture missing");
    proof.bytes = Buffer.from("changed");
    await expect(
      x.verifier.validateReceiptEvidence(x.payload, modified, x.binding),
    ).rejects.toThrow();
  });
});

describe("independent hosted exact body review", () => {
  it("rejects response markdown that differs from saved raw source frame", async () => {
    const x = await fixture();
    x.response.markdown = "Substituted answer unrelated to the exact source";
    const payload = Buffer.from(`${JSON.stringify(x.response)}\n`);
    x.binding.payloadSha256 = sha256Bytes(payload);
    x.context.terminalEvent.payloadSha256 = x.binding.payloadSha256;
    await expect(
      x.verifier.validateReceiptEvidence(payload, x.artifacts, x.binding),
    ).rejects.toThrow();
  });
});

describe("independent hosted inventory review", () => {
  it("rejects a text-only zero proof when captured result declares an extra image", async () => {
    const x = await fixture();
    x.response.result.images = ["images/1.png"];
    const payload = Buffer.from(`${JSON.stringify(x.response)}\n`);
    x.binding.payloadSha256 = sha256Bytes(payload);
    x.context.terminalEvent.payloadSha256 = x.binding.payloadSha256;
    await expect(
      x.verifier.validateReceiptEvidence(payload, x.artifacts, x.binding),
    ).rejects.toThrow();
  });
});

describe("independent pinned output contract persistence review", () => {
  it("rejects materialization whose valid contract differs from admitted exact contract", async () => {
    const state = mkdtempSync(join(tmpdir(), "archive-contract-state-")),
      root = mkdtempSync(join(tmpdir(), "archive-contract-root-"));
    const registry = new ProjectRegistry(join(state, "registry.db"));
    registry.configure({ ...fixtureProjectRegistry.snapshot(1), defaultOutputRoot: root }, 0);
    const archive = new RouteArtifactArchive({ stateDirectory: state, registry });
    try {
      const x = await fixture(registry.snapshotHash(1)),
        c = parseOutputContractV1(x.contractRaw);
      await x.verifier.validateReceiptEvidence(x.payload, x.artifacts, x.binding);
      archive.reserve({
        schema: "job-admission-1",
        requestId: c.requestId,
        taskSpecHash: c.taskSpecHash,
        taskFileHash: c.taskFileHash,
        outputContractSha256: "f".repeat(64),
        registryRevision: c.registryRevision,
        registrySnapshotHash: c.registrySnapshotSha256,
        projectId: c.projectId,
        repoId: c.repoId,
        storageSlug: c.storageSlug,
        requesterActorId: c.requesterActorId,
        recipientActorId: c.recipientActorId,
        route: {
          kind: "hosted_delivery",
          policyHash: c.policySnapshotSha256,
          conversationId: c.destination.conversationId,
          destinationId: "ordinary-chat-browser",
        },
      });
      const deliveryManifestBytes = Buffer.from(
        serializeDeliveryManifestV1({
          ...x.binding,
          schema: "delivery-manifest-1",
          artifactSet: "complete",
          payload: {
            source: { destinationId: "fixture", contentSha256: x.binding.payloadSha256 },
            sizeBytes: x.payload.length,
          },
          artifacts: x.artifacts.map((a) => ({
            ...a.descriptor,
            availability: "available",
            source: { destinationId: "fixture", contentSha256: a.descriptor.contentSha256 },
          })),
        }),
      );
      const deliveryManifestSha256 = sha256Bytes(deliveryManifestBytes);
      const receipt = {
        ...x.binding,
        schema: "materialization-receipt-1" as const,
        deliveryManifestSha256,
        requiredArtifactsVerified: true as const,
        payloadVerification: "hosted_response_source" as const,
        synthetic: true,
        verifiedArtifacts: x.artifacts.map((a) => a.descriptor),
      };
      const receiptBytes = Buffer.from(serializeMaterializationReceiptV1(receipt));
      await expect(
        new ArchiveDeliveryPersistence(archive).persistVerified({
          binding: x.binding,
          signedDeliveryManifestBytes: Buffer.from("synthetic upstream authenticated envelope"),
          deliveryManifestBytes,
          deliveryManifestSha256,
          payloadBytes: x.payload,
          verifiedArtifacts: x.artifacts,
          receipt,
          receiptBytes,
          receiptSha256: sha256Bytes(receiptBytes),
        }),
      ).rejects.toThrow();
    } finally {
      archive.close();
      registry.close();
      rmSync(state, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("independent hosted pre-submit delivery review", () => {
  it("allows authenticated contract-only evidence for a verified no-send failure", async () => {
    const x = await fixture();
    x.response.result.status = "manual_intervention_required";
    x.response.result.submitted = "no";
    x.response.result.responseFile = null;
    x.response.result.extractionMethod = null;
    x.response.result.extractionQuality = null;
    x.response.result.error = {
      code: "AUTH_REQUIRED",
      message: "Fixture sign-in absent",
      retryable: false,
      phase: "AUTH_CHECKED",
      cause: null,
    };
    x.response.markdown = null;
    x.response.framing = null;
    const artifacts = x.artifacts.filter(
      (a) => a.descriptor.artifactId === "hosted-output-contract",
    );
    x.context.claimedArtifacts = artifacts.map((a) => a.descriptor);
    const payload = Buffer.from(`${JSON.stringify(x.response)}\n`);
    x.binding.payloadSha256 = sha256Bytes(payload);
    x.context.terminalEvent.payloadSha256 = x.binding.payloadSha256;
    await expect(x.verifier.validatePayload(payload, x.binding)).resolves.toBeDefined();
    await expect(
      x.verifier.validateReceiptEvidence(payload, artifacts, x.binding),
    ).resolves.toBeUndefined();
  });
});

describe("no-send evidence cannot certify a generated reply", () => {
  it.each(["images", "files", "body", "source", "unknown", "yes"] as const)(
    "rejects contradictory %s claims while preserving contract-only failure evidence",
    async (contradiction) => {
      const x = await fixture();
      x.response.result.status = "manual_intervention_required";
      x.response.result.submitted = "no";
      x.response.result.responseFile = null;
      x.response.result.extractionMethod = null;
      x.response.result.extractionQuality = null;
      x.response.result.error = {
        code: "AUTH_REQUIRED",
        message: "Fixture",
        retryable: false,
        phase: "AUTH_CHECKED",
        cause: null,
      };
      x.response.markdown = null;
      x.response.framing = null;
      const artifacts = x.artifacts.filter(
        (a) => a.descriptor.artifactId === "hosted-output-contract",
      );
      if (contradiction === "images") x.response.result.images = ["images/unmapped.png"];
      else if (contradiction === "files")
        x.response.result.files = [{ name: "unmapped", path: "files/unmapped", bytes: 1 }];
      else if (contradiction === "body" || contradiction === "source") {
        const extra = x.artifacts.find(
          (a) =>
            a.descriptor.artifactId ===
            (contradiction === "body" ? "hosted-response-body" : "hosted-source-proof"),
        );
        if (!extra) throw new Error("fixture missing");
        artifacts.push(extra);
      } else x.response.result.submitted = contradiction;
      x.context.claimedArtifacts = artifacts.map((a) => a.descriptor);
      const payload = Buffer.from(`${JSON.stringify(x.response)}\n`);
      x.binding.payloadSha256 = sha256Bytes(payload);
      x.context.terminalEvent.payloadSha256 = x.binding.payloadSha256;
      await expect(
        x.verifier.validateReceiptEvidence(payload, artifacts, x.binding),
      ).rejects.toThrow();
    },
  );
});
