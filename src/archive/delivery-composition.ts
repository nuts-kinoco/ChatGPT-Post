/** Concrete host wiring. Every byte publication still passes the configured CAS sharing grants. */
import { isDeepStrictEqual } from "node:util";
import type { DeliveryAcceptanceContext, GitHubTaskBus } from "../adapters/github-transport.js";
import { assertDeliveryBinding } from "../contracts/delivery-proof.js";
import {
  type DeliveryBindingV1,
  type DeliveryManifestV1,
  serializeDeliveryManifestV1,
  validateDeliveryBindingV1,
} from "../contracts/materialization.js";
import { sha256Bytes } from "../contracts/task.js";
import type { TaskHandshake } from "../state/task-store.js";
import type { ContentAddressedDeliveryPublicationPortV1 } from "./content-store.js";
import {
  type ContentAddressedDeliveryReaderV1,
  DeliveryMaterializerV1,
  type DeliveryPayloadVerifierV1,
  type DeliveryPersistencePortV1,
  type VerifiedDeliveryArtifactV1,
} from "./materializer.js";
import {
  HostedDeliveryPayloadVerifier,
  type HostedPayloadContext,
  LocalDeliveryPayloadVerifier,
} from "./payload-verifiers.js";
import { ArchiveError } from "./types.js";
/** Explicit sender action; no implicit artifact upload occurs during result collection. */
export async function publishVerifiedDelivery(input: {
  bus: GitHubTaskBus;
  destinationId: string;
  publisher: ContentAddressedDeliveryPublicationPortV1;
  binding: DeliveryBindingV1;
  payloadBytes: Uint8Array;
  artifacts: VerifiedDeliveryArtifactV1[];
  payloadVerifier: DeliveryPayloadVerifierV1;
  payloadAlreadyPublishedOnBusDestinationId?: string;
}): Promise<DeliveryManifestV1> {
  const binding = validateDeliveryBindingV1(input.binding),
    payloadBytes = Uint8Array.from(input.payloadBytes),
    artifacts = structuredClone(input.artifacts);
  if (
    input.bus.codec.signer.actorId !== binding.recipientActorId ||
    sha256Bytes(payloadBytes) !== binding.payloadSha256
  )
    throw new ArchiveError("delivery_publication_binding_invalid");
  const validated = await input.payloadVerifier.validatePayload(payloadBytes, binding);
  if (
    !isDeepStrictEqual(
      validated.artifacts,
      artifacts
        .map((a) => a.descriptor)
        .sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0)),
    )
  )
    throw new ArchiveError("delivery_artifact_set_mismatch");
  await input.payloadVerifier.validateReceiptEvidence(payloadBytes, artifacts, binding);
  const payload = input.payloadAlreadyPublishedOnBusDestinationId
    ? {
        destinationId: input.payloadAlreadyPublishedOnBusDestinationId,
        contentSha256: binding.payloadSha256,
      }
    : await input.publisher.publish({
        destinationId: input.destinationId,
        bytes: payloadBytes,
        binding,
        purpose: "terminal_payload",
        artifactId: null,
      });
  const rows: DeliveryManifestV1["artifacts"] = [];
  for (const artifact of artifacts) {
    const source = await input.publisher.publish({
      destinationId: input.destinationId,
      bytes: artifact.bytes,
      binding,
      purpose: "artifact",
      artifactId: artifact.descriptor.artifactId,
    });
    rows.push({ ...artifact.descriptor, availability: "available", source });
  }
  const manifest: DeliveryManifestV1 = {
    ...binding,
    schema: "delivery-manifest-1",
    artifactSet: "complete",
    payload: { source: payload, sizeBytes: payloadBytes.length },
    artifacts: rows,
  };
  await input.bus.publishManifest(manifest);
  return manifest;
}
export interface RequesterMaterializationOptions {
  bus: GitHubTaskBus;
  busDestinationId: string;
  contentReader: ContentAddressedDeliveryReaderV1;
  approvedContentDestinationIds: readonly string[];
  persistence: DeliveryPersistencePortV1;
  allowSyntheticLocal?: boolean;
  /** Host-owned conversation/expected-output policy. No current-policy fallback for old jobs. */
  hostedContext?: (
    context: DeliveryAcceptanceContext,
  ) => Promise<
    Omit<
      HostedPayloadContext,
      "rawTaskSpec" | "taskFileBytes" | "terminalEvent" | "claimedArtifacts"
    >
  >;
}
/** Pass this callback to bus.acceptResult/acceptHosted. It re-reads authenticated immutable context,
 * fetches real content bytes, checks route evidence, persists, and only then returns a proof. */
