import type { Event } from "../state/machine.js";

export interface Observation {
  t: number;
  assistantCount: number;
  lastAssistantHash: string;
  lastAssistantEmpty: boolean;
  streaming: boolean;
  composerReady: boolean;
  copyAvailable: boolean;
  truncated: boolean;
  sidePanel: boolean;
  errorBanner: "none" | "chat_error" | "rate_limited" | "network";
  challenge: "none" | "login" | "captcha" | "consent";
}

export interface CompletionConfig {
  timeoutMs: number;
  stabilizationMs: number;
  fallbackStabilizationMs: number;
}

export const DEFAULT_COMPLETION_CONFIG: Omit<CompletionConfig, "timeoutMs"> = {
  stabilizationMs: 1500,
  fallbackStabilizationMs: 5000,
};

export type Verdict = Extract<
  Event,
  {
    type:
      | "VERDICT_WAITING"
      | "VERDICT_GENERATING"
      | "VERDICT_STABILIZING"
      | "VERDICT_COMPLETE"
      | "VERDICT_TIMEOUT"
      | "VERDICT_CHAT_ERROR"
      | "VERDICT_RATE_LIMITED"
      | "VERDICT_CHALLENGE";
  }
>;

/** Derived facts from the observation history (pure). */
export function derive(history: readonly Observation[], baseline: number) {
  let streamingSeen = false;
  let streamingOffAt: number | null = null;
  let prevStreaming = false;
  let lastHash: string | null = null;
  let lastHashChangedAt: number | null = null;
  let responseSeenAt: number | null = null;
  for (const o of history) {
    if (o.streaming) streamingSeen = true;
    if (prevStreaming && !o.streaming) streamingOffAt = o.t;
    prevStreaming = o.streaming;
    if (o.assistantCount > baseline) {
      if (responseSeenAt === null) responseSeenAt = o.t;
      if (o.lastAssistantHash !== lastHash) {
        lastHash = o.lastAssistantHash;
        lastHashChangedAt = o.t;
      }
    }
  }
  return { streamingSeen, streamingOffAt, lastHashChangedAt, responseSeenAt };
}

/** 10-ARCHITECTURE §6: rules evaluated top to bottom on the latest observation. */
export function judge(
  history: readonly Observation[],
  baseline: number,
  cfg: CompletionConfig,
): Verdict {
  const o = history[history.length - 1];
  if (!o) return { type: "VERDICT_WAITING" };
  if (o.challenge !== "none") return { type: "VERDICT_CHALLENGE", kind: o.challenge };
  if (o.errorBanner === "rate_limited") return { type: "VERDICT_RATE_LIMITED" };
  if (o.errorBanner === "chat_error") return { type: "VERDICT_CHAT_ERROR", cause: "banner" };
  if (o.errorBanner === "network") return { type: "VERDICT_CHAT_ERROR", cause: "network" };
  if (o.truncated) return { type: "VERDICT_CHAT_ERROR", cause: "output_truncated" };
  if (o.assistantCount - baseline > 1)
    return { type: "VERDICT_CHAT_ERROR", cause: "multiple_responses" };
  if (o.t >= cfg.timeoutMs) return { type: "VERDICT_TIMEOUT" };
  if (o.assistantCount <= baseline) return { type: "VERDICT_WAITING" };
  if (o.streaming) return { type: "VERDICT_GENERATING" };

  const d = derive(history, baseline);
  if (d.streamingSeen) {
    const origin = Math.max(d.streamingOffAt ?? o.t, d.lastHashChangedAt ?? 0);
    if (o.t - origin >= cfg.stabilizationMs && o.composerReady) return { type: "VERDICT_COMPLETE" };
    return { type: "VERDICT_STABILIZING" };
  }
  const origin = Math.max(d.responseSeenAt ?? o.t, d.lastHashChangedAt ?? 0);
  if (o.t - origin >= cfg.fallbackStabilizationMs && o.composerReady && o.copyAvailable) {
    return { type: "VERDICT_COMPLETE" };
  }
  return { type: "VERDICT_STABILIZING" };
}
