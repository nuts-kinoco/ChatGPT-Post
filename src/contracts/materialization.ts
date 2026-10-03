/** Strict portable delivery and supplemental receipt contracts. No signing, filesystem, or execution authority. */
import { parseStrictJsonBytes } from "./task.js";

const MAX_ARCHIVE_ENTRIES = 128;
const MAX_ARCHIVE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 64 * 1024 * 1024;

export type DeliveryExecutionV1 =
  | { kind: "local_execution"; runId: string | null }
  | { kind: "hosted_delivery"; attemptId: string };
export interface DeliveryBindingV1 {
  requesterActorId: string;
  recipientActorId: string;
  requestId: string;
  taskSpecHash: string;
  execution: DeliveryExecutionV1;
  terminalEventId: string;
  payloadSha256: string;
}
/** An opaque configured destination plus a digest, never a URL or filesystem path. */
export interface DeliveryContentAddressV1 {
  destinationId: string;
  contentSha256: string;
}
export interface DeliveryArtifactDescriptorV1 {
  artifactId: string;
  contentSha256: string;
  sizeBytes: number;
  required: boolean;
}
export interface DeliveryManifestArtifactV1 extends DeliveryArtifactDescriptorV1 {
  availability: "available" | "unavailable";
  source: DeliveryContentAddressV1 | null;
}
export interface DeliveryManifestV1 extends DeliveryBindingV1 {
  schema: "delivery-manifest-1";
  payload: { source: DeliveryContentAddressV1; sizeBytes: number };
  /** Explicit exhaustive enumeration, including an explicitly verified empty set. */
  artifactSet: "complete";
  artifacts: DeliveryManifestArtifactV1[];
}
export interface MaterializationReceiptV1 extends DeliveryBindingV1 {
  schema: "materialization-receipt-1";
  deliveryManifestSha256: string;
  requiredArtifactsVerified: true;
  payloadVerification: DeliveryPayloadVerificationV1;
  synthetic: boolean;
  verifiedArtifacts: DeliveryArtifactDescriptorV1[];
}

