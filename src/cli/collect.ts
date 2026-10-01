/** Durable, no-send recovery for a reply that may have completed after a runner timed out. */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CHATGPT_ORIGIN, CONVERSATION_PATH_RE } from "../chatgpt/page.js";
import { atomicWriteFile, normaliseResponseBody } from "../contracts/atomic-write.js";
import { checkResultInvariants } from "../contracts/invariants.js";
import type {
  BridgeResult,
  ChatRequest,
  ObservedModel,
  ObservedPreset,
} from "../contracts/types.js";
import {
  dotMarkerSeen,
  dotPrefix,
  dotSelectionWarnings,
  selectDotReplies,
} from "../dot/completion.js";
import { DotFailure, type DotPage } from "../dot/page.js";
import { IMAGE_CAPTURE_BUDGET_MS, sanitiseConversationUrl } from "../state/controller.js";
import type { Extraction, Ports } from "../state/ports.js";

export interface CollectIdentity {
  requestId: string | null;
  conversationUrl: string;
  submittedAt: string;
  baselineAssistantCount: number;
  /** Present for requestId recovery; absent for the deliberately restricted explicit form. */
  request?: ChatRequest;
  original?: BridgeResult | null;
  /** Durable request-ID recovery only: the actual submitted prompt used for ownership proof. */
  submittedPrompt?: string;
  /** Basenames only; attachment chips can be rendered alongside the user prompt. */
  attachmentNames?: string[];
}

export type CollectFailureCode =
  | "COLLECT_AUTH_UNAVAILABLE"
  | "COLLECT_LOCK_BUSY"
  | "COLLECT_BROWSER_UNAVAILABLE"
  | "COLLECT_CONVERSATION_UNAVAILABLE"
  | "COLLECT_HISTORY_NOT_RENDERED"
  | "COLLECT_CONVERSATION_MISMATCH"
  | "COLLECT_REPLY_ABSENT"
  | "COLLECT_REPLY_AMBIGUOUS"
  | "COLLECT_REPLY_OWNERSHIP_MISMATCH"
  | "COLLECT_STILL_GENERATING"
  | "COLLECT_EXTRACTION_FAILED";

export type CollectAttempt =
  | {
      ok: true;
      extraction: Extraction;
      observedAssistantCount: number;
      images: string[];
      warnings: string[];
    }
  | { ok: false; code: CollectFailureCode; message: string };

/** A browser's temporary WEB: route is not a durable conversation identity. */
export function confirmedConversationUrl(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const cleaned = sanitiseConversationUrl(candidate ?? null);
    if (!cleaned) continue;
    const parsed = new URL(cleaned);
    if (parsed.origin === CHATGPT_ORIGIN && CONVERSATION_PATH_RE.test(parsed.pathname))
      return cleaned;
  }
  return null;
}

/** A direct `run` has no jobs.db row; its write-ahead marker is the durable request locator. */
export async function dotRequestForCollect(
  runtimeDir: string,
  requestId: string,
  marker?: { requestPath?: string | undefined; completionMarker?: string | undefined },
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]$/.test(requestId))
    throw new Error("invalid requestId");
  const requestPath = requestPathForCollect(marker?.requestPath, runtimeDir, requestId);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(requestPath, "utf8"));
  } catch {
    return null;
  }
  if ((raw as { target?: unknown } | null)?.target !== "dot") return null;
  const { validateRequest } = await import("../contracts/schema.js");
  if (!validateRequest(raw).valid || (raw as { requestId: string }).requestId !== requestId)
    throw new Error("invalid or mismatched dot request.json");
  let result: { completionMarker?: string } | null = null;
  try {
    result = JSON.parse(await readFile(join(requestPath, "..", "result.json"), "utf8"));
  } catch {
    /* Older requests may have no result. */
  }
  return {
    requestPath,
    completionMarker:
      marker?.completionMarker ??
      result?.completionMarker ??
      (raw as { completionMarker?: string }).completionMarker,
  };
}

export function requestPathForCollect(
  markerRequestPath: string | undefined,
  runtimeDir: string,
  requestId: string,
): string {
  return markerRequestPath ?? join(runtimeDir, "requests", requestId, "request.json");
}

/**
 * Opens one known conversation and extracts only when its assistant-turn count is exactly the
 * write-ahead baseline plus one. This is intentionally separate from submission: this function
 * has no prompt-entry or dispatch dependency, which makes "never sends" mechanically testable.
 */
