import { describe, expect, it } from "vitest";
import {
  computeUsage,
  DEFAULT_LIMITS,
  formatUsage,
  type UsageRecord,
  validateLimits,
} from "../../src/diagnostics/usage.js";

const now = new Date("2026-09-15T12:00:00Z");
function rec(over: Partial<UsageRecord>): UsageRecord {
  return {
    requestId: "r",
    startedAt: "2026-09-15T11:00:00Z",
    submitted: "yes",
    status: "completed",
    errorCode: null,
    observedPreset: "high",
    observedModel: "latest",
    observedModelSlug: "gpt-5-6-thinking",
    attachments: 0,
    ...over,
  };
}

describe("usage ledger (PO 2026-09-15)", () => {
  it("counts only submitted messages, per slug pattern and rolling window", () => {
    const records = [
      rec({ requestId: "a", observedModelSlug: "gpt-6-pro" }),
      rec({ requestId: "b", observedModelSlug: "gpt-6-pro", startedAt: "2026-09-01T00:00:00Z" }), // out of week
      rec({ requestId: "c", submitted: "no", observedModelSlug: "gpt-6-pro" }), // not sent
      rec({ requestId: "d", observedModelSlug: "gpt-5-6" }),
      rec({ requestId: "e", attachments: 3 }),
      rec({ requestId: "f", errorCode: "RATE_LIMITED", status: "manual_intervention_required" }),
    ];
    const r = computeUsage(records, DEFAULT_LIMITS, now);
    const by = Object.fromEntries(r.lines.map((l) => [l.key, l]));
    expect(by.pro_pool?.used).toBe(1);
    expect(by.pro_pool?.remaining).toBe(49);
    expect(by.thinking_day?.used).toBe(2); // e, f (a is pro, d is instant)
    expect(by.instant_day?.used).toBe(1);
    expect(by.all_day?.used).toBe(4); // a, d, e, f (b out of window, c not sent)
    expect(by.attachments_3h?.used).toBe(3);
    expect(by.attachments_3h?.remaining).toBe(77);
    expect(r.lastRateLimited?.requestId).toBe("f");
    expect(formatUsage(r)).toContain("残り 49");
  });
  it("validateLimits rejects broken windows (Codex P5-4)", () => {
    expect("limits" in validateLimits(DEFAULT_LIMITS)).toBe(true);
    expect(
      validateLimits({ windows: { x: { label: "a", slug: "(", limit: null, windowHours: 1 } } }),
    ).toEqual({
      error: "x: slug is not a valid regex",
    });
    expect(
      validateLimits({ windows: { x: { label: "a", slug: "*", limit: -1, windowHours: 1 } } }),
    ).toHaveProperty("error");
    expect(
      validateLimits({ windows: { x: { label: "a", slug: "*", limit: 1, windowHours: "1" } } }),
    ).toHaveProperty("error");
    expect(validateLimits({ windows: {} })).toEqual({ error: "no windows" });
  });
  it("unknown limits report counts without remaining", () => {
    const r = computeUsage([rec({})], DEFAULT_LIMITS, now);
    const t = r.lines.find((l) => l.key === "thinking_day");
    expect(t?.used).toBe(1);
    expect(t?.remaining).toBeNull();
  });
});
