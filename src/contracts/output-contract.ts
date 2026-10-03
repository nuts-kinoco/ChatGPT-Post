/** Bounded, portable output evidence. Parsed bytes and responder claims never grant authority. */
import type { GitHubProjectDestination } from "./project-registry.js";
import { parseResponseFrame, type ResponseFrameIdentity } from "./response-frame.js";
import { parseStrictJsonBytes, sha256Bytes } from "./task.js";

export const MAX_OUTPUT_CONTRACT_BYTES = 64 * 1024;
export const MAX_ARTIFACT_DECLARATION_BYTES = 64 * 1024;
export const MAX_OUTPUT_ARTIFACTS = 64;
export const MAX_OUTPUT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_OUTPUT_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}(?![\s\S])/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
const ACTOR = /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/;
const LOGICAL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}(?![\s\S])/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?![\s\S])/;
const DECLARATION_MARKER = "BRIDGE ARTIFACT DECLARATION";
const DECLARATION_PREFIX = `${DECLARATION_MARKER} `;

export interface OutputContractDestinationV1 extends GitHubProjectDestination {
  conversationId: string;
}
export interface RequiredOutputV1 {
  logicalName: string;
  mediaType: string;
  maxBytes: number;
}
export interface OutputContractBindingV1 {
  requestId: string;
  taskSpecHash: string;
  taskFileHash: string;
  route: "hosted_delivery";
  requesterActorId: string;
  recipientActorId: string;
  policySnapshotSha256: string;
  registryRevision: number;
  registrySnapshotSha256: string;
  projectId: string;
  repoId: string;
  storageSlug: string;
  destination: OutputContractDestinationV1;
}
export interface OutputContractV1 extends OutputContractBindingV1 {
  schema: "output-contract-1";
  mode: "text_only" | "declared_artifacts";
  requiredOutputs: RequiredOutputV1[];
  allowAdditionalArtifacts: false;
  maxArtifacts: number;
  maxTotalBytes: number;
  declarationFormat: "bridge-artifact-declaration-1";
}
/** Previously authorized, recipient-owned scope, never constructed from a received contract.
 * The encompassing BrowserDeliveryPolicy is hashed independently. There is deliberately no
 * request/task identity, policy self-hash, or future contract/issuance hash in this reusable scope.
 * Historical storage-registry identity is checked independently in the per-request binding so a
 * new display name or output root does not change execution-policy authority.
 */
