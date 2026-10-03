/** Read-only projection of a host-verified renderer. No profile selection or execution grant. */
import type { RegisteredOperationDestination } from "../contracts/operations.js";
import { sha256Bytes } from "../contracts/task.js";
import { UiError } from "../contracts/ui.js";
import {
  hostedRendererIdentity,
  type VerifiedHostedRenderer,
} from "../prompt-rendering/hosted-registry.js";

export type ComposerPromptFormatResolver = (
  destination: RegisteredOperationDestination,
  modelId: string,
) => VerifiedHostedRenderer | null;
export type ComposerPromptFormat =
  | {
      schema: "bridge-issuer-prompt-format-1";
      readiness: "legacy";
      codec: "legacy-verbatim";
      dispatchRenderer: "unchanged-legacy";
    }
  | {
      schema: "bridge-issuer-prompt-format-1";
      readiness: "registered-pre-approval";
      status: "non-dispatch-preview";
      executionAuthorized: false;
      rendererId: "bridge-hosted-prompt-1";
      rendererArtifactSha256: string;
      profileId: string;
      profileVersion: number;
      profileSha256: string;
      policySnapshotSha256: string;
      providerId: "openai";
      agentId: "chatgpt-browser";
      routeId: "ordinary_chat_browser";
      modelId: "gpt-5.6-sol" | "gpt-5.5";
      codec: "bridge-task-brief-1";
      contextMode: "none";
      taskKinds: readonly ["answer", "review", "change"];
      unresolved: readonly ["approval", "attempt", "output-contract"];
      session: null;
      bootstrap: null;
    };
export function readComposerPromptFormat(
  resolver: ComposerPromptFormatResolver | undefined,
  destination: RegisteredOperationDestination,
  modelId: string,
): {
  renderer: VerifiedHostedRenderer | null;
  metadata: ComposerPromptFormat;
  fingerprint: string;
} {
  let renderer: VerifiedHostedRenderer | null;
  let identity: ReturnType<typeof hostedRendererIdentity> | null;
  try {
    renderer = resolver === undefined ? null : resolver(structuredClone(destination), modelId);
    identity = renderer === null ? null : hostedRendererIdentity(renderer);
  } catch {
    throw new UiError(
      "composer_prompt_format_unavailable",
      "Registered prompt format is unavailable; refresh before preparing or issuing a draft",
      409,
    );
  }
  let metadata: ComposerPromptFormat;
  if (!identity) {
    metadata = {
      schema: "bridge-issuer-prompt-format-1",
      readiness: "legacy",
      codec: "legacy-verbatim",
      dispatchRenderer: "unchanged-legacy",
    };
  } else {
    const profile = identity.profile;
    if (
      identity.policySnapshotSha256 !== destination.policyHash ||
      profile.agentId !== destination.providerId ||
      profile.modelId !== modelId ||
      profile.routeId !== destination.route ||
      !destination.modelIds.includes(modelId)
    )
      throw new UiError(
        "composer_prompt_format_binding_invalid",
        "Verified prompt format does not match the registered destination policy and model",
        409,
      );
    metadata = {
      schema: "bridge-issuer-prompt-format-1",
      readiness: "registered-pre-approval",
      status: "non-dispatch-preview",
      executionAuthorized: false,
      rendererId: profile.rendererId,
      rendererArtifactSha256: identity.rendererArtifactSha256,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      profileSha256: identity.profileSha256,
      policySnapshotSha256: identity.policySnapshotSha256,
      providerId: profile.providerId,
      agentId: profile.agentId,
      routeId: profile.routeId,
      modelId: profile.modelId,
      codec: profile.codec,
      contextMode: profile.contextMode,
      taskKinds: ["answer", "review", "change"],
      unresolved: ["approval", "attempt", "output-contract"],
      session: null,
      bootstrap: null,
    };
  }
  return {
    renderer,
    metadata,
    fingerprint: sha256Bytes(Buffer.from(JSON.stringify(metadata))),
  };
}
