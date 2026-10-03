/** Fixed synthetic registry and requester contract, never account or route authorization. */
import type { GitObjectStore } from "../../src/adapters/github-client.js";
import type {
  HostedExpectedOutputPolicy,
  OutputContractV1,
} from "../../src/contracts/output-contract.js";
import {
  type ProjectRegistryPort,
  type ProjectRegistrySnapshot,
  projectRegistryHash,
} from "../../src/contracts/project-registry.js";
import { loadTaskSpec } from "../../src/contracts/task.js";

const projectId = "e4541d37-c43c-4c7e-924a-3a6602b71d68";
const destination = { repositoryFullName: "owner/bus", branch: "main", namespace: "bridge-v2" };
const snapshot: ProjectRegistrySnapshot = {
  schema: "bridge-project-registry-1",
  revision: 1,
  defaultOutputRoot: null,
  projects: [
    {
      projectId,
      repoId: "fixture-repo",
      storageSlug: "PixivVault",
      displayName: "Fixture project",
      githubDestination: destination,
      outputRootOverride: null,
    },
  ],
};
export const fixtureProjectRegistry: ProjectRegistryPort = {
  currentRevision: () => 1,
  snapshot: (revision = 1) => {
    if (revision !== 1) throw new Error("project_registry_revision_missing");
    return structuredClone(snapshot);
  },
  resolve: (revision, repoId) => {
    const row = fixtureProjectRegistry.snapshot(revision).projects.find((p) => p.repoId === repoId);
    if (!row) throw new Error("project_not_registered_at_revision");
    return row;
  },
  defaultOutputRoot: (revision) => fixtureProjectRegistry.snapshot(revision).defaultOutputRoot,
  snapshotHash: (revision) => projectRegistryHash(fixtureProjectRegistry.snapshot(revision)),
};
export function fixtureGitDestination<T extends GitObjectStore>(git: T): T {
  Object.assign(git, {
    destination: { repositoryFullName: destination.repositoryFullName, branch: destination.branch },
  });
  return git;
}
export function fixtureHostedOutputPolicy(conversationId = "fixture"): HostedExpectedOutputPolicy {
  return {
    route: "hosted_delivery",
    requesterActorId: "requester",
    recipientActorId: "recipient",
    projectId,
    repoId: "fixture-repo",
    storageSlug: "PixivVault",
    destination: { ...destination, conversationId },
    mode: "text_only",
    requiredOutputs: [],
    allowAdditionalArtifacts: false,
    maxArtifacts: 0,
    maxTotalBytes: 0,
  };
}
export function fixtureOutputContract(raw: Uint8Array, conversationId = "fixture"): Uint8Array {
  const parsed = loadTaskSpec(raw);
  if (!parsed.valid) throw new Error("fixture_task_invalid");
  const contract: OutputContractV1 = {
    ...fixtureHostedOutputPolicy(conversationId),
    requiredOutputs: [],
    schema: "output-contract-1",
    requestId: parsed.task.request_id,
    taskSpecHash: parsed.taskSpecHash,
    taskFileHash: parsed.task.task_file_hash,
    policySnapshotSha256: parsed.task.policy_snapshot_sha256,
    registryRevision: 1,
    registrySnapshotSha256: fixtureProjectRegistry.snapshotHash(1),
    declarationFormat: "bridge-artifact-declaration-1",
  };
  return Buffer.from(JSON.stringify(contract));
}
