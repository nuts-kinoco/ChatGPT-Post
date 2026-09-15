import { describe, expect, it } from "vitest";
import {
  EFFORT_INDEX_OF,
  EFFORT_SLIDER_INDEX,
  EFFORT_SLIDER_MAX,
  ELEMENTS,
  type ElementKey,
  hintMatches,
  PRESET_LABELS,
  parseTriggerLabel,
  reverseLookupModel,
  reverseLookupPreset,
} from "../../src/chatgpt/selectors.js";
import type { ObservedPreset } from "../../src/contracts/types.js";

/** Elements the `run` path depends on; each needs at least one real-screen-verified candidate (OPS-008). */
const RUN_CRITICAL: ElementKey[] = [
  "composer",
  "sendButton",
  "stopButton",
  "modelPicker",
  "modelPickerCurrentLabel",
  "pickerMenu",
  "effortSlider",
  "effortSliderRow",
  "modelExpander",
  "modelRadio",
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
  it("preset label sets are pairwise disjoint across presets and reverse lookup is unique", () => {
    const all = new Map<string, string>();
    for (const [preset, byLocale] of Object.entries(PRESET_LABELS)) {
      for (const labels of Object.values(byLocale)) {
        for (const l of labels) {
          const prev = all.get(l.toLowerCase());
          // the same label may appear in ja and en of one preset (Instant / Pro), never in two presets
          expect(prev === undefined || prev === preset, `label ${l} in ${prev} and ${preset}`).toBe(
            true,
          );
          all.set(l.toLowerCase(), preset);
        }
      }
    }
    // all five levels confirmed on 2026-09-15 (ja)
    expect(reverseLookupPreset("Instant", "ja")).toEqual({ preset: "instant" });
    expect(reverseLookupPreset("中程度", "ja")).toEqual({ preset: "medium" });
    expect(reverseLookupPreset("高", "ja")).toEqual({ preset: "high" });
    expect(reverseLookupPreset("極高", "ja")).toEqual({ preset: "extra_high" });
    expect(reverseLookupPreset("Pro", "ja")).toEqual({ preset: "pro" });
    expect(reverseLookupPreset("思考量", "ja")).toEqual({ error: "unmapped" });
    for (let i = 0; i <= EFFORT_SLIDER_MAX; i++) {
      const preset = EFFORT_SLIDER_INDEX[i] as ObservedPreset;
      expect(EFFORT_INDEX_OF[preset]).toBe(i);
    }
  });
  it("trigger label parses whole-label and '<model> <effort>' forms (longest effort label first)", () => {
    expect(parseTriggerLabel("極高", "ja")).toEqual({
      preset: "extra_high",
      effortLabel: "極高",
      modelHint: null,
    });
    expect(parseTriggerLabel("5.5 高", "ja")).toEqual({
      preset: "high",
      effortLabel: "高",
      modelHint: "5.5",
    });
    expect(parseTriggerLabel("5.6 極高", "ja")).toEqual({
      preset: "extra_high",
      effortLabel: "極高",
      modelHint: "5.6",
    });
    expect(parseTriggerLabel("6 Pro", "ja")).toEqual({
      preset: "pro",
      effortLabel: "Pro",
      modelHint: "6",
    });
    expect(parseTriggerLabel("思考量", "ja")).toEqual({ error: "unmapped" });
    expect(parseTriggerLabel("5.5高", "ja")).toEqual({ error: "unmapped" }); // no separator
    // unknown prefixes are refused (Codex P5-3)
    expect(parseTriggerLabel("Unknown Pro", "ja")).toEqual({ error: "unmapped" });
    expect(parseTriggerLabel("Foo 高", "ja")).toEqual({ error: "unmapped" });
  });
  it("hintMatches cross-checks the trigger prefix with the menu observation", () => {
    expect(hintMatches(null, "latest", "high")).toBe(true);
    expect(hintMatches(null, "latest", "pro")).toBe(false); // pro on latest shows "6 Pro"
    expect(hintMatches("6", "latest", "pro")).toBe(true);
    expect(hintMatches("6", "latest", "high")).toBe(false);
    expect(hintMatches("5.5", "gpt-5.5", "high")).toBe(true);
    expect(hintMatches("5.5", "latest", "high")).toBe(false);
    expect(hintMatches("5.6", "gpt-5.6-sol", "medium")).toBe(true);
    expect(hintMatches(null, "gpt-5.6-sol", "medium")).toBe(false);
    expect(hintMatches("7", "latest", "high")).toBe(false);
  });
  it("model radio text maps by its first line (GPT-5.5 carries a retirement notice)", () => {
    expect(reverseLookupModel("最新", "ja")).toEqual({ model: "latest" });
    expect(reverseLookupModel("GPT-5.6 Sol", "ja")).toEqual({ model: "gpt-5.6-sol" });
    expect(reverseLookupModel("GPT-5.5\n10月14日 に提供終了予定", "ja")).toEqual({
      model: "gpt-5.5",
    });
    expect(reverseLookupModel("GPT-7", "ja")).toEqual({ error: "unmapped" });
  });
});