export async function collectLatestReply(
  identity: CollectIdentity,
  ports: Pick<Ports, "browser" | "chatgpt" | "lock">,
  imagesDir?: string,
): Promise<CollectAttempt> {
  const target = sanitiseConversationUrl(identity.conversationUrl);
  if (!target || identity.baselineAssistantCount < 0) {
    return {
      ok: false,
      code: "COLLECT_CONVERSATION_UNAVAILABLE",
      message: "invalid recovery identity",
    };
  }
  let locked = false;
  let browserUp = false;
  try {
    const acquired = await ports.lock.acquire("collect", identity.requestId);
    if (acquired.kind !== "ok")
      return { ok: false, code: "COLLECT_LOCK_BUSY", message: acquired.cause };
    locked = true;
    const path = await ports.browser.checkProfilePath();
    if (!path.ok) return { ok: false, code: "COLLECT_BROWSER_UNAVAILABLE", message: path.cause };
    const free = await ports.browser.checkProfileFree();
    if (!free.free) return { ok: false, code: "COLLECT_BROWSER_UNAVAILABLE", message: free.cause };
    const launched = await ports.browser.launch({
      copyCaptureShim: true,
      onCrash: () => undefined,
    });
    if (!launched.ok)
      return { ok: false, code: "COLLECT_BROWSER_UNAVAILABLE", message: launched.cause };
    browserUp = true;
    const auth = await ports.chatgpt.navigateAndObserveAuth();
    if (auth.kind !== "AUTH_OK")
      return {
        ok: false,
        code: "COLLECT_AUTH_UNAVAILABLE",
        message: "kind" in auth ? auth.kind : "authentication check failed",
      };
    const opened = await ports.chatgpt.openConversationForCollect(target);
    if (opened.kind !== "ok")
      return {
        ok: false,
        code:
          opened.kind === "retry" && opened.cause === "history_not_rendered"
            ? "COLLECT_HISTORY_NOT_RENDERED"
            : "COLLECT_CONVERSATION_UNAVAILABLE",
        message:
          opened.kind === "retry" && opened.cause === "history_not_rendered"
            ? `conversation history has not rendered yet; open ${target} to confirm the conversation, then retry collect`
            : "cause" in opened
              ? opened.cause
              : opened.kind,
      };
    const actual = sanitiseConversationUrl(await ports.chatgpt.currentUrl());
    if (actual !== target)
      return {
        ok: false,
        code: "COLLECT_CONVERSATION_MISMATCH",
        message: `expected ${target}, observed ${actual ?? "(invalid URL)"}`,
      };
    const observation = await ports.chatgpt.observe(0);
    const added = observation.assistantCount - identity.baselineAssistantCount;
    if (added <= 0)
      return {
        ok: false,
        code: "COLLECT_REPLY_ABSENT",
        message: `expected one reply after baseline=${identity.baselineAssistantCount}, observed=${observation.assistantCount}`,
      };
    if (added !== 1)
      return {
        ok: false,
        code: "COLLECT_REPLY_AMBIGUOUS",
        message: `expected exactly one reply after baseline=${identity.baselineAssistantCount}, observed=${observation.assistantCount}`,
      };
    if (observation.streaming)
      return {
        ok: false,
        code: "COLLECT_STILL_GENERATING",
        message: "the only candidate still has the stop button; do not extract a partial reply",
      };
    if (!identity.submittedPrompt)
      return {
        ok: false,
        code: "COLLECT_REPLY_OWNERSHIP_MISMATCH",
        message: "recovery identity has no submitted prompt for ownership proof",
      };
    const ownership = await ports.chatgpt.verifyLatestReplyOwnership(
      identity.submittedPrompt,
      identity.attachmentNames ?? [],
    );
    if (ownership.kind !== "match")
      return {
        ok: false,
        code: "COLLECT_REPLY_OWNERSHIP_MISMATCH",
        message: ownership.cause,
      };
    const extraction = await ports.chatgpt.extractLatest();
    if ("kind" in extraction)
      return { ok: false, code: "COLLECT_EXTRACTION_FAILED", message: extraction.cause };
    const warnings: string[] = opened.draftPresent
      ? ["draft_present: existing composer draft was observed and left untouched"]
      : [];
    const images: string[] = [];
    if (imagesDir) {
      try {
        const abort = new AbortController();
        const capture = ports.chatgpt.captureImages(imagesDir, abort.signal);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), IMAGE_CAPTURE_BUDGET_MS);
        });
        const first = await Promise.race([capture, timeout]);
        if (timer) clearTimeout(timer);
        let captured: { saved: string[]; warnings: string[] };
        if (first === "timeout") {
          abort.abort();
          captured = await capture.catch((err: Error) => ({ saved: [], warnings: [err.message] }));
          warnings.push("image_capture_failed: timeout");
        } else {
          captured = first;
        }
        images.push(...captured.saved.map((file) => `images/${file}`));
        warnings.push(...captured.warnings);
      } catch (err) {
        warnings.push(`image_capture_failed: ${(err as Error).message.slice(0, 200)}`);
      }
    } else {
      warnings.push("images_not_collected: no recovery image directory was configured");
    }
    if (extraction.markdown.trim() === "" && images.length === 0)
      return { ok: false, code: "COLLECT_EXTRACTION_FAILED", message: "empty" };
    if (images.length > 0) {
      const links = images.map((file, i) => `![image ${i + 1}](${file})`).join("\n\n");
      extraction.markdown = extraction.markdown.trimEnd();
      extraction.markdown = extraction.markdown
        ? `${extraction.markdown}\n\n${links}\n`
        : `${links}\n`;
    }
    return {
      ok: true,
      extraction,
      observedAssistantCount: observation.assistantCount,
      images,
      warnings,
    };
  } finally {
    if (browserUp) await ports.browser.close({ keepPage: false }).catch(() => undefined);
    if (locked) await ports.lock.release().catch(() => undefined);
  }
}

