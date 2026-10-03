/** Advisory extraction over a trusted selected artifact. No provider/process/query port. */
import { isDeepStrictEqual } from "node:util";
import { decodeStrictUtf8 } from "../contracts/raw-bytes.js";
import { parseResponseFrame } from "../contracts/response-frame.js";
import { parseStrictJsonBytes, sha256Bytes, taskResultArtifactRefs } from "../contracts/task.js";
import type { ArtifactRef } from "../contracts/task-types.js";
import type { ExecutionIdentity, ExecutorObservation } from "../state/task-executor.js";
import type { CliLaunchPlan } from "./cli-launch.js";
import {
  MAX_BOOTSTRAP_ACK_BYTES,
  SESSION_BOOTSTRAP_VERSION,
  type SessionBootstrapReceipt,
  validateSessionBootstrapPlan,
} from "./session-bootstrap.js";

export type AcceptedBootstrapTerminal = Extract<ExecutorObservation, { kind: "terminal" }>;
/** Constructed by a registered host adapter from already observed provenance, never model text.
 * The artifact contains the FULL response frame, not an extracted/rewritten body. */
export interface BootstrapResponseSource {
  protocol: "bridge-bootstrap-response-source-1";
  identity: ExecutionIdentity;
  provider: "claude" | "codex" | "antigravity";
  hostSessionId: string;
  /** Present only if the trusted adapter actually observed it. Never infer it from runId. */
  providerSessionId?: string;
  artifact: ArtifactRef;
}
export interface BootstrapExtractionSidecar {
  protocol: "bridge-bootstrap-extraction-1";
  source: BootstrapResponseSource;
  terminalPayloadSha256: string;
  frameSha256: string;
  frameBodySha256: string;
  receipt: SessionBootstrapReceipt;
}
export const BOOTSTRAP_UNAVAILABLE_REASONS = [
  "no_saved_launch_plan",
  "source_not_captured",
  "source_unavailable",
  "source_capture_failed",
  "bootstrap_state_missing_expired_or_changed",
  "projection_invalid",
] as const;
export type BootstrapUnavailableReason = (typeof BOOTSTRAP_UNAVAILABLE_REASONS)[number];
export function isBootstrapUnavailableReason(value: unknown): value is BootstrapUnavailableReason {
  return (BOOTSTRAP_UNAVAILABLE_REASONS as readonly unknown[]).includes(value);
}
export type BootstrapProjection =
  | { state: "pending"; source: BootstrapResponseSource }
  | { state: "confirmed"; sidecar: BootstrapExtractionSidecar }
  | { state: "unconfirmed"; reason: "no_unique_bound_v1_ack" }
  | { state: "unavailable"; reason: BootstrapUnavailableReason };

export function validateBootstrapResponseSource(
  source: BootstrapResponseSource,
  terminal: AcceptedBootstrapTerminal,
  plan: CliLaunchPlan,
): BootstrapResponseSource {
  const keys = Object.keys(source ?? {})
    .sort()
    .join(",");
  if (
    source?.protocol !== "bridge-bootstrap-response-source-1" ||
    ![
      "artifact,hostSessionId,identity,protocol,provider",
      "artifact,hostSessionId,identity,protocol,provider,providerSessionId",
    ].includes(keys) ||
    Object.keys(source.identity ?? {})
      .sort()
      .join(",") !== "fencingToken,requestId,runId,taskSpecHash" ||
    !isDeepStrictEqual(source.identity, terminal.identity) ||
    !isDeepStrictEqual(source.identity, plan.identity) ||
    source.provider !== plan.task.agent ||
    source.provider !== plan.bootstrap.reminder.session.provider ||
    source.hostSessionId !== plan.identity.runId ||
    (source.providerSessionId !== undefined &&
      (typeof source.providerSessionId !== "string" ||
        !/^[\x21-\x7e]{1,256}$/.test(source.providerSessionId))) ||
    !taskResultArtifactRefs(terminal.result).some((ref) => isDeepStrictEqual(ref, source.artifact))
  )
    throw new Error("bootstrap_source_invalid");
  return structuredClone(source);
}

/** Conservative Markdown block scanner: only a complete root JSON paragraph or root json fence.
 * No substring recovery, quote/list/HTML mining, or recursion into echoed metadata. */
function ackParagraphs(markdown: string): string[] {
  const lines = markdown.split("\n");
  const paragraphs: string[] = [];
  const fenceStart = /^( {0,3})(`{3,}|~{3,})(.*)$/;
  // Raw HTML/comments can contain blank lines and root-looking examples. Fail closed even
  // when a comment begins later in a prose line; extraction is deliberately not HTML parsing.
  const htmlContainer = /<[!?/a-zA-Z]/;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] as string;
    if (!line.trim()) {
      i++;
      continue;
    }
    // HTML can keep otherwise root-looking lines in a quoted/template container. Fail closed.
    if (htmlContainer.test(line)) throw new Error("bootstrap_ack_html_container");
    const fence = fenceStart.exec(line);
    if (fence) {
      const marker = fence[2] as string;
      const start = ++i;
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},} *$`);
      while (i < lines.length && !closing.test(lines[i] as string)) i++;
      if (i === lines.length) throw new Error("bootstrap_ack_unclosed_fence");
      if (
        fence[1] === "" &&
        fence[3] === "json" &&
        (start === 1 || !lines[start - 2]?.trim()) &&
        (i === lines.length - 1 || !lines[i + 1]?.trim())
      )
        paragraphs.push(lines.slice(start, i).join("\n"));
      i++;
      continue;
    }
    const start = i++;
    // A fence or HTML block may interrupt prose without a blank line. Never swallow its
    // opener: the next iteration must enter/deny that container before seeing its contents.
    while (
      i < lines.length &&
      lines[i]?.trim() &&
      !fenceStart.test(lines[i] as string) &&
      !htmlContainer.test(lines[i] as string)
    )
      i++;
    if (line.startsWith("{")) paragraphs.push(lines.slice(start, i).join("\n"));
  }
  return paragraphs;
}

