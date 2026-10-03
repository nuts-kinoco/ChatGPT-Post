import { describe, expect, it, vi } from "vitest";
import {
  type DeliveryArtifactDescriptorV1,
  type DeliveryBindingV1,
  type DeliveryManifestV1,
  DeliveryMaterializerV1,
  type DeliveryPersistencePortV1,
  parseDeliveryManifestV1,
  parseMaterializationReceiptV1,
  serializeDeliveryManifestV1,
  serializeMaterializationReceiptV1,
  type VerifiedDeliveryMaterializationV1,
  validateVerifiedDeliveryMaterializationV1,
} from "../../src/archive/materializer.js";
import { sha256Bytes } from "../../src/contracts/task.js";

const REQUEST = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const EVENT = "33333333-3333-3333-3333-333333333333";
const TASK_HASH = "a".repeat(64);
const digest = (text: string) => sha256Bytes(Buffer.from(text));

/** Explicit fake durable sink: unit tests exercise the persistence boundary, not platform fsync. */
class FakeDurableSink implements DeliveryPersistencePortV1 {
  readonly saved = new Map<string, VerifiedDeliveryMaterializationV1>();
  calls = 0;
  writes = 0;
  fail = false;
  async persistVerified(input: VerifiedDeliveryMaterializationV1) {
    this.calls++;
    validateVerifiedDeliveryMaterializationV1(input);
    if (this.fail) throw new Error("synthetic disk failure");
    const previous = this.saved.get(input.binding.requestId);
    if (
      previous &&
      (previous.receiptSha256 !== input.receiptSha256 ||
        sha256Bytes(previous.signedDeliveryManifestBytes) !==
          sha256Bytes(input.signedDeliveryManifestBytes))
    )
      throw new Error("immutable materialization conflict");
    if (!previous) {
      this.saved.set(input.binding.requestId, structuredClone(input));
      this.writes++;
    }
    return { state: "durable" as const, receiptSha256: input.receiptSha256 };
  }
}
function fixture(kind: DeliveryBindingV1["execution"]["kind"] = "local_execution", empty = false) {
  const payload = Buffer.from(`synthetic immutable ${kind} payload and receipt`);
  const artifact = Buffer.from("synthetic validated receipt evidence");
  const ref: DeliveryArtifactDescriptorV1 = {
    artifactId: "receipt-evidence",
    contentSha256: sha256Bytes(artifact),
    sizeBytes: artifact.length,
    required: true,
  };
  const expected: DeliveryBindingV1 = {
    requesterActorId: "requester",
    recipientActorId: "recipient",
    requestId: REQUEST,
    taskSpecHash: TASK_HASH,
    execution: kind === "local_execution" ? { kind, runId: RUN } : { kind, attemptId: RUN },
    terminalEventId: EVENT,
    payloadSha256: sha256Bytes(payload),
  };
  const manifest: DeliveryManifestV1 = {
    ...structuredClone(expected),
    schema: "delivery-manifest-1",
    artifactSet: "complete",
    payload: {
      source: { destinationId: "approved", contentSha256: expected.payloadSha256 },
      sizeBytes: payload.length,
    },
    artifacts: empty
      ? []
      : [
          {
            ...ref,
            availability: "available",
            source: { destinationId: "approved", contentSha256: ref.contentSha256 },
          },
        ],
  };
  const content = new Map<string, Uint8Array>([
    [expected.payloadSha256, payload],
    [ref.contentSha256, artifact],
  ]);
  let signedBytes = Buffer.alloc(0);
  const sign = (body: string = serializeDeliveryManifestV1(manifest)) => {
    // Deliberately fake signature port fixture; never presented as cryptographic integration proof.
    signedBytes = Buffer.from(
      JSON.stringify({ body, signature: digest(`fake-test-signature:${body}`) }),
    );
    const hash = sha256Bytes(signedBytes);
    content.set(hash, signedBytes);
    return { destinationId: "approved", contentSha256: hash };
  };
  const source = sign();
  const sink = new FakeDurableSink();
  const reader = {
    read: vi.fn(
      async (source: { contentSha256: string }) => content.get(source.contentSha256) ?? null,
    ),
  };
  const trustVerifier = {
    authenticate: vi.fn(async (bytes: Uint8Array) => {
      const envelope = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (envelope.signature !== digest(`fake-test-signature:${envelope.body}`))
        throw new Error("invalid fake signature");
      return { signerActorId: "recipient", manifestBytes: Buffer.from(envelope.body) };
    }),
  };
  const payloadVerifier = {
    validatePayload: vi.fn(async () => ({
      artifacts: empty ? [] : [structuredClone(ref)],
      payloadVerification:
        kind === "local_execution"
          ? ("local_result_and_receipt" as const)
          : ("hosted_response_source" as const),
      synthetic: true,
    })),
    validateReceiptEvidence: vi.fn(async () => {}),
  };
  const options = {
    approvedDestinationIds: ["approved"],
    reader,
    trustVerifier,
    payloadVerifier,
    persistence: sink,
  };
  const materializer = new DeliveryMaterializerV1(options);
  return {
    payload,
    artifact,
    ref,
    expected,
    manifest,
    content,
    sign,
    source,
    sink,
    reader,
    trustVerifier,
    payloadVerifier,
    options,
    materializer,
    collect: () => materializer.materialize({ expected, signedManifest: source }),
  };
}
function pending(result: unknown, issue?: string) {
  expect(result).toMatchObject({
    state: "delivery_pending",
    reexecute: false,
    ...(issue ? { issue } : {}),
  });
  expect(result).not.toHaveProperty("receipt");
}

