import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  type MaterializationBundleExpectation,
  materializationArtifactMemberName,
  materializationToNtfsBundle,
} from "../../src/archive/materialization-bundle.js";
import type { VerifiedDeliveryMaterializationV1 } from "../../src/archive/materializer.js";
import { decodeNtfsBundle } from "../../src/archive/ntfs-bundle.js";
import {
  type DeliveryBindingV1,
  type DeliveryManifestV1,
  type MaterializationReceiptV1,
  serializeDeliveryManifestV1,
  serializeMaterializationReceiptV1,
} from "../../src/contracts/materialization.js";

vi.mock("node:fs", () => {
  throw new Error("mapper must not import fs");
});
vi.mock("node:fs/promises", () => {
  throw new Error("mapper must not import fs promises");
});
vi.mock("node:sqlite", () => {
  throw new Error("mapper must not import SQLite");
});
vi.mock("node:child_process", () => {
  throw new Error("mapper must not import processes");
});
vi.mock("../../src/contracts/task.js", () => {
  throw new Error("mapper must not load schemas");
});
vi.mock("../../src/archive/materializer.js", () => {
  throw new Error("mapper type import must erase");
});
vi.mock("../../src/archive/materialization-store.js", () => {
  throw new Error("mapper must not import sink");
});
vi.mock("../../src/archive/paths.js", () => {
  throw new Error("mapper must not import IO policy");
});

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const uuid = "11111111-1111-1111-1111-111111111111";
// Independent mapping oracle: names and artifact ID 'a' digest are fixed, not from mapper/candidate.
const fixedNames = [
  "results/result.json",
  "results/delivery-manifest.json",
  "results/delivery-manifest.signed.json",
  "results/materialization-receipt.json",
];
const goldenArtifactName =
  "artifacts/artifact-ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb.bin";