export function extractBootstrapAck(
  plan: CliLaunchPlan,
  source: BootstrapResponseSource,
  terminal: AcceptedBootstrapTerminal,
  bytes: Uint8Array,
): { ackBytes: Uint8Array; frameSha256: string; frameBodySha256: string } {
  const bootstrap = validateSessionBootstrapPlan(plan.bootstrap, {
    sessionId: plan.identity.runId,
    provider: source.provider,
    role: "response_producer",
    repoId: plan.task.repo,
    contextEpoch: 1,
  });
  if (bootstrap.version !== SESSION_BOOTSTRAP_VERSION)
    throw new Error("bootstrap_launch_version_unsupported");
  validateBootstrapResponseSource(source, terminal, plan);
  if (bytes.length !== source.artifact.size_bytes || sha256Bytes(bytes) !== source.artifact.sha256)
    throw new Error("bootstrap_cached_artifact_mismatch");
  const frame = parseResponseFrame(decodeStrictUtf8(bytes, "bootstrap response"), {
    requestId: plan.identity.requestId,
    taskSpecHash: plan.identity.taskSpecHash,
    attemptId: plan.identity.runId,
  });
  let ackBytes: Uint8Array | undefined;
  let candidates = 0;
  for (const paragraph of ackParagraphs(frame.markdown)) {
    let parsed: unknown;
    try {
      parsed = parseStrictJsonBytes(Buffer.from(paragraph));
    } catch {
      throw new Error("bootstrap_ack_malformed");
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { protocol?: unknown }).protocol !== "bridge-session-bootstrap-ack/1"
    )
      continue;
    candidates++;
    if (
      Buffer.byteLength(paragraph) > MAX_BOOTSTRAP_ACK_BYTES ||
      !isDeepStrictEqual(parsed, bootstrap.ack)
    )
      throw new Error("bootstrap_ack_mismatch");
    ackBytes = Buffer.from(paragraph);
  }
  if (candidates !== 1 || !ackBytes) throw new Error("bootstrap_ack_absent_or_duplicate");
  return { ackBytes, frameSha256: frame.rawSha256, frameBodySha256: frame.bodySha256 };
}

export function createBootstrapExtractionSidecar(
  source: BootstrapResponseSource,
  terminal: AcceptedBootstrapTerminal,
  plan: CliLaunchPlan,
  extracted: { frameSha256: string; frameBodySha256: string },
  receipt: SessionBootstrapReceipt,
): BootstrapExtractionSidecar {
  const b = plan.bootstrap;
  if (
    !isDeepStrictEqual(receipt.session, b.reminder.session) ||
    receipt.version !== b.version ||
    receipt.bootstrapSha256 !== b.bootstrapSha256 ||
    receipt.reminderSha256 !== b.reminderSha256 ||
    receipt.challengeId !== b.challengeId ||
    receipt.protocol !== "bridge-session-bootstrap-receipt/1" ||
    receipt.evidence !== "bootstrap-ack-only"
  )
    throw new Error("bootstrap_receipt_mismatch");
  return {
    protocol: "bridge-bootstrap-extraction-1",
    source: validateBootstrapResponseSource(source, terminal, plan),
    terminalPayloadSha256: sha256Bytes(Buffer.from(JSON.stringify(terminal.result))),
    frameSha256: extracted.frameSha256,
    frameBodySha256: extracted.frameBodySha256,
    receipt: structuredClone(receipt),
  };
}

/** Strict sidecar validation for durable replay: recompute from the original cached bytes. */
export function validateBootstrapExtractionSidecar(
  sidecar: BootstrapExtractionSidecar,
  terminal: AcceptedBootstrapTerminal,
  plan: CliLaunchPlan,
  bytes: Uint8Array,
): BootstrapExtractionSidecar {
  const receipt = sidecar?.receipt;
  if (
    !receipt ||
    Object.keys(receipt).sort().join(",") !==
      "acknowledgedAt,bootstrapSha256,challengeId,evidence,expiresAt,protocol,receiptId,reminderSha256,session,version" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(receipt.receiptId) ||
    !Number.isFinite(Date.parse(receipt.acknowledgedAt)) ||
    !Number.isFinite(Date.parse(receipt.expiresAt)) ||
    new Date(receipt.acknowledgedAt).toISOString() !== receipt.acknowledgedAt ||
    new Date(receipt.expiresAt).toISOString() !== receipt.expiresAt ||
    Date.parse(receipt.acknowledgedAt) >= Date.parse(receipt.expiresAt)
  )
    throw new Error("bootstrap_sidecar_invalid");
  const extracted = extractBootstrapAck(plan, sidecar.source, terminal, bytes);
  const expected = createBootstrapExtractionSidecar(
    sidecar.source,
    terminal,
    plan,
    extracted,
    receipt,
  );
  if (!isDeepStrictEqual(sidecar, expected)) throw new Error("bootstrap_sidecar_invalid");
  return structuredClone(expected);
}
