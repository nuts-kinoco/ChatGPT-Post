/** Requester-side verification only. No task execution, transport ACK, or signer lives here. */
import {
  type DeliveryArtifactDescriptorV1,
  type DeliveryBindingV1,
  type DeliveryContentAddressV1,
  type DeliveryPayloadVerificationV1,
  MAX_DELIVERY_MANIFEST_BYTES,
  MaterializationContractError,
  type MaterializationReceiptV1,
  parseDeliveryManifestV1,
  parseMaterializationReceiptV1,
  serializeDeliveryManifestV1,
  serializeMaterializationReceiptV1,
  validateDeliveryArtifactDescriptorsV1,
  validateDeliveryBindingV1,
  validateDeliveryContentAddressV1,
} from "../contracts/materialization.js";
import { sha256Bytes } from "../contracts/task.js";
import { MAX_ARCHIVE_FILE_BYTES, MAX_ARCHIVE_TOTAL_BYTES } from "./paths.js";

// Compatibility re-exports for archive hosts; transport imports the pure contract module directly.
export type {
  DeliveryArtifactDescriptorV1,
  DeliveryBindingV1,
  DeliveryManifestV1,
  MaterializationReceiptV1,
} from "../contracts/materialization.js";
export {
  parseDeliveryManifestV1,
  parseMaterializationReceiptV1,
  serializeDeliveryManifestV1,
  serializeMaterializationReceiptV1,
} from "../contracts/materialization.js";
export interface VerifiedDeliveryArtifactV1 {
  descriptor: DeliveryArtifactDescriptorV1;
  bytes: Uint8Array;
}
export interface VerifiedDeliveryMaterializationV1 {
  binding: DeliveryBindingV1;
  signedDeliveryManifestBytes: Uint8Array;
  deliveryManifestBytes: Uint8Array;
  deliveryManifestSha256: string;
  payloadBytes: Uint8Array;
  verifiedArtifacts: VerifiedDeliveryArtifactV1[];
  receipt: MaterializationReceiptV1;
  receiptBytes: Uint8Array;
  receiptSha256: string;
}
/** The trusted sink MUST resolve the requester's already-persisted admission pin, compare immutable
 * identities, save every supplied byte with verified platform durability, and read back the whole
 * bundle before returning durable. It must reject conflicting retries, never repin/overwrite or run
 * a task. A fabricated success from an untrusted sink is not a filesystem durability attestation. */
export interface DeliveryPersistencePortV1 {
  persistVerified(
    input: VerifiedDeliveryMaterializationV1,
  ): Promise<{ state: "durable"; receiptSha256: string }>;
}
export interface ContentAddressedDeliveryReaderV1 {
  /** Host configuration must authorize both the destination AND this request's data-sharing scope.
   * Enforce maxBytes during retrieval; never resolve model-supplied paths, URLs, or latest replies. */
  read(
    source: DeliveryContentAddressV1,
    context: {
      binding: DeliveryBindingV1;
      purpose: "signed_delivery_manifest" | "terminal_payload" | "artifact";
      artifactId: string | null;
      maxBytes: number;
    },
  ): Promise<Uint8Array | null>;
}
export interface DeliveryManifestTrustVerifierV1 {
  /** Authenticate the recipient's registered signing role and exact requester/recipient/request/
   * task/execution/terminal binding. Return the authenticated original manifest body bytes only.
   * A JSON signature field or remote actor label is never proof. Implementations fail closed. */
  authenticate(
    signedManifestBytes: Uint8Array,
    expected: DeliveryBindingV1,
  ): Promise<{ signerActorId: string; manifestBytes: Uint8Array }>;
}
export interface DeliveryPayloadVerifierV1 {
  /** Validate immutable local ResultSpec against its task, or hosted source/frame identity against
   * its policy and terminal event. Return every expected artifact (including receipt evidence),
   * with requiredness derived from that trusted route's rules, never from the delivery manifest. */
  validatePayload(
    payloadBytes: Uint8Array,
    expected: DeliveryBindingV1,
  ): Promise<{
    artifacts: DeliveryArtifactDescriptorV1[];
    payloadVerification: DeliveryPayloadVerificationV1;
    synthetic: boolean;
  }>;
  /** Validate receipt/evidence bytes for the route, including pre-intent cancellation and an
   * allocated run whose supervisor proves no launch. Completed hosted responses preserve exact
   * source/turn/frame identities; verified no-send failures retain admission evidence only.
   * Called even with no artifacts; an empty reference list alone is not valid evidence. */
  validateReceiptEvidence(
    payloadBytes: Uint8Array,
    artifacts: readonly VerifiedDeliveryArtifactV1[],
    expected: DeliveryBindingV1,
  ): Promise<void>;
}
export interface DeliveryMaterializerOptionsV1 {
  approvedDestinationIds: readonly string[];
  reader: ContentAddressedDeliveryReaderV1;
  trustVerifier: DeliveryManifestTrustVerifierV1;
  payloadVerifier: DeliveryPayloadVerifierV1;
  persistence: DeliveryPersistencePortV1;
}
export type DeliveryMaterializationResultV1 =
  | {
      state: "complete";
      receipt: MaterializationReceiptV1;
      receiptBytes: Uint8Array;
      receiptSha256: string;
      reexecute: false;
    }
  | { state: "delivery_pending"; issue: string; reexecute: false };

