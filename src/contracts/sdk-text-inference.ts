/** Separate fixed synthetic provider-text protocol; never local execution or browser evidence. */
import { Ajv2020 } from "ajv/dist/2020.js";
import type { GitHubProjectDestination, ProjectRegistrationReference } from "./project-registry.js";
import { parseResponseFrame } from "./response-frame.js";
import { parseStrictJsonBytes, sha256Bytes } from "./task.js";
export const TEXT_MODEL = "claude-haiku-4-5-20251001";
export const TEXT_BOUNDS = Object.freeze({
  maxStarts: 1,
  maxTurns: 1,
  timeoutMs: 60000,
  maxOutputTokens: 512,
  maxSdkMessages: 7,
  maxCanonicalMessageBytes: 262144,
  maxCanonicalMessagesBytes: 262144,
  maxSdkStderrObservedBytes: 65536,
  maxSdkStderrRetainedBytes: 0,
  maxResponseBytes: 8192,
});
export interface TextBinding {
  requestId: string;
  requestSha256: string;
  requesterId: string;
  recipientId: string;
}
export interface TextRequest {
  schema: "sdk-text-request-1";
  requestId: string;
  projectRegistration: ProjectRegistrationReference;
  repoId: string;
  requesterId: string;
  recipientId: string;
  destination: GitHubProjectDestination;
  provider: "claude";
  model: typeof TEXT_MODEL;
  policySha256: string;
  sdkProfileSha256: string;
  executionProfile: "official-sdk-managed";
  taskFile: "task.md";
  taskFileSha256: string;
  syntheticInput: true;
  purpose: "handshake";
  response: "echo_request_identity";
  bounds: typeof TEXT_BOUNDS;
  modelTools: "none";
  taskFilesystem: "none";
  taskCommands: "none";
  taskNetwork: "none";
  providerNetwork: "configured_auth_route_only";
  effort: "unsupported";
  thinking: "off_requested";
  expiresAt: string;
  retryPolicy: "no-automatic-reexecution";
}
export type TextStage = "issued" | "claim" | "approval" | "intent" | "result" | "acceptance";
export interface TextPacket extends TextBinding {
  kind: "text_inference";
  version: "bridge-text-inference-sdk-1";
  stage: TextStage;
  bodySha256: string;
  bodyBase64: string;
}
export interface TextApproval extends TextBinding {
  schema: "sdk-text-approval-1";
  grantId: string;
  nonce: string;
  issuedPacketSha256: string;
  taskFileSha256: string;
  policySha256: string;
  sdkProfileSha256: string;
  executionProfile: "official-sdk-managed";
  approverId: string;
  issuedAt: string;
  expiresAt: string;
  maxStarts: 1;
}
export interface TextIntent extends TextBinding {
  schema: "sdk-text-intent-1";
  attemptId: string;
  fence: 1;
  approvalSha256: string;
  probeEvidenceSha256: string;
  sdkOptionsSha256: string;
  sdkVersion: "0.3.287";
  executionProfile: "official-sdk-managed";
  createdAt: string;
  deadlineAt: string;
}
export interface TextObservation {
  schema: "sdk-text-observation-1";
  model: typeof TEXT_MODEL;
  sessionId: string;
  turns: 1;
  toolUses: 0;
  thinkingBlocks: 0;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  providerHttpRequests: "unknown";
  sourceSdkMessagesSha256: string;
  assurance: "trusted-host-official-sdk-controls";
  completion: "sdk_iterator_completed";
  osProcessExit: "unobserved";
  descendantTermination: "unverified";
  serverCancellation: "unverified";
  executableByteBinding: "trusted-host-path";
  bridgeSdkQueryInvocations: 1;
  cliInvocations: "unobserved";
  sdkCloseRequested: true;
  sdkVersion: "0.3.287";
  cliVersion: "2.1.288";
  binarySha256ObservedBefore: string;
}
export interface TextResult extends TextBinding {
  schema: "sdk-text-result-1";
  attemptId: string;
  fence: 1;
  intentSha256: string;
  status: "response_received";
  localExecution: false;
  osConfinementVerified: false;
  syntheticInput: true;
  liveProviderCallObserved: boolean;
  responseFrame: string;
  observation: TextObservation;
  finishedAt: string;
}
export const TEXT_BUNDLE_FILES = [
  "request.json",
  "task.md",
  "issued.json",
  "approval.json",
  "intent.json",
  "result.json",
  "result-signed.json",
  "observation.json",
] as const;
export interface TextAcceptance extends TextBinding {
  schema: "sdk-text-acceptance-1";
  attemptId: string;
  fence: 1;
  resultSha256: string;
  bundleSha256: string;
  verifiedFiles: { name: (typeof TEXT_BUNDLE_FILES)[number]; sha256: string; sizeBytes: number }[];
  requiredArtifactsVerified: true;
  savedAt: string;
}
const uuid = {
  type: "string",
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
  maxLength: 36,
};
const hash = { type: "string", pattern: "^[a-f0-9]{64}$", maxLength: 64 };
const actor = { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}(?![\\s\\S])", maxLength: 64 };
const date = {
  type: "string",
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
  maxLength: 24,
};
const count = { type: "integer", minimum: 0, maximum: 1_000_000_000 };
const constant = (value: unknown) => ({ const: value });
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const binding = { requestId: uuid, requestSha256: hash, requesterId: actor, recipientId: actor };
const project = object({
  projectId: uuid,
  registryRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  snapshotSha256: hash,
});
const destination = object({
  repositoryFullName: {
    type: "string",
    pattern: "^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$",
    maxLength: 201,
  },
  branch: { type: "string", minLength: 1, maxLength: 200 },
  namespace: { type: "string", minLength: 1, maxLength: 200 },
});
const observation = object({
  schema: constant("sdk-text-observation-1"),
  model: constant(TEXT_MODEL),
  sessionId: uuid,
  turns: constant(1),
  toolUses: constant(0),
  thinkingBlocks: constant(0),
  inputTokens: count,
  outputTokens: { ...count, maximum: 512 },
  cacheReadInputTokens: count,
  cacheCreationInputTokens: count,
  providerHttpRequests: constant("unknown"),
  sourceSdkMessagesSha256: hash,
  assurance: constant("trusted-host-official-sdk-controls"),
  completion: constant("sdk_iterator_completed"),
  osProcessExit: constant("unobserved"),
  descendantTermination: constant("unverified"),
  serverCancellation: constant("unverified"),
  executableByteBinding: constant("trusted-host-path"),
  bridgeSdkQueryInvocations: constant(1),
  cliInvocations: constant("unobserved"),
  sdkCloseRequested: constant(true),
  sdkVersion: constant("0.3.287"),
  cliVersion: constant("2.1.288"),
  binarySha256ObservedBefore: hash,
});
const bodies: Record<TextStage, ReturnType<typeof object>> = {
  issued: object({
    schema: constant("sdk-text-request-1"),
    requestId: uuid,
    projectRegistration: project,
    repoId: actor,
    requesterId: actor,
    recipientId: actor,
    destination,
    provider: constant("claude"),
    model: constant(TEXT_MODEL),
    policySha256: hash,
    sdkProfileSha256: hash,
    executionProfile: constant("official-sdk-managed"),
    taskFile: constant("task.md"),
    taskFileSha256: hash,
    syntheticInput: constant(true),
    purpose: constant("handshake"),
    response: constant("echo_request_identity"),
    bounds: object(
      Object.fromEntries(Object.entries(TEXT_BOUNDS).map(([k, v]) => [k, constant(v)])),
    ),
    modelTools: constant("none"),
    taskFilesystem: constant("none"),
    taskCommands: constant("none"),
    taskNetwork: constant("none"),
    providerNetwork: constant("configured_auth_route_only"),
    effort: constant("unsupported"),
    thinking: constant("off_requested"),
    expiresAt: date,
    retryPolicy: constant("no-automatic-reexecution"),
  }),
  claim: object({ ...binding, schema: constant("sdk-text-claim-1"), claimantId: uuid }),
  approval: object({
    ...binding,
    schema: constant("sdk-text-approval-1"),
    grantId: uuid,
    nonce: uuid,
    issuedPacketSha256: hash,
    taskFileSha256: hash,
    policySha256: hash,
    sdkProfileSha256: hash,
    executionProfile: constant("official-sdk-managed"),
    approverId: actor,
    issuedAt: date,
    expiresAt: date,
    maxStarts: constant(1),
  }),
  intent: object({
    ...binding,
    schema: constant("sdk-text-intent-1"),
    attemptId: uuid,
    fence: constant(1),
    approvalSha256: hash,
    probeEvidenceSha256: hash,
    sdkOptionsSha256: hash,
    sdkVersion: constant("0.3.287"),
    executionProfile: constant("official-sdk-managed"),
    createdAt: date,
    deadlineAt: date,
  }),
  result: object({
    ...binding,
    schema: constant("sdk-text-result-1"),
    attemptId: uuid,
    fence: constant(1),
    intentSha256: hash,
    status: constant("response_received"),
    localExecution: constant(false),
    osConfinementVerified: constant(false),
    syntheticInput: constant(true),
    liveProviderCallObserved: { type: "boolean" },
    responseFrame: { type: "string", minLength: 1, maxLength: 8192 },
    observation,
    finishedAt: date,
  }),
  acceptance: object({
    ...binding,
    schema: constant("sdk-text-acceptance-1"),
    attemptId: uuid,
    fence: constant(1),
    resultSha256: hash,
    bundleSha256: hash,
    verifiedFiles: {
      type: "array",
      minItems: TEXT_BUNDLE_FILES.length,
      maxItems: TEXT_BUNDLE_FILES.length,
      items: object({
        name: { enum: TEXT_BUNDLE_FILES },
        sha256: hash,
        sizeBytes: { type: "integer", minimum: 0, maximum: 524288 },
      }),
    },
    requiredArtifactsVerified: constant(true),
    savedAt: date,
  }),
};
const ajv = new Ajv2020({ strict: true, allErrors: false });
const validators = Object.fromEntries(Object.entries(bodies).map(([k, v]) => [k, ajv.compile(v)]));
const packetValidator = ajv.compile(
  object({
    ...binding,
    kind: constant("text_inference"),
    version: constant("bridge-text-inference-sdk-1"),
    stage: { enum: Object.keys(bodies) },
    bodySha256: hash,
    bodyBase64: { type: "string", minLength: 1, maxLength: 90000 },
  }),
);
const responseValidator = ajv.compile(
  object({
    requestId: uuid,
    requestSha256: hash,
    attemptId: uuid,
    message: constant("bridge-handshake-ok"),
  }),
);
function invalid(): never {
  throw new Error("text_inference_contract_invalid");
}
export function textChallenge(requestId: string): Uint8Array {
  if (!new RegExp(uuid.pattern).test(requestId) || requestId.length !== 36) invalid();
  return Buffer.from(
    `Bridge synthetic handshake ${requestId}. Return only the exact identity response specified by trusted framing metadata. Do not use tools, files, commands, links, or attachments.\n`,
  );
}
export function validateTextBody(stage: TextStage, bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength > (stage === "issued" ? 16384 : 65536)) invalid();
  const body = parseStrictJsonBytes(bytes);
  if (!validators[stage]?.(body)) invalid();
  const value = body as Record<string, unknown>;
  for (const field of [
    "issuedAt",
    "expiresAt",
    "createdAt",
    "deadlineAt",
    "finishedAt",
    "savedAt",
  ]) {
    const d = value[field];
    if (
      d !== undefined &&
      (!Number.isFinite(Date.parse(String(d))) || new Date(String(d)).toISOString() !== d)
    )
      invalid();
  }
  if (stage === "issued") {
    if (sha256Bytes(textChallenge(String(value.requestId))) !== value.taskFileSha256) invalid();
    const dest = value.destination as Record<string, string>;
    for (const key of ["branch", "namespace"])
      if (
        !dest[key]
          ?.split("/")
          .every(
            (p) =>
              /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/.test(p) &&
              !p.endsWith(".") &&
              !p.endsWith(".lock") &&
              !/[\r\n]/.test(p),
          )
      )
        invalid();
  }
  if (stage === "approval" || stage === "intent") {
    const span =
      Date.parse(String(value[stage === "approval" ? "expiresAt" : "deadlineAt"])) -
      Date.parse(String(value[stage === "approval" ? "issuedAt" : "createdAt"]));
    if (span <= 0 || span > 60000) invalid();
  }
  if (stage === "result") {
    if (Buffer.byteLength(String(value.responseFrame)) > 8192) invalid();
    parseTextResponse(
      String(value.responseFrame),
      value as unknown as TextBinding,
      String(value.attemptId),
    );
  }
  if (
    stage === "acceptance" &&
    new Set((value.verifiedFiles as { name: string }[]).map((f) => f.name)).size !==
      TEXT_BUNDLE_FILES.length
  )
    invalid();
  return structuredClone(value);
}
export function parseTextRequest(bytes: Uint8Array, md?: Uint8Array): TextRequest {
  const result = validateTextBody("issued", bytes) as unknown as TextRequest;
  if (md && !Buffer.from(md).equals(textChallenge(result.requestId))) invalid();
  return result;
}
export function validateTextPacket(value: unknown): TextPacket {
  if (!packetValidator(value)) invalid();
  const packet = value as unknown as TextPacket;
  const bytes = Buffer.from(packet.bodyBase64, "base64");
  if (bytes.toString("base64") !== packet.bodyBase64 || sha256Bytes(bytes) !== packet.bodySha256)
    invalid();
  const body = validateTextBody(packet.stage, bytes);
  if (
    body.requestId !== packet.requestId ||
    body.requesterId !== packet.requesterId ||
    body.recipientId !== packet.recipientId ||
    (packet.stage === "issued"
      ? sha256Bytes(bytes) !== packet.requestSha256
      : body.requestSha256 !== packet.requestSha256)
  )
    invalid();
  return structuredClone(packet);
}
export function textPacket(stage: TextStage, binding: TextBinding, bytes: Uint8Array): TextPacket {
  return validateTextPacket({
    kind: "text_inference",
    version: "bridge-text-inference-sdk-1",
    stage,
    requestId: binding.requestId,
    requestSha256: binding.requestSha256,
    requesterId: binding.requesterId,
    recipientId: binding.recipientId,
    bodySha256: sha256Bytes(bytes),
    bodyBase64: Buffer.from(bytes).toString("base64"),
  });
}

/** The common frame's taskSha256 slot is the exact text-request digest, not a v2 TaskSpec claim. */
export function parseTextResponse(raw: string, binding: TextBinding, attemptId: string) {
  if (Buffer.byteLength(raw) > TEXT_BOUNDS.maxResponseBytes) invalid();
  const frame = parseResponseFrame(raw, {
    requestId: binding.requestId,
    taskSpecHash: binding.requestSha256,
    attemptId,
  });
  const body = parseStrictJsonBytes(Buffer.from(frame.markdown));
  if (!responseValidator(body)) invalid();
  const response = body as unknown as Record<string, unknown>;
  if (
    response.requestId !== binding.requestId ||
    response.requestSha256 !== binding.requestSha256 ||
    response.attemptId !== attemptId
  )
    invalid();
  return frame;
}
