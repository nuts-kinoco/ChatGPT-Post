/** Exact rendered-UI source lookup. This is provenance, never execution/approval evidence. */
import type { Page } from "playwright";
import { normaliseResponseBody } from "../contracts/atomic-write.js";
import { parseResponseFrame, type ResponseFrameIdentity } from "../contracts/response-frame.js";
import { sha256Bytes } from "../contracts/task.js";
import { htmlToMarkdown } from "../extraction/markdown.js";

export interface ExactHostedSourceIdentity {
  conversationId: string;
  userTurnId: string;
  assistantTurnId: string;
  artifactId?: string;
}
export interface HostedSourceFrame {
  identity: ResponseFrameIdentity;
  rawSha256: string;
  bodySha256: string;
}
export interface HostedSourceExpectation {
  conversationId: string;
  promptText: string;
  promptSha256: string;
  frame: HostedSourceFrame;
  artifact?: { contentSha256: string; sizeBytes: number };
}
export interface HostedSourceRecoveryExpectation {
  conversationId: string;
  promptText: string;
  promptSha256: string;
  identity: ResponseFrameIdentity;
}
export interface HostedSourceProvenanceV1 {
  version: "hosted-source-1";
  identity: ExactHostedSourceIdentity;
  promptSha256: string;
  promptMatchSha256: string;
  userTextSha256: string;
  frame: HostedSourceFrame;
  representation: "framed_markdown" | "artifact_bytes";
  contentSha256: string;
  sizeBytes: number;
}
export type HostedSourceUnavailableReason =
  | "invalid_identity"
  | "invalid_expectation"
  | "unsupported_source_version"
  | "source_read_failed"
  | "source_read_timeout"
  | "conversation_unavailable"
  | "conversation_mismatch"
  | "turn_limit_exceeded"
  | "byte_limit_exceeded"
  | "artifact_limit_exceeded"
  | "unsupported_message_ids"
  | "ambiguous_message_ids"
  | "message_unavailable"
  | "ambiguous_source"
  | "user_pairing_mismatch"
  | "prompt_mismatch"
  | "frame_mismatch"
  | "content_hash_mismatch"
  | "unsupported_artifact_ids"
  | "ambiguous_artifact_ids"
  | "artifact_unavailable"
  | "artifact_bytes_unsupported"
  | "source_snapshot_invalid";
export interface HostedSourceUnavailable {
  state: "unavailable";
  reason: HostedSourceUnavailableReason;
}
export interface HostedSourceAvailable {
  state: "available";
  provenance: HostedSourceProvenanceV1;
  rawMarkdown: string;
  markdown: string;
  bytes: Uint8Array;
  artifactInventory: HostedArtifactInventory;
}
export interface HostedArtifactInventory {
  /** Bounded selected-message contradiction check, never global enumeration proof. */
  contradictionCheck: "checked" | "unavailable";
  readerVersion: "rendered-ui-artifacts-1" | "trusted-snapshot-1" | null;
  /** Only a trusted source adapter can attest a complete enumeration, including a verified empty set. */
  enumerationKnown: boolean;
  artifacts: Array<{
    artifactId: string | null;
    contentSha256: string | null;
    sizeBytes: number | null;
    state: "available" | "unavailable";
    reason?: HostedSourceUnavailableReason;
  }>;
}
export type HostedSourceResolution = HostedSourceAvailable | HostedSourceUnavailable;
export interface HostedSourceLimits {
  maxTurns: number;
  maxSnapshotBytes: number;
  maxMessageBytes: number;
  maxArtifactsPerTurn: number;
  maxArtifactBytes: number;
  timeoutMs: number;
}
export interface HostedArtifactSnapshot {
  /** Null is deliberately unsupported: never derive an ID from order, filename or URL. */
  artifactId: string | null;
  bytes?: Uint8Array;
  unavailableReason?: "artifact_unavailable" | "artifact_bytes_unsupported";
}
export interface HostedTurnSnapshot {
  messageId: string | null;
  role: "user" | "assistant";
  text: string;
  /** Deterministic rendered assistant HTML conversion, not provider/browser internal state. */
  markdown: string;
  artifacts: readonly HostedArtifactSnapshot[];
  /** Missing proof is unknown, never a verified empty artifact set. */
  artifactEnumerationKnown?: boolean;
  artifactObservationChecked?: boolean;
  artifactReaderVersion?: "rendered-ui-artifacts-1" | "trusted-snapshot-1";
}
export interface HostedConversationSnapshot {
  state: "available";
  conversationId: string;
  /** Ordered, complete bounded list of the currently rendered turns, never a latest slice. */
  turns: readonly HostedTurnSnapshot[];
}
export interface HostedSourceSnapshotReader {
  read(
    limits: Readonly<HostedSourceLimits>,
  ): Promise<HostedConversationSnapshot | HostedSourceUnavailable>;
}

