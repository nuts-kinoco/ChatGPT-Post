/** Real requester persistence using the same immutable pre-admission pin as sender archives. */
import { isDeepStrictEqual } from "node:util";
import { parseOutputContractV1 } from "../contracts/output-contract.js";
import { sha256Bytes } from "../contracts/task.js";
import {
  type DeliveryPersistencePortV1,
  type VerifiedDeliveryMaterializationV1,
  validateVerifiedDeliveryMaterializationV1,
} from "./materializer.js";
import type { RouteArtifactArchive } from "./route-store.js";
import { ArchiveError } from "./types.js";
export class ArchiveDeliveryPersistence implements DeliveryPersistencePortV1 {
  constructor(private readonly archive: RouteArtifactArchive) {}
  async persistVerified(
    input: VerifiedDeliveryMaterializationV1,
  ): Promise<{ state: "durable"; receiptSha256: string }> {
    validateVerifiedDeliveryMaterializationV1(input);
    const admission = this.archive.admission(input.binding.requestId);
    if (
      admission.taskSpecHash !== input.binding.taskSpecHash ||
      admission.requesterActorId !== input.binding.requesterActorId ||
      admission.recipientActorId !== input.binding.recipientActorId ||
      admission.route.kind !== input.binding.execution.kind
    )
      throw new ArchiveError("archive_materialization_admission_mismatch");
    if (admission.route.kind === "hosted_delivery") {
      const evidence = input.verifiedArtifacts.find(
        (item) => item.descriptor.artifactId === "hosted-output-contract",
      );
      if (
        !admission.outputContractSha256 ||
        !evidence ||
        sha256Bytes(evidence.bytes) !== admission.outputContractSha256
      )
        throw new ArchiveError("archive_materialization_contract_mismatch");
      const contract = parseOutputContractV1(evidence.bytes);
      const registration = this.archive.projectRegistration(admission.requestId);
      const actual = {
        requestId: contract.requestId,
        taskSpecHash: contract.taskSpecHash,
        taskFileHash: contract.taskFileHash,
        requesterActorId: contract.requesterActorId,
        recipientActorId: contract.recipientActorId,
        policySnapshotSha256: contract.policySnapshotSha256,
        registryRevision: contract.registryRevision,
        registrySnapshotSha256: contract.registrySnapshotSha256,
        projectId: contract.projectId,
        repoId: contract.repoId,
        storageSlug: contract.storageSlug,
        destination: contract.destination,
      };
      const expected = {
        requestId: admission.requestId,
        taskSpecHash: admission.taskSpecHash,
        taskFileHash: admission.taskFileHash,
        requesterActorId: admission.requesterActorId,
        recipientActorId: admission.recipientActorId,
        policySnapshotSha256: admission.route.policyHash,
        registryRevision: admission.registryRevision,
        registrySnapshotSha256: admission.registrySnapshotHash,
        projectId: admission.projectId,
        repoId: admission.repoId,
        storageSlug: admission.storageSlug,
        destination: registration.githubDestination
          ? {
              ...registration.githubDestination,
              conversationId: admission.route.conversationId,
            }
          : null,
      };
      if (!isDeepStrictEqual(actual, expected))
        throw new ArchiveError("archive_materialization_contract_mismatch");
    }
    const files = [
      { relativePath: "results/result.json", bytes: input.payloadBytes },
      { relativePath: "results/delivery-manifest.json", bytes: input.deliveryManifestBytes },
      {
        relativePath: "results/delivery-manifest.signed.json",
        bytes: input.signedDeliveryManifestBytes,
      },
      { relativePath: "results/materialization-receipt.json", bytes: input.receiptBytes },
      ...input.verifiedArtifacts.map((item) => ({
        relativePath: `artifacts/artifact-${sha256Bytes(Buffer.from(item.descriptor.artifactId))}.bin`,
        bytes: item.bytes,
      })),
    ];
    this.archive.persistReceipt(
      input.binding.requestId,
      input.binding.terminalEventId,
      input.receiptSha256,
      Buffer.from(input.receiptBytes).toString("utf8"),
      files,
    );
    return { state: "durable", receiptSha256: input.receiptSha256 };
  }
}
