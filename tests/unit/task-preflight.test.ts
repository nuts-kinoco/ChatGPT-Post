import { describe, expect, it } from "vitest";
import { type QuotaObservation, quotaDecision } from "../../src/state/task-preflight.js";

const now = new Date("2026-10-03T00:00:00Z");
const unknown: QuotaObservation = {
  source: "unknown",
  observedAt: null,
  windowEndsAt: null,
  remainingPercent: null,
  maxAgeSeconds: 300,
};
describe("quota observations never imply billing or model authority", () => {
  it("requires observation or authorization by default", () => {
    expect(quotaDecision(unknown, null, false, now).mayContinue).toBe(false);
  });
  it("allows no-response unknown only within explicitly preauthorized bounded fallback", () => {
    const fallback = { preauthorized: true, maxStarts: 2, maxRunSeconds: 60 };
    expect(quotaDecision(unknown, fallback, false, now)).toEqual({
      state: "unknown",
      mayContinue: true,
      reason: "preauthorized_bounded_fallback",
    });
    expect(
      quotaDecision(unknown, { ...fallback, preauthorized: false }, false, now).mayContinue,
    ).toBe(false);
    expect(quotaDecision(unknown, fallback, true, now).mayContinue).toBe(false);
  });
  it("treats stale/future/reset-window percentages as unknown, never as a quota reset", () => {
    for (const patch of [
      { observedAt: "2026-10-02T23:00:00Z" },
      { observedAt: "2026-10-03T01:00:00Z" },
      { windowEndsAt: "2026-10-02T23:59:59Z" },
      { remainingPercent: -1 },
    ]) {
      expect(
        quotaDecision(
          {
            source: "provider",
            observedAt: now.toISOString(),
            windowEndsAt: "2026-10-03T05:00:00Z",
            remainingPercent: 10,
            maxAgeSeconds: 300,
            ...patch,
          },
          null,
          false,
          now,
        ).state,
      ).toBe("unknown");
    }
  });
  it("accepts a fresh user observation without pretending it is a provider reading", () => {
    const reported: QuotaObservation = {
      source: "user",
      observedAt: now.toISOString(),
      windowEndsAt: "2026-10-03T05:00:00Z",
      remainingPercent: 20,
      maxAgeSeconds: 300,
    };
    expect(quotaDecision(reported, null, false, now).state).toBe("observed");
    expect(reported.source).toBe("user");
  });
});