export interface HostedExpectedOutputPolicy {
  route: "hosted_delivery";
  requesterActorId: string;
  recipientActorId: string;
  projectId: string;
  repoId: string;
  storageSlug: string;
  destination: OutputContractDestinationV1;
  mode: "text_only" | "declared_artifacts";
  requiredOutputs: readonly RequiredOutputV1[];
  allowAdditionalArtifacts: false;
  maxArtifacts: number;
  maxTotalBytes: number;
}
export interface ArtifactDeclarationOutputV1 {
  logicalName: string;
  mediaType: string;
  filename: string;
  contentSha256: string;
  sizeBytes: number;
}
export interface ArtifactDeclarationV1 {
  schema: "artifact-declaration-1";
  requestId: string;
  taskSpecHash: string;
  attemptId: string;
  outputContractSha256: string;
  outputs: ArtifactDeclarationOutputV1[];
}
export interface ArtifactDeclarationExpectationV1 {
  contract: OutputContractV1;
  /** The admission-pinned digest of the exact authenticated contract body, never a reserialization. */
  outputContractSha256: string;
  frame: ResponseFrameIdentity;
}
export interface ParsedArtifactDeclarationV1 {
  declaration: ArtifactDeclarationV1;
  declarationSha256: string;
  /** Exact UTF-8 JSON bytes after the declaration prefix, excluding the line terminator. */
  declarationBytes: Uint8Array;
  /** Presentation projection only. The immutable frame still contains declaration and answer. */
  answerMarkdown: string;
  frame: { markdown: string; rawSha256: string; bodySha256: string };
}
export class OutputContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OutputContractError";
  }
}
function fail(code: string): never {
  throw new OutputContractError(code);
}
const SCOPE_KEYS = [
  "route",
  "requesterActorId",
  "recipientActorId",
  "projectId",
  "repoId",
  "storageSlug",
  "destination",
] as const;
const BINDING_KEYS = [
  "requestId",
  "taskSpecHash",
  "taskFileHash",
  "policySnapshotSha256",
  "registryRevision",
  "registrySnapshotSha256",
  ...SCOPE_KEYS,
] as const;
const OUTPUT_KEYS = [
  "mode",
  "requiredOutputs",
  "allowAdditionalArtifacts",
  "maxArtifacts",
  "maxTotalBytes",
] as const;
function object(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail(code);
  return value as Record<string, unknown>;
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function integer(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function destination(value: unknown, code: string): OutputContractDestinationV1 {
  const dest = object(value, ["repositoryFullName", "branch", "namespace", "conversationId"], code);
  if (
    !matches(dest.repositoryFullName, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/) ||
    dest.repositoryFullName.length > 201 ||
    dest.repositoryFullName.split("/").some((part) => part === "." || part === "..") ||
    !matches(dest.branch, /^[A-Za-z0-9_/-]{1,200}(?![\s\S])/) ||
    dest.branch.split("/").some((part) => !part) ||
    !matches(dest.namespace, /^[a-z0-9-]{1,64}(?![\s\S])/) ||
    !matches(dest.conversationId, SOURCE_ID)
  )
    fail(code);
  return dest as unknown as OutputContractDestinationV1;
}
function scope(value: Record<string, unknown>, code: string): void {
  if (
    value.route !== "hosted_delivery" ||
    !matches(value.requesterActorId, ACTOR) ||
    !matches(value.recipientActorId, ACTOR) ||
    !matches(value.projectId, UUID) ||
    !matches(value.repoId, ACTOR) ||
    !matches(value.storageSlug, SLUG) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value.storageSlug)
  )
    fail(code);
  destination(value.destination, code);
}
function binding(value: Record<string, unknown>, code: string): void {
  scope(value, code);
  if (
    !matches(value.requestId, UUID) ||
    !matches(value.taskSpecHash, HASH) ||
    !matches(value.taskFileHash, HASH) ||
    !integer(value.registryRevision, Number.MAX_SAFE_INTEGER) ||
    value.registryRevision < 1 ||
    !matches(value.registrySnapshotSha256, HASH) ||
    !matches(value.policySnapshotSha256, HASH)
  )
    fail(code);
}
function outputs(value: Record<string, unknown>, code: string): void {
  if (
    (value.mode !== "text_only" && value.mode !== "declared_artifacts") ||
    value.allowAdditionalArtifacts !== false ||
    !integer(value.maxArtifacts, MAX_OUTPUT_ARTIFACTS) ||
    !integer(value.maxTotalBytes, MAX_OUTPUT_TOTAL_BYTES) ||
    !Array.isArray(value.requiredOutputs) ||
    value.requiredOutputs.length > value.maxArtifacts
  )
    fail(code);
  if (
    value.mode === "text_only" &&
    (value.requiredOutputs.length !== 0 || value.maxArtifacts !== 0 || value.maxTotalBytes !== 0)
  )
    fail(code);
  if (value.mode === "declared_artifacts" && value.requiredOutputs.length === 0) fail(code);
  const names = new Set<string>();
  for (const entry of value.requiredOutputs) {
    const item = object(entry, ["logicalName", "mediaType", "maxBytes"], code);
    if (
      !matches(item.logicalName, LOGICAL_NAME) ||
      names.has(item.logicalName) ||
      !matches(item.mediaType, MIME) ||
      !integer(item.maxBytes, MAX_OUTPUT_FILE_BYTES)
    )
      fail(code);
    names.add(item.logicalName);
  }
}
function contractObject(value: unknown): OutputContractV1 {
  if (
    !value ||
    typeof value !== "object" ||
    (value as Record<string, unknown>).schema !== "output-contract-1"
  )
    fail("unknown_contract");
  const data = object(
    value,
    ["schema", ...BINDING_KEYS, ...OUTPUT_KEYS, "declarationFormat"],
    "output_contract_invalid",
  );
  binding(data, "output_contract_invalid");
  outputs(data, "output_contract_invalid");
  if (data.declarationFormat !== "bridge-artifact-declaration-1") fail("output_contract_invalid");
  return data as unknown as OutputContractV1;
}
function boundedJson(bytes: Uint8Array, maximum: number, code: string): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maximum)
    fail(code);
  try {
    return parseStrictJsonBytes(bytes);
  } catch {
    fail(code);
  }
}
export function parseOutputContractV1(bytes: Uint8Array): OutputContractV1 {
  return contractObject(boundedJson(bytes, MAX_OUTPUT_CONTRACT_BYTES, "output_contract_invalid"));
}
/** The body bytes, including whitespace and member order, are the signing/digest identity. */
export function outputContractDigest(bytes: Uint8Array): string {
  parseOutputContractV1(bytes);
  return sha256Bytes(bytes);
}
function sameDestination(a: OutputContractDestinationV1, b: OutputContractDestinationV1): boolean {
  return (
    a.repositoryFullName === b.repositoryFullName &&
    a.branch === b.branch &&
    a.namespace === b.namespace &&
    a.conversationId === b.conversationId
  );
}
/** Call only with a recipient-owned trusted policy and independently obtained task/registry binding.
 * Signature verification must precede this call; a valid signature alone cannot authorize the scope.
 */
