/** Recipient-owned expected-output authorization. A valid requester signature alone is insufficient. */

import {
  type HostedExpectedOutputPolicy,
  type OutputContractBindingV1,
  outputContractDigest,
  parseOutputContractV1,
  validateOutputContractPolicy,
} from "../contracts/output-contract.js";
import type { ProjectRegistryPort } from "../contracts/project-registry.js";
import type { TaskSpec } from "../contracts/task-types.js";
import type { IssuedMessage } from "./github-transport.js";
export function assertHostedOutputContract(input: {
  issued: IssuedMessage;
  task: TaskSpec;
  raw: Uint8Array | null;
  registry: ProjectRegistryPort | undefined;
  policyHash: string;
  conversationUrl: string;
  expectedOutputPolicy: HostedExpectedOutputPolicy | undefined;
}) {
  const { issued, task, raw, registry, policyHash, conversationUrl, expectedOutputPolicy } = input;
  const extension = issued as IssuedMessage & {
    version?: string;
    outputContractSha256?: string | null;
  };
  const reference = issued.projectRegistration;
  if (
    extension.version !== "bridge-issued-2" ||
    !extension.outputContractSha256 ||
    !raw ||
    !reference ||
    !registry ||
    !expectedOutputPolicy
  )
    throw new Error("output_contract_required");
  const project = registry.resolve(reference.registryRevision, task.repo),
    destination = project.githubDestination;
  if (
    !destination ||
    registry.snapshotHash(reference.registryRevision) !== reference.snapshotSha256 ||
    project.projectId !== reference.projectId ||
    project.storageSlug !== issued.projectSlug ||
    outputContractDigest(raw) !== extension.outputContractSha256
  )
    throw new Error("output_contract_binding_mismatch");
  const expected: OutputContractBindingV1 = {
    requestId: issued.requestId,
    taskSpecHash: issued.taskSpecHash,
    taskFileHash: issued.taskFileHash,
    route: "hosted_delivery",
    requesterActorId: issued.requesterId,
    recipientActorId: issued.recipientId,
    policySnapshotSha256: policyHash,
    registryRevision: reference.registryRevision,
    registrySnapshotSha256: reference.snapshotSha256,
    projectId: project.projectId,
    repoId: task.repo,
    storageSlug: project.storageSlug,
    destination: {
      ...destination,
      conversationId: new URL(conversationUrl).pathname.split("/").at(-1) ?? "",
    },
  };
  const contract = parseOutputContractV1(raw);
  validateOutputContractPolicy(contract, expectedOutputPolicy, expected);
  return contract;
}