describe("route-neutral requester delivery materialization", () => {
  it.each(["local_execution", "hosted_delivery"] as const)(
    "verifies all bytes and evidence before durable save for %s",
    async (kind) => {
      const f = fixture(kind);
      const result = await f.collect();
      expect(result.state).toBe("complete");
      if (result.state !== "complete") throw new Error(result.issue);
      expect(result.receipt).toMatchObject({
        ...f.expected,
        schema: "materialization-receipt-1",
        requiredArtifactsVerified: true,
        deliveryManifestSha256: sha256Bytes(Buffer.from(serializeDeliveryManifestV1(f.manifest))),
        verifiedArtifacts: [f.ref],
      });
      expect(f.payloadVerifier.validateReceiptEvidence).toHaveBeenCalledExactlyOnceWith(
        Uint8Array.from(f.payload),
        [{ descriptor: f.ref, bytes: Uint8Array.from(f.artifact) }],
        f.expected,
      );
      const saved = f.sink.saved.get(REQUEST);
      expect(saved?.payloadBytes).toEqual(Uint8Array.from(f.payload));
      expect(saved?.signedDeliveryManifestBytes).toEqual(
        Uint8Array.from(f.content.get(f.source.contentSha256) ?? []),
      );
      expect(f.sink.writes).toBe(1);
      expect(sha256Bytes(result.receiptBytes)).toBe(result.receiptSha256);
      expect(parseMaterializationReceiptV1(result.receiptBytes)).toEqual(result.receipt);
    },
  );
  it("retries byte-identically without another durable write or any execution capability", async () => {
    const f = fixture();
    const first = await f.collect();
    const second = await f.collect();
    expect(second).toEqual(first);
    expect(f.sink.calls).toBe(2);
    expect(f.sink.writes).toBe(1);
    expect(Object.keys(f.options)).not.toContain("execute");
  });
  it("deduplicates concurrent requests for the exact same immutable identity", async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.collect(), f.collect()]);
    expect(first).toEqual(second);
    expect(f.sink.calls).toBe(1);
    expect(f.trustVerifier.authenticate).toHaveBeenCalledTimes(1);
  });
  it("persists explicit verified empty set only after payload and receipt validation", async () => {
    const f = fixture("local_execution", true);
    const result = await f.collect();
    expect(result).toMatchObject({
      state: "complete",
      receipt: { requiredArtifactsVerified: true, verifiedArtifacts: [] },
    });
    expect(f.payloadVerifier.validatePayload).toHaveBeenCalledTimes(1);
    expect(f.payloadVerifier.validateReceiptEvidence).toHaveBeenCalledExactlyOnceWith(
      Uint8Array.from(f.payload),
      [],
      f.expected,
    );
    expect(f.sink.saved.get(REQUEST)?.verifiedArtifacts).toEqual([]);
  });
  it("does not use empty refs as a shortcut around receipt validation", async () => {
    const f = fixture("hosted_delivery", true);
    f.payloadVerifier.validateReceiptEvidence.mockRejectedValueOnce(
      new Error("source receipt missing"),
    );
    pending(await f.collect(), "delivery_receipt_evidence_invalid");
    expect(f.sink.calls).toBe(0);
  });
  it("never saves a payload rejected by its route-specific validator", async () => {
    const f = fixture();
    f.payloadVerifier.validatePayload.mockRejectedValueOnce(new Error("result receipt invalid"));
    pending(await f.collect(), "delivery_payload_validation_failed");
    expect(f.sink.calls).toBe(0);
  });
  it("rejects omitted required references although the signed manifest declares an empty set", async () => {
    const f = fixture();
    f.manifest.artifacts = [];
    const source = f.sign();
    pending(
      await f.materializer.materialize({ expected: f.expected, signedManifest: source }),
      "delivery_required_artifact_set_mismatch",
    );
    expect(f.sink.calls).toBe(0);
  });
  it.each(["artifactId", "contentSha256", "sizeBytes", "required"] as const)(
    "compares the required set's %s exactly",
    async (field) => {
      const f = fixture();
      const entry = f.manifest.artifacts[0];
      if (!entry) throw new Error("fixture");
      if (field === "artifactId") entry.artifactId = "another-artifact";
      if (field === "contentSha256") {
        entry.contentSha256 = "c".repeat(64);
        entry.source = { destinationId: "approved", contentSha256: entry.contentSha256 };
      }
      if (field === "sizeBytes") entry.sizeBytes++;
      if (field === "required") entry.required = false;
      pending(
        await f.materializer.materialize({ expected: f.expected, signedManifest: f.sign() }),
        "delivery_required_artifact_set_mismatch",
      );
      expect(f.sink.calls).toBe(0);
    },
  );
  it("leaves an explicitly withheld required artifact pending", async () => {
    const f = fixture();
    f.manifest.artifacts = [{ ...f.ref, availability: "unavailable", source: null }];
    pending(
      await f.materializer.materialize({ expected: f.expected, signedManifest: f.sign() }),
      "delivery_required_artifact_unavailable",
    );
    expect(f.sink.calls).toBe(0);
  });
  it.each(["missing", "truncated", "hash_mismatch"] as const)(
    "keeps %s artifact bytes pending without saving a receipt",
    async (mode) => {
      const f = fixture();
      if (mode === "missing") f.content.delete(f.ref.contentSha256);
      if (mode === "truncated") f.content.set(f.ref.contentSha256, f.artifact.subarray(1));
      if (mode === "hash_mismatch")
        f.content.set(f.ref.contentSha256, Buffer.alloc(f.artifact.length));
      pending(
        await f.collect(),
        mode === "missing"
          ? "delivery_content_unavailable"
          : mode === "truncated"
            ? "delivery_content_size_mismatch"
            : "delivery_content_hash_mismatch",
      );
      expect(f.sink.calls).toBe(0);
    },
  );
  it("retries transient source failure with exact payload and artifact identities", async () => {
    const f = fixture();
    f.content.delete(f.ref.contentSha256);
    pending(await f.collect());
    f.content.set(f.ref.contentSha256, f.artifact);
    expect((await f.collect()).state).toBe("complete");
    expect(f.sink.writes).toBe(1);
  });
  it("checks exact signed manifest content digest before authenticating", async () => {
    const f = fixture();
    f.content.set(f.source.contentSha256, Buffer.from("substituted manifest"));
    pending(await f.collect(), "delivery_content_hash_mismatch");
    expect(f.trustVerifier.authenticate).not.toHaveBeenCalled();
  });
  it("fails closed on invalid signature and wrong registered signer", async () => {
    const f = fixture();
    f.trustVerifier.authenticate.mockRejectedValueOnce(new Error("invalid signature"));
    pending(await f.collect(), "delivery_manifest_authentication_failed");
    f.trustVerifier.authenticate.mockResolvedValueOnce({
      signerActorId: "attacker",
      manifestBytes: Buffer.from(serializeDeliveryManifestV1(f.manifest)),
    });
    pending(await f.collect(), "delivery_manifest_signer_mismatch");
    expect(f.sink.calls).toBe(0);
  });
  it.each([
    "requesterActorId",
    "recipientActorId",
    "requestId",
    "taskSpecHash",
    "terminalEventId",
    "execution",
  ] as const)("rejects signed manifest %s substitution", async (field) => {
    const f = fixture();
    if (field === "execution") f.manifest.execution = { kind: "hosted_delivery", attemptId: RUN };
    else if (field === "taskSpecHash") f.manifest[field] = "b".repeat(64);
    else if (field === "requestId" || field === "terminalEventId") f.manifest[field] = RUN;
    else f.manifest[field] = "another_actor";
    pending(
      await f.materializer.materialize({ expected: f.expected, signedManifest: f.sign() }),
      "delivery_manifest_identity_mismatch",
    );
    expect(f.payloadVerifier.validatePayload).not.toHaveBeenCalled();
    expect(f.sink.calls).toBe(0);
  });
  it("denies an unapproved destination before asking its reader", async () => {
    const f = fixture();
    pending(
      await f.materializer.materialize({
        expected: f.expected,
        signedManifest: { ...f.source, destinationId: "unapproved" },
      }),
      "delivery_destination_denied",
    );
    expect(f.reader.read).not.toHaveBeenCalled();
  });
  it("denies signed artifact references to unapproved destinations", async () => {
    const f = fixture();
    const entry = f.manifest.artifacts[0];
    if (!entry?.source) throw new Error("fixture");
    entry.source.destinationId = "unapproved";
    pending(
      await f.materializer.materialize({ expected: f.expected, signedManifest: f.sign() }),
      "delivery_destination_denied",
    );
    expect(
      f.reader.read.mock.calls.every(
        ([source]) => !("destinationId" in source) || source.destinationId === "approved",
      ),
    ).toBe(true);
  });
  it("forbids arbitrary paths or URLs, even within signed source fields", async () => {
    const f = fixture();
    const data = JSON.parse(serializeDeliveryManifestV1(f.manifest));
    data.artifacts[0].source.path = "/private/secret";
    pending(
      await f.materializer.materialize({
        expected: f.expected,
        signedManifest: f.sign(JSON.stringify(data)),
      }),
      "delivery_schema_invalid",
    );
    expect(f.sink.calls).toBe(0);
    pending(
      await f.materializer.materialize({
        expected: f.expected,
        signedManifest: {
          destinationId: "https://evil.example",
          contentSha256: f.source.contentSha256,
        },
      }),
      "delivery_source_invalid",
    );
  });
  it("keeps sink failures pending and retries materialization only", async () => {
    const f = fixture();
    f.sink.fail = true;
    pending(await f.collect(), "delivery_persistence_failed");
    expect(f.sink.saved.size).toBe(0);
    f.sink.fail = false;
    const completed = await f.collect();
    expect(completed.state).toBe("complete");
    expect(f.sink.writes).toBe(1);
  });
  it("requires durable persistence acknowledgment for the exact receipt hash", async () => {
    const f = fixture();
    f.options.persistence.persistVerified = async () => ({
      state: "durable",
      receiptSha256: "0".repeat(64),
    });
    pending(await f.collect(), "delivery_persistence_proof_mismatch");
  });
  it("does not overwrite immutable materialization for changed signed manifest bytes", async () => {
    const f = fixture();
    const first = await f.collect();
    const original = f.sink.saved.get(REQUEST)?.receiptSha256;
    expect(first.state).toBe("complete");
    const whitespaceVariant = f.sign(`${serializeDeliveryManifestV1(f.manifest)} `);
    pending(
      await f.materializer.materialize({ expected: f.expected, signedManifest: whitespaceVariant }),
      "delivery_persistence_failed",
    );
    expect(f.sink.saved.get(REQUEST)?.receiptSha256).toBe(original);
    expect(f.sink.writes).toBe(1);
  });
  it("preserves trusted synthetic status and rejects a mismatched route-verification label", async () => {
    const f = fixture("local_execution", true);
    const first = await f.collect();
    expect(first).toMatchObject({
      state: "complete",
      receipt: { synthetic: true, payloadVerification: "local_result_and_receipt" },
    });
    f.payloadVerifier.validatePayload.mockResolvedValueOnce({
      artifacts: [],
      synthetic: true,
      payloadVerification: "hosted_response_source",
    });
    pending(await f.collect(), "delivery_payload_validation_failed");
    expect(f.sink.calls).toBe(1);
  });
  it("requires explicit trusted synthetic provenance even with no artifacts", async () => {
    const f = fixture("hosted_delivery", true);
    f.payloadVerifier.validatePayload.mockResolvedValueOnce({
      artifacts: [],
      payloadVerification: "hosted_response_source",
    } as Awaited<ReturnType<typeof f.payloadVerifier.validatePayload>>);
    pending(await f.collect(), "delivery_payload_validation_failed");
    expect(f.sink.calls).toBe(0);
  });
  it("retains explicit null run identity for route-validated never-started cancellation", async () => {
    const f = fixture("local_execution", true);
    f.expected.execution = { kind: "local_execution", runId: null };
    f.manifest.execution = { kind: "local_execution", runId: null };
    const result = await f.materializer.materialize({
      expected: f.expected,
      signedManifest: f.sign(),
    });
    expect(result).toMatchObject({
      state: "complete",
      receipt: { execution: { kind: "local_execution", runId: null } },
    });
    expect(f.payloadVerifier.validateReceiptEvidence).toHaveBeenCalledExactlyOnceWith(
      Uint8Array.from(f.payload),
      [],
      f.expected,
    );
  });
  it("preserves optional withheld state without inventing verified bytes", async () => {
    const f = fixture();
    const optional = { ...f.ref, artifactId: "optional-report", required: false };
    f.manifest.artifacts.push({ ...optional, availability: "unavailable", source: null });
    f.payloadVerifier.validatePayload.mockResolvedValueOnce({
      artifacts: [optional, f.ref],
      synthetic: true,
      payloadVerification: "local_result_and_receipt",
    });
    const result = await f.materializer.materialize({
      expected: f.expected,
      signedManifest: f.sign(),
    });
    expect(result).toMatchObject({ state: "complete", receipt: { verifiedArtifacts: [f.ref] } });
    expect(f.sink.saved.get(REQUEST)?.verifiedArtifacts).toHaveLength(1);
  });
  it("verifies every available optional artifact and returns the complete verified set", async () => {
    const f = fixture();
    const optional = { ...f.ref, artifactId: "optional-report", required: false };
    f.manifest.artifacts.push({
      ...optional,
      availability: "available",
      source: { destinationId: "approved", contentSha256: optional.contentSha256 },
    });
    f.payloadVerifier.validatePayload.mockResolvedValueOnce({
      artifacts: [f.ref, optional],
      synthetic: true,
      payloadVerification: "local_result_and_receipt",
    });
    const result = await f.materializer.materialize({
      expected: f.expected,
      signedManifest: f.sign(),
    });
    expect(result).toMatchObject({
      state: "complete",
      receipt: { verifiedArtifacts: [optional, f.ref] },
    });
    expect(f.sink.saved.get(REQUEST)?.verifiedArtifacts).toHaveLength(2);
  });
  it.each(["missing", "truncated", "hash_mismatch"] as const)(
    "keeps %s terminal payload bytes pending before payload validation",
    async (mode) => {
      const f = fixture();
      if (mode === "missing") f.content.delete(f.expected.payloadSha256);
      if (mode === "truncated") f.content.set(f.expected.payloadSha256, f.payload.subarray(1));
      if (mode === "hash_mismatch")
        f.content.set(f.expected.payloadSha256, Buffer.alloc(f.payload.length));
      pending(await f.collect());
      expect(f.payloadVerifier.validatePayload).not.toHaveBeenCalled();
      expect(f.sink.calls).toBe(0);
    },
  );
  it("passes exact task-bound data scope and bounded size to the approved reader", async () => {
    const f = fixture();
    await f.collect();
    expect(f.reader.read).toHaveBeenLastCalledWith(
      { destinationId: "approved", contentSha256: f.ref.contentSha256 },
      {
        binding: f.expected,
        purpose: "artifact",
        artifactId: f.ref.artifactId,
        maxBytes: f.ref.sizeBytes,
      },
    );
  });
  it("does not leak provider errors or private paths in pending issue codes", async () => {
    const f = fixture();
    f.reader.read.mockRejectedValueOnce(new Error("/private/token-abc failed"));
    expect(await f.collect()).toEqual({
      state: "delivery_pending",
      issue: "delivery_content_unavailable",
      reexecute: false,
    });
  });
  it("returns isolated receipt objects to concurrent callers", async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.collect(), f.collect()]);
    if (first.state !== "complete" || second.state !== "complete") throw new Error("fixture");
    first.receipt.requesterActorId = "mutated";
    first.receiptBytes.fill(0);
    expect(second.receipt.requesterActorId).toBe("requester");
    expect(sha256Bytes(second.receiptBytes)).toBe(second.receiptSha256);
    expect(f.sink.saved.get(REQUEST)?.receipt.requesterActorId).toBe("requester");
  });
  it("copies caller identities before asynchronous reader work", async () => {
    const f = fixture();
    const result = f.collect();
    f.expected.requesterActorId = "mutated";
    const completed = await result;
    expect(completed).toMatchObject({
      state: "complete",
      receipt: { requesterActorId: "requester" },
    });
  });
});

