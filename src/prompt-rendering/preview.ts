/** Offline preparation reuses TaskSpec v2 validation. Rendering the prepared snapshot is pure. */
import {
  loadTaskSpec,
  MAX_TASK_FILE_BYTES,
  sha256Bytes,
  verifyTaskFileBytes,
} from "../contracts/task.js";
import type { TaskSpec } from "../contracts/task-types.js";
import {
  decodeTaskBrief,
  exactObject,
  type MaterializedContext,
  strictUtf8,
  type TaskBrief,
  type TaskKind,
  type VerifiedContext,
  verifyContext,
} from "./brief.js";
import {
  CORE,
  type OfflinePromptProfile,
  type PreviewProfilePin,
  type PromptProfileRegistry,
  resolvePromptProfile,
} from "./profiles.js";

const KIND: Record<TaskKind, string> = {
  answer:
    "Answer the objective. Distinguish supporting evidence, assumptions and unverified points.",
  review:
    "Report supported findings in consequence order, with location, evidence, impact and a bounded remedy. Allow no findings. Review structure grants no edit authority.",
  change:
    "Summarize requested changes, resulting artifacts, checks actually run and reasons for checks not run. Change structure grants no additional path, command or network authority.",
};
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
interface PreparedData {
  task: TaskSpec;
  taskSpecSha256: string;
  profile: OfflinePromptProfile;
  brief: TaskBrief | null;
  legacy: string | null;
  context: VerifiedContext[];
}
export interface PreparedPromptPreview {
  readonly kind: "prepared-offline-prompt-preview-1";
}
const preparedData = new WeakMap<PreparedPromptPreview, PreparedData>();
export interface PreparePromptPreviewInput {
  rawTaskSpec: Uint8Array;
  taskFileBytes: Uint8Array;
  expectedTaskSpecSha256: string;
  routeId: string;
  registry: PromptProfileRegistry;
  profilePin: PreviewProfilePin;
  context: readonly MaterializedContext[];
}
/**
 * Calls the EXISTING TaskSpec validator (which lazily reads its local JSON schema).
 * No source materialization, approval, issue, attempt allocation, process or provider call.
 * Pins are consistency checks for an offline candidate, not authenticated policy extensions.
 */