export function buildRecoveredResult(
  identity: CollectIdentity,
  extraction: Extraction,
  responseFile: string,
  bridgeVersion: string,
  now: Date,
  images: string[] = [],
  warnings: string[] = [],
): BridgeResult {
  const original = identity.original ?? null;
  const startedAt = new Date(identity.submittedAt);
  if (Number.isNaN(startedAt.getTime()))
    throw new Error("collect identity has invalid submittedAt");
  const result: BridgeResult = {
    schemaVersion: "1.2",
    bridgeVersion,
    requestId: identity.requestId,
    status: "completed",
    requestedPreset: identity.request?.preset ?? original?.requestedPreset ?? null,
    observedPreset: (original?.observedPreset ?? null) as ObservedPreset | null,
    requestedModel: identity.request
      ? (identity.request.model ?? "current")
      : (original?.requestedModel ?? null),
    observedModel: (original?.observedModel ?? null) as ObservedModel | null,
    observedModelSlug: extraction.modelSlug,
    submitted: "yes",
    ...(original?.project ? { project: original.project } : {}),
    conversationUrl: sanitiseConversationUrl(identity.conversationUrl),
    responseFile,
    extractionMethod: extraction.method,
    extractionQuality: extraction.quality,
    startedAt: startedAt.toISOString(),
    completedAt: now.toISOString(),
    durationMs: Math.max(0, now.getTime() - startedAt.getTime()),
    artifacts: [],
    images,
    warnings: [
      "recovered without resubmission; original result is preserved alongside this recovery",
      ...warnings,
    ],
    error: null,
    recoveredBy: "collect",
    recoveredFromSubmittedAt: startedAt.toISOString(),
  };
  const problems = checkResultInvariants(result);
  if (problems.length > 0)
    throw new Error(`recovered result violates contract: ${problems.join("; ")}`);
  return result;
}

export async function writeRecoveredResult(
  outputDir: string,
  result: BridgeResult,
  markdown: string,
): Promise<{ resultPath: string; responsePath: string }> {
  await mkdir(outputDir, { recursive: true });
  const responsePath = join(outputDir, "response.md");
  const resultPath = join(outputDir, "result.json");
  await atomicWriteFile(responsePath, normaliseResponseBody(markdown));
  await atomicWriteFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return { resultPath, responsePath };
}