export function validateOutputContractPolicy(
  contract: OutputContractV1,
  policy: HostedExpectedOutputPolicy,
  expected: OutputContractBindingV1,
): void {
  contractObject(contract);
  const trusted = object(policy, [...SCOPE_KEYS, ...OUTPUT_KEYS], "output_policy_invalid");
  scope(trusted, "output_policy_invalid");
  outputs(trusted, "output_policy_invalid");
  const bound = object(expected, BINDING_KEYS, "output_contract_binding_invalid");
  binding(bound, "output_contract_binding_invalid");
  for (const key of BINDING_KEYS) {
    if (key !== "destination" && contract[key] !== expected[key])
      fail("output_contract_binding_mismatch");
  }
  if (!sameDestination(contract.destination, expected.destination))
    fail("output_contract_binding_mismatch");
  for (const key of SCOPE_KEYS) {
    if (key !== "destination" && policy[key] !== expected[key]) fail("output_policy_out_of_scope");
  }
  if (
    !sameDestination(policy.destination, expected.destination) ||
    contract.mode !== policy.mode ||
    contract.maxArtifacts > policy.maxArtifacts ||
    contract.maxTotalBytes > policy.maxTotalBytes
  )
    fail("output_policy_out_of_scope");
  const allowed = new Map(policy.requiredOutputs.map((item) => [item.logicalName, item]));
  if (allowed.size !== contract.requiredOutputs.length) fail("expected_set_mismatch");
  for (const item of contract.requiredOutputs) {
    const configured = allowed.get(item.logicalName);
    if (
      !configured ||
      item.mediaType !== configured.mediaType ||
      item.maxBytes > configured.maxBytes
    )
      fail("expected_set_mismatch");
  }
}
function portableFilename(value: unknown): value is string {
  return (
    matches(value, /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}(?![\s\S])/) &&
    !value.endsWith(".") &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)
  );
}
function declarationObject(
  value: unknown,
  expected: ArtifactDeclarationExpectationV1,
): ArtifactDeclarationV1 {
  const data = object(
    value,
    ["schema", "requestId", "taskSpecHash", "attemptId", "outputContractSha256", "outputs"],
    "artifact_declaration_invalid",
  );
  if (
    data.schema !== "artifact-declaration-1" ||
    !matches(data.requestId, UUID) ||
    !matches(data.taskSpecHash, HASH) ||
    !matches(data.attemptId, UUID) ||
    !matches(data.outputContractSha256, HASH) ||
    !Array.isArray(data.outputs) ||
    data.outputs.length > MAX_OUTPUT_ARTIFACTS
  )
    fail("artifact_declaration_invalid");
  if (
    data.requestId !== expected.frame.requestId ||
    data.taskSpecHash !== expected.frame.taskSpecHash ||
    data.attemptId !== expected.frame.attemptId ||
    data.outputContractSha256 !== expected.outputContractSha256
  )
    fail("artifact_declaration_binding_mismatch");
  const required = new Map(
    expected.contract.requiredOutputs.map((item) => [item.logicalName, item]),
  );
  if (data.outputs.length !== required.size || data.outputs.length > expected.contract.maxArtifacts)
    fail("declared_set_mismatch");
  const names = new Set<string>();
  const filenames = new Set<string>();
  let total = 0;
  for (const entry of data.outputs) {
    const item = object(
      entry,
      ["logicalName", "mediaType", "filename", "contentSha256", "sizeBytes"],
      "artifact_declaration_invalid",
    );
    if (
      !matches(item.logicalName, LOGICAL_NAME) ||
      !matches(item.mediaType, MIME) ||
      !matches(item.contentSha256, HASH) ||
      !integer(item.sizeBytes, MAX_OUTPUT_FILE_BYTES)
    )
      fail("artifact_declaration_invalid");
    const configured = required.get(item.logicalName);
    if (names.has(item.logicalName) || !configured) fail("declared_set_mismatch");
    if (item.mediaType !== configured.mediaType) fail("artifact_declaration_mime_mismatch");
    if (item.sizeBytes > configured.maxBytes) fail("artifact_declaration_size_limit");
    if (!portableFilename(item.filename)) fail("artifact_declaration_filename_invalid");
    const filenameKey = item.filename.toLowerCase();
    if (filenames.has(filenameKey)) fail("artifact_declaration_filename_collision");
    filenames.add(filenameKey);
    names.add(item.logicalName);
    total += item.sizeBytes;
  }
  if (total > expected.contract.maxTotalBytes || total > MAX_OUTPUT_TOTAL_BYTES)
    fail("artifact_declaration_size_limit");
  return data as unknown as ArtifactDeclarationV1;
}
function responseText(markdown: string | Uint8Array): string {
  if (typeof markdown === "string") {
    if (/[\uD800-\uDFFF]/u.test(markdown) || Buffer.byteLength(markdown) > MAX_RESPONSE_BYTES)
      fail("artifact_declaration_invalid");
    return markdown;
  }
  if (!(markdown instanceof Uint8Array) || markdown.byteLength > MAX_RESPONSE_BYTES)
    fail("artifact_declaration_invalid");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(markdown);
  } catch {
    fail("artifact_declaration_invalid");
  }
}
/** Parse the exact complete response frame, not an arbitrary body or a latest-message projection. */
export function parseArtifactDeclarationV1(
  markdown: string | Uint8Array,
  expected: ArtifactDeclarationExpectationV1,
): ParsedArtifactDeclarationV1 {
  contractObject(expected.contract);
  if (
    !matches(expected.outputContractSha256, HASH) ||
    !matches(expected.frame?.requestId, UUID) ||
    !matches(expected.frame?.taskSpecHash, HASH) ||
    !matches(expected.frame?.attemptId, UUID) ||
    expected.contract.requestId !== expected.frame.requestId ||
    expected.contract.taskSpecHash !== expected.frame.taskSpecHash
  )
    fail("output_contract_binding_mismatch");
  const frame = parseResponseFrame(responseText(markdown), expected.frame);
  const lines = frame.markdown.split("\n");
  const index = lines.findIndex((line) => line.trim().length !== 0);
  const line = lines[index];
  if (!line?.startsWith(DECLARATION_PREFIX)) fail("missing_declaration");
  // Also reject quoted, fenced, nested, or partial repeats anywhere in the same selected frame.
  if (frame.markdown.split(DECLARATION_MARKER).length !== 2) fail("artifact_declaration_invalid");
  const declarationBytes = Buffer.from(line.slice(DECLARATION_PREFIX.length), "utf8");
  const declaration = declarationObject(
    boundedJson(declarationBytes, MAX_ARTIFACT_DECLARATION_BYTES, "artifact_declaration_invalid"),
    expected,
  );
  return {
    declaration,
    declarationSha256: sha256Bytes(declarationBytes),
    declarationBytes,
    answerMarkdown: lines.slice(index + 1).join("\n"),
    frame,
  };
}