const DEFAULT_LIMITS: HostedSourceLimits = {
  maxTurns: 256,
  maxSnapshotBytes: 4 * 1024 * 1024,
  maxMessageBytes: 1024 * 1024,
  maxArtifactsPerTurn: 32,
  maxArtifactBytes: 1024 * 1024,
  timeoutMs: 5000,
};
const HARD_LIMITS: HostedSourceLimits = {
  maxTurns: 2048,
  maxSnapshotBytes: 16 * 1024 * 1024,
  maxMessageBytes: 1024 * 1024,
  maxArtifactsPerTurn: 64,
  maxArtifactBytes: 8 * 1024 * 1024,
  timeoutMs: 30000,
};
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/.test(value);
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(value);
const digest = (value: string | Uint8Array) =>
  sha256Bytes(typeof value === "string" ? Buffer.from(value, "utf8") : value);
// Full prompt equality only. The existing latest-reply collapsed-prefix matcher is insufficient.
const promptKey = (value: string) => value.replace(/\r\n?/g, "\n").trim();
const unavailable = (reason: HostedSourceUnavailableReason): HostedSourceUnavailable => ({
  state: "unavailable",
  reason,
});
function exactIdentity(value: ExactHostedSourceIdentity): boolean {
  return (
    !!value &&
    id(value.conversationId) &&
    id(value.userTurnId) &&
    id(value.assistantTurnId) &&
    value.userTurnId !== value.assistantTurnId &&
    (value.artifactId === undefined || id(value.artifactId))
  );
}
function frameIdentityValid(identity: ResponseFrameIdentity): boolean {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
  return (
    !!identity &&
    typeof identity.requestId === "string" &&
    uuid.test(identity.requestId) &&
    typeof identity.attemptId === "string" &&
    uuid.test(identity.attemptId) &&
    hash(identity.taskSpecHash)
  );
}
function frameValid(frame: HostedSourceFrame): boolean {
  return (
    !!frame && frameIdentityValid(frame.identity) && hash(frame.rawSha256) && hash(frame.bodySha256)
  );
}
function checkedLimits(input: Partial<HostedSourceLimits>): Readonly<HostedSourceLimits> {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const key of Object.keys(HARD_LIMITS) as (keyof HostedSourceLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > HARD_LIMITS[key])
      throw new Error("hosted_source_limits_invalid");
  }
  return Object.freeze(limits);
}