export function classifyDotCollect(
  snapshot: import("../dot/completion.js").DotSnapshot,
  requestId: string,
  marker: string | undefined,
  threadUrl: string,
) {
  const prefix = dotPrefix(requestId);
  const matches = snapshot.rows.filter((row) => row.self && row.text.startsWith(prefix));
  if (matches.length !== 1 || !matches[0])
    return {
      ok: false as const,
      code: matches.length
        ? ("COLLECT_REPLY_AMBIGUOUS" as const)
        : ("COLLECT_REPLY_ABSENT" as const),
      message: `expected exactly one own row; open ${threadUrl} manually to confirm the thread; never resend`,
    };
  // Shared thread: only rows attributed to this requestId, never every later row (A-200).
  const selection = selectDotReplies(
    snapshot.rows,
    snapshot.rows.indexOf(matches[0]),
    requestId,
    marker,
  );
  const replies = selection.replies;
  const markerSeen = marker !== undefined && replies.some((row) => dotMarkerSeen(row.text, marker));
  return {
    ok: true as const,
    replies,
    selectionWarnings: dotSelectionWarnings(selection),
    status: {
      state: markerSeen
        ? ("complete" as const)
        : marker !== undefined
          ? ("in_progress" as const)
          : ("unknown" as const),
      markerSeen,
      typing: snapshot.typing,
      replyCount: replies.length,
      files: replies.flatMap((row) =>
        row.files.map((name) => name.replace(/\u3092\u958b\u304f$|^Open /i, "")),
      ),
      threadUrl,
    },
  };
}

/** Read-only dependencies intentionally exclude prepare/send. Saving never replaces run output. */
export async function collectDotReply(
  requestId: string,
  marker: string | undefined,
  ports: Pick<Ports, "browser" | "lock">,
  getPage: () => Pick<DotPage, "navigate" | "snapshot" | "currentUrl" | "extract" | "files">,
  saveDir?: string,
) {
  let locked = false;
  let browserUp = false;
  try {
    const acquired = await ports.lock.acquire("collect", requestId);
    if (acquired.kind !== "ok")
      return { ok: false as const, code: "COLLECT_LOCK_BUSY", message: acquired.cause };
    locked = true;
    const path = await ports.browser.checkProfilePath();
    if (!path.ok)
      return { ok: false as const, code: "COLLECT_BROWSER_UNAVAILABLE", message: path.cause };
    const free = await ports.browser.checkProfileFree();
    if (!free.free)
      return { ok: false as const, code: "COLLECT_BROWSER_UNAVAILABLE", message: free.cause };
    const launched = await ports.browser.launch({
      copyCaptureShim: false,
      onCrash: () => undefined,
    });
    if (!launched.ok)
      return { ok: false as const, code: "COLLECT_BROWSER_UNAVAILABLE", message: launched.cause };
    browserUp = true;
    const dot = getPage();
    await dot.navigate();
    const classified = classifyDotCollect(
      await dot.snapshot(),
      requestId,
      marker,
      dot.currentUrl().split(/[?#]/)[0] ?? "",
    );
    if (!classified.ok) return classified;
    const warnings: string[] = [
      ...(marker !== undefined && !classified.status.markerSeen ? ["dot_marker_not_seen"] : []),
      ...classified.selectionWarnings,
    ];
    if (saveDir) {
      await mkdir(join(saveDir, "files"), { recursive: true });
      const extracted = dot.extract(classified.replies);
      warnings.push(...extracted.warnings);
      const downloaded = await dot.files(classified.replies, saveDir);
      warnings.push(...downloaded.warnings);
      await atomicWriteFile(
        join(saveDir, "response.md"),
        normaliseResponseBody(extracted.markdown),
      );
      await atomicWriteFile(
        join(saveDir, "collect-result.json"),
        `${JSON.stringify({ schemaVersion: "1.3", target: "dot", requestId, ...classified.status, warnings, savedFiles: downloaded.files }, null, 2)}\n`,
      );
    }
    return {
      ok: true as const,
      ...classified.status,
      warnings,
      ...(saveDir ? { savedDir: saveDir } : {}),
    };
  } catch (error) {
    const code =
      error instanceof DotFailure &&
      ["AUTH_REQUIRED", "CAPTCHA_OR_CHALLENGE", "MANUAL_INTERVENTION_REQUIRED"].includes(error.code)
        ? "COLLECT_AUTH_UNAVAILABLE"
        : "COLLECT_EXTRACTION_FAILED";
    return { ok: false as const, code, message: (error as Error).message };
  } finally {
    if (browserUp) await ports.browser.close({ keepPage: false }).catch(() => undefined);
    if (locked) await ports.lock.release().catch(() => undefined);
  }
}