function fixture(route: "local_execution" | "hosted_delivery" = "local_execution", count = 1) {
  const payloadBytes = Buffer.from(
    route === "local_execution"
      ? '{"synthetic":true,"route":"local"}\n'
      : '{"synthetic":true,"route":"hosted"}\n',
  );
  const binding: DeliveryBindingV1 = {
    requesterActorId: "requester",
    recipientActorId: "recipient",
    requestId: uuid,
    taskSpecHash: "a".repeat(64),
    terminalEventId: uuid,
    payloadSha256: hash(payloadBytes),
    execution:
      route === "local_execution" ? { kind: route, runId: null } : { kind: route, attemptId: uuid },
  };
  const verifiedArtifacts = Array.from({ length: count }, (_, i) => {
    const bytes = Buffer.from(i === 0 ? "abc" : `artifact-${i}`);
    return {
      descriptor: {
        artifactId: i === 0 ? "a" : `a-${i}`,
        contentSha256: hash(bytes),
        sizeBytes: bytes.length,
        required: true,
      },
      bytes,
    };
  });
  verifiedArtifacts.sort((a, b) =>
    a.descriptor.artifactId < b.descriptor.artifactId
      ? -1
      : a.descriptor.artifactId > b.descriptor.artifactId
        ? 1
        : 0,
  );
  const manifest: DeliveryManifestV1 = {
    ...binding,
    schema: "delivery-manifest-1",
    artifactSet: "complete",
    payload: {
      source: { destinationId: "synthetic", contentSha256: binding.payloadSha256 },
      sizeBytes: payloadBytes.length,
    },
    artifacts: verifiedArtifacts.map(({ descriptor }) => ({
      ...descriptor,
      availability: "available",
      source: { destinationId: "synthetic", contentSha256: descriptor.contentSha256 },
    })),
  };
  const deliveryManifestBytes = Buffer.from(serializeDeliveryManifestV1(manifest));
  const receipt: MaterializationReceiptV1 = {
    ...binding,
    schema: "materialization-receipt-1",
    deliveryManifestSha256: hash(deliveryManifestBytes),
    requiredArtifactsVerified: true,
    payloadVerification:
      route === "local_execution" ? "local_result_and_receipt" : "hosted_response_source",
    synthetic: true,
    verifiedArtifacts: verifiedArtifacts.map((item) => item.descriptor),
  };
  const receiptBytes = Buffer.from(serializeMaterializationReceiptV1(receipt));
  const input: VerifiedDeliveryMaterializationV1 = {
    binding,
    payloadBytes,
    deliveryManifestBytes,
    deliveryManifestSha256: hash(deliveryManifestBytes),
    // Opaque synthetic envelope: deliberately no signer/provenance claim.
    signedDeliveryManifestBytes: Buffer.from('{"syntheticEnvelope":"original"}\n'),
    receipt,
    receiptBytes,
    receiptSha256: hash(receiptBytes),
    verifiedArtifacts,
  };
  const originals = [
    payloadBytes,
    deliveryManifestBytes,
    input.signedDeliveryManifestBytes,
    receiptBytes,
  ];
  const members = originals.map((bytes, i) => ({
    name: fixedNames[i] as string,
    length: bytes.length,
    sha256: hash(bytes),
  }));
  for (const item of verifiedArtifacts) {
    // Test-only independent name calculation from original descriptors, never candidate container.
    members.push({
      name: `artifacts/artifact-${hash(Buffer.from(item.descriptor.artifactId))}.bin`,
      length: item.bytes.length,
      sha256: hash(item.bytes),
    });
  }
  const original: MaterializationBundleExpectation = { binding: structuredClone(binding), members };
  return { input, original, manifest };
}
describe("pure materialization-to-bundle mapping", () => {
  it("has an independent fixed-name and artifact-hash golden mapping", () => {
    const { input, original } = fixture();
    expect(materializationArtifactMemberName("a")).toBe(goldenArtifactName);
    const decoded = decodeNtfsBundle(
      materializationToNtfsBundle(input, original),
      original.members,
    );
    expect(decoded.members.map((item) => item.name)).toEqual(
      [goldenArtifactName, ...fixedNames].sort(),
    );
    const goldenBytes = [
      input.payloadBytes,
      input.deliveryManifestBytes,
      input.signedDeliveryManifestBytes,
      input.receiptBytes,
    ];
    fixedNames.forEach((name, i) => {
      expect(decoded.memberBytes(name)).toEqual(Uint8Array.from(goldenBytes[i] as Uint8Array));
    });
    expect(decoded.memberBytes(goldenArtifactName)).toEqual(Uint8Array.of(97, 98, 99));
  });
  it.each(["local_execution", "hosted_delivery"] as const)(
    "maps synthetic %s fixtures without trust claims",
    (route) => {
      const { input, original } = fixture(route);
      const result = materializationToNtfsBundle(input, original);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).not.toHaveProperty("ackCandidate");
      expect(result).not.toHaveProperty("durable");
      expect(decodeNtfsBundle(result, original.members).members).toHaveLength(5);
    },
  );
  it.each(["local_execution", "hosted_delivery"] as const)(
    "retains explicit verified-empty %s metadata",
    (route) => {
      const { input, original } = fixture(route, 0);
      expect(
        decodeNtfsBundle(materializationToNtfsBundle(input, original), original.members).members,
      ).toHaveLength(4);
      expect(input.receipt.requiredArtifactsVerified).toBe(true);
      expect(input.receipt.verifiedArtifacts).toEqual([]);
    },
  );
  it("accepts exactly 124 artifacts and rejects 125 with four fixed members", () => {
    const valid = fixture("local_execution", 124);
    expect(
      decodeNtfsBundle(
        materializationToNtfsBundle(valid.input, valid.original),
        valid.original.members,
      ).members,
    ).toHaveLength(128);
    const invalid = fixture("local_execution", 125);
    expect(() => materializationToNtfsBundle(invalid.input, invalid.original)).toThrow(
      "artifact_limit",
    );
  });
  it.each(["missing", "extra", "hash", "length"])(
    "rejects %s original member expectation",
    (kind) => {
      const { input, original } = fixture();
      if (kind === "missing") original.members = original.members.slice(1);
      if (kind === "extra")
        original.members = [
          ...original.members,
          { name: "extra", length: 0, sha256: hash(Buffer.alloc(0)) },
        ];
      if (kind === "hash")
        original.members = original.members.map((item, i) =>
          i === 0 ? { ...item, sha256: "0".repeat(64) } : item,
        );
      if (kind === "length")
        original.members = original.members.map((item, i) =>
          i === 0 ? { ...item, length: item.length + 1 } : item,
        );
      expect(() => materializationToNtfsBundle(input, original)).toThrow();
    },
  );
  it.each([
    "payloadBytes",
    "deliveryManifestBytes",
    "signedDeliveryManifestBytes",
    "receiptBytes",
  ] as const)("rejects altered raw %s against original expectation", (key) => {
    const { input, original } = fixture();
    input[key] = Buffer.concat([input[key], Buffer.from(" ")]);
    expect(() => materializationToNtfsBundle(input, original)).toThrow();
  });
  it("rejects a different raw envelope retry even with identical decoded JSON payload", () => {
    const { input, original } = fixture();
    const first = materializationToNtfsBundle(input, original);
    const raw = Buffer.from(input.signedDeliveryManifestBytes).toString("utf8");
    input.signedDeliveryManifestBytes = Buffer.from(' { "syntheticEnvelope" : "original" } ');
    expect(JSON.parse(raw)).toEqual(
      JSON.parse(Buffer.from(input.signedDeliveryManifestBytes).toString("utf8")),
    );
    expect(() => materializationToNtfsBundle(input, original)).toThrow();
    expect(
      decodeNtfsBundle(first, original.members).memberBytes(
        "results/delivery-manifest.signed.json",
      ),
    ).toEqual(Uint8Array.from(Buffer.from(raw)));
  });
  it.each([
    "requesterActorId",
    "recipientActorId",
    "requestId",
    "taskSpecHash",
    "terminalEventId",
    "payloadSha256",
    "execution",
  ] as const)("rejects independent %s binding mismatch", (key) => {
    const { input, original } = fixture();
    if (key === "execution")
      original.binding.execution = { kind: "hosted_delivery", attemptId: uuid };
    else if (key === "requestId" || key === "terminalEventId")
      original.binding[key] = "22222222-2222-2222-2222-222222222222";
    else if (key === "taskSpecHash" || key === "payloadSha256")
      original.binding[key] = "b".repeat(64);
    else original.binding[key] = "other";
    expect(() => materializationToNtfsBundle(input, original)).toThrow("mismatch");
  });
  it.each([
    "manifestHash",
    "receiptHash",
    "receiptMetadata",
    "artifactHash",
    "artifactSize",
    "artifactRequired",
    "missingArtifact",
    "extraArtifact",
  ])("rejects inconsistent %s metadata", (kind) => {
    const { input, original } = fixture();
    const artifact = input.verifiedArtifacts[0];
    if (!artifact) throw new Error("fixture");
    if (kind === "manifestHash") input.deliveryManifestSha256 = "0".repeat(64);
    if (kind === "receiptHash") input.receiptSha256 = "0".repeat(64);
    if (kind === "receiptMetadata") input.receipt.synthetic = false;
    if (kind === "artifactHash") artifact.descriptor.contentSha256 = "0".repeat(64);
    if (kind === "artifactSize") artifact.descriptor.sizeBytes += 1;
    if (kind === "artifactRequired") artifact.descriptor.required = false;
    if (kind === "missingArtifact") input.verifiedArtifacts = [];
    if (kind === "extraArtifact")
      input.verifiedArtifacts.push({
        descriptor: { ...artifact.descriptor, artifactId: "extra" },
        bytes: artifact.bytes,
      });
    expect(() => materializationToNtfsBundle(input, original)).toThrow();
  });
  it("owns copies independently of candidate, expected metadata and decoded readback", () => {
    const { input, original } = fixture();
    const expectations = structuredClone(original.members);
    const container = materializationToNtfsBundle(input, original);
    const retained = Uint8Array.from(container);
    for (const bytes of [
      input.payloadBytes,
      input.deliveryManifestBytes,
      input.signedDeliveryManifestBytes,
      input.receiptBytes,
      ...input.verifiedArtifacts.map((item) => item.bytes),
    ])
      bytes.fill(0);
    input.binding.requesterActorId = "other";
    original.members = [];
    original.binding.recipientActorId = "other";
    expect(container).toEqual(retained);
    const decoded = decodeNtfsBundle(container, expectations);
    decoded.memberBytes(goldenArtifactName).fill(0);
    expect(decoded.memberBytes(goldenArtifactName)).toEqual(Uint8Array.of(97, 98, 99));
    container.fill(0);
    expect(decoded.memberBytes(goldenArtifactName)).toEqual(Uint8Array.of(97, 98, 99));
  });
  it("keeps retry bytes deterministic and never mutates the original input", () => {
    const { input, original } = fixture();
    const saved = structuredClone(input);
    expect(materializationToNtfsBundle(input, original)).toEqual(
      materializationToNtfsBundle(input, original),
    );
    expect(structuredClone(input)).toEqual(saved);
  });
  it.each([
    "manifestBinding",
    "receiptBinding",
    "manifestMissing",
    "manifestExtra",
    "requiredUnavailable",
    "payloadSize",
    "receiptManifestHash",
    "noncanonicalManifest",
    "noncanonicalReceipt",
  ])("rejects internally inconsistent %s even when raw member expectations match", (kind) => {
    const { input, original, manifest } = fixture();
    if (kind === "manifestBinding") manifest.recipientActorId = "other";
    if (kind === "receiptBinding") input.receipt.recipientActorId = "other";
    if (kind === "manifestMissing") manifest.artifacts = [];
    if (kind === "manifestExtra") {
      const first = manifest.artifacts[0];
      if (!first) throw new Error("fixture");
      manifest.artifacts.push({ ...first, artifactId: "extra" });
    }
    if (kind === "requiredUnavailable") {
      const first = manifest.artifacts[0];
      if (!first) throw new Error("fixture");
      first.availability = "unavailable";
      first.source = null;
    }
    if (kind === "payloadSize") manifest.payload.sizeBytes += 1;
    input.deliveryManifestBytes = Buffer.from(serializeDeliveryManifestV1(manifest));
    if (kind === "noncanonicalManifest")
      input.deliveryManifestBytes = Buffer.concat([input.deliveryManifestBytes, Buffer.from(" ")]);
    input.deliveryManifestSha256 = hash(input.deliveryManifestBytes);
    input.receipt.deliveryManifestSha256 =
      kind === "receiptManifestHash" ? "0".repeat(64) : input.deliveryManifestSha256;
    input.receiptBytes = Buffer.from(serializeMaterializationReceiptV1(input.receipt));
    if (kind === "noncanonicalReceipt")
      input.receiptBytes = Buffer.concat([input.receiptBytes, Buffer.from(" ")]);
    input.receiptSha256 = hash(input.receiptBytes);
    // Explicitly constructed inconsistent fixture identities, not read from any container.
    original.members = original.members.map((item) => {
      const bytes =
        item.name === "results/delivery-manifest.json"
          ? input.deliveryManifestBytes
          : item.name === "results/materialization-receipt.json"
            ? input.receiptBytes
            : null;
      return bytes ? { ...item, length: bytes.length, sha256: hash(bytes) } : item;
    });
    expect(() => materializationToNtfsBundle(input, original)).toThrow("mismatch");
  });
  it.each([
    { length: 256 * 1024, accepted: true },
    { length: 256 * 1024 + 1, accepted: false },
  ])(
    "checks the signed-envelope boundary at $length bytes with matching original identity",
    ({ length, accepted }) => {
      const { input, original } = fixture();
      // Synthetic opaque original envelope, supplied independently before making any container.
      const originalEnvelope = Buffer.alloc(length, 0x61);
      input.signedDeliveryManifestBytes = Uint8Array.from(originalEnvelope);
      original.members = original.members.map((item) =>
        item.name === "results/delivery-manifest.signed.json"
          ? { name: item.name, length: originalEnvelope.length, sha256: hash(originalEnvelope) }
          : item,
      );
      if (accepted) {
        const container = materializationToNtfsBundle(input, original);
        expect(
          decodeNtfsBundle(container, original.members).memberBytes(
            "results/delivery-manifest.signed.json",
          ),
        ).toEqual(Uint8Array.from(originalEnvelope));
      } else {
        expect(() => materializationToNtfsBundle(input, original)).toThrow(
          "materialization_bundle_mismatch",
        );
      }
    },
  );
  it("preserves unavailable optional artifact metadata without manufacturing bytes", () => {
    const { input, original, manifest } = fixture();
    manifest.artifacts.push({
      artifactId: "optional",
      contentSha256: hash(Buffer.alloc(0)),
      sizeBytes: 0,
      required: false,
      availability: "unavailable",
      source: null,
    });
    input.deliveryManifestBytes = Buffer.from(serializeDeliveryManifestV1(manifest));
    input.deliveryManifestSha256 = hash(input.deliveryManifestBytes);
    input.receipt.deliveryManifestSha256 = input.deliveryManifestSha256;
    input.receiptBytes = Buffer.from(serializeMaterializationReceiptV1(input.receipt));
    input.receiptSha256 = hash(input.receiptBytes);
    original.members = original.members.map((item) => {
      const bytes =
        item.name === "results/delivery-manifest.json"
          ? input.deliveryManifestBytes
          : item.name === "results/materialization-receipt.json"
            ? input.receiptBytes
            : null;
      return bytes ? { ...item, length: bytes.length, sha256: hash(bytes) } : item;
    });
    const result = decodeNtfsBundle(materializationToNtfsBundle(input, original), original.members);
    expect(result.members).toHaveLength(5);
    expect(() => result.memberBytes(materializationArtifactMemberName("optional"))).toThrow();
  });
});
