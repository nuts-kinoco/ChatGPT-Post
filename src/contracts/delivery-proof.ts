/** Supplemental proof checks. Callers authenticate both signer identities before entering here.
 * This module verifies binding/completeness; only the requester materializer can assert durable save. */
import { isDeepStrictEqual } from "node:util";
import {
  type DeliveryBindingV1,
  type DeliveryManifestV1,
  type MaterializationReceiptV1,
  serializeDeliveryManifestV1,
  validateMaterializationReceiptV1,
} from "./materialization.js";
import { sha256Bytes } from "./task.js";
export function assertDeliveryBinding(
  actual: DeliveryBindingV1,
  expected: DeliveryBindingV1,
): void {
  for (const key of [
    "requesterActorId",
    "recipientActorId",
    "requestId",
    "taskSpecHash",
    "terminalEventId",
    "payloadSha256",
  ] as const)
    if (actual[key] !== expected[key]) throw new Error("delivery_proof_binding_mismatch");
  if (!isDeepStrictEqual(actual.execution, expected.execution))
    throw new Error("delivery_proof_execution_mismatch");
}
export function assertMaterializationProof(
  receipt: MaterializationReceiptV1,
  manifest: DeliveryManifestV1,
  binding: DeliveryBindingV1,
): void {
  validateMaterializationReceiptV1(receipt);
  serializeDeliveryManifestV1(manifest);
  assertDeliveryBinding(manifest, binding);
  assertDeliveryBinding(receipt, binding);
  if (
    sha256Bytes(Buffer.from(serializeDeliveryManifestV1(manifest))) !==
    receipt.deliveryManifestSha256
  )
    throw new Error("delivery_manifest_hash_mismatch");
  if (manifest.artifacts.some((row) => row.required && row.availability !== "available"))
    throw new Error("delivery_required_artifact_unavailable");
  const expected = manifest.artifacts
    .filter((row) => row.availability === "available")
    .map(({ artifactId, contentSha256, sizeBytes, required }) => ({
      artifactId,
      contentSha256,
      sizeBytes,
      required,
    }))
    .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  const observed = [...receipt.verifiedArtifacts].sort((a, b) =>
    a.artifactId.localeCompare(b.artifactId),
  );
  if (!isDeepStrictEqual(expected, observed))
    throw new Error("delivery_proof_artifact_set_mismatch");
}
