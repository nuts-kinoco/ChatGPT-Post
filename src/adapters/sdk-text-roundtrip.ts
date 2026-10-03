/** Explicit host-mediated one-shot orchestration; never run by imports, monitoring or catalogue reads. */

import type { TextResult } from "../contracts/sdk-text-inference.js";
import { parseTextRequest } from "../contracts/sdk-text-inference.js";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import type { SdkTextDeployment } from "./sdk-text-deployment.js";
export async function runSdkTextRoundtrip(
  runtime: SdkTextDeployment,
  raw: Uint8Array,
  markdown: Uint8Array,
  signal?: AbortSignal,
) {
  const stopped = () => {
    if (signal?.aborted) throw new Error("sdk_text_stopping");
  };
  stopped();
  if (!runtime.recipient || !runtime.preflight) throw new Error("sdk_text_recipient_unconfigured");
  raw = Buffer.from(raw);
  markdown = Buffer.from(markdown);
  const request = parseTextRequest(raw, markdown),
    id = request.requestId,
    requestSha256 = sha256Bytes(raw);
  const prior = runtime.recipient.get(id);
  if (prior && prior.requestSha256 !== requestSha256)
    throw new Error("sdk_text_request_hash_mismatch");
  if (!prior?.intentBase64) await runtime.preflight();
  stopped();
  const requestCommit = prior
    ? (await runtime.requesterBus.read(id)).commit
    : await runtime.requester.issue(runtime.requesterBus, raw, markdown, new Date());
  stopped();
  if (!prior) {
    await runtime.recipient.receive(id);
  }
  stopped();
  if (!prior?.intentBase64) await runtime.recipient.approve(id);
  stopped();
  const job = prior?.intentBase64
    ? await runtime.recipient.reconcile(id)
    : await runtime.recipient.start(id, signal);
  if (job.state !== "response_received")
    return {
      schema: "sdk-text-trial-report-1",
      status: "unknown",
      requestId: id,
      requestSha256: requestSha256,
      requestCommit,
      reexecute: false,
    };
  const snapshot = await runtime.requesterBus.bus.git.snapshot(),
    terminal = await runtime.requesterBus.readStage(id, "result", snapshot);
  if (!terminal) throw new Error("text_result_missing");
  const result = parseStrictJsonBytes(
    Buffer.from(terminal.packet.bodyBase64, "base64"),
  ) as unknown as TextResult;
  const accepted = await runtime.requester.collect(
    runtime.requesterBus,
    id,
    new Date(),
    terminal.packet.bodySha256,
  );
  const ack = await runtime.requesterBus.readStage(id, "acceptance");
  if (!ack || ack.packet.requestSha256 !== requestSha256)
    throw new Error("sdk_text_ack_unconfirmed");
  return {
    schema: "sdk-text-trial-report-1",
    status: result.liveProviderCallObserved
      ? "live_handshake_complete"
      : "synthetic_roundtrip_complete",
    requestId: id,
    requestSha256: requestSha256,
    attemptId: result.attemptId,
    requestCommit,
    resultObservedCommit: snapshot.commit,
    resultSha256: terminal.packet.bodySha256,
    ackCommit: accepted.commit,
    bundleSha256: accepted.bundleSha256,
    model: result.observation.model,
    sdkVersion: result.observation.sdkVersion,
    cliVersion: result.observation.cliVersion,
    completion: result.observation.completion,
    osProcessExit: "unobserved",
    osConfinementVerified: false,
    usage: {
      inputTokens: result.observation.inputTokens,
      outputTokens: result.observation.outputTokens,
      cacheReadInputTokens: result.observation.cacheReadInputTokens,
      cacheCreationInputTokens: result.observation.cacheCreationInputTokens,
    },
    providerHttpRequests: "unknown",
    reexecute: false,
  };
}
