/** Recipient-owned V2 registration. Prompt/profile consistency is never detached approval. */
import { isDeepStrictEqual } from "node:util";
import { validateHostedExpectedOutputPolicy } from "../contracts/output-contract.js";
import { PROMPT_MAX_CHARS } from "../contracts/request.js";
import type { ResponseFrameIdentity } from "../contracts/response-frame.js";
import {
  loadTaskSpec,
  parseStrictJsonBytes,
  sha256Bytes,
  verifyTaskFileBytes,
} from "../contracts/task.js";
import type { TaskSpec } from "../contracts/task-types.js";
import { REQUESTED_PRESETS } from "../contracts/types.js";
import { decodeTaskBrief, exactObject } from "../prompt-rendering/brief.js";
import {
  hostedRendererIdentity,
  reverifyInstalledHostedRenderer,
  type VerifiedHostedRenderer,
} from "../prompt-rendering/hosted-registry.js";
import { renderBoundHostedPrompt } from "../prompt-rendering/hosted-renderer.js";
import type { BrowserDeliveryPolicy } from "./browser-delivery.js";

const HASH = /^[a-f0-9]{64}(?![\s\S])/;
const ACTOR = /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/;
export interface HostedPromptBinding {
  schema: "bridge-prompt-policy-1";
  rendererId: "bridge-hosted-prompt-1";
  rendererArtifactSha256: string;
  profileId: string;
  profileVersion: number;
  profileSha256: string;
  agentId: "chatgpt-browser";
  modelId: "gpt-5.6-sol" | "gpt-5.5";
  routeId: "ordinary_chat_browser";
  codec: "bridge-task-brief-1";
  contextMode: "none";
  outputParser: "response-frame-1+artifact-declaration-1";
  cacheControls: "none";
}
export interface BrowserDeliveryPolicyV2 {
  schema: "bridge-browser-delivery-policy-2";
  delivery: BrowserDeliveryPolicy & {
    expectedOutputPolicy: NonNullable<BrowserDeliveryPolicy["expectedOutputPolicy"]>;
  };
  prompt: HostedPromptBinding;
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function binding(value: unknown): HostedPromptBinding {
  const p = exactObject(value, [
    "schema",
    "rendererId",
    "rendererArtifactSha256",
    "profileId",
    "profileVersion",
    "profileSha256",
    "agentId",
    "modelId",
    "routeId",
    "codec",
    "contextMode",
    "outputParser",
    "cacheControls",
  ]);
  if (
    p.schema !== "bridge-prompt-policy-1" ||
    p.rendererId !== "bridge-hosted-prompt-1" ||
    !matches(p.rendererArtifactSha256, HASH) ||
    !matches(p.profileSha256, HASH) ||
    !matches(p.profileId, ID) ||
    !integer(p.profileVersion, 1, 2147483647) ||
    p.agentId !== "chatgpt-browser" ||
    (p.modelId !== "gpt-5.6-sol" && p.modelId !== "gpt-5.5") ||
    p.routeId !== "ordinary_chat_browser" ||
    p.codec !== "bridge-task-brief-1" ||
    p.contextMode !== "none" ||
    p.outputParser !== "response-frame-1+artifact-declaration-1" ||
    p.cacheControls !== "none"
  )
    throw new Error("hosted_prompt_policy_invalid");
  return {
    schema: "bridge-prompt-policy-1",
    rendererId: "bridge-hosted-prompt-1",
    rendererArtifactSha256: p.rendererArtifactSha256,
    profileId: p.profileId,
    profileVersion: p.profileVersion,
    profileSha256: p.profileSha256,
    agentId: "chatgpt-browser",
    modelId: p.modelId,
    routeId: "ordinary_chat_browser",
    codec: "bridge-task-brief-1",
    contextMode: "none",
    outputParser: "response-frame-1+artifact-declaration-1",
    cacheControls: "none",
  };
}
function canonicalPolicy(value: unknown): BrowserDeliveryPolicyV2 {
  const root = exactObject(value, ["schema", "delivery", "prompt"]);
  if (root.schema !== "bridge-browser-delivery-policy-2")
    throw new Error("hosted_prompt_policy_invalid");
  const d = exactObject(root.delivery, [
      "recipientId",
      "requesterIds",
      "conversationUrl",
      "model",
      "preset",
      "maxStarts",
      "deadlineAt",
      "maxResponseBytes",
      "expectedOutputPolicy",
    ]),
    p = binding(root.prompt);
  if (
    !matches(d.recipientId, ACTOR) ||
    !Array.isArray(d.requesterIds) ||
    d.requesterIds.length < 1 ||
    d.requesterIds.length > 128 ||
    d.requesterIds.some((x) => !matches(x, ACTOR)) ||
    new Set(d.requesterIds).size !== d.requesterIds.length ||
    typeof d.conversationUrl !== "string" ||
    d.conversationUrl.length > 256 ||
    d.model !== p.modelId ||
    typeof d.preset !== "string" ||
    !REQUESTED_PRESETS.includes(d.preset as BrowserDeliveryPolicy["preset"]) ||
    !integer(d.maxStarts, 1, 100) ||
    typeof d.deadlineAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(d.deadlineAt) ||
    !Number.isFinite(Date.parse(d.deadlineAt)) ||
    !integer(d.maxResponseBytes, 1, 1048576)
  )
    throw new Error("hosted_prompt_policy_invalid");
  if (
    new Date(d.deadlineAt).toISOString().replace(/\.000Z$/, "Z") !==
    d.deadlineAt.replace(/\.000Z$/, "Z")
  )
    throw new Error("hosted_prompt_policy_invalid");
  const url = new URL(d.conversationUrl);
  if (
    url.origin !== "https://chatgpt.com" ||
    !/^\/c\/[a-zA-Z0-9-]+$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.toString() !== d.conversationUrl
  )
    throw new Error("hosted_prompt_policy_invalid");
  const o = validateHostedExpectedOutputPolicy(d.expectedOutputPolicy);
  if (
    o.recipientActorId !== d.recipientId ||
    !d.requesterIds.includes(o.requesterActorId) ||
    o.destination.conversationId !== url.pathname.split("/").at(-1)
  )
    throw new Error("hosted_prompt_policy_invalid");
  const expectedOutputPolicy = {
    route: o.route,
    requesterActorId: o.requesterActorId,
    recipientActorId: o.recipientActorId,
    projectId: o.projectId,
    repoId: o.repoId,
    storageSlug: o.storageSlug,
    destination: {
      repositoryFullName: o.destination.repositoryFullName,
      branch: o.destination.branch,
      namespace: o.destination.namespace,
      conversationId: o.destination.conversationId,
    },
    mode: o.mode,
    requiredOutputs: o.requiredOutputs.map((x) => ({
      logicalName: x.logicalName,
      mediaType: x.mediaType,
      maxBytes: x.maxBytes,
    })),
    allowAdditionalArtifacts: o.allowAdditionalArtifacts,
    maxArtifacts: o.maxArtifacts,
    maxTotalBytes: o.maxTotalBytes,
  };
  return {
    schema: "bridge-browser-delivery-policy-2",
    delivery: {
      recipientId: d.recipientId,
      requesterIds: d.requesterIds as string[],
      conversationUrl: d.conversationUrl,
      model: p.modelId,
      preset: d.preset as BrowserDeliveryPolicy["preset"],
      maxStarts: d.maxStarts,
      deadlineAt: d.deadlineAt,
      maxResponseBytes: d.maxResponseBytes,
      expectedOutputPolicy,
    },
    prompt: p,
  };
}
export function encodeBrowserDeliveryPolicyV2(value: unknown): Uint8Array {
  const raw = Buffer.from(`${JSON.stringify(canonicalPolicy(value))}\n`);
  if (raw.length > 128 * 1024) throw new Error("hosted_prompt_policy_too_large");
  return raw;
}
export function parseBrowserDeliveryPolicyV2(raw: Uint8Array): BrowserDeliveryPolicyV2 {
  if (raw.byteLength > 128 * 1024) throw new Error("hosted_prompt_policy_too_large");
  const value = canonicalPolicy(parseStrictJsonBytes(raw));
  if (!Buffer.from(encodeBrowserDeliveryPolicyV2(value)).equals(raw))
    throw new Error("hosted_prompt_policy_noncanonical");
  return value;
}
export interface RegisteredHostedPromptPolicy {
  readonly kind: "registered-hosted-prompt-policy-1";
}
interface Registration {
  policy: BrowserDeliveryPolicyV2;
  policySha256: string;
  renderer: VerifiedHostedRenderer;
}
const registrations = new WeakMap<RegisteredHostedPromptPolicy, Registration>();
export function registerHostedPromptPolicy(
  raw: Uint8Array,
  renderer: VerifiedHostedRenderer,
): RegisteredHostedPromptPolicy {
  const policy = parseBrowserDeliveryPolicyV2(raw),
    policySha256 = sha256Bytes(raw),
    identity = hostedRendererIdentity(renderer);
  if (
    identity.policySnapshotSha256 !== policySha256 ||
    identity.profileId !== policy.prompt.profileId ||
    identity.profileVersion !== policy.prompt.profileVersion ||
    identity.profileSha256 !== policy.prompt.profileSha256 ||
    identity.rendererArtifactSha256 !== policy.prompt.rendererArtifactSha256 ||
    identity.modelId !== policy.prompt.modelId ||
    identity.agentId !== policy.prompt.agentId ||
    identity.routeId !== policy.prompt.routeId ||
    identity.codec !== policy.prompt.codec
  )
    throw new Error("hosted_prompt_registration_mismatch");
  const handle = Object.freeze({ kind: "registered-hosted-prompt-policy-1" as const });
  registrations.set(handle, { policy, policySha256, renderer });
  return handle;
}
export function isRegisteredHostedPromptPolicy(
  value: unknown,
): value is RegisteredHostedPromptPolicy {
  return (
    typeof value === "object" &&
    value !== null &&
    registrations.has(value as RegisteredHostedPromptPolicy)
  );
}
export function hostedPromptPolicyDetails(handle: RegisteredHostedPromptPolicy) {
  const value = registrations.get(handle);
  if (!value) throw new Error("hosted_prompt_registration_unknown");
  hostedRendererIdentity(value.renderer);
  return { ...value, policy: structuredClone(value.policy) };
}
/** Revalidate the active opaque registration and installed assets at a future-use boundary. */
export function reverifyHostedPromptPolicy(handle: RegisteredHostedPromptPolicy): void {
  reverifyInstalledHostedRenderer(hostedPromptPolicyDetails(handle).renderer);
}
export function validateHostedPromptTask(
  handle: RegisteredHostedPromptPolicy,
  raw: Uint8Array,
  taskBytes: Uint8Array,
): TaskSpec {
  reverifyInstalledHostedRenderer(hostedPromptPolicyDetails(handle).renderer);
  const registration = hostedPromptPolicyDetails(handle),
    loaded = loadTaskSpec(raw);
  if (
    !loaded.valid ||
    !verifyTaskFileBytes(loaded.task, taskBytes).valid ||
    loaded.task.policy_snapshot_sha256 !== registration.policySha256 ||
    loaded.task.agent !== "chatgpt-browser" ||
    loaded.task.requested_model !== registration.policy.prompt.modelId ||
    loaded.task.mode !== "read_only" ||
    loaded.task.allowed_commands.length !== 0
  )
    throw new Error("hosted_prompt_task_mismatch");
  if (decodeTaskBrief(taskBytes).context.length !== 0)
    throw new Error("hosted_prompt_context_denied");
  return loaded.task;
}
export interface HostedPromptReceipt {
  schema: "bridge-hosted-prompt-receipt-1";
  requestId: string;
  attemptId: string;
  taskSpecSha256: string;
  taskFileSha256: string;
  policySnapshotSha256: string;
  rendererId: "bridge-hosted-prompt-1";
  rendererArtifactSha256: string;
  profileId: string;
  profileVersion: number;
  profileSha256: string;
  routeId: "ordinary_chat_browser";
  modelId: "gpt-5.6-sol" | "gpt-5.5";
  codec: "bridge-task-brief-1";
  contextMode: "none";
  outputParser: "response-frame-1+artifact-declaration-1";
  outputContractSha256: string;
  session: null;
  bootstrap: null;
  stablePrefixSha256: string;
  stablePrefixSizeBytes: number;
  promptSha256: string;
  promptSizeBytes: number;
}
const RECEIPT_KEYS = [
  "schema",
  "requestId",
  "attemptId",
  "taskSpecSha256",
  "taskFileSha256",
  "policySnapshotSha256",
  "rendererId",
  "rendererArtifactSha256",
  "profileId",
  "profileVersion",
  "profileSha256",
  "routeId",
  "modelId",
  "codec",
  "contextMode",
  "outputParser",
  "outputContractSha256",
  "session",
  "bootstrap",
  "stablePrefixSha256",
  "stablePrefixSizeBytes",
  "promptSha256",
  "promptSizeBytes",
] as const;
export function parseHostedPromptReceipt(raw: Uint8Array): HostedPromptReceipt {
  if (raw.byteLength > 8192) throw new Error("hosted_prompt_receipt_invalid");
  const v = exactObject(parseStrictJsonBytes(raw), RECEIPT_KEYS);
  if (
    v.schema !== "bridge-hosted-prompt-receipt-1" ||
    !matches(v.requestId, UUID) ||
    !matches(v.attemptId, UUID) ||
    !matches(v.profileId, ID) ||
    !integer(v.profileVersion, 1, 2147483647) ||
    v.rendererId !== "bridge-hosted-prompt-1" ||
    v.routeId !== "ordinary_chat_browser" ||
    (v.modelId !== "gpt-5.6-sol" && v.modelId !== "gpt-5.5") ||
    v.codec !== "bridge-task-brief-1" ||
    v.contextMode !== "none" ||
    v.outputParser !== "response-frame-1+artifact-declaration-1" ||
    v.session !== null ||
    v.bootstrap !== null ||
    !integer(v.stablePrefixSizeBytes, 0, 1048576) ||
    !integer(v.promptSizeBytes, 1, 1048576) ||
    v.stablePrefixSizeBytes > v.promptSizeBytes ||
    [
      "taskSpecSha256",
      "taskFileSha256",
      "policySnapshotSha256",
      "rendererArtifactSha256",
      "profileSha256",
      "outputContractSha256",
      "stablePrefixSha256",
      "promptSha256",
    ].some((k) => !matches(v[k], HASH))
  )
    throw new Error("hosted_prompt_receipt_invalid");
  const ordered = Object.fromEntries(RECEIPT_KEYS.map((key) => [key, v[key]]));
  if (!Buffer.from(`${JSON.stringify(ordered)}\n`).equals(raw))
    throw new Error("hosted_prompt_receipt_noncanonical");
  return ordered as unknown as HostedPromptReceipt;
}
export function createHostedPromptReceipt(
  handle: RegisteredHostedPromptPolicy,
  rawTaskSpec: Uint8Array,
  taskFileBytes: Uint8Array,
  frame: ResponseFrameIdentity,
  outputContractRaw: Uint8Array,
) {
  validateHostedPromptTask(handle, rawTaskSpec, taskFileBytes);
  const r = hostedPromptPolicyDetails(handle),
    p = r.policy.prompt;
  const rendered = renderBoundHostedPrompt({
    renderer: r.renderer,
    rawTaskSpec,
    taskFileBytes,
    frame,
    outputContractRaw,
    policySnapshotSha256: r.policySha256,
  });
  if (Buffer.from(rendered.promptBytes).toString("utf8").length > PROMPT_MAX_CHARS)
    throw new Error("hosted_prompt_composer_limit");
  const receipt: HostedPromptReceipt = {
    schema: "bridge-hosted-prompt-receipt-1",
    requestId: frame.requestId,
    attemptId: frame.attemptId,
    taskSpecSha256: sha256Bytes(rawTaskSpec),
    taskFileSha256: sha256Bytes(taskFileBytes),
    policySnapshotSha256: r.policySha256,
    rendererId: "bridge-hosted-prompt-1",
    rendererArtifactSha256: p.rendererArtifactSha256,
    profileId: p.profileId,
    profileVersion: p.profileVersion,
    profileSha256: p.profileSha256,
    routeId: "ordinary_chat_browser",
    modelId: p.modelId,
    codec: "bridge-task-brief-1",
    contextMode: "none",
    outputParser: "response-frame-1+artifact-declaration-1",
    outputContractSha256: sha256Bytes(outputContractRaw),
    session: null,
    bootstrap: null,
    stablePrefixSha256: sha256Bytes(rendered.stablePrefixBytes),
    stablePrefixSizeBytes: rendered.stablePrefixBytes.length,
    promptSha256: sha256Bytes(rendered.promptBytes),
    promptSizeBytes: rendered.promptBytes.length,
  };
  const receiptRaw = Buffer.from(`${JSON.stringify(receipt)}\n`);
  parseHostedPromptReceipt(receiptRaw);
  return { receipt, receiptRaw, promptBytes: rendered.promptBytes };
}
/** Exact historical policy lookup. Absence is unsupported, never a legacy/default fallback. */
export class HostedPromptPolicyRegistry {
  private readonly rows = new Map<string, RegisteredHostedPromptPolicy>();
  add(handle: RegisteredHostedPromptPolicy): void {
    const row = hostedPromptPolicyDetails(handle);
    const old = this.rows.get(row.policySha256);
    if (
      old &&
      old !== handle &&
      !isDeepStrictEqual(hostedPromptPolicyDetails(old).policy, row.policy)
    )
      throw new Error("hosted_prompt_registry_conflict");
    this.rows.set(row.policySha256, handle);
  }
  get(hash: string): RegisteredHostedPromptPolicy | null {
    const handle = this.rows.get(hash);
    if (!handle) return null;
    reverifyInstalledHostedRenderer(hostedPromptPolicyDetails(handle).renderer);
    return handle;
  }
}

/** Explicit deployment adapter shared by issuer/composer. Unknown V2 history never means legacy. */
export function createHostedPromptFormatLookup(
  registry: HostedPromptPolicyRegistry,
  legacyPolicyHashes: readonly string[] = [],
) {
  if (
    legacyPolicyHashes.some((hash) => !matches(hash, HASH)) ||
    new Set(legacyPolicyHashes).size !== legacyPolicyHashes.length
  )
    throw new Error("hosted_prompt_legacy_registry_invalid");
  const legacy = new Set(legacyPolicyHashes);
  return (
    destination: import("../contracts/operations.js").RegisteredOperationDestination,
    modelId: string,
  ): VerifiedHostedRenderer | null => {
    const registered = registry.get(destination.policyHash);
    if (!registered) {
      if (legacy.has(destination.policyHash)) return null;
      throw new Error("hosted_prompt_registration_unavailable");
    }
    const row = hostedPromptPolicyDetails(registered);
    if (
      destination.route !== row.policy.prompt.routeId ||
      destination.providerId !== row.policy.prompt.agentId ||
      modelId !== row.policy.prompt.modelId ||
      !destination.modelIds.includes(modelId)
    )
      throw new Error("hosted_prompt_destination_mismatch");
    return row.renderer;
  };
}
