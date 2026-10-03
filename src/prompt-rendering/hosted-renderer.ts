/** Deterministic production formatting. Existing host admission and output-policy checks own authority. */

import { MAX_OUTPUT_CONTRACT_BYTES, parseOutputContractV1 } from "../contracts/output-contract.js";
import { checkedOutputContractInstructions } from "../contracts/output-contract-prompt.js";
import {
  MAX_TASK_FILE_BYTES,
  MAX_TASK_SPEC_BYTES,
  parseStrictJsonBytes,
  sha256Bytes,
} from "../contracts/raw-bytes.js";
import {
  type ResponseFrameIdentity,
  responseFrameInstructions,
} from "../contracts/response-frame.js";
import type { TaskSpec } from "../contracts/task-types.js";
import { decodeTaskBrief, exactObject, type TaskBrief, type TaskKind } from "./brief.js";
import {
  type HostedRendererIdentity,
  hostedRendererIdentity,
  type VerifiedHostedRenderer,
} from "./hosted-registry.js";
import {
  HOSTED_CORE,
  HOSTED_GUIDANCE,
  HOSTED_OUTPUT_GRAMMAR,
  HOSTED_TASK_KINDS,
} from "./production-constants.js";
import { HOSTED_SHA256 } from "./production-profile.js";