/** Trusted adapter boundary; returned snapshots are checked again regardless of reader behavior. */
export class ExactHostedSourceResolver {
  readonly limits: Readonly<HostedSourceLimits>;
  constructor(
    private readonly reader: HostedSourceSnapshotReader,
    limits: Partial<HostedSourceLimits> = {},
  ) {
    this.limits = checkedLimits(limits);
  }
  private async snapshot(): Promise<HostedConversationSnapshot | HostedSourceUnavailable> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await Promise.race([
        this.reader.read(this.limits),
        new Promise<HostedSourceUnavailable>((resolve) => {
          timer = setTimeout(
            () => resolve(unavailable("source_read_timeout")),
            this.limits.timeoutMs,
          );
        }),
      ]);
      if (snapshot.state === "unavailable") return snapshot;
      if (
        snapshot.state !== "available" ||
        !id(snapshot.conversationId) ||
        !Array.isArray(snapshot.turns)
      )
        return unavailable("source_snapshot_invalid");
      if (snapshot.turns.length > this.limits.maxTurns) return unavailable("turn_limit_exceeded");
      let bytes = Buffer.byteLength(snapshot.conversationId);
      if (bytes > this.limits.maxSnapshotBytes) return unavailable("byte_limit_exceeded");
      const seen = new Set<string>();
      for (const turn of snapshot.turns) {
        if (!id(turn.messageId)) return unavailable("unsupported_message_ids");
        if (seen.has(turn.messageId)) return unavailable("ambiguous_message_ids");
        seen.add(turn.messageId);
        if (
          !["user", "assistant"].includes(turn.role) ||
          typeof turn.text !== "string" ||
          typeof turn.markdown !== "string" ||
          !Array.isArray(turn.artifacts) ||
          (turn.artifactEnumerationKnown !== undefined &&
            typeof turn.artifactEnumerationKnown !== "boolean")
        )
          return unavailable("source_snapshot_invalid");
        const textBytes = Buffer.byteLength(turn.text);
        const markdownBytes = Buffer.byteLength(turn.markdown);
        if (Math.max(textBytes, markdownBytes) > this.limits.maxMessageBytes)
          return unavailable("byte_limit_exceeded");
        bytes += textBytes + markdownBytes + Buffer.byteLength(turn.messageId);
        if (turn.artifacts.length > this.limits.maxArtifactsPerTurn)
          return unavailable("artifact_limit_exceeded");
        for (const artifact of turn.artifacts) {
          if (artifact.artifactId !== null && !id(artifact.artifactId))
            return unavailable("unsupported_artifact_ids");
          bytes += artifact.artifactId?.length ?? 0;
          if (
            artifact.unavailableReason !== undefined &&
            !["artifact_unavailable", "artifact_bytes_unsupported"].includes(
              artifact.unavailableReason,
            )
          )
            return unavailable("source_snapshot_invalid");
          if (artifact.bytes !== undefined) {
            if (!(artifact.bytes instanceof Uint8Array))
              return unavailable("source_snapshot_invalid");
            if (artifact.bytes.byteLength > this.limits.maxArtifactBytes)
              return unavailable("byte_limit_exceeded");
            bytes += artifact.bytes.byteLength;
          }
        }
        if (bytes > this.limits.maxSnapshotBytes) return unavailable("byte_limit_exceeded");
      }
      return snapshot;
    } catch {
      return unavailable("source_read_failed");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Initial pin needs independently captured prompt/frame hashes; matching text alone is not enough. */
  async pin(
    expected: HostedSourceExpectation,
    identity?: ExactHostedSourceIdentity,
  ): Promise<HostedSourceResolution> {
    if (identity !== undefined && !exactIdentity(identity)) return unavailable("invalid_identity");
    if (
      !id(expected?.conversationId) ||
      typeof expected.promptText !== "string" ||
      !promptKey(expected.promptText) ||
      Buffer.byteLength(expected.promptText) > this.limits.maxMessageBytes ||
      !hash(expected.promptSha256) ||
      digest(expected.promptText) !== expected.promptSha256 ||
      !frameValid(expected.frame) ||
      (expected.artifact !== undefined &&
        (!hash(expected.artifact.contentSha256) ||
          !Number.isSafeInteger(expected.artifact.sizeBytes) ||
          expected.artifact.sizeBytes < 0 ||
          expected.artifact.sizeBytes > this.limits.maxArtifactBytes)) ||
      !!identity?.artifactId !== !!expected.artifact
    )
      return unavailable("invalid_expectation");
    expected = structuredClone(expected);
    if (identity) identity = structuredClone(identity);
    const snapshot = await this.snapshot();
    if (snapshot.state === "unavailable") return snapshot;
    return this.pinSnapshot(expected, identity, snapshot);
  }

  /**
   * Initial observation after a transient failure, only while no source has ever been pinned.
   * The caller must use resolve(existing) once provenance exists; this method cannot replace
   * known hashes or authorize another send. It observes a valid exact-attempt frame's hashes.
   */
  async recover(
    expected: HostedSourceRecoveryExpectation,
    identity?: ExactHostedSourceIdentity,
  ): Promise<HostedSourceResolution> {
    if (identity !== undefined && (!exactIdentity(identity) || identity.artifactId !== undefined))
      return unavailable("invalid_identity");
    if (
      !id(expected?.conversationId) ||
      typeof expected.promptText !== "string" ||
      !promptKey(expected.promptText) ||
      Buffer.byteLength(expected.promptText) > this.limits.maxMessageBytes ||
      !hash(expected.promptSha256) ||
      digest(expected.promptText) !== expected.promptSha256 ||
      !frameIdentityValid(expected.identity)
    )
      return unavailable("invalid_expectation");
    expected = structuredClone(expected);
    if (identity) identity = structuredClone(identity);
    const snapshot = await this.snapshot();
    if (snapshot.state === "unavailable") return snapshot;
    if (
      snapshot.conversationId !== expected.conversationId ||
      (identity && identity.conversationId !== expected.conversationId)
    )
      return unavailable("conversation_mismatch");
    let pairs: Array<{ user: HostedTurnSnapshot; assistant: HostedTurnSnapshot }> = [];
    if (identity) {
      const pair = this.pair(snapshot, identity);
      if (pair.state === "unavailable") return pair;
      if (promptKey(pair.user.text) !== promptKey(expected.promptText))
        return unavailable("prompt_mismatch");
      pairs = [pair];
    } else {
      let user: HostedTurnSnapshot | undefined;
      for (const turn of snapshot.turns) {
        if (turn.role === "user") user = turn;
        else if (user && promptKey(user.text) === promptKey(expected.promptText))
          pairs.push({ user, assistant: turn });
      }
    }
    const matches: Array<{ identity: ExactHostedSourceIdentity; frame: HostedSourceFrame }> = [];
    for (const pair of pairs) {
      try {
        const parsed = parseResponseFrame(pair.assistant.markdown, expected.identity);
        matches.push({
          identity: {
            conversationId: snapshot.conversationId,
            userTurnId: pair.user.messageId as string,
            assistantTurnId: pair.assistant.messageId as string,
          },
          frame: {
            identity: expected.identity,
            rawSha256: parsed.rawSha256,
            bodySha256: parsed.bodySha256,
          },
        });
      } catch {
        // Incomplete or unrelated turns do not trigger submission, waiting, or latest fallback.
      }
    }
    if (matches.length > 1) return unavailable("ambiguous_source");
    const match = matches[0];
    if (!match) return unavailable(identity ? "frame_mismatch" : "message_unavailable");
    return this.pinSnapshot(
      {
        conversationId: expected.conversationId,
        promptText: expected.promptText,
        promptSha256: expected.promptSha256,
        frame: match.frame,
      },
      match.identity,
      snapshot,
    );
  }

  private pinSnapshot(
    expected: HostedSourceExpectation,
    identity: ExactHostedSourceIdentity | undefined,
    snapshot: HostedConversationSnapshot,
  ): HostedSourceResolution {
    if (
      snapshot.conversationId !== expected.conversationId ||
      (identity && identity.conversationId !== expected.conversationId)
    )
      return unavailable("conversation_mismatch");
    let candidates: Array<{ user: HostedTurnSnapshot; assistant: HostedTurnSnapshot }> = [];
    if (identity) {
      const pair = this.pair(snapshot, identity);
      if (pair.state === "unavailable") return pair;
      candidates = [pair];
    } else {
      let user: HostedTurnSnapshot | undefined;
      for (const turn of snapshot.turns) {
        if (turn.role === "user") user = turn;
        else if (user && promptKey(user.text) === promptKey(expected.promptText)) {
          try {
            const parsed = parseResponseFrame(turn.markdown, expected.frame.identity);
            if (
              parsed.rawSha256 === expected.frame.rawSha256 &&
              parsed.bodySha256 === expected.frame.bodySha256
            )
              candidates.push({ user, assistant: turn });
          } catch {
            // Never use another/latest turn simply because one candidate is incomplete.
          }
        }
      }
    }
    if (candidates.length === 0) return unavailable("message_unavailable");
    if (candidates.length !== 1) return unavailable("ambiguous_source");
    const pair = candidates[0];
    if (!pair) return unavailable("message_unavailable");
    if (promptKey(pair.user.text) !== promptKey(expected.promptText))
      return unavailable("prompt_mismatch");
    const selected: ExactHostedSourceIdentity = identity ?? {
      conversationId: snapshot.conversationId,
      userTurnId: pair.user.messageId as string,
      assistantTurnId: pair.assistant.messageId as string,
    };
    const content = this.content(pair.assistant, selected);
    if (content.state === "unavailable") return content;
    if (
      expected.artifact &&
      (digest(content.bytes) !== expected.artifact.contentSha256 ||
        content.bytes.byteLength !== expected.artifact.sizeBytes)
    )
      return unavailable("content_hash_mismatch");
    const provenance: HostedSourceProvenanceV1 = {
      version: "hosted-source-1",
      identity: selected,
      promptSha256: expected.promptSha256,
      promptMatchSha256: digest(promptKey(expected.promptText)),
      userTextSha256: digest(pair.user.text),
      frame: expected.frame,
      representation: selected.artifactId === undefined ? "framed_markdown" : "artifact_bytes",
      contentSha256: digest(content.bytes),
      sizeBytes: content.bytes.byteLength,
    };
    return this.verified(pair, provenance);
  }

  /** Recovery never discovers replacement IDs, even if another turn has identical bytes. */
  async resolve(provenance: HostedSourceProvenanceV1): Promise<HostedSourceResolution> {
    if (provenance?.version !== "hosted-source-1") return unavailable("unsupported_source_version");
    if (!exactIdentity(provenance.identity)) return unavailable("invalid_identity");
    if (
      !frameValid(provenance.frame) ||
      !hash(provenance.promptSha256) ||
      !hash(provenance.promptMatchSha256) ||
      !hash(provenance.userTextSha256) ||
      !hash(provenance.contentSha256) ||
      !Number.isSafeInteger(provenance.sizeBytes) ||
      provenance.sizeBytes < 0 ||
      provenance.representation !==
        (provenance.identity.artifactId === undefined ? "framed_markdown" : "artifact_bytes")
    )
      return unavailable("invalid_expectation");
    provenance = structuredClone(provenance);
    const snapshot = await this.snapshot();
    if (snapshot.state === "unavailable") return snapshot;
    const pair = this.pair(snapshot, provenance.identity);
    if (pair.state === "unavailable") return pair;
    return this.verified(pair, provenance);
  }

  private pair(
    snapshot: HostedConversationSnapshot,
    identity: ExactHostedSourceIdentity,
  ):
    | HostedSourceUnavailable
    | { state: "pair"; user: HostedTurnSnapshot; assistant: HostedTurnSnapshot } {
    if (snapshot.conversationId !== identity.conversationId)
      return unavailable("conversation_mismatch");
    const user = snapshot.turns.find((turn) => turn.messageId === identity.userTurnId);
    const index = snapshot.turns.findIndex((turn) => turn.messageId === identity.assistantTurnId);
    const assistant = snapshot.turns[index];
    if (!user || !assistant) return unavailable("message_unavailable");
    if (user.role !== "user" || assistant.role !== "assistant")
      return unavailable("user_pairing_mismatch");
    let precedingUser: HostedTurnSnapshot | undefined;
    for (let at = index - 1; at >= 0; at--) {
      if (snapshot.turns[at]?.role === "user") {
        precedingUser = snapshot.turns[at];
        break;
      }
    }
    if (precedingUser?.messageId !== user.messageId) return unavailable("user_pairing_mismatch");
    return { state: "pair", user, assistant };
  }
  private content(
    assistant: HostedTurnSnapshot,
    identity: ExactHostedSourceIdentity,
  ): HostedSourceUnavailable | { state: "content"; bytes: Uint8Array } {
    if (identity.artifactId === undefined)
      return { state: "content", bytes: Buffer.from(assistant.markdown, "utf8") };
    if (assistant.artifacts.some((artifact) => artifact.artifactId === null))
      return unavailable("unsupported_artifact_ids");
    const artifactIds = assistant.artifacts.map((artifact) => artifact.artifactId);
    if (new Set(artifactIds).size !== artifactIds.length)
      return unavailable("ambiguous_artifact_ids");
    const matching = assistant.artifacts.filter(
      (artifact) => artifact.artifactId === identity.artifactId,
    );
    if (matching.length > 1) return unavailable("ambiguous_artifact_ids");
    const artifact = matching[0];
    if (!artifact) return unavailable("artifact_unavailable");
    if (artifact.unavailableReason) return unavailable(artifact.unavailableReason);
    if (!artifact.bytes)
      return unavailable(artifact.unavailableReason ?? "artifact_bytes_unsupported");
    return { state: "content", bytes: Uint8Array.from(artifact.bytes) };
  }
  private verified(
    pair: { user: HostedTurnSnapshot; assistant: HostedTurnSnapshot },
    provenance: HostedSourceProvenanceV1,
  ): HostedSourceResolution {
    if (
      digest(pair.user.text) !== provenance.userTextSha256 ||
      digest(promptKey(pair.user.text)) !== provenance.promptMatchSha256
    )
      return unavailable("prompt_mismatch");
    try {
      const parsed = parseResponseFrame(pair.assistant.markdown, provenance.frame.identity);
      if (
        parsed.rawSha256 !== provenance.frame.rawSha256 ||
        parsed.bodySha256 !== provenance.frame.bodySha256
      )
        return unavailable("content_hash_mismatch");
      const content = this.content(pair.assistant, provenance.identity);
      if (content.state === "unavailable") return content;
      if (
        digest(content.bytes) !== provenance.contentSha256 ||
        content.bytes.byteLength !== provenance.sizeBytes
      )
        return unavailable("content_hash_mismatch");
      Object.freeze(provenance.identity);
      Object.freeze(provenance.frame.identity);
      Object.freeze(provenance.frame);
      Object.freeze(provenance);
      return {
        state: "available",
        provenance,
        rawMarkdown: pair.assistant.markdown,
        markdown: parsed.markdown,
        bytes: content.bytes,
        artifactInventory: this.inventory(pair.assistant),
      };
    } catch {
      return unavailable("frame_mismatch");
    }
  }
  private inventory(assistant: HostedTurnSnapshot): HostedArtifactInventory {
    const counts = new Map<string, number>();
    for (const artifact of assistant.artifacts)
      if (artifact.artifactId !== null)
        counts.set(artifact.artifactId, (counts.get(artifact.artifactId) ?? 0) + 1);
    return {
      enumerationKnown: assistant.artifactEnumerationKnown === true,
      contradictionCheck: assistant.artifactObservationChecked === true ? "checked" : "unavailable",
      readerVersion:
        assistant.artifactObservationChecked === true
          ? (assistant.artifactReaderVersion ?? "trusted-snapshot-1")
          : null,
      artifacts: assistant.artifacts.map((artifact) => {
        const reason =
          artifact.artifactId === null
            ? "unsupported_artifact_ids"
            : (counts.get(artifact.artifactId) ?? 0) > 1
              ? "ambiguous_artifact_ids"
              : artifact.unavailableReason !== undefined
                ? artifact.unavailableReason
                : artifact.bytes === undefined
                  ? (artifact.unavailableReason ?? "artifact_bytes_unsupported")
                  : undefined;
        return {
          artifactId: artifact.artifactId,
          contentSha256: artifact.bytes === undefined ? null : digest(artifact.bytes),
          sizeBytes: artifact.bytes?.byteLength ?? null,
          state: reason ? "unavailable" : "available",
          ...(reason ? { reason } : {}),
        };
      }),
    };
  }
}

