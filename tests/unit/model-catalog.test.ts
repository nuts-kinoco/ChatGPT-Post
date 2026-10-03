import { readFile } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import {
  buildModelCatalog,
  legacyCatalogSelection,
  MAX_MODEL_LABEL_LENGTH,
  MODEL_SELECTOR_PROFILE,
  type ModelRowObservation,
  type VisibleModelCatalog,
} from "../../src/chatgpt/model-catalog.js";
import { ChatGptPage } from "../../src/chatgpt/page.js";
import { parseTriggerLabel, reverseLookupModel } from "../../src/chatgpt/selectors.js";

const options = { contextId: "test-session", observedAt: "2026-10-03T00:00:00Z" };
function row(label = "Latest", checked = true, enabled = true): ModelRowObservation {
  return { label, checked, enabled, providerModelId: null };
}
const make = (rows: ModelRowObservation[]) => buildModelCatalog(rows, options);
const idProfile = {
  ...MODEL_SELECTOR_PROFILE,
  version: "synthetic-reviewed-id-v1",
  providerModelIdAttribute: "data-fixture-provider-id",
};

describe("pure versioned read-only browser model catalog", () => {
  it("records exact label and legacy alias but no provider identity or execution authority", () => {
    const catalog = make([row("  Latest  ")]);
    expect(catalog).toMatchObject({
      schema: "bridge-provider-catalog-1",
      version: "chatgpt-visible-model-catalog-1",
      provider: "chatgpt",
      route: "ordinary_chat_browser",
      complete: true,
      reason: "none",
      executionAuthorized: false,
      accountAvailability: "unknown",
      cost: "unknown",
    });
    expect(catalog.options[0]).toMatchObject({
      label: "  Latest  ",
      legacyModel: "latest",
      providerModelId: null,
      identitySource: "unverified_label",
      checked: true,
      enabled: true,
      effort: { scope: "unknown", values: [] },
    });
    expect(catalog.options[0]?.observationKey).toMatch(/^ui-option:/);
    expect(
      catalog.selectorProfileEvidence.some((evidence) => evidence.kind === "structural_capture"),
    ).toBe(true);
  });
  it("unknown future label/ID remains discovery-only", () => {
    const catalog = buildModelCatalog(
      [{ ...row("GPT-8 Future"), providerModelId: "provider-new-8" }],
      { ...options, profile: idProfile },
    );
    expect(catalog.options[0]).toMatchObject({
      label: "GPT-8 Future",
      providerModelId: "provider-new-8",
      legacyModel: null,
    });
    expect(legacyCatalogSelection(catalog, "current")).toMatchObject({
      ok: false,
      cause: "unmapped model label",
    });
    expect(reverseLookupModel("GPT-8 Future", "en")).toEqual({ error: "unmapped" });
    expect(parseTriggerLabel("8 Pro", "en")).toEqual({ error: "unmapped" });
    expect(catalog.executionAuthorized).toBe(false);
  });
  it("ignores unreviewed provider IDs instead of trusting arbitrary DOM attributes", () => {
    const catalog = make([{ ...row(), providerModelId: "looks-like-a-provider-id" }]);
    expect(catalog.options[0]?.providerModelId).toBeNull();
  });
  it.each(["Latest", "最新", "GPT-5.6 Sol", "GPT-5.5\nLeaving on October 14"])(
    "retains legacy mapping for %s",
    (label) => {
      expect(legacyCatalogSelection(make([row(label)]), "current").ok).toBe(true);
    },
  );
  it("disabled known option cannot be selected or accepted as current", () => {
    const catalog = make([row("Latest", true, false)]);
    expect(catalog.complete).toBe(true);
    expect(legacyCatalogSelection(catalog, "latest")).toMatchObject({ ok: false });
    expect(legacyCatalogSelection(catalog, "current")).toMatchObject({ ok: false });
  });
  it.each(["checked", "enabled", "label"] as const)(
    "unknown %s is incomplete, never defaulted",
    (field) => {
      const catalog = make([{ ...row(), [field]: null }]);
      expect(catalog).toMatchObject({ complete: false, reason: "incomplete" });
      expect(legacyCatalogSelection(catalog, "latest").ok).toBe(false);
    },
  );
  it("truncation cannot turn oversized text into an executable label", () => {
    const catalog = make([row(`Latest\n${"x".repeat(MAX_MODEL_LABEL_LENGTH)}`)]);
    expect(catalog).toMatchObject({ complete: false, reason: "incomplete" });
    expect(catalog.options[0]?.label).toHaveLength(MAX_MODEL_LABEL_LENGTH);
    expect(catalog.options[0]?.legacyModel).toBeNull();
  });
  it("preserves duplicate rows as complete but ambiguous observations", () => {
    const catalog = make([row(), row("Latest", false)]);
    expect(catalog.options).toHaveLength(2);
    expect(new Set(catalog.options.map((o) => o.observationKey)).size).toBe(2);
    expect(catalog).toMatchObject({ complete: true, reason: "ambiguous" });
    expect(catalog.issues).toContain("duplicate_label");
    expect(legacyCatalogSelection(catalog, "latest").ok).toBe(false);
  });
  it("duplicate legacy aliases across locales are also ambiguous", () => {
    const catalog = make([row(), row("最新", false)]);
    expect(catalog.issues).toContain("duplicate_legacy_model");
    expect(legacyCatalogSelection(catalog, "latest").ok).toBe(false);
  });
  it("duplicate reviewed provider IDs are ambiguous even with distinct labels", () => {
    const catalog = buildModelCatalog(
      [
        { ...row(), providerModelId: "id" },
        { ...row("Other", false), providerModelId: "id" },
      ],
      { ...options, profile: idProfile },
    );
    expect(catalog.issues).toContain("duplicate_id");
    expect(catalog.options.every((o) => o.ambiguity === "duplicate_id")).toBe(true);
    expect(legacyCatalogSelection(catalog, "latest").ok).toBe(false);
  });
  it.each([[[row(), row("GPT-5.5")]], [[row("Latest", false)]]])(
    "rejects invalid checked cardinality",
    (rows) => {
      const catalog = make(rows);
      expect(catalog.issues).toContain("checked_count_invalid");
      expect(legacyCatalogSelection(catalog, "current").ok).toBe(false);
    },
  );
  it("missing reviewed provider ID makes discovery incomplete", () => {
    const catalog = buildModelCatalog([row()], { ...options, profile: idProfile });
    expect(catalog).toMatchObject({ complete: false, reason: "incomplete" });
    expect(catalog.options[0]?.providerModelId).toBeNull();
  });
  it("fingerprint and per-option identity ignore display order/time but bind material state/profile/context", () => {
    const rows = [row(), row("GPT-5.5", false)];
    const original = make(rows);
    const reordered = buildModelCatalog([...rows].reverse(), {
      ...options,
      observedAt: "2026-10-04T00:00:00Z",
    });
    expect(reordered.catalogFingerprint).toBe(original.catalogFingerprint);
    expect(reordered.options.map((o) => o.observationKey).sort()).toEqual(
      original.options.map((o) => o.observationKey).sort(),
    );
    for (const changed of [
      make([row("Latest", false), row("GPT-5.5", true)]),
      make([row("Latest", true, false), row("GPT-5.5", false)]),
      buildModelCatalog(rows, {
        ...options,
        profile: { ...MODEL_SELECTOR_PROFILE, version: "next" },
      }),
      buildModelCatalog(rows, { ...options, contextId: "other-session" }),
      buildModelCatalog(rows, { ...options, complete: false, issues: ["row_changed"] }),
    ])
      expect(changed.catalogFingerprint).not.toBe(original.catalogFingerprint);
  });
  it("the real sanitized redesign fixture exposes no provider model ID", async () => {
    const html = await readFile(
      new URL("../fixtures/chatgpt-2026-09-24-redesign.html", import.meta.url),
      "utf8",
    );
    const match = html.match(/<div role="menuitemradio"([^>]*)>([^<]*)<\/div>/);
    expect(match).not.toBeNull();
    expect(match?.[1]).not.toContain("model-id");
    const catalog = make([row(match?.[2])]);
    expect(catalog.options[0]?.providerModelId).toBeNull();
  });
});