export const MAX_HOSTED_PROMPT_BYTES = 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
export interface HostedPromptInput {
  renderer: VerifiedHostedRenderer;
  rawTaskSpec: Uint8Array;
  taskFileBytes: Uint8Array;
  policySnapshotSha256: string;
}
interface BoundInput {
  identity: HostedRendererIdentity;
  task: TaskSpec;
  taskSpecSha256: string;
  taskBytes: Uint8Array;
  brief: TaskBrief;
}
function boundTask(input: HostedPromptInput): BoundInput {
  const identity = hostedRendererIdentity(input.renderer);
  if (
    !(input.rawTaskSpec instanceof Uint8Array) ||
    input.rawTaskSpec.byteLength > MAX_TASK_SPEC_BYTES ||
    !(input.taskFileBytes instanceof Uint8Array) ||
    input.taskFileBytes.byteLength > MAX_TASK_FILE_BYTES
  )
    throw new Error("hosted_prompt_input_size_invalid");
  const specBytes = Uint8Array.from(input.rawTaskSpec),
    taskBytes = Uint8Array.from(input.taskFileBytes);
  const value = parseStrictJsonBytes(specBytes);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("hosted_task_invalid");
  const task = value as TaskSpec;
  // Full existing TaskSpec schema/authority validation is performed by the host. This pure
  // closure independently binds the exact raw bytes and all fields used by this renderer.
  if (
    task.protocol_version !== "2.0" ||
    typeof task.request_id !== "string" ||
    !UUID.test(task.request_id) ||
    task.agent !== identity.agentId ||
    task.requested_model !== identity.modelId ||
    typeof task.task_file_hash !== "string" ||
    !HOSTED_SHA256.test(task.task_file_hash) ||
    task.task_file_hash !== sha256Bytes(taskBytes) ||
    input.policySnapshotSha256 !== identity.policySnapshotSha256 ||
    task.policy_snapshot_sha256 !== identity.policySnapshotSha256
  )
    throw new Error("hosted_prompt_binding_mismatch");
  const brief = decodeTaskBrief(taskBytes);
  if (brief.context.length !== 0) throw new Error("hosted_context_forbidden");
  return { identity, task, taskSpecSha256: sha256Bytes(specBytes), taskBytes, brief };
}
/** One-line escaped JSON data prevents objective text from introducing Markdown sections. */
function dataJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
function section(name: string, value: unknown): string {
  return `## ${name}\n${dataJson(value)}\n`;
}
function stablePrefix(identity: HostedRendererIdentity): string {
  return (
    `# Bridge hosted task\n\n## Core\n${HOSTED_CORE}\n\n## Output grammar\n${HOSTED_OUTPUT_GRAMMAR}\n\n` +
    section("Provider profile", {
      profileId: identity.profileId,
      profileVersion: identity.profileVersion,
      providerId: identity.profile.providerId,
      agentId: identity.agentId,
      modelId: identity.modelId,
      routeId: identity.routeId,
      codec: identity.codec,
      format: identity.profile.format,
      contextMode: "none",
      cacheControls: "none",
    }) +
    `\n## Provider guidance\n${HOSTED_GUIDANCE}\n\n`
  );
}
function kindSection(brief: TaskBrief): string {
  return section("Task kind", {
    taskKind: brief.taskKind,
    instructions: HOSTED_TASK_KINDS[brief.taskKind],
  });
}
function taskSections(brief: TaskBrief): string {
  return (
    section("Objective", brief.objective) +
    section("Constraints", brief.constraints) +
    section("Deliverables", brief.deliverables) +
    section("Acceptance", brief.acceptance)
  );
}
function boundedPrompt(text: string): Uint8Array {
  if (Buffer.byteLength(text) > MAX_HOSTED_PROMPT_BYTES) throw new Error("hosted_prompt_too_large");
  return Buffer.from(text, "utf8");
}
export interface RenderBoundHostedPromptInput extends HostedPromptInput {
  frame: ResponseFrameIdentity;
  /** Exact independently authenticated contract body, never a responder-supplied sidecar. */
  outputContractRaw: Uint8Array;
}
export interface HostedPromptBindings {
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
export interface BoundHostedPrompt {
  promptBytes: Uint8Array;
  stablePrefixBytes: Uint8Array;
  bindings: Readonly<HostedPromptBindings>;
}
/** No I/O, clock, entropy, network, bootstrap or model calls. */
export function renderBoundHostedPrompt(input: RenderBoundHostedPromptInput): BoundHostedPrompt {
  exactObject(input, [
    "renderer",
    "rawTaskSpec",
    "taskFileBytes",
    "frame",
    "outputContractRaw",
    "policySnapshotSha256",
  ]);
  const { identity, task, taskSpecSha256, taskBytes, brief } = boundTask(input);
  exactObject(input.frame, ["requestId", "taskSpecHash", "attemptId"]);
  const frame = { ...input.frame };
  if (
    frame.requestId !== task.request_id ||
    frame.taskSpecHash !== taskSpecSha256 ||
    typeof frame.attemptId !== "string" ||
    !UUID.test(frame.attemptId)
  )
    throw new Error("hosted_frame_binding_mismatch");
  if (
    !(input.outputContractRaw instanceof Uint8Array) ||
    input.outputContractRaw.byteLength > MAX_OUTPUT_CONTRACT_BYTES
  )
    throw new Error("hosted_output_contract_invalid");
  const contractRaw = Uint8Array.from(input.outputContractRaw);
  const contract = parseOutputContractV1(contractRaw);
  if (
    contract.policySnapshotSha256 !== identity.policySnapshotSha256 ||
    contract.route !== "hosted_delivery"
  )
    throw new Error("hosted_output_contract_binding_mismatch");
  // Both factories use the same exact boundary and declaration helpers. In particular,
  // this validator receives original task bytes, never the rendered Markdown body.
  const outputInstructions = checkedOutputContractInstructions(taskBytes, frame, contractRaw);
  const prefix = stablePrefix(identity),
    stablePrefixBytes = Buffer.from(prefix, "utf8");
  const promptBytes = boundedPrompt(
    `${prefix}${kindSection(brief)}\n## Request output binding\n${responseFrameInstructions(frame)}\n\n${outputInstructions}\n\n${taskSections(brief)}`,
  );
  return {
    promptBytes,
    stablePrefixBytes,
    bindings: Object.freeze({
      requestId: task.request_id,
      attemptId: frame.attemptId,
      taskSpecSha256,
      taskFileSha256: task.task_file_hash,
      policySnapshotSha256: identity.policySnapshotSha256,
      rendererId: identity.rendererId,
      rendererArtifactSha256: identity.rendererArtifactSha256,
      profileId: identity.profileId,
      profileVersion: identity.profileVersion,
      profileSha256: identity.profileSha256,
      routeId: identity.routeId,
      modelId: identity.modelId,
      codec: identity.codec,
      contextMode: identity.contextMode,
      outputParser: identity.outputParser,
      outputContractSha256: sha256Bytes(contractRaw),
      session: null,
      bootstrap: null,
      stablePrefixSha256: sha256Bytes(stablePrefixBytes),
      stablePrefixSizeBytes: stablePrefixBytes.byteLength,
      promptSha256: sha256Bytes(promptBytes),
      promptSizeBytes: promptBytes.byteLength,
    }),
  };
}
export function renderHostedPrompt(
  renderer: VerifiedHostedRenderer,
  input: Omit<RenderBoundHostedPromptInput, "renderer" | "policySnapshotSha256">,
): BoundHostedPrompt {
  return renderBoundHostedPrompt({
    ...input,
    renderer,
    policySnapshotSha256: hostedRendererIdentity(renderer).policySnapshotSha256,
  });
}
export interface HostedPromptPreview {
  schema: "bridge-hosted-prompt-preview-1";
  status: "non-dispatch-preview";
  executionAuthorized: false;
  taskSpecSha256: string;
  taskFileSha256: string;
  policySnapshotSha256: string;
  taskKind: TaskKind;
  unresolved: readonly ["approval", "attempt", "output-contract"];
  session: null;
  bootstrap: null;
  stablePrefix: { text: string; sha256: string; sizeBytes: number };
  preview: {
    text: string;
    sha256: string;
    sizeBytes: number;
    digestScope: "preview-only-not-final-send";
  };
}
/** Read-only exact prepared task preview. It invents neither an attempt nor a contract. */
export function prepareHostedPromptPreview(input: HostedPromptInput): HostedPromptPreview {
  exactObject(input, ["renderer", "rawTaskSpec", "taskFileBytes", "policySnapshotSha256"]);
  const { identity, task, taskSpecSha256, brief } = boundTask(input);
  const prefix = stablePrefix(identity),
    prefixBytes = Buffer.from(prefix);
  const text = `${prefix}${kindSection(brief)}\n## Preview status\nApproval, attempt and authenticated output contract are unresolved. This preview cannot be dispatched.\n\n${taskSections(brief)}`;
  const bytes = boundedPrompt(text);
  return {
    schema: "bridge-hosted-prompt-preview-1",
    status: "non-dispatch-preview",
    executionAuthorized: false,
    taskSpecSha256,
    taskFileSha256: task.task_file_hash,
    policySnapshotSha256: identity.policySnapshotSha256,
    taskKind: brief.taskKind,
    unresolved: ["approval", "attempt", "output-contract"],
    session: null,
    bootstrap: null,
    stablePrefix: {
      text: prefix,
      sha256: sha256Bytes(prefixBytes),
      sizeBytes: prefixBytes.byteLength,
    },
    preview: {
      text,
      sha256: sha256Bytes(bytes),
      sizeBytes: bytes.byteLength,
      digestScope: "preview-only-not-final-send",
    },
  };
}
