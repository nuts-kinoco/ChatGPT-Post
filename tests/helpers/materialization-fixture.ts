/** Synthetic signing/binding fixture only. It does not implement production artifact materialization.
 * Production materializer tests separately verify exact bytes and durable requester-side saving. */
import type {
  DeliveryAcceptanceContext,
  GitHubTaskBus,
  HostedEvent,
} from "../../src/adapters/github-transport.js";
import {
  type DeliveryManifestV1,
  type MaterializationReceiptV1,
  serializeDeliveryManifestV1,
} from "../../src/contracts/materialization.js";
import { sha256Bytes, taskResultArtifactRefs } from "../../src/contracts/task.js";
import type { TaskResult } from "../../src/contracts/task-types.js";
import type { TaskHandshake } from "../../src/state/task-store.js";
export async function fixtureManifest(recipient: GitHubTaskBus, requestId: string): Promise<void> {
  const snapshot = await recipient.git.snapshot();
  const { issued } = await recipient.readIssued(
    snapshot,
    recipient.path("inbox", requestId, "issued.json"),
  );
  const hosted = issued.route === "ordinary_chat_browser";
  const event = hosted
    ? await recipient.readHosted(snapshot, requestId, "hosted_result")
    : await recipient.readEvent(snapshot, requestId, "terminal_result");
  const bytes = await recipient.git.read(
    snapshot,
    recipient.path(
      hosted ? "hosted" : "outbox",
      requestId,
      hosted ? "response.json" : "result.json",
    ),
  );
  if (!event || !bytes) throw new Error("fixture_missing_terminal");
  const payload = JSON.parse(Buffer.from(bytes).toString());
  const artifacts = hosted
    ? []
    : [
        ...new Map(
          taskResultArtifactRefs(payload as TaskResult).map((ref) => [ref.artifact_id, ref]),
        ).values(),
      ].map((ref) => ({
        artifactId: ref.artifact_id,
        contentSha256: ref.sha256,
        sizeBytes: ref.size_bytes,
        required: true,
        availability: "available" as const,
        source: { destinationId: "synthetic-cas", contentSha256: ref.sha256 },
      }));
  const manifest: DeliveryManifestV1 = {
    schema: "delivery-manifest-1",
    requesterActorId: issued.requesterId,
    recipientActorId: issued.recipientId,
    requestId,
    taskSpecHash: issued.taskSpecHash,
    execution: hosted
      ? { kind: "hosted_delivery", attemptId: payload.attemptId }
      : { kind: "local_execution", runId: (event as TaskHandshake).runId },
    terminalEventId: event.eventId,
    payloadSha256: event.payloadSha256,
    payload: {
      source: { destinationId: "synthetic-cas", contentSha256: event.payloadSha256 },
      sizeBytes: bytes.length,
    },
    artifactSet: "complete",
    artifacts,
  };
  await recipient.publishManifest(manifest);
}
export function fixtureReceipt(context: DeliveryAcceptanceContext): MaterializationReceiptV1 {
  const m = context.manifest;
  const payload = JSON.parse(Buffer.from(context.payloadBytes).toString());
  return {
    schema: "materialization-receipt-1",
    requesterActorId: m.requesterActorId,
    recipientActorId: m.recipientActorId,
    requestId: m.requestId,
    taskSpecHash: m.taskSpecHash,
    execution: m.execution,
    terminalEventId: m.terminalEventId,
    payloadSha256: m.payloadSha256,
    deliveryManifestSha256: sha256Bytes(Buffer.from(serializeDeliveryManifestV1(m))),
    requiredArtifactsVerified: true,
    payloadVerification:
      m.execution.kind === "local_execution"
        ? "local_result_and_receipt"
        : "hosted_response_source",
    synthetic: payload.synthetic === true,
    verifiedArtifacts: m.artifacts
      .filter((row) => row.availability === "available")
      .map(({ artifactId, contentSha256, sizeBytes, required }) => ({
        artifactId,
        contentSha256,
        sizeBytes,
        required,
      })),
  };
}
export async function fixtureAccept(
  recipient: GitHubTaskBus,
  requester: GitHubTaskBus,
  requestId: string,
  hosted = false,
  observe?: (bytes: Uint8Array, event: TaskHandshake | HostedEvent) => Promise<void>,
) {
  await fixtureManifest(recipient, requestId);
  const accept = async (
    bytes: Uint8Array,
    event: TaskHandshake | HostedEvent,
    context: DeliveryAcceptanceContext,
  ) => {
    await observe?.(bytes, event);
    return fixtureReceipt(context);
  };
  return hosted
    ? requester.acceptHosted(requestId, accept)
    : requester.acceptResult(requestId, accept);
}
