import { describe, expect, it } from "vitest";
import {
  ELEMENTS,
  type ElementKey,
  PRESET_LABELS,
  reverseLookupPreset,
} from "../../src/chatgpt/selectors.js";

/** Elements the `run` path depends on; each needs at least one real-screen-verified candidate (OPS-008). */
const RUN_CRITICAL: ElementKey[] = [
  "composer",
  "sendButton",
  "stopButton",
  "modelPicker",
  "modelPickerCurrentLabel",
  "assistantTurn",
  "assistantTurnBody",
  "copyTurnButton",
  "loginCta",
];

describe("selectors (14-SELECTOR-STRATEGY, AC-016)", () => {
  it("run-critical elements have a verified candidate", () => {
    for (const key of RUN_CRITICAL) {
      const verified = ELEMENTS[key].candidates.filter((c) => c.verifiedOn);
      expect(verified.length, key).toBeGreaterThan(0);
    }
  });
  it("preset label sets are pairwise disjoint and reverse lookup is unique", () => {
    const all = new Map<string, string>();
    for (const [preset, byLocale] of Object.entries(PRESET_LABELS)) {
      for (const labels of Object.values(byLocale)) {
        for (const l of labels) {
          expect(all.has(l.toLowerCase()), `duplicate label ${l}`).toBe(false);
          all.set(l.toLowerCase(), preset);
        }
      }
    }
    expect(reverseLookupPreset("極高", "ja")).toEqual({ preset: "extra_high" });
    expect(reverseLookupPreset("思考量", "ja")).toEqual({ error: "unmapped" });
  });
});