describe("strict deterministic delivery schemas", () => {
  it.each([
    "unknown_version",
    "duplicate_key",
    "invalid_utf8",
    "extra_field",
    "unsafe_number",
    "duplicate_artifact",
    "unsupported_route",
    "mixed_route",
  ] as const)("rejects %s", (mode) => {
    const f = fixture();
    const data = JSON.parse(serializeDeliveryManifestV1(f.manifest));
    let raw: Uint8Array;
    if (mode === "unknown_version") data.schema = "delivery-manifest-99";
    if (mode === "extra_field") data.authority = true;
    if (mode === "unsafe_number") data.payload.sizeBytes = Number.MAX_SAFE_INTEGER + 1;
    if (mode === "duplicate_artifact") data.artifacts.push(data.artifacts[0]);
    if (mode === "unsupported_route") data.execution.kind = "unknown";
    if (mode === "mixed_route") data.execution.attemptId = RUN;
    raw = Buffer.from(JSON.stringify(data));
    if (mode === "duplicate_key")
      raw = Buffer.from(
        `{"schema":"delivery-manifest-1",${Buffer.from(raw).toString("utf8").slice(1)}`,
      );
    if (mode === "invalid_utf8") raw = Uint8Array.from([0xff, 0xfe]);
    expect(() => parseDeliveryManifestV1(raw)).toThrow();
  });
  it("rejects missing explicit complete artifact enumeration", () => {
    const f = fixture("local_execution", true);
    const data = JSON.parse(serializeDeliveryManifestV1(f.manifest));
    delete data.artifactSet;
    expect(() => parseDeliveryManifestV1(Buffer.from(JSON.stringify(data)))).toThrow();
  });
  it("uses canonical key and artifact ordering independently of input property order", async () => {
    const f = fixture();
    const result = await f.collect();
    if (result.state !== "complete") throw new Error(result.issue);
    const extra = { ...f.ref, artifactId: "aaa" };
    const receipt = { ...result.receipt, verifiedArtifacts: [f.ref, extra] };
    const shuffled = {
      ...Object.fromEntries(Object.entries(receipt).reverse()),
      verifiedArtifacts: [extra, f.ref],
    } as typeof receipt;
    expect(serializeMaterializationReceiptV1(shuffled)).toBe(
      serializeMaterializationReceiptV1(receipt),
    );
    expect(
      parseMaterializationReceiptV1(
        Buffer.from(serializeMaterializationReceiptV1(receipt)),
      ).verifiedArtifacts.map((ref) => ref.artifactId),
    ).toEqual(["aaa", "receipt-evidence"]);
  });
  it("revalidates bundle bytes, exact receipt schema, and full verified set at persistence boundary", async () => {
    const f = fixture();
    await f.collect();
    const saved = f.sink.saved.get(REQUEST);
    if (!saved) throw new Error("fixture");
    const damaged = structuredClone(saved);
    damaged.payloadBytes = Buffer.from("changed");
    expect(() => validateVerifiedDeliveryMaterializationV1(damaged)).toThrow();
    const omitted = structuredClone(saved);
    omitted.verifiedArtifacts = [];
    expect(() => validateVerifiedDeliveryMaterializationV1(omitted)).toThrow();
    const extra = { ...saved.receipt, status: "succeeded" };
    expect(() => parseMaterializationReceiptV1(Buffer.from(JSON.stringify(extra)))).toThrow();
  });
  it.each([
    "extra_field",
    "unknown_version",
    "fractional_size",
    "unpaired_unicode",
    "newlined_hash",
    "newlined_actor",
    "duplicate_artifact",
    "route_verification",
    "synthetic_missing",
    "required_set_missing",
  ] as const)("rejects malformed receipt %s", async (mode) => {
    const f = fixture();
    const result = await f.collect();
    if (result.state !== "complete") throw new Error("fixture");
    const data = JSON.parse(Buffer.from(result.receiptBytes).toString("utf8"));
    if (mode === "extra_field") data.grant = "yes";
    if (mode === "unknown_version") data.schema = "materialization-receipt-2";
    if (mode === "fractional_size") data.verifiedArtifacts[0].sizeBytes = 1.5;
    if (mode === "unpaired_unicode") data.verifiedArtifacts[0].artifactId = "bad\uD800";
    if (mode === "newlined_hash") data.payloadSha256 += "\n";
    if (mode === "newlined_actor") data.requesterActorId += "\n";
    if (mode === "duplicate_artifact") data.verifiedArtifacts.push(data.verifiedArtifacts[0]);
    if (mode === "route_verification") data.payloadVerification = "hosted_response_source";
    if (mode === "synthetic_missing") delete data.synthetic;
    if (mode === "required_set_missing") delete data.requiredArtifactsVerified;
    expect(() => parseMaterializationReceiptV1(Buffer.from(JSON.stringify(data)))).toThrow();
  });
  it("enforces metadata artifact-count, per-file, total, and parser byte bounds", () => {
    const f = fixture();
    const raw = () => JSON.parse(serializeDeliveryManifestV1(f.manifest));
    const tooMany = raw();
    tooMany.artifacts = Array.from({ length: 129 }, (_, index) => ({
      ...tooMany.artifacts[0],
      artifactId: `artifact-${index}`,
    }));
    expect(() => parseDeliveryManifestV1(Buffer.from(JSON.stringify(tooMany)))).toThrow();
    const tooLarge = raw();
    tooLarge.artifacts[0].sizeBytes = 16 * 1024 * 1024 + 1;
    expect(() => parseDeliveryManifestV1(Buffer.from(JSON.stringify(tooLarge)))).toThrow();
    const total = raw();
    total.artifacts = Array.from({ length: 5 }, (_, index) => ({
      ...total.artifacts[0],
      sizeBytes: 16 * 1024 * 1024,
      artifactId: `artifact-${index}`,
    }));
    expect(() => parseDeliveryManifestV1(Buffer.from(JSON.stringify(total)))).toThrow();
    expect(() => parseDeliveryManifestV1(Buffer.alloc(256 * 1024 + 1))).toThrow();
  });
});
