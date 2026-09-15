import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { uploadBudgetMs } from "../contracts/attachments.js";
import type {
  ObservedModel,
  ObservedPreset,
  RequestedModel,
  RequestedPreset,
} from "../contracts/types.js";
import { COPY_CAPTURE_GLOBAL } from "../extraction/copy-capture.js";
import { htmlToMarkdown } from "../extraction/markdown.js";
import { verifyCandidate } from "../extraction/verify.js";
import type {
  AuthObservation,
  Baseline,
  ChatGptPort,
  Extraction,
  PresetResolution,
} from "../state/ports.js";
import type { Observation } from "./completion.js";
import {
  build,
  countMatches,
  DomUnexpected,
  describeCandidate,
  EFFORT_INDEX_OF,
  EFFORT_KEY_INTERVAL_MS,
  EFFORT_SLIDER_INDEX,
  EFFORT_SLIDER_MAX,
  ELEMENTS,
  type ElementKey,
  exists,
  hintMatches,
  type Locale,
  latest,
  PHRASES,
  parseTriggerLabel,
  probe,
  resolve,
  reverseLookupModel,
  reverseLookupPreset,
} from "./selectors.js";

export const CHATGPT_ORIGIN = "https://chatgpt.com";
const LOGIN_HOSTS = [
  /(^|\.)auth\.openai\.com$/i,
  /(^|\.)auth0\.openai\.com$/i,
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
];

export interface ChatGptPageOptions {
  verifiedOnly: boolean;
  pollIntervalMs?: number;
  newChatTimeoutMs?: number;
  log?: (message: string) => void;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** Whitespace-insensitive comparison key: FR-024 guards against loss, not layout differences. */
function normalisePrompt(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, "");
}

export class ChatGptPage implements ChatGptPort {
  private locale: Locale = "ja";
  private sendButton: Locator | null = null;
  private lastError: string | null = null;
  private streamingCandidateLogged = false;
  /** Effort slider index before this run changed it (null = untouched). */
  private effortToRestore: number | null = null;

  constructor(
    private readonly page: Page,
    private readonly opts: ChatGptPageOptions,
  ) {}

  private get sel() {
    return { verifiedOnly: this.opts.verifiedOnly };
  }

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  private async detectLocale(): Promise<void> {
    const lang = await this.page
      .evaluate(() => document.documentElement.lang || "")
      .catch(() => "");
    this.locale = lang.toLowerCase().startsWith("ja") ? "ja" : "en";
  }

