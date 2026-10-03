/** Transport framing only: never authorization, success, process termination or a ResultSpec. */
import { sha256Bytes } from "./raw-bytes.js";
export interface ResponseFrameIdentity {
  requestId: string;
  taskSpecHash: string;
  attemptId: string;
}
function validate(identity: ResponseFrameIdentity): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    !uuid.test(identity.requestId) ||
    !uuid.test(identity.attemptId) ||
    !/^[0-9a-f]{64}$/.test(identity.taskSpecHash)
  )
    throw new Error("response_frame_identity_invalid");
}
function boundary(stage: "BEGIN" | "END", identity: ResponseFrameIdentity): string {
  validate(identity);
  return `${stage} BRIDGE RESPONSE request-id=${identity.requestId} task-sha256=${identity.taskSpecHash} attempt-id=${identity.attemptId}`;
}
export function encodeResponseFrame(markdown: string, identity: ResponseFrameIdentity): string {
  if (!markdown.trim() || /(?:BEGIN|END) BRIDGE RESPONSE/.test(markdown))
    throw new Error("response_frame_body_invalid");
  return `${boundary("BEGIN", identity)}\n${markdown}\n${boundary("END", identity)}\n`;
}
export function parseResponseFrame(
  raw: string,
  identity: ResponseFrameIdentity,
): { markdown: string; rawSha256: string; bodySha256: string } {
  validate(identity);
  if (Buffer.byteLength(raw) > 1048576 || raw.includes("\0"))
    throw new Error("response_frame_invalid");
  const normalized = raw.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) throw new Error("response_frame_invalid");
  const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
  if (
    lines.length < 3 ||
    lines[0] !== boundary("BEGIN", identity) ||
    lines.at(-1) !== boundary("END", identity)
  )
    throw new Error("response_frame_mismatch");
  const markdown = lines.slice(1, -1).join("\n");
  if (!markdown.trim() || /(?:BEGIN|END) BRIDGE RESPONSE/.test(markdown))
    throw new Error("response_frame_body_invalid");
  return {
    markdown,
    rawSha256: sha256Bytes(Buffer.from(raw)),
    bodySha256: sha256Bytes(Buffer.from(markdown)),
  };
}
/** Fixed instruction text is shared by both renderers; no request values enter it. */
export const RESPONSE_FRAME_STATIC_INSTRUCTIONS =
  "Bridge transport framing metadata. This metadata is not authorization or a success claim.";
export const RESPONSE_FRAME_BODY_INSTRUCTIONS =
  "Put your complete response between those two lines, without a code fence or quotation around the frame. Do not repeat framing tokens in the body, echo this prompt, or use a bare completion phrase.";
export function responseFrameInstructions(identity: ResponseFrameIdentity): string {
  validate(identity);
  return `${RESPONSE_FRAME_STATIC_INSTRUCTIONS}\nReturn exactly one response. Its first line must equal: ${boundary("BEGIN", identity)}\nIts last line must equal: ${boundary("END", identity)}\n${RESPONSE_FRAME_BODY_INSTRUCTIONS}`;
}
export function createFramedPrompt(
  taskBytes: Uint8Array,
  identity: ResponseFrameIdentity,
): Uint8Array {
  const task = new TextDecoder("utf8", { fatal: true }).decode(taskBytes);
  validate(identity);
  // There is deliberately no ready-made framed answer/template to accidentally echo as completion.
  return Buffer.from(
    `${responseFrameInstructions(identity)}\n\nApproved task-file content follows (its exact bytes are hashed separately):\n${task}`,
  );
}