export function prepareOfflinePromptPreview(
  input: PreparePromptPreviewInput,
): PreparedPromptPreview {
  exactObject(input, [
    "rawTaskSpec",
    "taskFileBytes",
    "expectedTaskSpecSha256",
    "routeId",
    "registry",
    "profilePin",
    "context",
  ]);
  if (
    !(input.rawTaskSpec instanceof Uint8Array) ||
    !(input.taskFileBytes instanceof Uint8Array) ||
    !/^[a-f0-9]{64}(?![\s\S])/.test(input.expectedTaskSpecSha256)
  )
    throw new Error("prompt_input_invalid");
  const parsed = loadTaskSpec(input.rawTaskSpec, input.expectedTaskSpecSha256);
  if (!parsed.valid) throw new Error("prompt_task_spec_invalid");
  if (input.taskFileBytes.byteLength > MAX_TASK_FILE_BYTES)
    throw new Error("prompt_task_file_too_large");
  const taskBytes = Uint8Array.from(input.taskFileBytes);
  if (!verifyTaskFileBytes(parsed.task, taskBytes).valid)
    throw new Error("prompt_task_file_mismatch");
  const profile = resolvePromptProfile(input.registry, input.profilePin);
  if (
    profile.agentId !== parsed.task.agent ||
    profile.modelId !== parsed.task.requested_model ||
    profile.routeId !== input.routeId ||
    input.profilePin.policySnapshotSha256 !== parsed.task.policy_snapshot_sha256
  )
    throw new Error("prompt_profile_binding_mismatch");
  const brief = profile.codec === "bridge-task-brief-1" ? decodeTaskBrief(taskBytes) : null;
  const context = verifyContext(brief?.context ?? [], input.context);
  // JSON/XML escaping expands each source UTF-8 byte by at most six.
  // Bound the aggregate before allocating the rendered strings, including section overhead.
  const upperBound =
    6 *
      (taskBytes.byteLength +
        parsed.rawBytes.byteLength +
        context.reduce((sum, row) => sum + row.manifest.sizeBytes, 0)) +
    65536;
  if (upperBound > MAX_PREVIEW_BYTES) throw new Error("prompt_preview_too_large");
  const data: PreparedData = {
    task: parsed.task,
    taskSpecSha256: parsed.taskSpecHash,
    profile,
    brief,
    legacy: brief ? null : strictUtf8(taskBytes, 1024 * 1024),
    context,
  };
  const handle = Object.freeze({ kind: "prepared-offline-prompt-preview-1" as const });
  preparedData.set(handle, data);
  return handle;
}
/** One-line escaped JSON data, including inside XML. Delimiters in data cannot add sections. */
function dataJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
function section(profile: OfflinePromptProfile, name: string, value: unknown): string {
  const data = dataJson(value);
  return profile.format === "xml-json-data"
    ? `<${name} encoding="json">\n${data}\n</${name}>\n`
    : `## ${name}\n${data}\n`;
}
export interface OfflinePromptPreview {
  schema: "bridge-offline-prompt-preview-1";
  status: "non-dispatch-preview";
  executionAuthorized: false;
  dispatchRenderer: "unchanged-legacy";
  policyProfileBinding: "unverified-offline-candidate";
  profile: OfflinePromptProfile;
  taskSpecSha256: string;
  taskFileSha256: string;
  policySnapshotSha256: string;
  taskKind: TaskKind | "legacy-verbatim";
  unresolved: readonly ["approval", "attempt", "session", "bootstrap", "output-contract"];
  stablePrefix: { text: string; sha256: string; sizeBytes: number };
  preview: {
    text: string;
    sha256: string;
    sizeBytes: number;
    digestScope: "preview-only-not-final-send";
  };
  context: readonly {
    id: string;
    revision: string;
    sha256: string;
    sizeBytes: number;
    placement: "stable" | "variable";
  }[];
  cache: {
    status: "unmeasured";
    controlsEnabled: false;
    savings: "unknown";
    quotaEffect: "unknown";
  };
}
/** Deterministic over the immutable prepared snapshot; no I/O, clock, entropy or model calls. */
export function renderPromptPreview(prepared: PreparedPromptPreview): OfflinePromptPreview {
  const input = preparedData.get(prepared);
  if (!input) throw new Error("prompt_prepared_snapshot_unknown");
  const { task, taskSpecSha256, profile, brief, context, legacy } = input;
  const renderContext = (placement: "stable" | "variable") =>
    context
      .filter((row) => row.manifest.placement === placement)
      .map((row) => section(profile, "input_data", { ...row.manifest, text: row.text }))
      .join("\n");
  const stableText = [
    CORE,
    section(profile, "profile", {
      renderer: profile.rendererVersion,
      id: profile.profileId,
      version: profile.version,
      provider: profile.provider,
      agent: profile.agentId,
      model: profile.modelId,
      route: profile.routeId,
      codec: profile.codec,
      guidance: profile.guidance,
    }),
    renderContext("stable"),
  ].join("\n");
  const binding = {
    previewOnly: true,
    requestId: task.request_id,
    taskSpecSha256,
    taskFileSha256: task.task_file_hash,
    policySnapshotSha256: task.policy_snapshot_sha256,
    profileSha256: profile.profileSha256,
    authorization: "not-verified",
    attempt: "unresolved",
    session: "unresolved",
    bootstrap: "unresolved",
    outputContract: "unresolved",
    declaredScope: {
      mode: task.mode,
      paths: task.allowed_paths,
      commands: task.allowed_commands,
      network: task.task_network,
    },
    successCriteria: task.success_criteria,
  };
  const objective = brief
    ? {
        objective: brief.objective,
        constraints: brief.constraints,
        deliverables: brief.deliverables,
        acceptance: brief.acceptance,
      }
    : { legacyVerbatimTask: legacy };
  const text = [
    stableText,
    brief
      ? section(profile, "task_kind", { kind: brief.taskKind, guidance: KIND[brief.taskKind] })
      : section(profile, "task_kind", {
          kind: "legacy-verbatim",
          guidance: "Use the original task text without inferring a task kind.",
        }),
    renderContext("variable"),
    section(profile, "unresolved_preview_binding", binding),
    section(profile, "task_and_acceptance", objective),
  ].join("\n");
  if (Buffer.byteLength(text) > MAX_PREVIEW_BYTES) throw new Error("prompt_preview_too_large");
  return {
    schema: "bridge-offline-prompt-preview-1",
    status: "non-dispatch-preview",
    executionAuthorized: false,
    dispatchRenderer: "unchanged-legacy",
    policyProfileBinding: "unverified-offline-candidate",
    profile,
    taskSpecSha256,
    taskFileSha256: task.task_file_hash,
    policySnapshotSha256: task.policy_snapshot_sha256,
    taskKind: brief?.taskKind ?? "legacy-verbatim",
    unresolved: ["approval", "attempt", "session", "bootstrap", "output-contract"],
    stablePrefix: {
      text: stableText,
      sha256: sha256Bytes(Buffer.from(stableText)),
      sizeBytes: Buffer.byteLength(stableText),
    },
    preview: {
      text,
      sha256: sha256Bytes(Buffer.from(text)),
      sizeBytes: Buffer.byteLength(text),
      digestScope: "preview-only-not-final-send",
    },
    context: context.map(({ manifest: row }) => ({
      id: row.id,
      revision: row.revision,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      placement: row.placement,
    })),
    cache: {
      status: "unmeasured",
      controlsEnabled: false,
      savings: "unknown",
      quotaEffect: "unknown",
    },
  };
}