const ID = /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/;
function fail(code: string): never {
  throw new MaterializationContractError(code);
}
function bindingFrom(value: DeliveryBindingV1): DeliveryBindingV1 {
  const {
    requesterActorId,
    recipientActorId,
    requestId,
    taskSpecHash,
    execution,
    terminalEventId,
    payloadSha256,
  } = value;
  return validateDeliveryBindingV1({
    requesterActorId,
    recipientActorId,
    requestId,
    taskSpecHash,
    execution,
    terminalEventId,
    payloadSha256,
  });
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
    .join(",")}}`;
}
function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}
/** Revalidate the exact immutable bundle at a trusted persistence boundary. Cryptographic manifest
 * authentication and route receipt validation remain the materializer's mandatory preceding gates. */
export function validateVerifiedDeliveryMaterializationV1(
  input: VerifiedDeliveryMaterializationV1,
): void {
  const expected = validateDeliveryBindingV1(input.binding);
  const receipt = parseMaterializationReceiptV1(input.receiptBytes);
  if (
    !same(bindingFrom(receipt), expected) ||
    !same(receipt, input.receipt) ||
    serializeMaterializationReceiptV1(receipt) !==
      Buffer.from(input.receiptBytes).toString("utf8") ||
    sha256Bytes(input.receiptBytes) !== input.receiptSha256 ||
    input.signedDeliveryManifestBytes.byteLength > MAX_DELIVERY_MANIFEST_BYTES ||
    input.deliveryManifestBytes.byteLength > MAX_DELIVERY_MANIFEST_BYTES ||
    sha256Bytes(input.deliveryManifestBytes) !== input.deliveryManifestSha256 ||
    serializeDeliveryManifestV1(parseDeliveryManifestV1(input.deliveryManifestBytes)) !==
      Buffer.from(input.deliveryManifestBytes).toString("utf8") ||
    !same(bindingFrom(parseDeliveryManifestV1(input.deliveryManifestBytes)), expected) ||
    receipt.deliveryManifestSha256 !== input.deliveryManifestSha256 ||
    input.payloadBytes.byteLength > MAX_ARCHIVE_FILE_BYTES ||
    sha256Bytes(input.payloadBytes) !== expected.payloadSha256
  )
    fail("delivery_persistence_bundle_invalid");
  const refs = validateDeliveryArtifactDescriptorsV1(
    input.verifiedArtifacts.map((artifact) => artifact.descriptor),
  );
  if (!same(receipt.verifiedArtifacts, refs)) fail("delivery_persistence_bundle_invalid");
  let total =
    input.signedDeliveryManifestBytes.byteLength +
    input.deliveryManifestBytes.byteLength +
    input.payloadBytes.byteLength +
    input.receiptBytes.byteLength;
  for (const artifact of input.verifiedArtifacts) {
    if (
      artifact.bytes.byteLength !== artifact.descriptor.sizeBytes ||
      sha256Bytes(artifact.bytes) !== artifact.descriptor.contentSha256
    )
      fail("delivery_persistence_bundle_invalid");
    total += artifact.bytes.byteLength;
  }
  if (total > MAX_ARCHIVE_TOTAL_BYTES) fail("delivery_size_limit");
}

export class DeliveryMaterializerV1 {
  private readonly approvedDestinations: ReadonlySet<string>;
  private readonly pending = new Map<string, Promise<DeliveryMaterializationResultV1>>();
  constructor(private readonly options: DeliveryMaterializerOptionsV1) {
    if (
      !options.approvedDestinationIds.every((id) => ID.test(id)) ||
      new Set(options.approvedDestinationIds).size !== options.approvedDestinationIds.length
    )
      fail("delivery_destination_configuration_invalid");
    this.approvedDestinations = new Set(options.approvedDestinationIds);
  }
  async materialize(input: {
    expected: DeliveryBindingV1;
    signedManifest: DeliveryContentAddressV1;
  }): Promise<DeliveryMaterializationResultV1> {
    try {
      const expected = validateDeliveryBindingV1(input.expected);
      const source = validateDeliveryContentAddressV1(input.signedManifest);
      const key = canonical({ expected, source });
      const active = this.pending.get(key);
      if (active) return structuredClone(await active);
      const work = this.collect(expected, source);
      this.pending.set(key, work);
      try {
        return structuredClone(await work);
      } finally {
        if (this.pending.get(key) === work) this.pending.delete(key);
      }
    } catch (error) {
      return {
        state: "delivery_pending",
        issue:
          error instanceof MaterializationContractError
            ? error.message
            : "delivery_verification_failed",
        reexecute: false,
      };
    }
  }
  private async read(
    source: DeliveryContentAddressV1,
    expected: DeliveryBindingV1,
    purpose: "signed_delivery_manifest" | "terminal_payload" | "artifact",
    sizeBytes: number | null,
    artifactId: string | null = null,
  ): Promise<Uint8Array> {
    if (!this.approvedDestinations.has(source.destinationId)) fail("delivery_destination_denied");
    const maxBytes =
      purpose === "signed_delivery_manifest"
        ? MAX_DELIVERY_MANIFEST_BYTES
        : (sizeBytes ?? MAX_ARCHIVE_FILE_BYTES);
    let response: Uint8Array | null;
    try {
      response = await this.options.reader.read(structuredClone(source), {
        binding: structuredClone(expected),
        purpose,
        artifactId,
        maxBytes,
      });
    } catch {
      fail("delivery_content_unavailable");
    }
    if (!(response instanceof Uint8Array)) fail("delivery_content_unavailable");
    if (response.byteLength > maxBytes || (sizeBytes !== null && response.byteLength !== sizeBytes))
      fail("delivery_content_size_mismatch");
    const bytes = Uint8Array.from(response);
    if (sha256Bytes(bytes) !== source.contentSha256) fail("delivery_content_hash_mismatch");
    return bytes;
  }
  private async collect(
    expected: DeliveryBindingV1,
    source: DeliveryContentAddressV1,
  ): Promise<DeliveryMaterializationResultV1> {
    const signedBytes = await this.read(source, expected, "signed_delivery_manifest", null);
    let authenticated: { signerActorId: string; manifestBytes: Uint8Array };
    try {
      authenticated = await this.options.trustVerifier.authenticate(
        Uint8Array.from(signedBytes),
        structuredClone(expected),
      );
    } catch {
      fail("delivery_manifest_authentication_failed");
    }
    if (authenticated.signerActorId !== expected.recipientActorId)
      fail("delivery_manifest_signer_mismatch");
    const manifest = parseDeliveryManifestV1(authenticated.manifestBytes);
    if (!same(bindingFrom(manifest), expected)) fail("delivery_manifest_identity_mismatch");
    if (
      manifest.artifacts.reduce(
        (total, artifact) => total + artifact.sizeBytes,
        manifest.payload.sizeBytes + signedBytes.byteLength,
      ) > MAX_ARCHIVE_TOTAL_BYTES
    )
      fail("delivery_size_limit");
    const payloadBytes = await this.read(
      manifest.payload.source,
      expected,
      "terminal_payload",
      manifest.payload.sizeBytes,
    );
    let expectedRefs: DeliveryArtifactDescriptorV1[];
    let payloadVerification: DeliveryPayloadVerificationV1;
    let synthetic: boolean;
    try {
      const validated = await this.options.payloadVerifier.validatePayload(
        Uint8Array.from(payloadBytes),
        structuredClone(expected),
      );
      if (
        typeof validated.synthetic !== "boolean" ||
        validated.payloadVerification !==
          (expected.execution.kind === "local_execution"
            ? "local_result_and_receipt"
            : "hosted_response_source")
      )
        fail("delivery_payload_validation_failed");
      expectedRefs = validateDeliveryArtifactDescriptorsV1(validated.artifacts);
      payloadVerification = validated.payloadVerification;
      synthetic = validated.synthetic;
    } catch {
      fail("delivery_payload_validation_failed");
    }
    const manifestRefs = manifest.artifacts.map(
      ({ artifactId, contentSha256, sizeBytes, required }) => ({
        artifactId,
        contentSha256,
        sizeBytes,
        required,
      }),
    );
    if (!same(expectedRefs, manifestRefs)) fail("delivery_required_artifact_set_mismatch");
    const verifiedArtifacts: VerifiedDeliveryArtifactV1[] = [];
    for (const artifact of manifest.artifacts) {
      if (artifact.availability === "unavailable" || !artifact.source) {
        if (artifact.required) fail("delivery_required_artifact_unavailable");
        continue;
      }
      const bytes = await this.read(
        artifact.source,
        expected,
        "artifact",
        artifact.sizeBytes,
        artifact.artifactId,
      );
      verifiedArtifacts.push({
        descriptor: structuredClone(
          manifestRefs.find(
            (ref) => ref.artifactId === artifact.artifactId,
          ) as DeliveryArtifactDescriptorV1,
        ),
        bytes,
      });
    }
    try {
      await this.options.payloadVerifier.validateReceiptEvidence(
        Uint8Array.from(payloadBytes),
        structuredClone(verifiedArtifacts),
        structuredClone(expected),
      );
    } catch {
      fail("delivery_receipt_evidence_invalid");
    }
    const deliveryManifestBytes = Buffer.from(serializeDeliveryManifestV1(manifest));
    const deliveryManifestSha256 = sha256Bytes(deliveryManifestBytes);
    const receipt: MaterializationReceiptV1 = {
      ...expected,
      schema: "materialization-receipt-1",
      deliveryManifestSha256,
      requiredArtifactsVerified: true,
      payloadVerification,
      synthetic,
      verifiedArtifacts: verifiedArtifacts.map((artifact) => artifact.descriptor),
    };
    const receiptBytes = Buffer.from(serializeMaterializationReceiptV1(receipt));
    const receiptSha256 = sha256Bytes(receiptBytes);
    const bundle: VerifiedDeliveryMaterializationV1 = {
      binding: expected,
      signedDeliveryManifestBytes: signedBytes,
      deliveryManifestBytes,
      deliveryManifestSha256,
      payloadBytes,
      verifiedArtifacts,
      receipt,
      receiptBytes,
      receiptSha256,
    };
    validateVerifiedDeliveryMaterializationV1(bundle);
    let persisted: { state: "durable"; receiptSha256: string };
    try {
      persisted = await this.options.persistence.persistVerified(structuredClone(bundle));
    } catch {
      fail("delivery_persistence_failed");
    }
    if (persisted.state !== "durable" || persisted.receiptSha256 !== receiptSha256)
      fail("delivery_persistence_proof_mismatch");
    return {
      state: "complete",
      receipt: structuredClone(receipt),
      receiptBytes: Uint8Array.from(receiptBytes),
      receiptSha256,
      reexecute: false,
    };
  }
}
