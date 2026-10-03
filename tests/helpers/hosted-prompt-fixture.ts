/** Real local build consistency checks, synthetic policy/task data, and zero provider calls. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type BrowserDeliveryPolicyV2,
  encodeBrowserDeliveryPolicyV2,
  registerHostedPromptPolicy,
} from "../../src/adapters/hosted-prompt-policy.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { encodeTaskBrief, type TaskKind } from "../../src/prompt-rendering/brief.js";
import { verifyInstalledHostedRenderer } from "../../src/prompt-rendering/hosted-registry.js";
import {
  createProductionPromptProfile,
  encodeProductionPromptProfile,
} from "../../src/prompt-rendering/production-profile.js";
import { adapterTask } from "./adapter-fixture.js";
import { fixtureHostedOutputPolicy, fixtureOutputContract } from "./output-contract-fixture.js";
export function hostedPromptFixture(
  modelId: "gpt-5.6-sol" | "gpt-5.5" = "gpt-5.6-sol",
  kind: TaskKind = "answer",
) {
  const profile = createProductionPromptProfile({
    profileId: `fixture-${modelId}`,
    profileVersion: 1,
    modelId,
  });
  const profileRaw = encodeProductionPromptProfile(profile),
    profileSha256 = sha256Bytes(profileRaw);
  const buildRaw = readFileSync(
    fileURLToPath(
      new URL("../../dist/prompt-rendering/hosted-build-manifest.json", import.meta.url),
    ),
  );
  const rendererArtifactSha256 = sha256Bytes(buildRaw);
  const policy: BrowserDeliveryPolicyV2 = {
    schema: "bridge-browser-delivery-policy-2",
    delivery: {
      recipientId: "recipient",
      requesterIds: ["requester"],
      conversationUrl: "https://chatgpt.com/c/fixture",
      model: modelId,
      preset: "current",
      maxStarts: 2,
      deadlineAt: "2026-10-03T06:00:00Z",
      maxResponseBytes: 10000,
      expectedOutputPolicy: fixtureHostedOutputPolicy(),
    },
    prompt: {
      schema: "bridge-prompt-policy-1",
      rendererId: "bridge-hosted-prompt-1",
      rendererArtifactSha256,
      profileId: profile.profileId,
      profileVersion: 1,
      profileSha256,
      agentId: "chatgpt-browser",
      modelId,
      routeId: "ordinary_chat_browser",
      codec: "bridge-task-brief-1",
      contextMode: "none",
      outputParser: "response-frame-1+artifact-declaration-1",
      cacheControls: "none",
    },
  };
  const policyRaw = encodeBrowserDeliveryPolicyV2(policy),
    policySnapshotSha256 = sha256Bytes(policyRaw);
  const renderer = verifyInstalledHostedRenderer({
    profileRaw,
    profileSha256,
    rendererArtifactSha256,
    policySnapshotSha256,
  });
  const registration = registerHostedPromptPolicy(policyRaw, renderer);
  const taskFileBytes = encodeTaskBrief({
    taskKind: kind,
    objective: "Inspect only the supplied synthetic design",
    constraints: ["No model calls"],
    deliverables: ["A concise answer"],
    acceptance: ["Report uncertainty"],
    context: [],
  });
  const task = {
    ...adapterTask(),
    agent: "chatgpt-browser",
    requested_model: modelId,
    policy_snapshot_sha256: policySnapshotSha256,
    task_file_hash: sha256Bytes(taskFileBytes),
  };
  const rawTaskSpec = Buffer.from(JSON.stringify(task)),
    outputContractRaw = fixtureOutputContract(rawTaskSpec);
  const frame = {
    requestId: task.request_id,
    taskSpecHash: sha256Bytes(rawTaskSpec),
    attemptId: "00000000-0000-4000-8000-000000000002",
  };
  return {
    profile,
    profileRaw,
    profileSha256,
    rendererArtifactSha256,
    policy,
    policyRaw,
    policySnapshotSha256,
    renderer,
    registration,
    task,
    taskFileBytes,
    rawTaskSpec,
    outputContractRaw,
    frame,
  };
}