export type DeliveryPayloadVerificationV1 = "local_result_and_receipt" | "hosted_response_source";
const HASH = /^[a-f0-9]{64}(?![\s\S])/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
const ID = /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/;
const ARTIFACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}(?![\s\S])/;
export const MAX_DELIVERY_MANIFEST_BYTES = 256 * 1024;
const BINDING_KEYS = [
  "requesterActorId",
  "recipientActorId",
  "requestId",
  "taskSpecHash",
  "execution",
  "terminalEventId",
  "payloadSha256",
];
const ARTIFACT_KEYS = ["artifactId", "contentSha256", "sizeBytes", "required"];
export class MaterializationContractError extends Error {}
function fail(code: string): never {
  throw new MaterializationContractError(code);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail("delivery_schema_invalid");
  return value as Record<string, unknown>;
}
function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.test(value);
}
function size(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_ARCHIVE_FILE_BYTES
  );
}
function binding(value: Record<string, unknown>): DeliveryBindingV1 {
  if (
    !matches(value.requesterActorId, ID) ||
    !matches(value.recipientActorId, ID) ||
    !matches(value.requestId, UUID) ||
    !matches(value.taskSpecHash, HASH) ||
    !matches(value.terminalEventId, UUID) ||
    !matches(value.payloadSha256, HASH)
  )
    fail("delivery_identity_invalid");
  const execution = value.execution as Record<string, unknown> | null;
  if (execution?.kind === "local_execution") {
    object(execution, ["kind", "runId"]);
    if (execution.runId !== null && !matches(execution.runId, UUID))
      fail("delivery_identity_invalid");
  } else if (execution?.kind === "hosted_delivery") {
    object(execution, ["kind", "attemptId"]);
    if (!matches(execution.attemptId, UUID)) fail("delivery_identity_invalid");
  } else fail("delivery_route_unsupported");
  return {
    requesterActorId: value.requesterActorId as string,
    recipientActorId: value.recipientActorId as string,
    requestId: value.requestId as string,
    taskSpecHash: value.taskSpecHash as string,
    execution: structuredClone(execution) as DeliveryExecutionV1,
    terminalEventId: value.terminalEventId as string,
    payloadSha256: value.payloadSha256 as string,
  };
}
function address(value: unknown): DeliveryContentAddressV1 {
  const ref = object(value, ["destinationId", "contentSha256"]);
  if (!matches(ref.destinationId, ID) || !matches(ref.contentSha256, HASH))
    fail("delivery_source_invalid");
  return { destinationId: ref.destinationId as string, contentSha256: ref.contentSha256 as string };
}
function descriptor(
  value: unknown,
  extraKeys: readonly string[] = [],
): DeliveryArtifactDescriptorV1 {
  const ref = object(value, [...ARTIFACT_KEYS, ...extraKeys]);
  if (
    !matches(ref.artifactId, ARTIFACT_ID) ||
    !matches(ref.contentSha256, HASH) ||
    !size(ref.sizeBytes) ||
    typeof ref.required !== "boolean"
  )
    fail("delivery_artifact_invalid");
  return {
    artifactId: ref.artifactId as string,
    contentSha256: ref.contentSha256 as string,
    sizeBytes: ref.sizeBytes as number,
    required: ref.required,
  };
}
function descriptors(value: unknown): DeliveryArtifactDescriptorV1[] {
  if (!Array.isArray(value) || value.length > MAX_ARCHIVE_ENTRIES)
    fail("delivery_artifact_set_invalid");
  const refs = value.map((v) => descriptor(v));
  checkArtifactSet(refs);
  return sorted(refs);
}
function checkArtifactSet(refs: readonly DeliveryArtifactDescriptorV1[]): void {
  if (
    refs.length > MAX_ARCHIVE_ENTRIES ||
    new Set(refs.map((r) => r.artifactId)).size !== refs.length ||
    refs.reduce((sum, r) => sum + r.sizeBytes, 0) > MAX_ARCHIVE_TOTAL_BYTES
  )
    fail("delivery_artifact_set_invalid");
}
function sorted<T extends DeliveryArtifactDescriptorV1>(refs: readonly T[]): T[] {
  return [...refs].sort((a, b) =>
    a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0,
  );
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
function boundedParse(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_DELIVERY_MANIFEST_BYTES)
    fail("delivery_manifest_size_limit");
  try {
    return parseStrictJsonBytes(bytes);
  } catch {
    fail("delivery_schema_invalid");
  }
}
export function parseDeliveryManifestV1(bytes: Uint8Array): DeliveryManifestV1 {
  const data = object(boundedParse(bytes), [
    ...BINDING_KEYS,
    "schema",
    "payload",
    "artifactSet",
    "artifacts",
  ]);
  const bound = binding(data);
  if (
    data.schema !== "delivery-manifest-1" ||
    data.artifactSet !== "complete" ||
    !Array.isArray(data.artifacts)
  )
    fail("delivery_manifest_invalid");
  if (data.artifacts.length > MAX_ARCHIVE_ENTRIES) fail("delivery_artifact_set_invalid");
  const payload = object(data.payload, ["source", "sizeBytes"]);
  const payloadSource = address(payload.source);
  if (!size(payload.sizeBytes) || payloadSource.contentSha256 !== bound.payloadSha256)
    fail("delivery_payload_reference_invalid");
  const artifacts = data.artifacts.map((entry): DeliveryManifestArtifactV1 => {
    const ref = descriptor(entry, ["availability", "source"]);
    const item = entry as Record<string, unknown>;
    if (item.availability === "unavailable" && item.source === null)
      return { ...ref, availability: "unavailable", source: null };
    if (item.availability !== "available") fail("delivery_artifact_invalid");
    const source = address(item.source);
    if (source.contentSha256 !== ref.contentSha256) fail("delivery_artifact_invalid");
    return { ...ref, availability: "available", source };
  });
  checkArtifactSet(artifacts);
  if (
    artifacts.reduce((sum, r) => sum + r.sizeBytes, payload.sizeBytes as number) >
    MAX_ARCHIVE_TOTAL_BYTES
  )
    fail("delivery_size_limit");
  return {
    ...bound,
    schema: "delivery-manifest-1",
    payload: { source: payloadSource, sizeBytes: payload.sizeBytes as number },
    artifactSet: "complete",
    artifacts: sorted(artifacts),
  };
}
export function serializeDeliveryManifestV1(manifest: DeliveryManifestV1): string {
  return `${canonical(parseDeliveryManifestV1(Buffer.from(canonical(manifest))))}\n`;
}
export function parseMaterializationReceiptV1(bytes: Uint8Array): MaterializationReceiptV1 {
  const data = object(boundedParse(bytes), [
    ...BINDING_KEYS,
    "schema",
    "deliveryManifestSha256",
    "requiredArtifactsVerified",
    "payloadVerification",
    "synthetic",
    "verifiedArtifacts",
  ]);
  const bound = binding(data);
  if (
    data.schema !== "materialization-receipt-1" ||
    !matches(data.deliveryManifestSha256, HASH) ||
    data.requiredArtifactsVerified !== true ||
    typeof data.synthetic !== "boolean" ||
    data.payloadVerification !==
      (bound.execution.kind === "local_execution"
        ? "local_result_and_receipt"
        : "hosted_response_source")
  )
    fail("materialization_receipt_invalid");
  return {
    ...bound,
    schema: "materialization-receipt-1",
    deliveryManifestSha256: data.deliveryManifestSha256 as string,
    requiredArtifactsVerified: true,
    payloadVerification: data.payloadVerification as DeliveryPayloadVerificationV1,
    synthetic: data.synthetic as boolean,
    verifiedArtifacts: descriptors(data.verifiedArtifacts),
  };
}
/** Canonical key ordering and artifact-ID ordering; no retry-dependent timestamp or generated ID. */
export function serializeMaterializationReceiptV1(receipt: MaterializationReceiptV1): string {
  return `${canonical(parseMaterializationReceiptV1(Buffer.from(canonical(receipt))))}\n`;
}

export function validateMaterializationReceiptV1(value: unknown): MaterializationReceiptV1 {
  return parseMaterializationReceiptV1(Buffer.from(canonical(value)));
}
export function validateDeliveryBindingV1(value: unknown): DeliveryBindingV1 {
  return binding(object(value, BINDING_KEYS));
}
export function validateDeliveryContentAddressV1(value: unknown): DeliveryContentAddressV1 {
  return address(value);
}
export function validateDeliveryArtifactDescriptorsV1(
  value: unknown,
): DeliveryArtifactDescriptorV1[] {
  return descriptors(value);
}