interface RenderedTurn {
  messageId: string | null;
  role: "user" | "assistant";
  text: string;
  html: string;
  artifacts: Array<{ artifactId: string | null }>;
}
interface RenderedSnapshot {
  state: "available";
  conversationId: string;
  turns: RenderedTurn[];
}

/**
 * Reads the existing authorized page only. No navigation, hidden APIs, browser stores, clicks,
 * latest-message fallback, or URL downloads. A virtualized/unrendered old turn is unavailable.
 * Artifact links are observed but unsupported until a reviewed exact-ID bytes adapter exists.
 */
export class PlaywrightHostedSourceSnapshotReader implements HostedSourceSnapshotReader {
  constructor(private readonly page: Pick<Page, "evaluate">) {}
  async read(
    limits: Readonly<HostedSourceLimits>,
  ): Promise<HostedConversationSnapshot | HostedSourceUnavailable> {
    try {
      limits = checkedLimits(limits);
      const observed: RenderedSnapshot | HostedSourceUnavailable = await this.page.evaluate(
        (bounds) => {
          const fail = (reason: HostedSourceUnavailableReason): HostedSourceUnavailable => ({
            state: "unavailable",
            reason,
          });
          const url = new URL(document.location.href);
          const match = /^\/c\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?![\s\S])/.exec(url.pathname);
          if (url.origin !== "https://chatgpt.com" || url.search || url.hash || !match?.[1])
            return fail("conversation_unavailable");
          const nodes = document.querySelectorAll<HTMLElement>(
            '[data-message-author-role="user"], [data-message-author-role="assistant"]',
          );
          if (nodes.length > bounds.maxTurns) return fail("turn_limit_exceeded");
          if (nodes.length === 0) return fail("unsupported_message_ids");
          const turns: RenderedTurn[] = [];
          const encoder = new TextEncoder();
          let total = 0;
          for (const node of Array.from(nodes)) {
            const role = node.getAttribute("data-message-author-role") as "user" | "assistant";
            // IDs must belong to this role-bearing message node, not a guessed ancestor/index.
            const messageId = node.getAttribute("data-message-id");
            if (!messageId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/.test(messageId))
              return fail("unsupported_message_ids");
            const bodies =
              role === "assistant" ? node.querySelectorAll<HTMLElement>(".markdown") : [];
            if (bodies.length > 1) return fail("source_snapshot_invalid");
            const body = bodies[0] ?? node;
            const text = body.innerText;
            const html = role === "assistant" ? body.innerHTML : "";
            const textBytes = encoder.encode(text).byteLength;
            const htmlBytes = encoder.encode(html).byteLength;
            if (Math.max(textBytes, htmlBytes) > bounds.maxMessageBytes)
              return fail("byte_limit_exceeded");
            total += textBytes + htmlBytes + encoder.encode(messageId).byteLength;
            if (total > bounds.maxSnapshotBytes) return fail("byte_limit_exceeded");
            const links = node.querySelectorAll<HTMLElement>(
              '[data-artifact-id], [data-file-id], a[download], a[href^="sandbox:"], img, video, audio, canvas, iframe, object, embed, [data-testid*="artifact"], [data-testid*="file-attachment"]',
            );
            if (links.length > bounds.maxArtifactsPerTurn) return fail("artifact_limit_exceeded");
            const artifacts: Array<{ artifactId: string | null }> = [];
            for (const link of Array.from(links)) {
              // Real stable IDs only. Filename, download URL, message ID and ordinal are not IDs.
              const artifactId = link.getAttribute("data-artifact-id");
              if (
                artifactId !== null &&
                !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/.test(artifactId)
              )
                return fail("unsupported_artifact_ids");
              total += encoder.encode(artifactId ?? "").byteLength;
              if (total > bounds.maxSnapshotBytes) return fail("byte_limit_exceeded");
              artifacts.push({ artifactId });
            }
            turns.push({ messageId, role, text, html, artifacts });
          }
          return { state: "available" as const, conversationId: match[1], turns };
        },
        limits,
      );
      if (observed.state === "unavailable") return observed;
      return {
        state: "available",
        conversationId: observed.conversationId,
        turns: observed.turns.map((turn) => ({
          messageId: turn.messageId,
          role: turn.role,
          text: turn.text,
          markdown:
            turn.role === "assistant" ? normaliseResponseBody(htmlToMarkdown(turn.html)) : "",
          // Current UI DOM has no complete stable attachment enumeration contract. An empty
          // selector result is not evidence that all required files have been delivered.
          artifactEnumerationKnown: false,
          artifactObservationChecked: true,
          artifactReaderVersion: "rendered-ui-artifacts-1",
          artifacts: turn.artifacts.map((artifact) => ({
            ...artifact,
            unavailableReason: "artifact_bytes_unsupported" as const,
          })),
        })),
      };
    } catch {
      return unavailable("source_read_failed");
    }
  }
}