  private async pageHasPhrase(root: Page | Locator, phrases: readonly string[]): Promise<boolean> {
    for (const p of phrases) {
      try {
        if ((await root.getByText(p, { exact: false }).count()) > 0) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  private allPhrases(key: keyof typeof PHRASES): string[] {
    return [...PHRASES[key].ja, ...PHRASES[key].en];
  }

  // ---------- auth ----------

  async navigateAndObserveAuth(): Promise<
    AuthObservation | { kind: "dom_unexpected"; element: string; tried: string[] }
  > {
    try {
      await this.page.goto(`${CHATGPT_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    } catch (err) {
      return { kind: "NOT_READY", cause: `navigation failed: ${(err as Error).message}` };
    }
    await this.page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await this.detectLocale();
    return this.observeAuth(this.page.url());
  }

  async observeAuth(url: string): Promise<AuthObservation> {
    const host = hostOf(url);
    if (host !== "chatgpt.com" && !host.endsWith(".chatgpt.com")) {
      return LOGIN_HOSTS.some((re) => re.test(host))
        ? { kind: "AUTH_REQUIRED" }
        : { kind: "WRONG_PAGE", url };
    }
    if (await exists(this.page, "challengeFrame", this.sel))
      return { kind: "CHALLENGE", challenge: "captcha" };
    const dialogs = build(this.page, { kind: "role", role: "dialog", name: "" });
    const dialogCount = await dialogs.count();
    for (let i = 0; i < dialogCount; i++) {
      const d = dialogs.nth(i);
      if (!(await d.isVisible().catch(() => false))) continue;
      const text = (await d.innerText().catch(() => "")).toLowerCase();
      if (this.allPhrases("rateLimited").some((p) => text.includes(p.toLowerCase())))
        return { kind: "CHALLENGE", challenge: "rate_limited" };
      if (this.allPhrases("challenge").some((p) => text.includes(p.toLowerCase())))
        return { kind: "CHALLENGE", challenge: "captcha" };
    }
    const composer = await probe(this.page, "composer", this.sel);
    // ChatGPT shows a composer even when logged out, so a visible login CTA wins (FR-016 (b)).
    const login = await exists(this.page, "loginCta", this.sel);
    if (login) return { kind: "AUTH_REQUIRED" };
    if (composer.found) {
      if (dialogCount > 0) {
        for (let i = 0; i < dialogCount; i++) {
          const d = dialogs.nth(i);
          if (
            (await d.isVisible().catch(() => false)) &&
            (await d.getAttribute("aria-modal").catch(() => null)) === "true"
          ) {
            return { kind: "CHALLENGE", challenge: "consent" };
          }
        }
      }
      return { kind: "AUTH_OK" };
    }
    return { kind: "NOT_READY", cause: "neither composer nor login CTA visible" };
  }

  // ---------- new chat ----------

  async openNewChat(): Promise<
    | { kind: "ok" }
    | { kind: "failed"; cause: "existing_conversation" | "generating" | "composer_not_empty" }
    | { kind: "retry"; cause: string }
    | { kind: "dom_unexpected"; element: string; tried: string[] }
  > {
    const isConversation = (u: string) => /\/c\//.test(new URL(u).pathname);
    // The sidebar exposes several "new chat" links, so a new chat is opened by URL (a normal user action).
    try {
      if (new URL(this.page.url()).pathname !== "/") {
        await this.page.goto(`${CHATGPT_ORIGIN}/`, { waitUntil: "domcontentloaded" });
      }
    } catch (err) {
      return { kind: "retry", cause: (err as Error).message };
    }
    const deadline = Date.now() + (this.opts.newChatTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const composer = await probe(this.page, "composer", this.sel);
      if (composer.found && composer.locator) {
        if (isConversation(this.page.url()))
          return { kind: "failed", cause: "existing_conversation" };
        if (await exists(this.page, "stopButton", this.sel))
          return { kind: "failed", cause: "generating" };
        const text = (await composer.locator.innerText().catch(() => "")).trim();
        if (text.length > 0) return { kind: "failed", cause: "composer_not_empty" };
        return { kind: "ok" };
      }
      await this.page.waitForTimeout(this.opts.pollIntervalMs ?? 250);
    }
    return { kind: "retry", cause: "composer did not appear after new chat" };
  }

  // ---------- preset / model picker ----------

  private async readPresetLabel(): Promise<string | null> {
    const p = await probe(this.page, "modelPickerCurrentLabel", this.sel);
    if (!p.found || !p.locator) return null;
    const text = (await p.locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    return text || null;
  }

  /** Opens the picker (trigger click) and waits for the menu. Throws DomUnexpected / Error. */
  private async openPicker(): Promise<Locator> {
    const menuProbe = await probe(this.page, "pickerMenu", this.sel);
    if (menuProbe.found && menuProbe.locator) return menuProbe.locator;
    const trigger = await resolve(this.page, "modelPicker", this.sel);
    await trigger.click({ timeout: 3000 });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const m = await probe(this.page, "pickerMenu", this.sel);
      if (m.found && m.locator) {
        await this.page.waitForTimeout(400); // transitions-ready
        return m.locator;
      }
      await this.page.waitForTimeout(100);
    }
    throw new Error("picker menu did not open");
  }

  /** Closes the picker by clicking outside (Escape was observed not to close it). */
  private async closePicker(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      if (!(await exists(this.page, "pickerMenu", this.sel))) return;
      await this.page.mouse.click(5, 5);
      await this.page.waitForTimeout(500);
    }
    if (await exists(this.page, "pickerMenu", this.sel)) {
      await this.page.keyboard.press("Escape").catch(() => undefined);
      await this.page.waitForTimeout(300);
    }
  }

  private async readSlider(
    menu: Locator,
  ): Promise<{ now: number; max: number; label: string; slider: Locator; row: Locator }> {
    const slider = await resolve(menu, "effortSlider", this.sel);
    const row = await resolve(menu, "effortSliderRow", this.sel);
    const now = Number(await slider.getAttribute("aria-valuenow"));
    const max = Number(await slider.getAttribute("aria-valuemax"));
    const ids = ((await row.getAttribute("aria-describedby")) ?? "").split(/\s+/).filter(Boolean);
    let label = "";
    if (ids[0]) {
      const raw = await this.page
        .locator(`[id="${ids[0]}"]`)
        .innerText()
        .catch(() => "");
      // "極高、5件中4件目。" -> "極高"
      label = raw.split(/[、,]/)[0]?.trim() ?? "";
    }
    return { now, max, label, slider, row };
  }

  /**
   * Moves the effort slider to the requested level with keyboard (Home, then ArrowRight × index,
   * spaced by EFFORT_KEY_INTERVAL_MS so the persisted value keeps up), then verifies in the menu.
   * The menu is left open; the caller closes it and re-verifies the trigger label.
   */
  private async selectEffort(
    menu: Locator,
    target: ObservedPreset,
  ): Promise<{ ok: true } | { ok: false; cause: string }> {
    const before = await this.readSlider(menu);
    if (before.max !== EFFORT_SLIDER_MAX) {
      return { ok: false, cause: `effort slider has ${before.max + 1} levels, expected 5` };
    }
    const idx = EFFORT_INDEX_OF[target];
    if (before.now !== idx) {
      if (this.effortToRestore === null) this.effortToRestore = before.now;
      // The menuitem row owns the keyboard shortcuts (aria-keyshortcuts="ArrowLeft ArrowRight");
      // the slider span itself is tabindex=-1. Focus the row, fall back to the span.
      await before.slider.focus().catch(() => before.row.focus());
      await this.page.keyboard.press("Home");
      await this.page.waitForTimeout(EFFORT_KEY_INTERVAL_MS);
      for (let i = 0; i < idx; i++) {
        await this.page.keyboard.press("ArrowRight");
        await this.page.waitForTimeout(EFFORT_KEY_INTERVAL_MS);
      }
      await this.page.waitForTimeout(800);
    }
    const after = await this.readSlider(menu);
    if (after.now !== idx) return { ok: false, cause: `slider at ${after.now}, expected ${idx}` };
    const r = reverseLookupPreset(after.label, this.locale);
    if ("error" in r || r.preset !== target) {
      return { ok: false, cause: `slider label "${after.label}" does not map to ${target}` };
    }
    return { ok: true };
  }

  private async readModelRadios(
    menu: Locator,
  ): Promise<Array<{ text: string; checked: boolean; locator: Locator }>> {
    const def = ELEMENTS.modelRadio;
    const out: Array<{ text: string; checked: boolean; locator: Locator }> = [];
    for (const c of def.candidates) {
      if (this.opts.verifiedOnly && !c.verifiedOn) continue;
      const loc = build(menu, c);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 20); i++) {
        const item = loc.nth(i);
        out.push({
          text: (await item.innerText().catch(() => "")).trim(),
          checked: (await item.getAttribute("aria-checked").catch(() => null)) === "true",
          locator: item,
        });
      }
      if (out.length > 0) break;
    }
    return out;
  }

  /** Switches the menu to the advanced view where model radios are interactive. */
  private async expandModels(menu: Locator): Promise<void> {
    const expander = await resolve(menu, "modelExpander", this.sel);
    if ((await expander.getAttribute("aria-expanded")) !== "true") {
      await expander.click({ timeout: 3000 });
      await this.page.waitForTimeout(500);
    }
  }

  private async observeModel(
    menu: Locator,
  ): Promise<{ ok: true; model: ObservedModel; label: string } | { ok: false; cause: string }> {
    const radios = await this.readModelRadios(menu);
    const checked = radios.filter((r) => r.checked);
    if (radios.length === 0) return { ok: false, cause: "no model radios found" };
    if (checked.length !== 1) return { ok: false, cause: `${checked.length} model radios checked` };
    const c = checked[0] as { text: string };
    const r = reverseLookupModel(c.text, this.locale);
    if ("error" in r) return { ok: false, cause: `${r.error} model label: "${c.text}"` };
    return { ok: true, model: r.model, label: c.text.split(/\r?\n/)[0] ?? c.text };
  }

  /**
   * Clicks the target radio (advanced view), re-expands (the click flips the view back to simple)
   * and verifies aria-checked. Model selection is per page load (A-067 note), never persisted.
   */
  private async selectModel(
    menu: Locator,
    target: ObservedModel,
  ): Promise<{ ok: true; label: string } | { ok: false; cause: string; available: boolean }> {
    await this.expandModels(menu);
    const radios = await this.readModelRadios(menu);
    const hits = radios.filter((r) => {
      const m = reverseLookupModel(r.text, this.locale);
      return !("error" in m) && m.model === target;
    });
    if (hits.length === 0) {
      return { ok: false, cause: `model ${target} not in picker`, available: false };
    }
    if (hits.length > 1) {
      return { ok: false, cause: `model ${target} matched ${hits.length} radios`, available: true };
    }
    const hit = hits[0] as { checked: boolean; locator: Locator };
    if (!hit.checked) {
      await hit.locator.click({ timeout: 3000 });
      await this.page.waitForTimeout(1200);
      await this.expandModels(menu);
    }
    const obs = await this.observeModel(menu);
    if (!obs.ok) return { ok: false, cause: obs.cause, available: true };
    if (obs.model !== target) {
      return {
        ok: false,
        cause: `model radio shows ${obs.model} after selecting ${target}`,
        available: true,
      };
    }
    return { ok: true, label: obs.label };
  }

  /**
   * FR-021 / A-063 / A-067: model (in-page radio) first, then effort (persisted slider), then a final
   * read of the trigger label with the menu closed. Any doubt -> not_verifiable (fail closed).
   */
  async resolvePreset(
    requested: RequestedPreset,
    model: RequestedModel,
  ): Promise<PresetResolution> {
    let observedModel: ObservedModel;
    let modelLabel: string;
    try {
      // 1. model (advanced view). Selecting a radio flips the view and steals keyboard focus, so the
      //    picker is closed and reopened before touching the slider.
      if (model !== "current") {
        const menu = await this.openPicker();
        try {
          const r = await this.selectModel(menu, model);
          if (!r.ok) {
            return r.available
              ? { kind: "not_verifiable", cause: r.cause }
              : { kind: "not_available" };
          }
        } finally {
          await this.closePicker();
        }
        await this.page.waitForTimeout(500);
      }
      // 2. effort (simple view), then re-observe the model radio in the same menu instance
      const menu = await this.openPicker();
      try {
        if (requested !== "current") {
          const e = await this.selectEffort(menu, requested);
          if (!e.ok) return { kind: "not_verifiable", cause: e.cause };
        }
        await this.expandModels(menu);
        const obs = await this.observeModel(menu);
        if (!obs.ok) return { kind: "not_verifiable", cause: obs.cause };
        if (model !== "current" && obs.model !== model) {
          return {
            kind: "not_verifiable",
            cause: `model radio shows ${obs.model} after selecting ${model}`,
          };
        }
        observedModel = obs.model;
        modelLabel = obs.label;
      } finally {
        await this.closePicker();
      }
      // persisted value catches up shortly after close; read the trigger label afterwards
      await this.page.waitForTimeout(1200);
    } catch (err) {
      if (err instanceof DomUnexpected)
        return { kind: "dom_unexpected", element: err.element, tried: err.tried };
      return { kind: "retry", cause: (err as Error).message };
    }
    let label: string | null;
    try {
      const picker = await probe(this.page, "modelPickerCurrentLabel", this.sel);
      if (!picker.found) {
        const tried = ELEMENTS.modelPickerCurrentLabel.candidates.map(
          (c) => `${describeCandidate(c)} -> ${picker.matches}`,
        );
        return { kind: "dom_unexpected", element: "modelPickerCurrentLabel", tried };
      }
      label = await this.readPresetLabel();
    } catch (err) {
      return { kind: "retry", cause: (err as Error).message };
    }
    if (!label) return { kind: "not_verifiable", cause: "preset label is empty" };
    const r = parseTriggerLabel(label, this.locale);
    if ("error" in r) return { kind: "not_verifiable", cause: `${r.error}: "${label}"` };
    if (r.modelHint) this.opts.log?.(`trigger label carries model hint "${r.modelHint}"`);
    if (!hintMatches(r.modelHint, observedModel, r.preset)) {
      return {
        kind: "not_verifiable",
        cause: `trigger "${label}" does not agree with menu (model ${observedModel}, ${r.preset})`,
      };
    }
    if (requested !== "current" && r.preset !== requested) {
      return {
        kind: "not_verifiable",
        cause: `trigger shows "${label}" (${r.preset}) after selecting ${requested}`,
      };
    }
    return { kind: "observed", preset: r.preset, label, model: observedModel, modelLabel };
  }

  // ---------- prompt ----------

  async enterPrompt(
    text: string,
    attachments: string[],
  ): Promise<
    | { kind: "ok" }
    | { kind: "mismatch"; cause: string }
    | { kind: "retry"; cause: string }
    | { kind: "dom_unexpected"; element: string; tried: string[] }
  > {
    let composer: Locator;
    try {
      composer = await resolve(this.page, "composer", this.sel);
    } catch (err) {
      if (err instanceof DomUnexpected)
        return { kind: "dom_unexpected", element: err.element, tried: err.tried };
      return { kind: "retry", cause: (err as Error).message };
    }
    const expected = normalisePrompt(text);
    let lastSeen = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await composer.click();
        await composer.fill("");
        await composer.fill(text);
        await this.page.waitForTimeout(150);
        const seen = normalisePrompt(await composer.innerText());
        lastSeen = seen;
        if (seen === expected) {
          if (attachments.length === 0) return { kind: "ok" };
          return this.attachFiles(attachments);
        }
      } catch (err) {
        return { kind: "retry", cause: (err as Error).message };
      }
    }
    return {
      kind: "mismatch",
      cause: `composer content differs (expected ${expected.length} chars, saw ${lastSeen.length} chars)`,
    };
  }

  /**
   * A-068: setInputFiles on the composer's hidden file input, then wait for one chip per file and for
   * the upload to finish (send button leaves aria-disabled). Chip names may be server-renamed
   * ("name(1).ext"), so only the count is asserted; names are logged.
   */
  private async attachFiles(
    paths: string[],
  ): Promise<
    | { kind: "ok" }
    | { kind: "mismatch"; cause: string }
    | { kind: "retry"; cause: string }
    | { kind: "dom_unexpected"; element: string; tried: string[] }
  > {
    const def = ELEMENTS.fileInput;
    let input: Locator | null = null;
    const tried: string[] = [];
    for (const c of def.candidates) {
      if (this.opts.verifiedOnly && !c.verifiedOn) continue;
      const loc = build(this.page, c);
      const n = await loc.count().catch(() => 0);
      tried.push(`${describeCandidate(c)} -> ${n}`);
      if (n === 1) {
        input = loc.first();
        break;
      }
    }
    if (!input) return { kind: "dom_unexpected", element: "fileInput", tried };
    let totalBytes = 0;
    for (const p of paths) totalBytes += (await stat(p)).size;
    try {
      await input.setInputFiles(paths);
    } catch (err) {
      return { kind: "mismatch", cause: `attachment_failed: ${(err as Error).message}` };
    }
    // chips
    const chipDeadline = Date.now() + 15_000;
    let chips = 0;
    while (Date.now() < chipDeadline) {
      chips = await countMatches(this.page, "attachmentChip", this.sel);
      if (chips >= paths.length) break;
      await this.page.waitForTimeout(250);
    }
    if (chips !== paths.length) {
      return {
        kind: "mismatch",
        cause: `attachment_failed: ${chips} chips for ${paths.length} files`,
      };
    }
    // upload completion
    const budget = uploadBudgetMs(totalBytes);
    const upDeadline = Date.now() + budget;
    while (Date.now() < upDeadline) {
      const send = await probe(this.page, "sendButton", this.sel);
      const ariaDisabled = send.locator
        ? await send.locator.getAttribute("aria-disabled").catch(() => null)
        : "true";
      if (send.found && send.enabled && ariaDisabled !== "true") {
        const names = await this.page
          .locator("form [role=group][aria-label]")
          .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""))
          .catch(() => [] as string[]);
        this.opts.log?.(`attachments uploaded: ${names.join(", ")}`);
        return { kind: "ok" };
      }
      await this.page.waitForTimeout(500);
    }
    return {
      kind: "mismatch",
      cause: `attachment_failed: upload did not finish within ${budget} ms (${totalBytes} bytes)`,
    };
  }

  async snapshotBaseline(
    expectedLabel: string,
  ): Promise<
    | { kind: "ok"; baseline: Baseline }
    | { kind: "preset_changed" }
    | { kind: "dom_unexpected"; element: string; tried: string[] }
  > {
    const label = (await this.readPresetLabel()) ?? "";
    if (label !== expectedLabel) return { kind: "preset_changed" };
    try {
      this.sendButton = await resolve(this.page, "sendButton", this.sel);
    } catch (err) {
      if (err instanceof DomUnexpected)
        return { kind: "dom_unexpected", element: err.element, tried: err.tried };
      throw err;
    }
    const assistantCount = await countMatches(this.page, "assistantTurn", this.sel);
    return { kind: "ok", baseline: { assistantCount, url: this.page.url(), presetLabel: label } };
  }

  async dispatchSubmit(
    baselineLabel: string,
  ): Promise<
    | { kind: "dispatched"; url: string }
    | { kind: "failed"; cause: "click_failed" | "send_button_missing" | "send_button_disabled" }
    | { kind: "aborted" }
  > {
    const label = (await this.readPresetLabel()) ?? "";
    if (label !== baselineLabel) return { kind: "aborted" };
    const btn = this.sendButton;
    if (!btn) return { kind: "failed", cause: "send_button_missing" };
    if (!(await btn.isVisible().catch(() => false)))
      return { kind: "failed", cause: "send_button_missing" };
    if (!(await btn.isEnabled().catch(() => false)))
      return { kind: "failed", cause: "send_button_disabled" };
    try {
      await btn.click({ timeout: 5000 });
    } catch (err) {
      this.lastError = (err as Error).message;
      return { kind: "failed", cause: "click_failed" };
    }
    return { kind: "dispatched", url: this.page.url() };
  }

  // ---------- observation ----------

  async observe(t: number): Promise<Observation> {
    const assistantCount = await countMatches(this.page, "assistantTurn", this.sel);
    let lastText = "";
    let latestTurn: Locator | null = null;
    if (assistantCount > 0) {
      latestTurn = await latest(this.page, "assistantTurn", this.sel);
      if (latestTurn) lastText = await latestTurn.innerText().catch(() => "");
    }
    const streaming = await exists(this.page, "stopButton", this.sel);
    if (streaming && !this.streamingCandidateLogged) {
      this.streamingCandidateLogged = true;
      for (const c of ELEMENTS.stopButton.candidates) {
        if (
          (await build(this.page, c)
            .count()
            .catch(() => 0)) > 0
        ) {
          this.opts.log?.(`stopButton matched by ${describeCandidate(c)}`);
          break;
        }
      }
    }
    const composer = await probe(this.page, "composer", this.sel);
    const composerReady = !streaming && composer.found && composer.enabled === true;
    const copyAvailable = latestTurn ? await exists(latestTurn, "copyTurnButton", this.sel) : false;
    const truncated = await exists(this.page, "continueButton", this.sel);
    const sidePanel = await exists(this.page, "sidePanel", this.sel);

    let errorBanner: Observation["errorBanner"] = "none";
    const alerts = build(this.page, { kind: "role", role: "alert", name: "" });
    const alertCount = await alerts.count().catch(() => 0);
    const texts: string[] = [];
    for (let i = 0; i < alertCount; i++) {
      const a = alerts.nth(i);
      if (await a.isVisible().catch(() => false))
        texts.push((await a.innerText().catch(() => "")).toLowerCase());
    }
    if (latestTurn && !streaming) {
      const turnErr = await this.pageHasPhrase(latestTurn, [
        ...this.allPhrases("chatError"),
        ...this.allPhrases("networkError"),
      ]);
      if (turnErr) texts.push(lastText.toLowerCase());
    }
    const has = (key: keyof typeof PHRASES) =>
      texts.some((tx) => this.allPhrases(key).some((p) => tx.includes(p.toLowerCase())));
    if (has("rateLimited")) errorBanner = "rate_limited";
    else if (has("networkError")) errorBanner = "network";
    else if (has("chatError")) errorBanner = "chat_error";

    let challenge: Observation["challenge"] = "none";
    if (await exists(this.page, "challengeFrame", this.sel)) challenge = "captcha";
    else if (!composer.found && (await exists(this.page, "loginCta", this.sel)))
      challenge = "login";

    return {
      t,
      assistantCount,
      lastAssistantHash: sha1(lastText),
      lastAssistantEmpty: lastText.trim().length === 0,
      streaming,
      composerReady,
      copyAvailable,
      truncated,
      sidePanel,
      errorBanner,
      challenge,
    };
  }

  // ---------- extraction ----------

  async extractLatest(): Promise<Extraction | { kind: "empty"; cause: "empty" | "canvas" }> {
    const turn = await latest(this.page, "assistantTurn", this.sel);
    if (!turn) return { kind: "empty", cause: "empty" };
    if (await exists(this.page, "sidePanel", this.sel)) return { kind: "empty", cause: "canvas" };
    const bodyProbe = await probe(turn, "assistantTurnBody", this.sel);
    const body = bodyProbe.found && bodyProbe.locator ? bodyProbe.locator : turn;
    const innerText = await body.innerText().catch(() => "");
    if (innerText.trim().length === 0) return { kind: "empty", cause: "empty" };
    const modelSlug = await this.readModelSlug(turn);

    // 1. copy capture (page-side shim; no system clipboard)
    try {
      const copyBtn = await this.findCopyTurnButton(turn);
      if (copyBtn) {
        await this.page.evaluate((key) => {
          (window as unknown as Record<string, unknown>)[key] = null;
        }, COPY_CAPTURE_GLOBAL);
        await copyBtn.scrollIntoViewIfNeeded().catch(() => undefined);
        try {
          await copyBtn.click({ timeout: 3000 });
        } catch {
          await copyBtn.click({ timeout: 3000, force: true });
        }
        await this.page.waitForTimeout(300);
        const captured = await this.page.evaluate(
          (key) => (window as unknown as Record<string, unknown>)[key],
          COPY_CAPTURE_GLOBAL,
        );
        if (typeof captured === "string" && captured.trim().length > 0) {
          const v = verifyCandidate(captured, innerText);
          if (v.ok) return { markdown: captured, method: "copy", quality: "full", modelSlug };
          this.opts.log?.(`copy capture rejected: ${v.reason}`);
        }
      }
    } catch (err) {
      this.opts.log?.(`copy capture failed: ${(err as Error).message}`);
    }

    // 2. DOM -> Markdown
    try {
      const html = await body.innerHTML();
      const md = htmlToMarkdown(html);
      const v = verifyCandidate(md, innerText);
      if (v.ok) return { markdown: md, method: "dom", quality: "full", modelSlug };
      this.opts.log?.(`dom conversion rejected: ${v.reason}`);
    } catch (err) {
      this.opts.log?.(`dom conversion failed: ${(err as Error).message}`);
    }

    // 3. innerText
    return { markdown: innerText, method: "innerText", quality: "degraded", modelSlug };
  }

  async restoreEffort(): Promise<
    { kind: "unchanged" } | { kind: "restored" } | { kind: "failed"; cause: string }
  > {
    if (this.effortToRestore === null) return { kind: "unchanged" };
    const target = EFFORT_SLIDER_INDEX[this.effortToRestore];
    if (!target) return { kind: "failed", cause: `unknown level ${this.effortToRestore}` };
    try {
      const menu = await this.openPicker();
      let r: { ok: true } | { ok: false; cause: string };
      try {
        r = await this.selectEffort(menu, target);
      } finally {
        await this.closePicker();
      }
      if (!r.ok) return { kind: "failed", cause: r.cause };
      await this.page.waitForTimeout(1200);
      const label = (await this.readPresetLabel()) ?? "";
      const parsed = parseTriggerLabel(label, this.locale);
      if ("error" in parsed || parsed.preset !== target) {
        return { kind: "failed", cause: `trigger shows "${label}" after restore to ${target}` };
      }
      this.effortToRestore = null;
      return { kind: "restored" };
    } catch (err) {
      return { kind: "failed", cause: (err as Error).message };
    }
  }

  private async readModelSlug(turn: Locator): Promise<string | null> {
    const el = turn.locator("[data-message-model-slug]").first();
    if ((await el.count().catch(() => 0)) === 0) {
      const self = await turn.getAttribute("data-message-model-slug").catch(() => null);
      return self?.trim() || null;
    }
    const v = await el.getAttribute("data-message-model-slug").catch(() => null);
    return v?.trim() || null;
  }

  private async findCopyTurnButton(turn: Locator): Promise<Locator | null> {
    // The action bar usually sits outside the message body; search the turn's article ancestor first.
    const article = turn.locator("xpath=ancestor-or-self::article[1]");
    const roots: Locator[] = [];
    if ((await article.count().catch(() => 0)) > 0) roots.push(article.first());
    roots.push(turn);
    for (const root of roots) {
      for (const c of ELEMENTS.copyTurnButton.candidates) {
        if (this.opts.verifiedOnly && !c.verifiedOn) continue;
        const loc = build(root, c);
        const n = await loc.count().catch(() => 0);
        if (n === 1) return loc.first();
        if (n > 1) return null; // ambiguous (likely code-block copies): degrade to dom
      }
    }
    return null;
  }

  // ---------- diagnostics ----------

  /**
   * Opens the picker and records the effort slider state and model options. With `walk`, steps the
   * slider through every level reading its label, then restores the original level and verifies it
   * (the account-level effort setting is otherwise left untouched). Never sends.
   */
  private async listPresetOptions(walk: boolean): Promise<Record<string, unknown> | null> {
    let menu: Locator;
    try {
      menu = await this.openPicker();
    } catch (err) {
      return { error: (err as Error).message };
    }
    try {
      const before = await this.readSlider(menu);
      const report: Record<string, unknown> = {
        triggerLabel: await this.readPresetLabel(),
        effortSlider: { valueNow: before.now, valueMax: before.max, label: before.label },
      };
      if (walk) {
        const labels: Record<number, string> = {};
        for (let i = 0; i <= before.max; i++) {
          const preset = EFFORT_SLIDER_INDEX[i];
          if (!preset) break;
          const r = await this.selectEffort(menu, preset);
          labels[i] = r.ok ? (await this.readSlider(menu)).label : `ERROR: ${r.cause}`;
        }
        report.effortLabels = labels;
        const orig = EFFORT_SLIDER_INDEX[before.now];
        const restore = orig
          ? await this.selectEffort(menu, orig)
          : { ok: false, cause: "unknown" };
        report.restored = restore.ok
          ? before.now
          : `FAILED: ${"cause" in restore ? restore.cause : ""}`;
        if (restore.ok) this.effortToRestore = null;
      }
      await this.expandModels(menu).catch(() => undefined);
      report.modelOptions = (await this.readModelRadios(menu)).map(
        (r) => `${r.text.replace(/\s+/g, " ")}${r.checked ? " [checked]" : ""}`,
      );
      return report;
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      await this.closePicker();
      await this.page.waitForTimeout(1200);
    }
  }

  async inspectUiReport(
    artifactsDir: string,
    opts: { walkEffort?: boolean } = {},
  ): Promise<string> {
    await mkdir(artifactsDir, { recursive: true });
    const report: Record<string, unknown> = {
      url: this.page.url(),
      locale: this.locale,
      lastError: this.lastError,
      elements: {},
    };
    const elements = report.elements as Record<string, unknown>;
    for (const key of Object.keys(ELEMENTS) as ElementKey[]) {
      const def = ELEMENTS[key];
      const root = def.scope ? await latest(this.page, def.scope, {}) : this.page;
      const rows: unknown[] = [];
      for (const c of def.candidates) {
        try {
          const loc = build(root ?? this.page, c);
          const attached = await loc.count();
          let visible = 0;
          for (let i = 0; i < Math.min(attached, 20); i++)
            if (
              await loc
                .nth(i)
                .isVisible()
                .catch(() => false)
            )
              visible++;
          const sample =
            attached > 0
              ? (
                  await loc
                    .first()
                    .innerText()
                    .catch(() => "")
                ).slice(0, 80)
              : "";
          rows.push({
            candidate: describeCandidate(c),
            verifiedOn: c.verifiedOn ?? null,
            attached,
            visible,
            sample,
          });
        } catch (err) {
          rows.push({ candidate: describeCandidate(c), error: (err as Error).message });
        }
      }
      elements[key] = { mode: def.mode, scope: def.scope ?? null, candidates: rows };
    }
    report.presetLabel = await this.readPresetLabel();
    report.presetOptions = await this.listPresetOptions(opts.walkEffort ?? false);
    report.presetLabelAfter = await this.readPresetLabel();
    const path = join(artifactsDir, "inspect-ui.json");
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return path;
  }
}
