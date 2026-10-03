/** Strict recipient-installed production profile, distinct from offline previews. */
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/raw-bytes.js";
import { exactObject } from "./brief.js";
import {
  HOSTED_CORE,
  HOSTED_GUIDANCE,
  HOSTED_OUTPUT_GRAMMAR,
  HOSTED_TASK_KINDS,
} from "./production-constants.js";

export const MAX_PRODUCTION_PROFILE_BYTES = 16 * 1024;
export const HOSTED_RENDERER_ID = "bridge-hosted-prompt-1";
export const HOSTED_RENDERER_VERSION = 1;
export type HostedModelId = "gpt-5.6-sol" | "gpt-5.5";
export interface ProductionPromptProfile {
  schema: "bridge-production-prompt-profile-1";
  profileId: string;
  profileVersion: number;
  rendererId: typeof HOSTED_RENDERER_ID;
  rendererVersion: 1;
  providerId: "openai";
  agentId: "chatgpt-browser";
  modelId: HostedModelId;
  routeId: "ordinary_chat_browser";
  codec: "bridge-task-brief-1";
  format: "markdown-json-data-1";
  core: { id: "bridge-hosted-core-1"; contentSha256: string };
  guidance: { id: "openai-concise-evidence-1"; contentSha256: string };
  taskKinds: {
    answer: { id: "bridge-answer-1"; contentSha256: string };
    review: { id: "bridge-review-1"; contentSha256: string };
    change: { id: "bridge-change-1"; contentSha256: string };
  };
  outputGrammar: {
    id: "bridge-hosted-output-grammar-1";
    staticInstructionsSha256: string;
    parser: "response-frame-1+artifact-declaration-1";
  };
  contextMode: "none";
  cacheControls: "none";
  evidence: {
    guidanceUrl: "https://developers.openai.com/api/docs/guides/reasoning-best-practices";
    checkedAt: "2026-10-03";
  };
}
export const HOSTED_SHA256 = /^[a-f0-9]{64}(?![\s\S])/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/;
const digest = (text: string) => sha256Bytes(Buffer.from(text, "utf8"));
/** Recursively freeze only parsed JSON objects, which contain no buffer views. */
export function freezeHostedJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeHostedJson(child);
    Object.freeze(value);
  }
  return value;
}
/** Build-time/administrator convenience. This describes formatting and grants no authority. */
export function createProductionPromptProfile(input: {
  profileId: string;
  profileVersion: number;
  modelId: HostedModelId;
}): ProductionPromptProfile {
  exactObject(input, ["profileId", "profileVersion", "modelId"]);
  if (
    typeof input.profileId !== "string" ||
    !ID.test(input.profileId) ||
    !Number.isSafeInteger(input.profileVersion) ||
    input.profileVersion < 1 ||
    input.profileVersion > 2147483647 ||
    (input.modelId !== "gpt-5.6-sol" && input.modelId !== "gpt-5.5")
  )
    throw new Error("hosted_profile_invalid");
  const constants = [
    HOSTED_CORE,
    HOSTED_GUIDANCE,
    ...Object.values(HOSTED_TASK_KINDS),
    HOSTED_OUTPUT_GRAMMAR,
  ];
  if (
    constants.some((value) => Buffer.byteLength(value) > 8192) ||
    constants.reduce((size, value) => size + Buffer.byteLength(value), 0) > 32768
  )
    throw new Error("hosted_profile_constants_too_large");
  return freezeHostedJson({
    schema: "bridge-production-prompt-profile-1",
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    rendererId: HOSTED_RENDERER_ID,
    rendererVersion: HOSTED_RENDERER_VERSION,
    providerId: "openai",
    agentId: "chatgpt-browser",
    modelId: input.modelId,
    routeId: "ordinary_chat_browser",
    codec: "bridge-task-brief-1",
    format: "markdown-json-data-1",
    core: { id: "bridge-hosted-core-1", contentSha256: digest(HOSTED_CORE) },
    guidance: { id: "openai-concise-evidence-1", contentSha256: digest(HOSTED_GUIDANCE) },
    taskKinds: {
      answer: { id: "bridge-answer-1", contentSha256: digest(HOSTED_TASK_KINDS.answer) },
      review: { id: "bridge-review-1", contentSha256: digest(HOSTED_TASK_KINDS.review) },
      change: { id: "bridge-change-1", contentSha256: digest(HOSTED_TASK_KINDS.change) },
    },
    outputGrammar: {
      id: "bridge-hosted-output-grammar-1",
      staticInstructionsSha256: digest(HOSTED_OUTPUT_GRAMMAR),
      parser: "response-frame-1+artifact-declaration-1",
    },
    contextMode: "none",
    cacheControls: "none",
    evidence: {
      guidanceUrl: "https://developers.openai.com/api/docs/guides/reasoning-best-practices",
      checkedAt: "2026-10-03",
    },
  });
}
/** Validate every fixed content reference as well as grammar. No arbitrary lookup or URL read. */
export function parseProductionPromptProfile(raw: Uint8Array): ProductionPromptProfile {
  if (
    !(raw instanceof Uint8Array) ||
    raw.byteLength === 0 ||
    raw.byteLength > MAX_PRODUCTION_PROFILE_BYTES
  )
    throw new Error("hosted_profile_size_invalid");
  const parsed = parseStrictJsonBytes(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("hosted_profile_invalid");
  const value = parsed as ProductionPromptProfile;
  const expected = createProductionPromptProfile({
    profileId: value.profileId,
    profileVersion: value.profileVersion,
    modelId: value.modelId,
  });
  // Exact canonical comparison rejects every missing/extra/reordered member, noncanonical
  // string/number, unknown literal, NUL, BOM, surrogate, changed constant and trailing byte.
  if (!Buffer.from(raw).equals(Buffer.from(`${JSON.stringify(expected)}\n`)))
    throw new Error("hosted_profile_noncanonical_or_mismatch");
  return expected;
}
export function encodeProductionPromptProfile(profile: ProductionPromptProfile): Uint8Array {
  const raw = Buffer.from(`${JSON.stringify(profile)}\n`);
  parseProductionPromptProfile(raw);
  return raw;
}
/** Fixed constant catalog included in the installed build, never read from task-selected paths. */
export function productionConstantManifestBytes(): Uint8Array {
  return Buffer.from(
    `${JSON.stringify(
      [
        { id: "bridge-hosted-core-1", text: HOSTED_CORE },
        { id: "openai-concise-evidence-1", text: HOSTED_GUIDANCE },
        { id: "bridge-answer-1", text: HOSTED_TASK_KINDS.answer },
        { id: "bridge-review-1", text: HOSTED_TASK_KINDS.review },
        { id: "bridge-change-1", text: HOSTED_TASK_KINDS.change },
        { id: "bridge-hosted-output-grammar-1", text: HOSTED_OUTPUT_GRAMMAR },
      ].map(({ id, text }) => ({
        id,
        contentSha256: digest(text),
        sizeBytes: Buffer.byteLength(text),
      })),
    )}\n`,
  );
}