interface PickerInternals {
  resolvePreset(
    requested: "current" | "high",
    model: "current" | "latest",
  ): Promise<{ kind: string; cause?: string }>;
  readModelCatalog(menu: Locator): Promise<{ catalog: VisibleModelCatalog; locators: Locator[] }>;
  observeModel(menu: Locator): Promise<{ ok: boolean; model?: string }>;
  selectModel(
    menu: Locator,
    target: "latest" | "gpt-5.5",
  ): Promise<{ ok: boolean; cause?: string }>;
  selectEffort(menu: Locator, target: "high"): Promise<{ ok: boolean }>;
  listPresetOptions(walk: boolean): Promise<Record<string, unknown>>;
  openPicker(): Promise<Locator>;
  closePicker(): Promise<void>;
  readPresetLabel(): Promise<string>;
  readSlider(menu: Locator): Promise<unknown>;
}
function fakePicker(initial: ModelRowObservation[]) {
  let rows = initial;
  const hidden = new Set<number>();
  const clicks = vi.fn(async (index: number) => {
    rows = rows.map((r, i) => ({ ...r, checked: i === index }));
  });
  const items = () =>
    rows.map((_r, i) => ({
      isVisible: vi.fn(async () => !hidden.has(i)),
      isEnabled: vi.fn(async () => rows[i]?.enabled ?? true),
      innerText: vi.fn(async () => rows[i]?.label),
      getAttribute: vi.fn(async (name: string) =>
        name === "aria-checked"
          ? rows[i]?.checked === null
            ? null
            : String(rows[i]?.checked)
          : name === "aria-disabled"
            ? rows[i]?.enabled === null
              ? "unknown"
              : String(!rows[i]?.enabled)
            : null,
      ),
      click: vi.fn(async () => clicks(i)),
    }));
  let locators = items();
  const collection = { count: vi.fn(async () => rows.length), nth: (i: number) => locators[i] };
  const expander = {
    count: async () => 1,
    nth: () => ({ isVisible: async () => true, getAttribute: async () => "true" }),
  };
  const menu = {
    getByRole: vi.fn(() => collection),
    locator: vi.fn(() => expander),
  } as unknown as Locator;
  const keyboard = { press: vi.fn() };
  const page = {
    on: vi.fn(),
    addInitScript: async () => {},
    waitForTimeout: async () => {},
    keyboard,
    locator: vi.fn(),
  } as unknown as Page;
  const chat = new ChatGptPage(page, { verifiedOnly: true }) as unknown as PickerInternals;
  return {
    chat,
    menu,
    hidden,
    clicks,
    collection,
    keyboard,
    page,
    get locators() {
      return locators;
    },
    setRows(next: ModelRowObservation[]) {
      rows = next;
      locators = items();
    },
  };
}

