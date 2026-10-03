/** Compose manual/CLI recipes with the existing signed atomic bus; no alternate task ledger. */
import { type FanoutInput, GitHubFanout } from "../adapters/fanout.js";
import type { GitHubTaskBus } from "../adapters/github-transport.js";
import {
  type OutputContractBindingV1,
  type OutputContractV1,
  parseOutputContractV1,
  validateOutputContractPolicy,
} from "../contracts/output-contract.js";
import { loadTaskSpec, sha256Bytes } from "../contracts/task.js";
import type { UiComposerPort } from "./composer.js";
export function composerTransportPort(
  bus: GitHubTaskBus,
  prepare: UiComposerPort["prepare"],
): UiComposerPort {
  const fanout = new GitHubFanout(bus);
  return {
    prepare,
    async issue(preview, finalAppendGuard, issuerPreparation) {
      const registry = bus.registry;
      if (
        !registry ||
        registry.currentRevision() !== preview.registryRevision ||
        registry.snapshotHash(preview.registryRevision) !== preview.registrySha256
      )
        throw new Error("composer_registry_stale");
      const reference = {
        projectId: preview.projectId,
        registryRevision: preview.registryRevision,
        snapshotSha256: preview.registrySha256,
      };
      const requests: FanoutInput[] = preview.children.map((child) => {
        const raw = Buffer.from(child.rawSpec),
          taskBytes = Buffer.from(child.taskMarkdown),
          parsed = loadTaskSpec(raw, child.taskSpecHash);
        if (
          !parsed.valid ||
          parsed.task.request_id !== child.requestId ||
          sha256Bytes(taskBytes) !== child.taskFileHash ||
          parsed.task.task_file_hash !== child.taskFileHash
        )
          throw new Error("composer_payload_binding_invalid");
        const project = registry.resolve(preview.registryRevision, parsed.task.repo);
        if (project.projectId !== preview.projectId) throw new Error("composer_project_mismatch");
        let outputContractRaw: Uint8Array | undefined;
        if (child.route === "ordinary_chat_browser") {
          const policy = child.outputPolicy;
          if (!policy || !project.githubDestination) throw new Error("output_contract_required");
          const binding: OutputContractBindingV1 = {
            requestId: child.requestId,
            taskSpecHash: child.taskSpecHash,
            taskFileHash: child.taskFileHash,
            route: "hosted_delivery",
            requesterActorId: bus.codec.signer.actorId,
            recipientActorId: child.recipientActorId,
            policySnapshotSha256: parsed.task.policy_snapshot_sha256,
            registryRevision: preview.registryRevision,
            registrySnapshotSha256: preview.registrySha256,
            projectId: preview.projectId,
            repoId: project.repoId,
            storageSlug: project.storageSlug,
            destination: {
              ...project.githubDestination,
              conversationId: policy.destination.conversationId,
            },
          };
          const contract: OutputContractV1 = {
            ...binding,
            schema: "output-contract-1",
            mode: policy.mode,
            requiredOutputs: structuredClone([...policy.requiredOutputs]),
            allowAdditionalArtifacts: false,
            maxArtifacts: policy.maxArtifacts,
            maxTotalBytes: policy.maxTotalBytes,
            declarationFormat: "bridge-artifact-declaration-1",
          };
          outputContractRaw = Buffer.from(JSON.stringify(contract));
          validateOutputContractPolicy(parseOutputContractV1(outputContractRaw), policy, binding);
        } else if (child.outputPolicy) throw new Error("output_contract_route_unsupported");
        return {
          raw,
          taskBytes,
          recipientId: child.recipientActorId,
          route: child.route,
          ...(outputContractRaw ? { outputContractRaw } : {}),
          expectedProjectRegistration: reference,
        };
      });
      if (requests.length === 1) {
        const request = requests[0];
        if (!request || preview.fanoutId !== null) throw new Error("composer_group_invalid");
        return {
          commit: await bus.issue(
            request.raw,
            request.taskBytes,
            request.recipientId,
            request.route,
            request.outputContractRaw,
            request.expectedProjectRegistration,
            finalAppendGuard,
            issuerPreparation,
          ),
        };
      }
      if (!preview.fanoutId || requests.length < 2 || requests.length > 4)
        throw new Error("composer_group_invalid");
      return {
        commit: await fanout.issue(preview.fanoutId, requests, finalAppendGuard, issuerPreparation),
      };
    },
  };
}
