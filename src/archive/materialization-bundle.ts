/** Pure candidate mapping only. This module grants no trust, storage or ACK authority. */
import {
  type DeliveryBindingV1,
  MAX_DELIVERY_MANIFEST_BYTES,
  parseDeliveryManifestV1,
  parseMaterializationReceiptV1,
  serializeDeliveryManifestV1,
  serializeMaterializationReceiptV1,
  validateDeliveryArtifactDescriptorsV1,
  validateDeliveryBindingV1,
} from "../contracts/materialization.js";
import { sha256Bytes } from "../contracts/raw-bytes.js";
import type { VerifiedDeliveryMaterializationV1 } from "./materializer.js";
import {
  decodeNtfsBundle,
  encodeNtfsBundle,
  type NtfsBundleMemberIdentity,
} from "./ntfs-bundle.js";

export const MAX_MATERIALIZATION_BUNDLE_ARTIFACTS = 124;
export interface MaterializationBundleExpectation {
  /** Caller retains original admission identity; this mapper cannot establish its provenance. */
  binding: DeliveryBindingV1;
  /** Original raw member identities supplied separately, never learned from a candidate bundle. */
  members: readonly NtfsBundleMemberIdentity[];
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}
function requireSame(left: unknown, right: unknown): void {
  if (canonical(left) !== canonical(right)) throw new Error("materialization_bundle_mismatch");
}
function bindingOf(value: DeliveryBindingV1): DeliveryBindingV1 {
  return validateDeliveryBindingV1({
    requesterActorId: value.requesterActorId,
    recipientActorId: value.recipientActorId,
    requestId: value.requestId,
    taskSpecHash: value.taskSpecHash,
    execution: value.execution,
    terminalEventId: value.terminalEventId,
    payloadSha256: value.payloadSha256,
  });
}
/** Mirrors materialization-store.ts naming, without importing the filesystem sink. */
export function materializationArtifactMemberName(artifactId: string): string {
  return `artifacts/artifact-${sha256Bytes(Buffer.from(artifactId, "utf8"))}.bin`;
}
/** Rechecks byte/metadata consistency, then maps an existing materializer candidate to a container.
 * Authentication and route/evidence validation must already occur at their existing trusted gates.
 * The historical Verified input type is structural only; no typed trust token is minted here. */
export function materializationToNtfsBundle(
  input: VerifiedDeliveryMaterializationV1,
  original: MaterializationBundleExpectation,
): Uint8Array {
  // Snapshot metadata independently. The codec performs bounded, private byte snapshots.
  const expectedBinding = validateDeliveryBindingV1(structuredClone(original.binding));
  const expectedMembers = structuredClone(original.members);
  const candidateBinding = validateDeliveryBindingV1(structuredClone(input.binding));
  const candidateReceipt = structuredClone(input.receipt);
  const manifestHash = input.deliveryManifestSha256;
  const receiptHash = input.receiptSha256;
  if (
    !Array.isArray(input.verifiedArtifacts) ||
    input.verifiedArtifacts.length > MAX_MATERIALIZATION_BUNDLE_ARTIFACTS
  )
    throw new Error("materialization_bundle_artifact_limit");
  const artifacts = input.verifiedArtifacts.map((item) => ({
    descriptor: structuredClone(item.descriptor),
    bytes: item.bytes,
  }));
  const refs = validateDeliveryArtifactDescriptorsV1(artifacts.map((item) => item.descriptor));
  const container = encodeNtfsBundle([
    { name: "results/result.json", bytes: input.payloadBytes },
    { name: "results/delivery-manifest.json", bytes: input.deliveryManifestBytes },
    { name: "results/delivery-manifest.signed.json", bytes: input.signedDeliveryManifestBytes },
    { name: "results/materialization-receipt.json", bytes: input.receiptBytes },
    ...artifacts.map((item) => ({
      name: materializationArtifactMemberName(item.descriptor.artifactId),
      bytes: item.bytes,
    })),
  ]);
  // Required independently supplied identities include the raw signed envelope, across retries.
  const snapshot = decodeNtfsBundle(container, expectedMembers);
  const payloadBytes = snapshot.memberBytes("results/result.json");
  const manifestBytes = snapshot.memberBytes("results/delivery-manifest.json");
  const signedBytes = snapshot.memberBytes("results/delivery-manifest.signed.json");
  const receiptBytes = snapshot.memberBytes("results/materialization-receipt.json");
  const manifest = parseDeliveryManifestV1(manifestBytes);
  const receipt = parseMaterializationReceiptV1(receiptBytes);
  requireSame(candidateBinding, expectedBinding);
  requireSame(bindingOf(manifest), expectedBinding);
  requireSame(bindingOf(receipt), expectedBinding);
  requireSame(receipt, candidateReceipt);
  requireSame(receipt.verifiedArtifacts, refs);
  requireSame(
    refs,
    manifest.artifacts
      .filter((item) => item.availability === "available")
      .map(({ artifactId, contentSha256, sizeBytes, required }) => ({
        artifactId,
        contentSha256,
        sizeBytes,
        required,
      })),
  );
  if (
    manifest.artifacts.some((item) => item.required && item.availability !== "available") ||
    sha256Bytes(payloadBytes) !== expectedBinding.payloadSha256 ||
    payloadBytes.byteLength !== manifest.payload.sizeBytes ||
    sha256Bytes(manifestBytes) !== manifestHash ||
    receipt.deliveryManifestSha256 !== manifestHash ||
    sha256Bytes(receiptBytes) !== receiptHash ||
    signedBytes.byteLength > MAX_DELIVERY_MANIFEST_BYTES ||
    Buffer.from(manifestBytes).toString("utf8") !== serializeDeliveryManifestV1(manifest) ||
    Buffer.from(receiptBytes).toString("utf8") !== serializeMaterializationReceiptV1(receipt)
  )
    throw new Error("materialization_bundle_mismatch");
  for (const ref of refs) {
    const bytes = snapshot.memberBytes(materializationArtifactMemberName(ref.artifactId));
    if (bytes.byteLength !== ref.sizeBytes || sha256Bytes(bytes) !== ref.contentSha256)
      throw new Error("materialization_bundle_mismatch");
  }
  return container;
}