function configureEffort(fake: ReturnType<typeof fakePicker>, sliderVisible: boolean) {
  let now = 0;
  const slider = {
    isVisible: async () => sliderVisible,
    getAttribute: async (name: string) =>
      name === "aria-valuenow" ? String(now) : name === "aria-valuemax" ? "4" : null,
    focus: vi.fn(async () => {}),
  };
  const rowControl = {
    isVisible: async () => true,
    getAttribute: async () => "synthetic-effort-value",
    focus: vi.fn(async () => {}),
  };
  const expander = { isVisible: async () => true, getAttribute: async () => "true" };
  vi.mocked(fake.menu.locator).mockImplementation(
    (selector: string) =>
      ({
        count: async () => 1,
        nth: () =>
          selector.includes("[role=slider]") || selector.includes('[role="slider"]')
            ? slider
            : selector.includes("data-reasoning-slider") || selector.includes("aria-describedby")
              ? rowControl
              : expander,
      }) as unknown as Locator,
  );
  vi.mocked(fake.page.locator).mockImplementation((selector: string) => {
    if (selector === '[id="synthetic-effort-value"]')
      return {
        innerText: async () => (now === 2 ? "High, 3 of 5" : "Instant, 1 of 5"),
      } as unknown as Locator;
    return {
      count: async () => 1,
      nth: () => ({
        isVisible: async () => true,
        isEnabled: async () => true,
        innerText: async () => (now === 2 ? "High" : "Instant"),
      }),
    } as unknown as Locator;
  });
  fake.keyboard.press.mockImplementation(async (key: string) => {
    if (key === "Home") now = 0;
    if (key === "ArrowRight") now++;
  });
}

