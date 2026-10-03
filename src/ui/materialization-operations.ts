/** Concrete requester proof/ACK port on the existing authenticated bus. Reads never materialize. */
import { isDeepStrictEqual } from "node:util";
import type { DeliveryAcceptanceContext, GitHubTaskBus } from "../adapters/github-transport.js";
import { assertDeliveryBinding } from "../contracts/delivery-proof.js";
import {
  type MaterializationReceiptV1,
  serializeMaterializationReceiptV1,
} from "../contracts/materialization.js";
import type { OperationBinding, OperationTerminalBinding } from "../contracts/operations.js";
import { sha256Bytes } from "../contracts/task.js";
import { UiError } from "../contracts/ui.js";
import type { UiOperationsSources } from "./operations.js";

export function requesterMaterializationPort(options: {
  bus: GitHubTaskBus;
  /** Exact authoritative local/hosted binding, read without this port to avoid recursion. */
  currentBinding(
    binding: OperationBinding,
  ): OperationBinding | null | Promise<OperationBinding | null>;
  /** Trusted wrapper around createRequesterMaterialization; must persist before returning proof. */
  materialize(context: DeliveryAcceptanceContext): Promise<MaterializationReceiptV1>;
}): NonNullable<UiOperationsSources["materialization"]> {
  const { bus } = options;
  const exact = async (binding: OperationBinding) => {
    if (!isDeepStrictEqual(await options.currentBinding(binding), binding))
      throw new UiError(
        "stale_materialization_binding",
        "Delivery changed; refresh before accepting",
        409,
      );
  };
  const assertTerminal = (
    context: DeliveryAcceptanceContext,
    binding: OperationBinding,
    terminal: OperationTerminalBinding,
  ) => {
    if (
      context.issued.requesterId !== bus.codec.signer.actorId ||
      context.issued.requestId !== binding.requestId ||
      context.issued.taskSpecHash !== binding.taskSpecHash ||
      context.terminalEvent.eventId !== terminal.eventId ||
      context.terminalEvent.payloadSha256 !== terminal.payloadSha256 ||
      context.manifest.execution.kind !== binding.kind ||
      (binding.kind === "local_execution" &&
        context.issued.taskFileHash !== binding.taskFileHash) ||
      (binding.kind === "hosted_delivery" &&
        context.manifest.execution.kind === "hosted_delivery" &&
        context.manifest.execution.attemptId !== binding.attemptId)
    )
      throw new UiError(
        "materialization_identity_mismatch",
        "Only the exact requester delivery may be accepted",
        409,
      );
  };
  return {
    requesterActorId: bus.codec.signer.actorId,
    async verified(identity) {
      const snapshot = await bus.git.snapshot();
      const proof = await bus.readMaterialization(snapshot, identity.requestId);
      assertDeliveryBinding(proof, identity);
      const ack =
        identity.execution.kind === "local_execution"
          ? await bus.readEvent(snapshot, identity.requestId, "result_ack")
          : await bus.readHosted(snapshot, identity.requestId, "hosted_ack");
      if (
        !ack ||
        ack.eventId !== identity.terminalEventId ||
        ack.payloadSha256 !== identity.payloadSha256
      )
        throw new UiError(
          "materialization_ack_unobserved",
          "Matching signed delivery ACK is not yet observed",
          409,
        );
      if (proof.synthetic) return null;
      return {
        binding: structuredClone(identity),
        receiptSha256: sha256Bytes(Buffer.from(serializeMaterializationReceiptV1(proof))),
        deliveryManifestSha256: proof.deliveryManifestSha256,
        requiredArtifactsVerified: true,
        payloadVerified: true,
        synthetic: false,
        signedAcknowledgementVerified: true,
      };
    },
    async materializeAndAcknowledge(binding, terminal) {
      await exact(binding);
      const accept = async (
        _bytes: Uint8Array,
        _event: unknown,
        context: DeliveryAcceptanceContext,
      ) => {
        assertTerminal(context, binding, terminal);
        await exact(binding);
        const proof = await options.materialize(context);
        assertDeliveryBinding(proof, context.manifest);
        if (proof.synthetic)
          throw new UiError(
            "synthetic_materialization_denied",
            "Production delivery proof cannot be synthetic",
            409,
          );
        await exact(binding);
        return proof;
      };
      if (binding.kind === "local_execution") await bus.acceptResult(binding.requestId, accept);
      else await bus.acceptHosted(binding.requestId, accept);
      // The receiver's next ordinary host tick records the actual signed ACK; never fabricate its ledger row.
    },
  };
}
