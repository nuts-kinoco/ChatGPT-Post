import { describe, expect, it } from "vitest";
import { type CompletionConfig, judge, type Observation } from "../../src/chatgpt/completion.js";

const cfg: CompletionConfig = {
  timeoutMs: 60_000,
  stabilizationMs: 1500,
  fallbackStabilizationMs: 5000,
};

function obs(t: number, o: Partial<Observation> = {}): Observation {
  return {
    t,
    assistantCount: 1,
    lastAssistantHash: "h1",
    lastAssistantEmpty: false,
    streaming: false,
    composerReady: true,
    copyAvailable: true,
    truncated: false,
    sidePanel: false,
    errorBanner: "none",
    challenge: "none",
    ...o,
  };
}

/** Build a timeline with 250ms ticks from a list of [durationMs, partial] segments. */
function timeline(segments: Array<[number, Partial<Observation>]>): Observation[] {
  const out: Observation[] = [];
  let t = 0;
  for (const [dur, o] of segments) {
    for (let i = 0; i < dur; i += 250) {
      out.push(obs(t, o));
      t += 250;
    }
  }
  return out;
}

describe("completion.judge (10-ARCHITECTURE §6)", () => {
  it("normal: waiting -> generating -> stabilizing -> complete after 1500ms with composer ready", () => {
    const h = timeline([
      [1000, { assistantCount: 0 }],
      [2000, { streaming: true, composerReady: false, lastAssistantHash: "h1" }],
      [1500, { streaming: false, composerReady: true, lastAssistantHash: "h2" }],
    ]);
    expect(judge(h.slice(0, 2), 0, cfg).type).toBe("VERDICT_WAITING");
    expect(judge(h.slice(0, 8), 0, cfg).type).toBe("VERDICT_GENERATING");
    expect(judge(h.slice(0, 13), 0, cfg).type).toBe("VERDICT_STABILIZING");
    h.push(obs(h.length * 250, { streaming: false, lastAssistantHash: "h2" }));
    h.push(obs(h.length * 250, { streaming: false, lastAssistantHash: "h2" }));
    expect(judge(h, 0, cfg).type).toBe("VERDICT_COMPLETE");
  });

  it("does not count stable time while the stop button is visible", () => {
    const h = timeline([
      [10_000, { streaming: true, composerReady: false, lastAssistantHash: "same" }],
    ]);
    h.push(obs(10_000, { streaming: false, lastAssistantHash: "same" }));
    expect(judge(h, 0, cfg).type).toBe("VERDICT_STABILIZING");
    h.push(obs(11_500, { streaming: false, lastAssistantHash: "same" }));
    expect(judge(h, 0, cfg).type).toBe("VERDICT_COMPLETE");
  });

  it("stop button flickering for one observation resets nothing harmful", () => {
    const h = timeline([[2000, { streaming: true, composerReady: false }]]);
    h.push(obs(2000, { streaming: false, composerReady: false }));
    h.push(obs(2250, { streaming: true, composerReady: false }));
    expect(judge(h, 0, cfg).type).toBe("VERDICT_GENERATING");
  });

  it("hash change after stop-button disappearance moves the stabilization origin", () => {
    const h = timeline([[2000, { streaming: true, composerReady: false, lastAssistantHash: "a" }]]);
    h.push(obs(2000, { streaming: false, lastAssistantHash: "a" }));
    h.push(obs(2500, { streaming: false, lastAssistantHash: "b" })); // late re-render
    h.push(obs(3500, { streaming: false, lastAssistantHash: "b" }));
    expect(judge(h, 0, cfg).type).toBe("VERDICT_STABILIZING"); // 1000ms since change
    h.push(obs(4000, { streaming: false, lastAssistantHash: "b" }));
    expect(judge(h, 0, cfg).type).toBe("VERDICT_COMPLETE"); // 1500ms since change
  });

  it("fallback path when streaming was never observed needs 5s + composerReady + copyAvailable", () => {
    const h = timeline([
      [5000, { streaming: false, lastAssistantHash: "x", copyAvailable: false }],
    ]);
    expect(judge(h, 0, cfg).type).toBe("VERDICT_STABILIZING");
    h.push(obs(5000, { streaming: false, lastAssistantHash: "x", copyAvailable: true }));
    expect(judge(h, 0, cfg).type).toBe("VERDICT_COMPLETE");
  });

  it("composerReady=false blocks completion on the main path", () => {
    const h = timeline([[1000, { streaming: true, composerReady: false }]]);
    h.push(obs(1000, { streaming: false, composerReady: false }));
    h.push(obs(3000, { streaming: false, composerReady: false }));
    expect(judge(h, 0, cfg).type).toBe("VERDICT_STABILIZING");
  });

  it("empty body still completes (extraction decides EXTRACTION_FAILED)", () => {
    const h = timeline([[1000, { streaming: true, composerReady: false }]]);
    h.push(obs(1000, { streaming: false, lastAssistantEmpty: true, lastAssistantHash: "e" }));
    h.push(obs(3000, { streaming: false, lastAssistantEmpty: true, lastAssistantHash: "e" }));
    expect(judge(h, 0, cfg).type).toBe("VERDICT_COMPLETE");
  });

  it("timeoutMs wins even while streaming, but reports VERDICT_TIMEOUT_ACTIVE not plain VERDICT_TIMEOUT (#124)", () => {
    // The wall-clock deadline still stops the wait — it must not keep watching forever
    // just because streaming is true. But a bare VERDICT_TIMEOUT here would be
    // indistinguishable from a genuine stall, and a caller (bridge CLI user) reading
    // GENERATION_TIMEOUT would reasonably retry — colliding with the still-running
    // generation on the same shared profile (2026-09-17 incident).
    const h = timeline([[1000, { streaming: true, composerReady: false }]]);
    h.push(obs(60_000, { streaming: true, composerReady: false }));
    expect(judge(h, 0, cfg).type).toBe("VERDICT_TIMEOUT_ACTIVE");
  });

  it("timeoutMs while genuinely stalled (not streaming) still reports plain VERDICT_TIMEOUT", () => {
    const h = timeline([[1000, { streaming: false, composerReady: false }]]);
    h.push(obs(60_000, { streaming: false, composerReady: false }));
    expect(judge(h, 0, cfg).type).toBe("VERDICT_TIMEOUT");
  });

  it("no assistant ever -> waiting -> timeout (no separate first-response limit)", () => {
    const h = [obs(1000, { assistantCount: 0 }), obs(59_000, { assistantCount: 0 })];
    expect(judge(h, 0, cfg).type).toBe("VERDICT_WAITING");
    h.push(obs(60_000, { assistantCount: 0 }));
    expect(judge(h, 0, cfg).type).toBe("VERDICT_TIMEOUT");
  });

  it("transient count drop yields VERDICT_WAITING (machine keeps generating)", () => {
    const h = timeline([[1000, { streaming: true, composerReady: false }]]);
    h.push(obs(1000, { assistantCount: 0, streaming: true }));
    expect(judge(h, 0, cfg).type).toBe("VERDICT_WAITING");
  });

  it("error/challenge/truncated/multiple take precedence", () => {
    expect(judge([obs(0, { errorBanner: "chat_error" })], 0, cfg)).toEqual({
      type: "VERDICT_CHAT_ERROR",
      cause: "banner",
    });
    expect(judge([obs(0, { errorBanner: "network" })], 0, cfg)).toEqual({
      type: "VERDICT_CHAT_ERROR",
      cause: "network",
    });
    expect(judge([obs(0, { errorBanner: "rate_limited" })], 0, cfg).type).toBe(
      "VERDICT_RATE_LIMITED",
    );
    expect(judge([obs(0, { challenge: "login" })], 0, cfg)).toEqual({
      type: "VERDICT_CHALLENGE",
      kind: "login",
    });
    expect(judge([obs(0, { truncated: true })], 0, cfg)).toEqual({
      type: "VERDICT_CHAT_ERROR",
      cause: "output_truncated",
    });
    expect(judge([obs(0, { assistantCount: 2 })], 0, cfg)).toEqual({
      type: "VERDICT_CHAT_ERROR",
      cause: "multiple_responses",
    });
    // challenge beats timeout
    expect(judge([obs(99_999, { challenge: "captcha" })], 0, cfg).type).toBe("VERDICT_CHALLENGE");
  });
});
