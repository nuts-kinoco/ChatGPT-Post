import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import type { RequestedPreset } from "../contracts/types.js";
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
  ELEMENTS,
  type ElementKey,
  exists,
  type Locale,
  latest,
  PHRASES,
  probe,
  resolve,
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

  // ---------- preset ----------

  private async readPresetLabel(): Promise<string | null> {
    const p = await probe(this.page, "modelPickerCurrentLabel", this.sel);
    if (!p.found || !p.locator) return null;
    const text = (await p.locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    return text || null;
  }

  async resolvePreset(requested: RequestedPreset): Promise<PresetResolution> {
    if (requested !== "current") {
      return {
        kind: "not_verifiable",
        cause: "preset selection is not implemented in Phase 4 (use current)",
      };
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
    const r = reverseLookupPreset(label, this.locale);
    if ("error" in r) return { kind: "not_verifiable", cause: `${r.error}: "${label}"` };
    return { kind: "observed", preset: r.preset, label };
  }

  // ---------- prompt ----------

  async enterPrompt(
    text: string,
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
        if (seen === expected) return { kind: "ok" };
      } catch (err) {
        return { kind: "retry", cause: (err as Error).message };
      }
    }
    return {
      kind: "mismatch",
      cause: `composer content differs (expected ${expected.length} chars, saw ${lastSeen.length} chars)`,
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
          if (v.ok) return { markdown: captured, method: "copy", quality: "full" };
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
      if (v.ok) return { markdown: md, method: "dom", quality: "full" };
      this.opts.log?.(`dom conversion rejected: ${v.reason}`);
    } catch (err) {
      this.opts.log?.(`dom conversion failed: ${(err as Error).message}`);
    }

    // 3. innerText
    return { markdown: innerText, method: "innerText", quality: "degraded" };
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
   * Opens the picker, records the effort slider state and model options, closes it with Escape.
   * Read-only apart from the menu toggle (no selection is changed).
   */
  private async listPresetOptions(): Promise<Record<string, unknown> | null> {
    const picker = await probe(this.page, "modelPicker", this.sel);
    if (!picker.found || !picker.locator) return null;
    try {
      await picker.locator.click({ timeout: 3000 });
      await this.page.waitForTimeout(400);
      const slider = this.page
        .locator("[data-model-reasoning-effort-slider] [role=slider]")
        .first();
      const sliderInfo =
        (await slider.count().catch(() => 0)) > 0
          ? {
              valueNow: await slider.getAttribute("aria-valuenow"),
              valueMax: await slider.getAttribute("aria-valuemax"),
              description: (
                await this.page
                  .locator("[data-model-reasoning-effort-slider]")
                  .locator("xpath=ancestor::*[@role='menuitem'][1]")
                  .innerText()
                  .catch(() => "")
              )
                .replace(/\s+/g, " ")
                .trim(),
            }
          : null;
      const radios = build(this.page, { kind: "role", role: "menuitemradio", name: "" });
      const models: string[] = [];
      const n = await radios.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 20); i++) {
        const t = (
          await radios
            .nth(i)
            .innerText()
            .catch(() => "")
        )
          .replace(/\s+/g, " ")
          .trim();
        const checked = await radios
          .nth(i)
          .getAttribute("aria-checked")
          .catch(() => null);
        if (t) models.push(`${t}${checked === "true" ? " [checked]" : ""}`);
      }
      return {
        triggerLabel: await this.readPresetLabel(),
        effortSlider: sliderInfo,
        modelOptions: models,
      };
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      await this.page.keyboard.press("Escape").catch(() => undefined);
    }
  }

  async inspectUiReport(artifactsDir: string): Promise<string> {
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
    report.presetOptions = await this.listPresetOptions();
    const path = join(artifactsDir, "inspect-ui.json");
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return path;
  }
}
