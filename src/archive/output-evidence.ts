/** Contract-scoped hosted output evidence. Model declarations are constraints, never authority. */
import { isDeepStrictEqual } from "node:util";
import type { HostedResponse } from "../adapters/browser-delivery.js";
import type { DeliveryArtifactDescriptorV1 } from "../contracts/materialization.js";
import { validateDeliveryArtifactDescriptorsV1 } from "../contracts/materialization.js";
import {
  outputContractDigest,
  parseArtifactDeclarationV1,
  parseOutputContractV1,
} from "../contracts/output-contract.js";
import { sha256Bytes } from "../contracts/task.js";
import type { HostedSourceAvailable, HostedSourceProvenanceV1 } from "./hosted-source.js";
import { ArchiveError } from "./types.js";

export { createOutputContractPrompt } from "../contracts/output-contract-prompt.js";
export interface HostedSourceProofV2 {
  schema: "hosted-source-proof-2";
  requestId: string;
  taskSpecHash: string;
  attemptId: string;
  source: HostedSourceProvenanceV1;
  outputContractSha256: string;
  declarationSha256: string;
  completenessScope: "bound_output_contract";
  contradictionCheck: {
    state: "checked";
    readerVersion: "rendered-ui-artifacts-1" | "trusted-snapshot-1";
    globalEnumerationKnown: boolean;
  };
  resolvedOutputs: {
    logicalName: string;
    mediaType: string;
    filename: string;
    artifactId: string;
    contentSha256: string;
    sizeBytes: number;
  }[];
}
export function buildHostedSourceProofV2(
  response: HostedResponse,
  source: HostedSourceAvailable,
  contractRaw: Uint8Array,
): { proof: HostedSourceProofV2; bytes: Uint8Array; artifacts: DeliveryArtifactDescriptorV1[] } {
  const contract = parseOutputContractV1(contractRaw),
    hash = outputContractDigest(contractRaw);
  if (
    !response.framing ||
    !isDeepStrictEqual(response.framing, source.provenance.frame) ||
    source.provenance.identity.conversationId !== contract.destination.conversationId ||
    source.artifactInventory.contradictionCheck !== "checked" ||
    !source.artifactInventory.readerVersion
  )
    throw new ArchiveError("output_observation_unsupported");
  const parsed = parseArtifactDeclarationV1(source.rawMarkdown, {
    contract,
    outputContractSha256: hash,
    frame: response.framing.identity,
  });
  if (
    response.result.status !== "completed" ||
    response.requestId !== response.framing.identity.requestId ||
    response.taskSpecHash !== response.framing.identity.taskSpecHash ||
    response.attemptId !== response.framing.identity.attemptId ||
    parsed.frame.markdown !== response.markdown ||
    parsed.frame.rawSha256 !== response.framing.rawSha256 ||
    parsed.frame.bodySha256 !== response.framing.bodySha256 ||
    sha256Bytes(Buffer.from(source.rawMarkdown)) !== source.provenance.contentSha256 ||
    Buffer.byteLength(source.rawMarkdown) !== source.provenance.sizeBytes ||
    source.provenance.representation !== "framed_markdown"
  )
    throw new ArchiveError("delivery_hosted_source_mismatch");
  // Legacy download paths do not establish exact assistant-turn artifact identity.
  // Until a provider supplies that mapping, they cannot be silently omitted from proof.
  if (response.result.images.length > 0 || (response.result.files?.length ?? 0) > 0)
    throw new ArchiveError("output_legacy_artifact_mapping_unsupported");
  const observed = source.artifactInventory.artifacts;
  if (
    observed.length !== parsed.declaration.outputs.length ||
    observed.some(
      (item) =>
        item.state !== "available" ||
        !item.artifactId ||
        !item.contentSha256 ||
        item.sizeBytes === null,
    )
  )
    throw new ArchiveError("observed_attachment_mismatch");
  const used = new Set<string>();
  const resolvedOutputs: HostedSourceProofV2["resolvedOutputs"] = [];
  for (const declared of parsed.declaration.outputs) {
    const matching = observed.filter(
      (item) =>
        item.contentSha256 === declared.contentSha256 &&
        item.sizeBytes === declared.sizeBytes &&
        !used.has(item.artifactId ?? ""),
    );
    const item = matching[0];
    if (matching.length !== 1 || !item?.artifactId)
      throw new ArchiveError("observed_attachment_mismatch");
    used.add(item.artifactId);
    resolvedOutputs.push({ ...declared, artifactId: item.artifactId });
  }
  const proof: HostedSourceProofV2 = {
    schema: "hosted-source-proof-2",
    requestId: response.requestId,
    taskSpecHash: response.taskSpecHash,
    attemptId: response.attemptId,
    source: source.provenance,
    outputContractSha256: hash,
    declarationSha256: parsed.declarationSha256,
    completenessScope: "bound_output_contract",
    contradictionCheck: {
      state: "checked",
      readerVersion: source.artifactInventory.readerVersion,
      globalEnumerationKnown: source.artifactInventory.enumerationKnown,
    },
    resolvedOutputs,
  };
  const bytes = Buffer.from(`${JSON.stringify(proof)}\n`);
  const artifacts = validateDeliveryArtifactDescriptorsV1([
    {
      artifactId: "hosted-source-proof",
      contentSha256: sha256Bytes(bytes),
      sizeBytes: bytes.length,
      required: true,
    },
    {
      artifactId: "hosted-response-body",
      contentSha256: source.provenance.contentSha256,
      sizeBytes: source.provenance.sizeBytes,
      required: true,
    },
    {
      artifactId: "hosted-output-contract",
      contentSha256: hash,
      sizeBytes: contractRaw.length,
      required: true,
    },
    ...resolvedOutputs.map((o) => ({
      artifactId: o.artifactId,
      contentSha256: o.contentSha256,
      sizeBytes: o.sizeBytes,
      required: true,
    })),
  ]);
  return { proof, bytes, artifacts };
}
