import type { Page } from "playwright";
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
  probe,
  resolve,
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
  it("A-144 Project selectors are live-verified (2026-09-22), except the creation submit click itself", () => {
    // projectSidebarItem/projectOpenHomeButton (find+open an existing Project) and
    // newProjectButton/newProjectNameInput (open the creation dialog, fill the name) were all
    // confirmed against the real chatgpt.com DOM. newProjectConfirmButton's element and its
    // enable-on-fill behavior were confirmed too, but the click was never exercised live (that
    // would have created a real Project in the account under test) -- see its own `purpose` note.
    const projectKeys: ElementKey[] = [
      "projectSidebarItem",
      "projectOpenHomeButton",
      "newProjectButton",
      "newProjectNameInput",
      "newProjectConfirmButton",
    ];
    for (const key of projectKeys) {
      expect(
        ELEMENTS[key].candidates.some((candidate) => candidate.verifiedOn),
        key,
      ).toBe(true);
    }
  });

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
    expect(parseTriggerLabel("Pro", "ja")).toEqual({
      preset: "pro",
      effortLabel: "Pro",
      modelHint: null,
    });
    expect(parseTriggerLabel("思考量", "ja")).toEqual({ error: "unmapped" });
    expect(parseTriggerLabel("5.5高", "ja")).toEqual({ error: "unmapped" }); // no separator
    // unknown prefixes are refused (Codex P5-3)
    expect(parseTriggerLabel("Unknown Pro", "ja")).toEqual({ error: "unmapped" });
    expect(parseTriggerLabel("Foo 高", "ja")).toEqual({ error: "unmapped" });
  });
  it("hintMatches cross-checks the trigger prefix with the menu observation", () => {
    // A-161: the redesigned trigger renders latest Pro as bare "Pro".
    expect(hintMatches(null, "latest", "high")).toBe(true);
    expect(hintMatches(null, "latest", "pro")).toBe(true);
    expect(hintMatches(null, "gpt-5.5", "pro")).toBe(false);
    expect(hintMatches(null, "gpt-5.6-sol", "pro")).toBe(false);
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

  it("A-123 (Phase 0-C-2, ChatGPT Pro redesign review §2.2): resolve()/probe() return the actually-visible match, not DOM-order index 0", async () => {
    // Two DOM matches for composer's first (css) candidate: index 0 is hidden, index 1 is the
    // real visible one. The old code checked countVisible()===1 but returned loc.first() (index
    // 0) — this fixture reproduces exactly that mismatch.
    const nths = [
      { _idx: 0, isVisible: async () => false, isEnabled: async () => true },
      { _idx: 1, isVisible: async () => true, isEnabled: async () => true },
    ];
    const fakeLocator = {
      count: async () => nths.length,
      nth: (i: number) => nths[i],
      first: () => nths[0], // what the old, buggy code would have returned
    };
    const fakeRoot = { locator: () => fakeLocator };

    const resolved = await resolve(fakeRoot as unknown as Page, "composer", {
      verifiedOnly: true,
    });
    expect((resolved as unknown as { _idx: number })._idx).toBe(1);

    const probed = await probe(fakeRoot as unknown as Page, "composer", { verifiedOnly: true });
    expect(probed.found).toBe(true);
    expect((probed.locator as unknown as { _idx: number })._idx).toBe(1);
  });
});