export function createRequesterMaterialization(options: RequesterMaterializationOptions) {
  return (async (_payload: Uint8Array, _event: unknown, initial: DeliveryAcceptanceContext) => {
    const context = await options.bus.deliveryContext(
      await options.bus.git.snapshot(),
      initial.issued.requestId,
    );
    if (
      !isDeepStrictEqual(initial.terminalEvent, context.terminalEvent) ||
      sha256Bytes(initial.payloadBytes) !== sha256Bytes(context.payloadBytes) ||
      sha256Bytes(initial.signedManifestBytes) !== sha256Bytes(context.signedManifestBytes)
    )
      throw new ArchiveError("delivery_context_changed");
    const {
      requesterActorId,
      recipientActorId,
      requestId,
      taskSpecHash,
      execution,
      terminalEventId,
      payloadSha256,
    } = context.manifest;
    const binding = validateDeliveryBindingV1({
      requesterActorId,
      recipientActorId,
      requestId,
      taskSpecHash,
      execution,
      terminalEventId,
      payloadSha256,
    });
    if (binding.requesterActorId !== options.bus.codec.signer.actorId)
      throw new ArchiveError("delivery_requester_denied");
    const source = {
      destinationId: options.busDestinationId,
      contentSha256: sha256Bytes(context.signedManifestBytes),
    };
    let verifier: DeliveryPayloadVerifierV1;
    if (binding.execution.kind === "local_execution")
      verifier = new LocalDeliveryPayloadVerifier(async () => ({
        rawTaskSpec: context.rawTaskSpec,
        taskFileBytes: context.taskFileBytes,
        terminalEvent: context.terminalEvent as TaskHandshake,
        allowSynthetic: options.allowSyntheticLocal ?? false,
      }));
    else {
      if (!options.hostedContext) throw new ArchiveError("delivery_hosted_context_unconfigured");
      const trusted = await options.hostedContext(context);
      verifier = new HostedDeliveryPayloadVerifier(async () => ({
        ...trusted,
        rawTaskSpec: context.rawTaskSpec,
        taskFileBytes: context.taskFileBytes,
        terminalEvent:
          context.terminalEvent as import("../adapters/github-transport.js").HostedEvent,
        claimedArtifacts: context.manifest.artifacts.map(
          ({ artifactId, contentSha256, sizeBytes, required }) => ({
            artifactId,
            contentSha256,
            sizeBytes,
            required,
          }),
        ),
      }));
    }
    const materializer = new DeliveryMaterializerV1({
      approvedDestinationIds: [
        ...new Set([options.busDestinationId, ...options.approvedContentDestinationIds]),
      ],
      persistence: options.persistence,
      payloadVerifier: verifier,
      reader: {
        read: async (address, scope) => {
          if (scope.purpose === "signed_delivery_manifest") {
            if (
              address.destinationId !== source.destinationId ||
              address.contentSha256 !== source.contentSha256 ||
              context.signedManifestBytes.length > scope.maxBytes
            )
              return null;
            return Uint8Array.from(context.signedManifestBytes);
          }
          if (
            scope.purpose === "terminal_payload" &&
            address.destinationId === options.busDestinationId &&
            address.contentSha256 === binding.payloadSha256 &&
            context.payloadBytes.length <= scope.maxBytes
          )
            return Uint8Array.from(context.payloadBytes);
          return options.contentReader.read(address, scope);
        },
      },
      trustVerifier: {
        authenticate: async (bytes, expected) => {
          const decoded = options.bus.codec.decode(bytes);
          if (decoded.message.kind !== "delivery_manifest")
            throw new ArchiveError("delivery_manifest_invalid");
          assertDeliveryBinding(decoded.message.manifest, expected);
          return {
            signerActorId: decoded.actorId,
            manifestBytes: Buffer.from(serializeDeliveryManifestV1(decoded.message.manifest)),
          };
        },
      },
    });
    const result = await materializer.materialize({ expected: binding, signedManifest: source });
    if (result.state !== "complete") throw new ArchiveError(result.issue, true);
    return result.receipt;
  }) satisfies Parameters<GitHubTaskBus["acceptResult"]>[1] &
    Parameters<GitHubTaskBus["acceptHosted"]>[1];
}

/** Resolve historical requester-known policy/config rather than trusting a result's destination. */
export function createHostedPayloadContext(
  registry: import("../contracts/project-registry.js").ProjectRegistryPort,
  policyForHash: (
    policyHash: string,
  ) => import("../contracts/output-contract.js").HostedExpectedOutputPolicy | null,
) {
  return async (context: DeliveryAcceptanceContext) => {
    const { loadTaskSpec } = await import("../contracts/task.js");
    const parsed = loadTaskSpec(context.rawTaskSpec);
    const reference = context.issued.projectRegistration;
    if (!parsed.valid || !reference || !context.outputContractRaw)
      throw new ArchiveError("delivery_hosted_contract_context_required");
    const project = registry.resolve(reference.registryRevision, context.issued.repoId),
      policy = policyForHash(parsed.task.policy_snapshot_sha256);
    if (
      !project.githubDestination ||
      !policy ||
      project.projectId !== reference.projectId ||
      registry.snapshotHash(reference.registryRevision) !== reference.snapshotSha256
    )
      throw new ArchiveError("delivery_hosted_policy_unavailable");
    const outputContractBinding: import("../contracts/output-contract.js").OutputContractBindingV1 =
      {
        requestId: context.issued.requestId,
        taskSpecHash: context.issued.taskSpecHash,
        taskFileHash: context.issued.taskFileHash,
        route: "hosted_delivery",
        requesterActorId: context.issued.requesterId,
        recipientActorId: context.issued.recipientId,
        policySnapshotSha256: parsed.task.policy_snapshot_sha256,
        registryRevision: reference.registryRevision,
        registrySnapshotSha256: reference.snapshotSha256,
        projectId: project.projectId,
        repoId: project.repoId,
        storageSlug: project.storageSlug,
        destination: {
          ...project.githubDestination,
          conversationId: policy.destination.conversationId,
        },
      };
    return {
      expectedConversationId: policy.destination.conversationId,
      outputContractRaw: context.outputContractRaw,
      expectedOutputPolicy: policy,
      outputContractBinding,
    };
  };
}
