/** Concrete route verification for requester materialization. Context is authenticated transport evidence. */
import { isDeepStrictEqual } from "node:util";
import type { HostedResponse } from "../adapters/browser-delivery.js";
import type { HostedEvent } from "../adapters/github-transport.js";
import { checkResultInvariants } from "../contracts/invariants.js";
import type {
  DeliveryArtifactDescriptorV1,
  DeliveryBindingV1,
} from "../contracts/materialization.js";
import { validateDeliveryArtifactDescriptorsV1 } from "../contracts/materialization.js";
import {
  type HostedExpectedOutputPolicy,
  type OutputContractBindingV1,
  outputContractDigest,
  parseOutputContractV1,
  validateOutputContractPolicy,
} from "../contracts/output-contract.js";
import { createFramedPrompt, parseResponseFrame } from "../contracts/response-frame.js";
import {
  loadTaskSpec,
  parseStrictJsonBytes,
  sha256Bytes,
  taskResultArtifactRefs,
  validateTaskResult,
  verifyTaskFileBytes,
} from "../contracts/task.js";
import type { TaskResult } from "../contracts/task-types.js";
import type { TaskHandshake } from "../state/task-store.js";
import type { HostedSourceAvailable, HostedSourceProvenanceV1 } from "./hosted-source.js";
import type { DeliveryPayloadVerifierV1, VerifiedDeliveryArtifactV1 } from "./materializer.js";
import {
  buildHostedSourceProofV2,
  createOutputContractPrompt,
  type HostedSourceProofV2,
} from "./output-evidence.js";
import { exact, HASH, MESSAGE_ID } from "./route-validation.js";
import { ArchiveError } from "./types.js";
export interface LocalPayloadContext {
  rawTaskSpec: Uint8Array;
  taskFileBytes: Uint8Array;
  terminalEvent: TaskHandshake;
  allowSynthetic?: boolean;
}
export interface HostedPayloadContext {
  rawTaskSpec: Uint8Array;
  taskFileBytes: Uint8Array;
  terminalEvent: HostedEvent;
  /** Descriptors from the authenticated recipient delivery manifest; source proof must corroborate them. */
  claimedArtifacts: DeliveryArtifactDescriptorV1[];
  expectedConversationId: string;
  synthetic?: boolean;
  allowSynthetic?: boolean;
  outputContractRaw?: Uint8Array;
  expectedOutputPolicy?: HostedExpectedOutputPolicy;
  outputContractBinding?: OutputContractBindingV1;
}
function requiredTask(raw: Uint8Array, file: Uint8Array, binding: DeliveryBindingV1) {
  const loaded = loadTaskSpec(raw, binding.taskSpecHash);
  if (
    !loaded.valid ||
    loaded.task.request_id !== binding.requestId ||
    !verifyTaskFileBytes(loaded.task, file).valid
  )
    throw new ArchiveError("delivery_task_binding_invalid");
  return loaded.task;
}
function uniqueRefs(refs: DeliveryArtifactDescriptorV1[]): DeliveryArtifactDescriptorV1[] {
  const byId = new Map<string, DeliveryArtifactDescriptorV1>();
  for (const r of refs) {
    const prior = byId.get(r.artifactId);
    if (prior && !isDeepStrictEqual(prior, r))
      throw new ArchiveError("delivery_artifact_identity_conflict");
    byId.set(r.artifactId, r);
  }
  return validateDeliveryArtifactDescriptorsV1([...byId.values()]);
}
function verifyBytes(
  expected: DeliveryArtifactDescriptorV1[],
  artifacts: readonly VerifiedDeliveryArtifactV1[],
): void {
  const actual = validateDeliveryArtifactDescriptorsV1(artifacts.map((x) => x.descriptor));
  if (!isDeepStrictEqual(actual, expected))
    throw new ArchiveError("delivery_artifact_set_mismatch");
  for (const artifact of artifacts)
    if (
      artifact.bytes.length !== artifact.descriptor.sizeBytes ||
      sha256Bytes(artifact.bytes) !== artifact.descriptor.contentSha256
    )
      throw new ArchiveError("delivery_artifact_hash_mismatch");
}
export class LocalDeliveryPayloadVerifier implements DeliveryPayloadVerifierV1 {
  constructor(
    private readonly context: (binding: DeliveryBindingV1) => Promise<LocalPayloadContext>,
  ) {}
  private async checked(bytes: Uint8Array, binding: DeliveryBindingV1) {
    if (
      binding.execution.kind !== "local_execution" ||
      sha256Bytes(bytes) !== binding.payloadSha256
    )
      throw new ArchiveError("delivery_local_binding_invalid");
    const context = await this.context(binding),
      task = requiredTask(context.rawTaskSpec, context.taskFileBytes, binding),
      result = parseStrictJsonBytes(bytes) as TaskResult,
      event = context.terminalEvent;
    if (
      event.stage !== "terminal_result" ||
      event.requestId !== binding.requestId ||
      event.taskSpecHash !== binding.taskSpecHash ||
      event.eventId !== binding.terminalEventId ||
      event.actorId !== binding.recipientActorId ||
      event.payloadSha256 !== binding.payloadSha256 ||
      event.runId !== binding.execution.runId ||
      !validateTaskResult(result, { task, taskSpecHash: binding.taskSpecHash }).valid ||
      !["succeeded", "failed", "cancelled"].includes(result.status) ||
      result.run_id !== binding.execution.runId ||
      event.sequence !== result.observation_seq ||
      event.fencingToken !== result.fencing_token ||
      !isDeepStrictEqual(event.processIdentity, result.process_identity)
    )
      throw new ArchiveError("delivery_local_binding_invalid");
    if (result.synthetic && !context.allowSynthetic)
      throw new ArchiveError("delivery_synthetic_not_authorized");
    if (!result.synthetic && (!result.receipt || result.verification.state !== "verified"))
      throw new ArchiveError("delivery_receipt_missing");
    const artifacts = uniqueRefs(
      taskResultArtifactRefs(result).map((r) => ({
        artifactId: r.artifact_id,
        contentSha256: r.sha256,
        sizeBytes: r.size_bytes,
        required: true,
      })),
    );
    return { result, artifacts };
  }
  async validatePayload(bytes: Uint8Array, binding: DeliveryBindingV1) {
    const { result, artifacts } = await this.checked(bytes, binding);
    return {
      artifacts,
      payloadVerification: "local_result_and_receipt" as const,
      synthetic: result.synthetic,
    };
  }
  async validateReceiptEvidence(
    bytes: Uint8Array,
    artifacts: readonly VerifiedDeliveryArtifactV1[],
    binding: DeliveryBindingV1,
  ): Promise<void> {
    const checked = await this.checked(bytes, binding);
    verifyBytes(checked.artifacts, artifacts);
    const receipt = checked.result.receipt;
    if (
      !checked.result.synthetic &&
      receipt?.process_state === "never_started" &&
      binding.execution.kind === "local_execution" &&
      binding.execution.runId === null
    ) {
      const evidence = artifacts.find(
        (a) => a.descriptor.artifactId === receipt.evidence_ref.artifact_id,
      );
      if (!evidence) throw new ArchiveError("delivery_receipt_missing");
      const value = exact(parseStrictJsonBytes(evidence.bytes), [
        "requestId",
        "sequence",
        "processState",
      ]);
      if (
        value.requestId !== binding.requestId ||
        value.sequence !== checked.result.observation_seq ||
        value.processState !== "never_started"
      )
        throw new ArchiveError("delivery_receipt_invalid");
    }
  }
}
export interface HostedSourceProofV1 {
  schema: "hosted-source-proof-1";
  requestId: string;
  taskSpecHash: string;
  attemptId: string;
  source: HostedSourceProvenanceV1;
  artifactSet: "complete";
  artifacts: DeliveryArtifactDescriptorV1[];
}
function validateHostedSourceProof(value: HostedSourceProofV1): void {
  exact(value, [
    "schema",
    "requestId",
    "taskSpecHash",
    "attemptId",
    "source",
    "artifactSet",
    "artifacts",
  ]);
  if (value.schema !== "hosted-source-proof-1" || value.artifactSet !== "complete")
    throw new ArchiveError("delivery_hosted_proof_invalid");
  const source = value.source;
  exact(source, [
    "version",
    "identity",
    "promptSha256",
    "promptMatchSha256",
    "userTextSha256",
    "frame",
    "representation",
    "contentSha256",
    "sizeBytes",
  ]);
  exact(source.identity, ["conversationId", "userTurnId", "assistantTurnId"]);
  exact(source.frame, ["identity", "rawSha256", "bodySha256"]);
  exact(source.frame.identity, ["requestId", "taskSpecHash", "attemptId"]);
  if (
    source.version !== "hosted-source-1" ||
    source.representation !== "framed_markdown" ||
    source.frame.identity.requestId !== value.requestId ||
    source.frame.identity.taskSpecHash !== value.taskSpecHash ||
    source.frame.identity.attemptId !== value.attemptId ||
    Object.values(source.identity).some((id) => !MESSAGE_ID.test(id)) ||
    source.identity.userTurnId === source.identity.assistantTurnId ||
    [
      source.promptSha256,
      source.promptMatchSha256,
      source.userTextSha256,
      source.frame.rawSha256,
      source.frame.bodySha256,
      source.contentSha256,
    ].some((h) => !HASH.test(h)) ||
    source.contentSha256 !== source.frame.rawSha256 ||
    !Number.isSafeInteger(source.sizeBytes) ||
    source.sizeBytes < 0
  )
    throw new ArchiveError("delivery_hosted_proof_invalid");
  validateDeliveryArtifactDescriptorsV1(value.artifacts);
  if (
    value.artifacts.some(
      (a) => !a.required || ["hosted-source-proof", "hosted-response-body"].includes(a.artifactId),
    )
  )
    throw new ArchiveError("delivery_hosted_proof_invalid");
}
/** Host may publish only after exact reader proves the complete artifact inventory. */
export function buildHostedSourceProof(
  response: HostedResponse,
  source: HostedSourceAvailable,
): { bytes: Uint8Array; artifacts: DeliveryArtifactDescriptorV1[] } {
  if (
    !response.framing ||
    !isDeepStrictEqual(response.framing, source.provenance.frame) ||
    !source.artifactInventory.enumerationKnown ||
    source.artifactInventory.artifacts.some(
      (a) => a.state !== "available" || !a.artifactId || !a.contentSha256 || a.sizeBytes === null,
    )
  )
    throw new ArchiveError("delivery_hosted_source_incomplete");
  const artifacts = source.artifactInventory.artifacts.map((a) => ({
    artifactId: a.artifactId as string,
    contentSha256: a.contentSha256 as string,
    sizeBytes: a.sizeBytes as number,
    required: true,
  }));
  const proof: HostedSourceProofV1 = {
    schema: "hosted-source-proof-1",
    requestId: response.requestId,
    taskSpecHash: response.taskSpecHash,
    attemptId: response.attemptId,
    source: source.provenance,
    artifactSet: "complete",
    artifacts: uniqueRefs(artifacts),
  };
  validateHostedSourceProof(proof);
  const bytes = Buffer.from(`${JSON.stringify(proof)}\n`);
  return {
    bytes,
    artifacts: uniqueRefs([
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
      ...artifacts,
    ]),
  };
}
export class HostedDeliveryPayloadVerifier implements DeliveryPayloadVerifierV1 {
  constructor(
    private readonly context: (binding: DeliveryBindingV1) => Promise<HostedPayloadContext>,
  ) {}
  private async checked(bytes: Uint8Array, binding: DeliveryBindingV1) {
    if (
      binding.execution.kind !== "hosted_delivery" ||
      sha256Bytes(bytes) !== binding.payloadSha256
    )
      throw new ArchiveError("delivery_hosted_binding_invalid");
    const context = await this.context(binding),
      task = requiredTask(context.rawTaskSpec, context.taskFileBytes, binding),
      response = parseStrictJsonBytes(bytes) as HostedResponse,
      event = context.terminalEvent;
    exact(response, [
      "version",
      "requestId",
      "taskSpecHash",
      "attemptId",
      "evidence",
      "localExecution",
      "result",
      "markdown",
      "framing",
    ]);
    if (
      response.version !== "hosted-response-1" ||
      response.requestId !== binding.requestId ||
      response.taskSpecHash !== binding.taskSpecHash ||
      response.attemptId !== binding.execution.attemptId ||
      response.evidence !== "ordinary-chat-browser-dom" ||
      response.localExecution !== false ||
      checkResultInvariants(response.result).length ||
      response.result.requestId !== binding.requestId ||
      response.result.target === "dot" ||
      event.stage !== "hosted_result" ||
      event.requestId !== binding.requestId ||
      event.taskSpecHash !== binding.taskSpecHash ||
      event.eventId !== binding.terminalEventId ||
      event.actorId !== binding.recipientActorId ||
      event.payloadSha256 !== binding.payloadSha256
    )
      throw new ArchiveError("delivery_hosted_binding_invalid");
    if (context.synthetic && !context.allowSynthetic)
      throw new ArchiveError("delivery_synthetic_not_authorized");
    const artifacts = validateDeliveryArtifactDescriptorsV1(context.claimedArtifacts);
    if (context.outputContractRaw) {
      if (!context.expectedOutputPolicy || !context.outputContractBinding)
        throw new ArchiveError("delivery_hosted_contract_context_required");
      validateOutputContractPolicy(
        parseOutputContractV1(context.outputContractRaw),
        context.expectedOutputPolicy,
        context.outputContractBinding,
      );
      if (
        context.outputContractBinding.requestId !== binding.requestId ||
        context.outputContractBinding.taskSpecHash !== binding.taskSpecHash ||
        context.outputContractBinding.taskFileHash !== task.task_file_hash ||
        context.outputContractBinding.requesterActorId !== binding.requesterActorId ||
        context.outputContractBinding.recipientActorId !== binding.recipientActorId ||
        context.outputContractBinding.destination.conversationId !== context.expectedConversationId
      )
        throw new ArchiveError("delivery_hosted_contract_binding_invalid");
    } else if (!context.allowSynthetic)
      throw new ArchiveError("delivery_hosted_contract_context_required");
    if (response.result.status === "completed") {
      if (
        !response.framing ||
        response.framing.identity.requestId !== binding.requestId ||
        response.framing.identity.taskSpecHash !== binding.taskSpecHash ||
        response.framing.identity.attemptId !== binding.execution.attemptId ||
        !artifacts.some((a) => a.artifactId === "hosted-response-body" && a.required) ||
        !artifacts.some((a) => a.artifactId === "hosted-source-proof" && a.required)
      )
        throw new ArchiveError("delivery_hosted_source_incomplete");
      if (
        task.agent !== "chatgpt-browser" ||
        (response.result.requestedModel !== null &&
          response.result.requestedModel !== task.requested_model)
      )
        throw new ArchiveError("delivery_hosted_model_mismatch");
    } else {
      if (
        response.result.submitted !== "no" ||
        response.framing !== null ||
        response.markdown !== null ||
        response.result.images.length > 0 ||
        (response.result.files?.length ?? 0) > 0
      )
        throw new ArchiveError("delivery_hosted_outcome_unknown");
      // No generated message exists. Retain only authenticated admission evidence, without
      // inventing user/assistant message IDs or a successful output declaration.
      const expected = context.outputContractRaw
        ? [
            {
              artifactId: "hosted-output-contract",
              contentSha256: outputContractDigest(context.outputContractRaw),
              sizeBytes: context.outputContractRaw.length,
              required: true,
            },
          ]
        : [];
      if (!isDeepStrictEqual(artifacts, expected))
        throw new ArchiveError("delivery_hosted_contract_mismatch");
    }
    return { context, response, artifacts };
  }
  async validatePayload(bytes: Uint8Array, binding: DeliveryBindingV1) {
    const value = await this.checked(bytes, binding);
    return {
      artifacts: value.artifacts,
      payloadVerification: "hosted_response_source" as const,
      synthetic: value.context.synthetic ?? false,
    };
  }
  async validateReceiptEvidence(
    bytes: Uint8Array,
    artifacts: readonly VerifiedDeliveryArtifactV1[],
    binding: DeliveryBindingV1,
  ): Promise<void> {
    const value = await this.checked(bytes, binding);
    verifyBytes(value.artifacts, artifacts);
    if (value.response.result.submitted === "no") {
      if (value.context.outputContractRaw) {
        const contract = artifacts.find(
          (a) => a.descriptor.artifactId === "hosted-output-contract",
        );
        if (
          !contract ||
          !Buffer.from(contract.bytes).equals(Buffer.from(value.context.outputContractRaw))
        )
          throw new ArchiveError("delivery_hosted_contract_mismatch");
      }
      return;
    }
    const raw = artifacts.find((a) => a.descriptor.artifactId === "hosted-response-body"),
      proofBytes = artifacts.find((a) => a.descriptor.artifactId === "hosted-source-proof");
    if (!raw || !proofBytes) throw new ArchiveError("delivery_hosted_source_incomplete");
    const parsedProof = parseStrictJsonBytes(proofBytes.bytes) as { schema?: unknown };
    if (value.context.outputContractRaw) {
      if (
        parsedProof.schema !== "hosted-source-proof-2" ||
        !value.context.expectedOutputPolicy ||
        !value.context.outputContractBinding
      )
        throw new ArchiveError("delivery_hosted_contract_proof_required");
      const contract = parseOutputContractV1(value.context.outputContractRaw);
      validateOutputContractPolicy(
        contract,
        value.context.expectedOutputPolicy,
        value.context.outputContractBinding,
      );
      const contractArtifact = artifacts.find(
        (a) => a.descriptor.artifactId === "hosted-output-contract",
      );
      if (
        !contractArtifact ||
        !Buffer.from(contractArtifact.bytes).equals(Buffer.from(value.context.outputContractRaw))
      )
        throw new ArchiveError("delivery_hosted_contract_mismatch");
      const proof = parsedProof as HostedSourceProofV2;
      exact(proof, [
        "schema",
        "requestId",
        "taskSpecHash",
        "attemptId",
        "source",
        "outputContractSha256",
        "declarationSha256",
        "completenessScope",
        "contradictionCheck",
        "resolvedOutputs",
      ]);
      exact(proof.contradictionCheck, ["state", "readerVersion", "globalEnumerationKnown"]);
      if (
        proof.completenessScope !== "bound_output_contract" ||
        proof.contradictionCheck.state !== "checked" ||
        !["trusted-snapshot-1", "rendered-ui-artifacts-1"].includes(
          proof.contradictionCheck.readerVersion,
        ) ||
        typeof proof.contradictionCheck.globalEnumerationKnown !== "boolean" ||
        !Array.isArray(proof.resolvedOutputs) ||
        proof.resolvedOutputs.length > 64 ||
        proof.outputContractSha256 !== outputContractDigest(value.context.outputContractRaw)
      )
        throw new ArchiveError("delivery_hosted_contract_proof_invalid");
      for (const output of proof.resolvedOutputs)
        exact(output, [
          "logicalName",
          "mediaType",
          "filename",
          "artifactId",
          "contentSha256",
          "sizeBytes",
        ]);
      validateHostedSourceProof({
        schema: "hosted-source-proof-1",
        requestId: proof.requestId,
        taskSpecHash: proof.taskSpecHash,
        attemptId: proof.attemptId,
        source: proof.source,
        artifactSet: "complete",
        artifacts: proof.resolvedOutputs.map((o) => ({
          artifactId: o.artifactId,
          contentSha256: o.contentSha256,
          sizeBytes: o.sizeBytes,
          required: true,
        })),
      });
      const source: HostedSourceAvailable = {
        state: "available",
        provenance: proof.source,
        rawMarkdown: Buffer.from(raw.bytes).toString("utf8"),
        markdown: value.response.markdown ?? "",
        bytes: raw.bytes,
        artifactInventory: {
          enumerationKnown: proof.contradictionCheck.globalEnumerationKnown,
          contradictionCheck: "checked",
          readerVersion: proof.contradictionCheck.readerVersion,
          artifacts: proof.resolvedOutputs.map((o) => {
            const artifact = artifacts.find((a) => a.descriptor.artifactId === o.artifactId);
            if (!artifact) throw new ArchiveError("delivery_required_artifact_unavailable");
            return {
              artifactId: o.artifactId,
              contentSha256: sha256Bytes(artifact.bytes),
              sizeBytes: artifact.bytes.length,
              state: "available" as const,
            };
          }),
        },
      };
      const expectedProof = buildHostedSourceProofV2(
        value.response,
        source,
        value.context.outputContractRaw,
      );
      if (
        !isDeepStrictEqual(proof, expectedProof.proof) ||
        !isDeepStrictEqual(value.artifacts, expectedProof.artifacts)
      )
        throw new ArchiveError("delivery_hosted_contract_proof_mismatch");
      const validatedFrame = value.response.framing;
      if (!validatedFrame) throw new ArchiveError("delivery_hosted_source_incomplete");
      const prompt = createOutputContractPrompt(
        value.context.taskFileBytes,
        validatedFrame.identity,
        value.context.outputContractRaw,
      );
      if (
        proof.source.promptSha256 !== sha256Bytes(prompt) ||
        proof.source.promptMatchSha256 !==
          sha256Bytes(
            Buffer.from(Buffer.from(prompt).toString("utf8").replace(/\r\n?/g, "\n").trim()),
          ) ||
        proof.source.identity.conversationId !== value.context.expectedConversationId ||
        proof.source.contentSha256 !== sha256Bytes(raw.bytes) ||
        proof.source.sizeBytes !== raw.bytes.length
      )
        throw new ArchiveError("delivery_hosted_source_mismatch");
      return;
    }
    if (!value.context.allowSynthetic)
      throw new ArchiveError("delivery_hosted_contract_proof_required");
    const proof = parseStrictJsonBytes(proofBytes.bytes) as HostedSourceProofV1;
    validateHostedSourceProof(proof);
    const frame = value.response.framing;
    if (!frame) throw new ArchiveError("delivery_hosted_source_incomplete");
    const parsed = parseResponseFrame(
      new TextDecoder("utf8", { fatal: true }).decode(raw.bytes),
      frame.identity,
    );
    const prompt = createFramedPrompt(value.context.taskFileBytes, frame.identity);
    if (
      proof.source.promptSha256 !== sha256Bytes(prompt) ||
      proof.source.promptMatchSha256 !==
        sha256Bytes(
          Buffer.from(Buffer.from(prompt).toString("utf8").replace(/\r\n?/g, "\n").trim()),
        )
    )
      throw new ArchiveError("delivery_hosted_prompt_mismatch");
    if (
      proof.requestId !== binding.requestId ||
      proof.taskSpecHash !== binding.taskSpecHash ||
      proof.attemptId !== frame.identity.attemptId ||
      proof.source.identity.conversationId !== value.context.expectedConversationId ||
      !isDeepStrictEqual(proof.source.frame, frame) ||
      proof.source.contentSha256 !== sha256Bytes(raw.bytes) ||
      proof.source.sizeBytes !== raw.bytes.length ||
      parsed.rawSha256 !== frame.rawSha256 ||
      parsed.bodySha256 !== frame.bodySha256 ||
      parsed.markdown !== value.response.markdown
    )
      throw new ArchiveError("delivery_hosted_source_mismatch");
    const expected = uniqueRefs([
      { ...proofBytes.descriptor },
      { ...raw.descriptor },
      ...proof.artifacts,
    ]);
    if (!isDeepStrictEqual(expected, value.artifacts))
      throw new ArchiveError("delivery_hosted_artifact_set_mismatch");
  }
}