describe("offline scoped picker collection and legacy mutations", () => {
  it("excludes hidden stale rows and reads more than twenty visible options", async () => {
    const fake = fakePicker([
      row(),
      ...Array.from({ length: 24 }, (_, i) => row(`Future ${i}`, false)),
    ]);
    fake.hidden.add(1);
    const result = await fake.chat.readModelCatalog(fake.menu);
    expect(result.catalog.complete).toBe(true);
    expect(result.catalog.options).toHaveLength(24);
    expect(result.catalog.options.map((o) => o.label)).not.toContain("Future 0");
    expect(result.catalog.options.at(-1)?.label).toBe("Future 23");
    expect(fake.clicks).not.toHaveBeenCalled();
    expect(fake.keyboard.press).not.toHaveBeenCalled();
  });
  it.each([
    [row(), row("Latest", false)],
    [row(), row("GPT-5.5", false, false)],
    [row(), { ...row("GPT-5.5", false), checked: null }],
  ])("fails before click on disabled, duplicate or incomplete observations", async (...rows) => {
    const fake = fakePicker(rows);
    expect((await fake.chat.selectModel(fake.menu, "gpt-5.5")).ok).toBe(false);
    expect(fake.clicks).not.toHaveBeenCalled();
  });
  it("selects one enabled exact legacy option and verifies the observed selection", async () => {
    const fake = fakePicker([row(), row("GPT-5.5", false)]);
    expect(await fake.chat.selectModel(fake.menu, "gpt-5.5")).toMatchObject({
      ok: true,
      label: "GPT-5.5",
    });
    expect(fake.clicks).toHaveBeenCalledTimes(1);
    expect(await fake.chat.observeModel(fake.menu)).toMatchObject({ ok: true, model: "gpt-5.5" });
  });
  it("no click is needed when an exact legacy target is already selected", async () => {
    const fake = fakePicker([row()]);
    expect((await fake.chat.selectModel(fake.menu, "latest")).ok).toBe(true);
    expect(fake.clicks).not.toHaveBeenCalled();
  });
  it("changing checked state between collection passes is incomplete", async () => {
    const fake = fakePicker([row(), row("GPT-5.5", false)]);
    const item = fake.locators[0];
    let reads = 0;
    item?.getAttribute.mockImplementation(async (name: string) =>
      name === "aria-checked" ? (++reads === 1 ? "true" : "false") : null,
    );
    const result = await fake.chat.readModelCatalog(fake.menu);
    expect(result.catalog).toMatchObject({ complete: false, reason: "incomplete" });
    expect(result.catalog.issues).toContain("row_changed");
    expect((await fake.chat.selectModel(fake.menu, "latest")).ok).toBe(false);
    expect(fake.clicks).not.toHaveBeenCalled();
  });
  it("a stale local catalog is rejected before the selection click", async () => {
    const fake = fakePicker([row(), row("GPT-5.5", false)]);
    const original = fake.chat.readModelCatalog.bind(fake.chat);
    let calls = 0;
    vi.spyOn(fake.chat, "readModelCatalog").mockImplementation(async (menu) => {
      if (++calls === 2) fake.setRows([row(), row("GPT-5.5", false, false)]);
      return original(menu);
    });
    expect(await fake.chat.selectModel(fake.menu, "gpt-5.5")).toMatchObject({
      ok: false,
      cause: "model catalog changed before selection",
    });
    expect(fake.clicks).not.toHaveBeenCalled();
  });
  it("a row changing after fresh catalog reads is rejected before click", async () => {
    const fake = fakePicker([row(), row("GPT-5.5", false)]);
    const original = fake.chat.readModelCatalog.bind(fake.chat);
    let calls = 0;
    vi.spyOn(fake.chat, "readModelCatalog").mockImplementation(async (menu) => {
      const result = await original(menu);
      if (++calls === 2) fake.setRows([row(), row("GPT-8 Future", false)]);
      return result;
    });
    expect(await fake.chat.selectModel(fake.menu, "gpt-5.5")).toMatchObject({
      ok: false,
      cause: "model option changed before selection",
    });
    expect(fake.clicks).not.toHaveBeenCalled();
  });
  it("count changes/unknown enabled states cannot be smoothed into an executable catalog", async () => {
    const fake = fakePicker([{ ...row(), enabled: null }]);
    expect((await fake.chat.readModelCatalog(fake.menu)).catalog.complete).toBe(false);
    const changing = fakePicker([row()]);
    changing.collection.count.mockResolvedValueOnce(1).mockResolvedValue(2);
    expect((await changing.chat.readModelCatalog(changing.menu)).catalog.complete).toBe(false);
  });
  it("explicit diagnostics retain catalog even when effort slider is unreadable and never walk by default", async () => {
    const fake = fakePicker([row("GPT-8 Future")]);
    vi.spyOn(fake.chat, "openPicker").mockResolvedValue(fake.menu);
    vi.spyOn(fake.chat, "closePicker").mockResolvedValue();
    vi.spyOn(fake.chat, "readPresetLabel").mockResolvedValue("8 Pro");
    vi.spyOn(fake.chat, "readSlider").mockRejectedValue(new Error("private failure"));
    const effort = vi.spyOn(fake.chat, "selectEffort");
    const report = await fake.chat.listPresetOptions(false);
    expect(report.modelCatalog).toMatchObject({
      complete: true,
      options: [{ label: "GPT-8 Future", legacyModel: null }],
    });
    expect(report.modelOptions).toEqual(["GPT-8 Future [checked]"]);
    expect(report.effortReadError).toBe("slider_unreadable");
    expect(effort).not.toHaveBeenCalled();
    expect(fake.clicks).not.toHaveBeenCalled();
  });
  it("an unrecognized effort topology fails before any keyboard mutation", async () => {
    const fake = fakePicker([row()]);
    vi.spyOn(fake.chat, "readSlider").mockResolvedValue({ now: 0, max: 5, label: "Instant" });
    expect((await fake.chat.selectEffort(fake.menu, "high")).ok).toBe(false);
    expect(fake.keyboard.press).not.toHaveBeenCalled();
  });
  it.each([
    [row("GPT-8 Future")],
    [row(), row("Latest", false)],
    [row("Latest", true, false)],
    [{ ...row(), checked: null }],
  ])("rejects unverifiable current model before any effort mutation", async (...rows) => {
    const fake = fakePicker(rows);
    vi.spyOn(fake.chat, "openPicker").mockResolvedValue(fake.menu);
    vi.spyOn(fake.chat, "closePicker").mockResolvedValue();
    const effort = vi.spyOn(fake.chat, "selectEffort");
    expect((await fake.chat.resolvePreset("high", "current")).kind).toBe("not_verifiable");
    expect(effort).not.toHaveBeenCalled();
    expect(fake.clicks).not.toHaveBeenCalled();
    expect(fake.keyboard.press).not.toHaveBeenCalled();
  });
  it("rejects model changes across picker reopen before any effort mutation", async () => {
    const fake = fakePicker([row(), row("GPT-5.5", false)]);
    let opens = 0;
    vi.spyOn(fake.chat, "openPicker").mockImplementation(async () => {
      if (++opens === 2) fake.setRows([row("Latest", false), row("GPT-5.5")]);
      return fake.menu;
    });
    vi.spyOn(fake.chat, "closePicker").mockResolvedValue();
    const effort = vi.spyOn(fake.chat, "selectEffort");
    expect(await fake.chat.resolvePreset("high", "current")).toMatchObject({
      kind: "not_verifiable",
      cause: "model catalog changed before effort selection",
    });
    expect(effort).not.toHaveBeenCalled();
    expect(fake.keyboard.press).not.toHaveBeenCalled();
  });
  it("a compatible visible radio/slider profile preserves normal explicit effort selection", async () => {
    const fake = fakePicker([row()]);
    configureEffort(fake, true);
    vi.spyOn(fake.chat, "openPicker").mockResolvedValue(fake.menu);
    vi.spyOn(fake.chat, "closePicker").mockResolvedValue();
    expect(await fake.chat.resolvePreset("high", "current")).toMatchObject({
      kind: "observed",
      preset: "high",
      model: "latest",
    });
    expect(fake.keyboard.press.mock.calls.map((call) => call[0])).toEqual([
      "Home",
      "ArrowRight",
      "ArrowRight",
    ]);
    expect(fake.clicks).not.toHaveBeenCalled();
  });
  it("an advanced view that hides the slider fails before keyboard action", async () => {
    const fake = fakePicker([row()]);
    configureEffort(fake, false);
    vi.spyOn(fake.chat, "openPicker").mockResolvedValue(fake.menu);
    vi.spyOn(fake.chat, "closePicker").mockResolvedValue();
    expect(await fake.chat.resolvePreset("high", "current")).toMatchObject({
      kind: "dom_unexpected",
      element: "effortSlider",
    });
    expect(fake.keyboard.press).not.toHaveBeenCalled();
    expect(fake.clicks).not.toHaveBeenCalled();
  });
});
