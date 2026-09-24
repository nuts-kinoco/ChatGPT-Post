import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { withTimeout } from "../browser/timeout.js";
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
import type { NewChatFailure } from "../state/machine.js";
import type {
  AuthObservation,
  Baseline,
  ChatGptPort,
  Extraction,
  PresetResolution,
  ProjectCreateControl,
} from "../state/ports.js";
import type { Observation } from "./completion.js";
import {
  all,
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
/** A-144: only this full URL shape preserves A-106's existing direct-open behavior. */
export const PROJECT_URL_RE = /^https:\/\/chatgpt\.com\/g\/g-p-[A-Za-z0-9-]+\/project$/;
export type ProjectReference = { kind: "url"; url: string } | { kind: "name"; name: string };

/**
 * A-145: a missing Project row is safety-critical evidence. Live observation found the complete
 * sidebar list empty from about three seconds after load and still empty at least 15 seconds
 * later. Six scans four seconds apart take 20 seconds from the first to last scan, exceeding that
 * observed empty period instead of reusing the ordinary short element-render retry.
 */
const PROJECT_ABSENCE_CONFIRMATION_SCANS = 6;
const PROJECT_ABSENCE_CONFIRMATION_INTERVAL_MS = 4_000;
/** Poll the post-create row at a human-scale cadence even when a caller uses a zero UI poll delay. */
const PROJECT_CREATED_ROW_POLL_INTERVAL_MS = 1_000;

/** A-144: URL-shaped values retain A-106 behavior; every other string is an exact Project name. */
export function classifyProject(value: string): ProjectReference {
  return PROJECT_URL_RE.test(value) ? { kind: "url", url: value } : { kind: "name", name: value };
}
/**
 * A-106: a conversation's pathname is either the plain `/c/<id>` or, when started inside a
 * Project (openProject), nested under it: `/g/g-p-<hash>-<slug>/c/<id>` — verified live
 * 2026-09-16 (clicking a project chat lands on the nested form). Keep schemas/request.schema.json
 * §conversationUrl in sync with this pattern by hand (JSON can't import it).
 */
export const CONVERSATION_PATH_RE =
  /^(?:\/c\/[A-Za-z0-9-]+|\/g\/g-p-[A-Za-z0-9-]+\/c\/[A-Za-z0-9-]+)$/;
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
  /** A-092: the viewer "保存" download crashes Chrome stable under automation (2026-09-15); opt-in only. */
  imageViaViewer?: boolean;
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

/**
 * Comparison key for verifying the composer received the prompt: FR-024 guards against *loss*,
 * not layout differences.
 *
 * A-128 (Phase 0-D-1, ChatGPT Pro self-review §2.3): stripping ALL whitespace (the previous
 * implementation) meant `print("a b")` and `print("ab")`, or differently-indented code, compared
 * as identical — masking loss of exactly the whitespace-sensitive content (string literals,
 * indentation) this check exists to catch. Limited to line-ending normalisation, NBSP/full-width
 * normalisation (via NFKC), and trimming only the string's own leading/trailing whitespace; all
 * other internal whitespace — including indentation — is preserved and compared literally.
 */
export function normalisePrompt(text: string): string {
  return text.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

/**
 * ChatGPT's ProseMirror composer turns each newline inserted through Playwright's contenteditable
 * path into a block boundary. Chromium's `innerText()` renders each such boundary as two newlines;
 * an empty source line is an empty block between two boundaries and therefore renders as five.
 *
 * A-142's saved trace proves the mapping for the live composer: a source run of `n` newlines is
 * read back as `3n - 1` newlines (1 -> 2, 2 -> 5). Undo only those exact runs on the observed
 * value. In particular, this is not a general whitespace-insensitive comparison: unexpected
 * runs, indentation, spaces, and every non-whitespace character remain literal and fail closed.
 */
function normaliseComposerInnerText(text: string): string {
  return normalisePrompt(text).replace(/\n+/g, (run) => {
    const sourceNewlines = (run.length + 1) / 3;
    return Number.isInteger(sourceNewlines) ? "\n".repeat(sourceNewlines) : run;
  });
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

  /**
   * A-127 (Phase 0-C-1, ChatGPT Pro self-review §2.1): `continueButton`/`sidePanel`/
   * `challengeFrame` have no `verifiedOn` candidates, so with the normal `verifiedOnly: true`
   * every candidate was skipped and these presence checks always silently returned `false` — "we
   * never checked" was indistinguishable from "confirmed absent" for exactly the three signals
   * (truncated response, Canvas, CAPTCHA/challenge) safety-relevant enough to matter most. Rather
   * than fabricate an unverified `verifiedOn` date, these detection-only checks (never used to
   * click/act — only to report a status) always run their candidates regardless of the run's
   * `verifiedOnly` setting: a false positive here just means extra caution in a warning/status
   * field, not a wrong action, so it's an acceptable trade for closing the always-false gap.
   */
  private get safetyCheckOpts() {
    return { verifiedOnly: false };
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
    if (await exists(this.page, "challengeFrame", this.safetyCheckOpts))
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

  /**
   * A-096: continue an existing conversation. The URL must stay on /c/<id> after load (a redirect to
   * "/" means the conversation does not exist for this account); the composer must be empty and no
   * generation may be in progress. Assistant turns already present become the baseline count.
   */
  async openConversation(
    url: string,
  ): Promise<
    | { kind: "ok" }
    | { kind: "failed"; cause: NewChatFailure }
    | { kind: "retry"; cause: string }
    | { kind: "dom_unexpected"; element: string; tried: string[] }
  > {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { kind: "failed", cause: "conversation_not_found" };
    }
    if (target.origin !== CHATGPT_ORIGIN || !CONVERSATION_PATH_RE.test(target.pathname)) {
      return { kind: "failed", cause: "conversation_not_found" };
    }
    try {
      await this.page.goto(`${target.origin}${target.pathname}`, { waitUntil: "domcontentloaded" });
    } catch (err) {
      return { kind: "retry", cause: (err as Error).message };
    }
    const deadline = Date.now() + (this.opts.newChatTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const composer = await probe(this.page, "composer", this.sel);
      if (composer.found && composer.locator) {
        await this.page.waitForTimeout(1000); // history renders after the composer
        const now = new URL(this.page.url());
        // Codex P6-1: a redirect to another origin with a composer must never receive the prompt
        if (now.origin !== CHATGPT_ORIGIN || now.pathname !== target.pathname) {
          return { kind: "failed", cause: "conversation_not_found" };
        }
        if ((await countMatches(this.page, "assistantTurn", this.sel)) === 0) {
          return { kind: "failed", cause: "conversation_not_found" };
        }
        if (await exists(this.page, "stopButton", this.sel))
          return { kind: "failed", cause: "generating" };
        const text = (await composer.locator.innerText().catch(() => "")).trim();
        if (text.length > 0) return { kind: "failed", cause: "composer_not_empty" };
        return { kind: "ok" };
      }
      await this.page.waitForTimeout(this.opts.pollIntervalMs ?? 250);
    }
    return { kind: "retry", cause: "composer did not appear in the conversation" };
  }

  /**
   * A-106: opens a ChatGPT Project's home page and waits for its own composer (same
   * `#prompt-textarea`, reused as-is — verified live 2026-09-16). Submitting from there starts a
   * new chat inside that project instead of at the plain chatgpt.com root.
   */
  async openProject(
    url: string,
  ): Promise<
    | { kind: "ok" }
    | { kind: "failed"; cause: "project_not_found" | "generating" | "composer_not_empty" }
    | { kind: "retry"; cause: string }
    | { kind: "dom_unexpected"; element: string; tried: string[] }
  > {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { kind: "failed", cause: "project_not_found" };
    }
    if (!PROJECT_URL_RE.test(url) || target.origin !== CHATGPT_ORIGIN) {
      return { kind: "failed", cause: "project_not_found" };
    }
    try {
      await this.page.goto(`${target.origin}${target.pathname}`, { waitUntil: "domcontentloaded" });
    } catch (err) {
      return { kind: "retry", cause: (err as Error).message };
    }
    const deadline = Date.now() + (this.opts.newChatTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const composer = await probe(this.page, "composer", this.sel);
      if (composer.found && composer.locator) {
        const now = new URL(this.page.url());
        // A redirect away from the project (e.g. access revoked, project deleted) must never
        // receive the prompt — same fail-closed pattern as openConversation's Codex P6-1 fix.
        if (now.origin !== CHATGPT_ORIGIN || now.pathname !== target.pathname) {
          return { kind: "failed", cause: "project_not_found" };
        }
        if (await exists(this.page, "stopButton", this.sel))
          return { kind: "failed", cause: "generating" };
        const text = (await composer.locator.innerText().catch(() => "")).trim();
        if (text.length > 0) return { kind: "failed", cause: "composer_not_empty" };
        return { kind: "ok" };
      }
      await this.page.waitForTimeout(this.opts.pollIntervalMs ?? 250);
    }
    return { kind: "retry", cause: "composer did not appear on the project page" };
  }

  /** Waits for a registry-defined element without ever bypassing verifiedOnly gating. */
  private async waitForElement(key: ElementKey, timeoutMs = 3_000): Promise<Locator> {
    const deadline = Date.now() + timeoutMs;
    let last: DomUnexpected | null = null;
    while (Date.now() < deadline) {
      try {
        return await resolve(this.page, key, this.sel);
      } catch (err) {
        if (!(err instanceof DomUnexpected)) throw err;
        last = err;
        await this.page.waitForTimeout(100);
      }
    }
    throw last ?? new DomUnexpected(key, []);
  }

  /**
   * A-144 (live-verified 2026-09-22): project sidebar rows are client-routed `role="button"` divs
   * with no `href` — the only confirmed way to learn a row's Project-home URL is to click its own
   * "プロジェクトのホームを開く" button (scoped to that row; every row has one) and read the
   * resulting `page.url()`. This navigates away from the sidebar list, which is fine here since
   * every caller either uses the resolved URL immediately (via `openProject()`, which navigates
   * again itself) or is mid-poll and will re-run `all()` against the (still-present) sidebar next
   * iteration.
   */
  private async openProjectHomeUrl(item: Locator): Promise<string | null> {
    const openHomeButton = await resolve(item, "projectOpenHomeButton", this.sel);
    await openHomeButton.click();
    await this.page.waitForTimeout(300);
    const url = this.page.url();
    return PROJECT_URL_RE.test(url) ? url : null;
  }

  /**
   * Two passes deliberately: `openProjectHomeUrl()` navigates the page away from the sidebar list,
   * which would detach every other row's `Locator` mid-loop. Count text matches first (no
   * navigation) so an ambiguous (>1) match is detected and reported without ever clicking anything;
   * only a confirmed single match proceeds to the one navigation that resolves its URL.
   */
  private async exactProjectMatches(name: string): Promise<{
    matches: Array<{ item: Locator; url: string | null }>;
    visibleProjectRowCount: number;
  }> {
    const items = await all(this.page, "projectSidebarItem", this.sel);
    const matchedItems: Locator[] = [];
    for (const item of items) {
      if ((await item.innerText().catch(() => "")).trim() === name) matchedItems.push(item);
    }
    if (matchedItems.length !== 1) {
      return {
        matches: matchedItems.map((item) => ({ item, url: null })),
        visibleProjectRowCount: items.length,
      };
    }
    const only = matchedItems[0];
    if (!only) return { matches: [], visibleProjectRowCount: items.length };
    return {
      matches: [{ item: only, url: await this.openProjectHomeUrl(only) }],
      visibleProjectRowCount: items.length,
    };
  }

  private creationUncertain(cause: string): { kind: "creation_uncertain"; cause: string } {
    return {
      kind: "creation_uncertain",
      cause:
        "Project creation was submitted but not confirmed; check the sidebar manually before retrying. " +
        cause,
    };
  }

  /**
   * A-144/A-145: resolves only an exact visible-name match. More than one exact match is never
   * guessed. A zero match is not absence evidence by itself: before the irreversible creation
   * click it must be repeated across the long A-145 confirmation window while an unrelated
   * Project row remains visible. The New Project control is deliberately not absence evidence:
   * it can remain visible while all Project rows flicker away. A zero-Project account has no
   * independently verified empty-state or list-response signal yet, so it fails closed.
   */
  async resolveOrCreateProject(
    name: string,
    control?: ProjectCreateControl,
  ): Promise<
    | { kind: "ok"; url: string; created: boolean }
    | { kind: "creation_uncertain"; cause: string }
    | { kind: "failed"; cause: NewChatFailure }
    | { kind: "retry"; cause: string }
    | { kind: "dom_unexpected"; element: string; tried: string[] }
  > {
    try {
      await this.page.goto(`${CHATGPT_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    } catch (err) {
      return { kind: "retry", cause: `navigation failed: ${(err as Error).message}` };
    }
    // This bounded best-effort wait reduces avoidable early scans, but network idleness is not a
    // SPA hydration guarantee. The visible Project rows in every scan below are the actual creation
    // gate, and remain fail-closed if this wait times out or resolves too early.
    await this.page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

    let existing: Awaited<ReturnType<ChatGptPage["exactProjectMatches"]>>;
    try {
      existing = await this.exactProjectMatches(name);
    } catch (err) {
      if (err instanceof DomUnexpected)
        return { kind: "dom_unexpected", element: err.element, tried: err.tried };
      return { kind: "retry", cause: (err as Error).message };
    }
    if (existing.matches.length > 1) {
      return {
        kind: "dom_unexpected",
        element: "projectSidebarItem",
        tried: [`exact visible name matched ${existing.matches.length} items`],
      };
    }
    if (existing.matches.length === 1) {
      const url = existing.matches[0]?.url;
      return url
        ? { kind: "ok", url, created: false }
        : {
            kind: "dom_unexpected",
            element: "projectSidebarItem",
            tried: ["exact visible name matched an item without a Project-home URL"],
          };
    }

    // A zero row count is never absence evidence. The verified New Project button cannot make it
    // so: during A-145 it remained visible while every Project row transiently disappeared. Until
    // a dedicated empty-state or authoritative Project-list response is verified live, a truly
    // empty account therefore remains intentionally unsupported.
    if (existing.visibleProjectRowCount === 0) {
      return {
        kind: "retry",
        cause:
          "Project absence was not confirmed: no visible Project rows (the sidebar may be collapsed or flickering); zero-Project creation is unsupported until a verified empty-state or authoritative list-response signal is available",
      };
    }

    // Preserve the initial row-backed read as scan one, then require five delayed re-scans. A row
    // disappearing at any sampled point aborts rather than merely resetting the streak: otherwise
    // an A-145-style sidebar flicker could turn a real existing Project into apparent absence.
    let confirmedAbsenceScans = 1;
    for (let scan = 1; scan < PROJECT_ABSENCE_CONFIRMATION_SCANS; scan++) {
      await this.page.waitForTimeout(PROJECT_ABSENCE_CONFIRMATION_INTERVAL_MS);
      try {
        existing = await this.exactProjectMatches(name);
      } catch (err) {
        if (err instanceof DomUnexpected)
          return { kind: "dom_unexpected", element: err.element, tried: err.tried };
        return { kind: "retry", cause: (err as Error).message };
      }
      if (existing.matches.length > 1) {
        return {
          kind: "dom_unexpected",
          element: "projectSidebarItem",
          tried: [`exact visible name matched ${existing.matches.length} items`],
        };
      }
      if (existing.matches.length === 1) {
        const url = existing.matches[0]?.url;
        return url
          ? { kind: "ok", url, created: false }
          : {
              kind: "dom_unexpected",
              element: "projectSidebarItem",
              tried: ["exact visible name matched an item without a Project-home URL"],
            };
      }
      if (existing.visibleProjectRowCount === 0) {
        return {
          kind: "retry",
          cause:
            "Project absence was not confirmed: visible Project rows disappeared during the A-145 confirmation window",
        };
      }
      confirmedAbsenceScans++;
    }
    if (confirmedAbsenceScans < PROJECT_ABSENCE_CONFIRMATION_SCANS) {
      return {
        kind: "retry",
        cause: "Project absence was not confirmed during the A-145 confirmation window",
      };
    }

    let confirmButton: Locator;
    try {
      await (await this.waitForElement("newProjectButton")).click();
      await (await this.waitForElement("newProjectNameInput")).fill(name);
      confirmButton = await this.waitForElement("newProjectConfirmButton");
    } catch (err) {
      if (err instanceof DomUnexpected)
        return { kind: "dom_unexpected", element: err.element, tried: err.tried };
      return { kind: "retry", cause: `Project creation flow failed: ${(err as Error).message}` };
    }

    // The controller can time out while this method is still alive because Promise.race does not
    // cancel its loser. Check its signal at the irreversible boundary, then record that the submit
    // may have reached ChatGPT before calling Playwright. From this point every path is uncertain.
    if (control?.signal.aborted) {
      return { kind: "retry", cause: "Project creation was aborted before confirm click" };
    }
    control?.markSubmitted();
    try {
      await confirmButton.click();
    } catch (err) {
      return this.creationUncertain(`confirm click failed: ${(err as Error).message}`);
    }

    const deadline = Date.now() + (this.opts.newChatTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      let created: Awaited<ReturnType<ChatGptPage["exactProjectMatches"]>>;
      try {
        created = await this.exactProjectMatches(name);
      } catch (err) {
        return this.creationUncertain(
          err instanceof DomUnexpected
            ? `sidebar observation failed: ${err.element}: tried ${err.tried.join(", ")}`
            : `sidebar observation failed: ${(err as Error).message}`,
        );
      }
      if (created.matches.length > 1) {
        return this.creationUncertain(
          `created exact visible name matched ${created.matches.length} items`,
        );
      }
      if (created.matches.length === 1) {
        const url = created.matches[0]?.url;
        return url
          ? { kind: "ok", url, created: true }
          : this.creationUncertain("created exact visible name has no Project-home URL");
      }
      try {
        await this.page.waitForTimeout(PROJECT_CREATED_ROW_POLL_INTERVAL_MS);
      } catch (err) {
        return this.creationUncertain(`post-submit poll failed: ${(err as Error).message}`);
      }
    }
    return this.creationUncertain("created Project did not appear in the sidebar");
  }

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
    // The Project trace in A-149 shows the composer still present while this verified trigger is
    // briefly replaced during hydration. Keep the existing verified-only selector and bounded
    // fail-closed behavior, but do not turn that one transient re-query into DOM_CHANGED.
    const trigger = await this.waitForElement("modelPicker");
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

  /**
   * A failed prompt entry must not leave an unsent draft for a later run to inherit. Cleanup is
   * deliberately best-effort: the original failure remains the useful result if the page is no
   * longer actionable.
   */
  private async clearComposerAfterFailedPrompt(composer: Locator): Promise<void> {
    try {
      await composer.fill("");
    } catch (err) {
      try {
        this.opts.log?.(`prompt cleanup failed: ${(err as Error).message}`);
      } catch {
        // Logging must not turn the original prompt-entry failure into a new failure.
      }
    }
  }

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
        const seen = normaliseComposerInnerText(await composer.innerText());
        lastSeen = seen;
        if (seen === expected) {
          if (attachments.length === 0) return { kind: "ok" };
          return this.attachFiles(attachments);
        }
      } catch (err) {
        const cause = (err as Error).message;
        await this.clearComposerAfterFailedPrompt(composer);
        return { kind: "retry", cause };
      }
    }
    await this.clearComposerAfterFailedPrompt(composer);
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
    const truncated = await exists(this.page, "continueButton", this.safetyCheckOpts);
    const sidePanel = await exists(this.page, "sidePanel", this.safetyCheckOpts);

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
    if (await exists(this.page, "challengeFrame", this.safetyCheckOpts)) challenge = "captcha";
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
    if (await exists(this.page, "sidePanel", this.safetyCheckOpts))
      return { kind: "empty", cause: "canvas" };
    const bodyProbe = await probe(turn, "assistantTurnBody", this.sel);
    const modelSlug = await this.readModelSlug(turn);
    if (!bodyProbe.found || !bodyProbe.locator) {
      // No Markdown body: an image-only turn (A-091) carries only UI captions ("編集"). Text is
      // empty but the turn is not, provided a large image is present; images are captured later.
      const imgCount = await countMatches(turn, "turnImage", this.sel);
      if (imgCount > 0) return { markdown: "", method: "dom", quality: "full", modelSlug };
      const raw = (await turn.innerText().catch(() => "")).trim();
      if (raw.length === 0) return { kind: "empty", cause: "empty" };
      return { markdown: raw, method: "innerText", quality: "degraded", modelSlug };
    }
    const body = bodyProbe.locator;
    const innerText = await body.innerText().catch(() => "");
    if (innerText.trim().length === 0) {
      const imgCount = await countMatches(turn, "turnImage", this.sel);
      if (imgCount > 0) return { markdown: "", method: "dom", quality: "full", modelSlug };
      return { kind: "empty", cause: "empty" };
    }

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

  /**
   * A-091 / A-069 / A-092: generated images. For each distinct large image in the latest turn:
   *   1. fetch the very same img.src inside the page (the URL the page itself renders)
   *   2. opt-in fallback (CHATGPT_BRIDGE_IMAGE_VIA_VIEWER=1): image -> viewer (role=dialog) -> "保存"
   *      -> Playwright download event. Chrome stable crashed on this under automation (2026-09-15).
   * The viewer carries its own composer and send button; only "保存" and the close button are touched.
   */
  async captureImages(
    dir: string,
    signal: AbortSignal,
  ): Promise<{ saved: string[]; warnings: string[] }> {
    const saved: string[] = [];
    const warnings: string[] = [];
    const turn = await latest(this.page, "assistantTurn", this.sel);
    if (!turn) return { saved, warnings };
    const seen = new Set<string>();
    const targets: Array<{ src: string; locator: Locator }> = [];
    for (const c of ELEMENTS.turnImage.candidates) {
      if (this.opts.verifiedOnly && !c.verifiedOn) continue;
      const loc = build(turn, c);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 20); i++) {
        const img = loc.nth(i);
        const src = (await img.getAttribute("src").catch(() => null)) ?? "";
        if (!src || seen.has(src)) continue;
        const natural = await img
          .evaluate((e) => (e as HTMLImageElement).naturalWidth)
          .catch(() => 0);
        if (natural < 256) continue;
        seen.add(src);
        targets.push({ src, locator: img });
      }
      if (targets.length > 0) break;
    }
    if (targets.length === 0) return { saved, warnings };
    await mkdir(dir, { recursive: true });
    for (const [i, t] of targets.entries()) {
      const n = i + 1;
      if (signal.aborted) {
        warnings.push(`image_capture_failed: image ${n}: aborted (time budget exhausted)`);
        continue;
      }
      // A-092: in-page fetch of the rendered URL is primary (A-069); the viewer download is opt-in
      // because Chrome stable crashes on the download under automation (crash dumps 2026-09-15).
      const viaFetch = await this.saveImageViaFetch(t.src, dir, n, signal).catch((err) => ({
        ok: false as const,
        cause: (err as Error).message,
      }));
      if (viaFetch.ok) {
        saved.push(viaFetch.file);
        continue;
      }
      if (!this.opts.imageViaViewer) {
        warnings.push(`image_capture_failed: image ${n}: ${viaFetch.cause}`);
        continue;
      }
      this.opts.log?.(`image ${n}: fetch failed (${viaFetch.cause}); trying viewer download`);
      const viaViewer = await this.saveImageViaViewer(t.locator, dir, n, signal).catch((err) => ({
        ok: false as const,
        cause: (err as Error).message,
      }));
      if (viaViewer.ok) saved.push(viaViewer.file);
      else warnings.push(`image_capture_failed: image ${n}: ${viaFetch.cause}; ${viaViewer.cause}`);
    }
    return { saved, warnings };
  }

  private async saveImageViaViewer(
    img: Locator,
    dir: string,
    n: number,
    signal: AbortSignal,
  ): Promise<{ ok: true; file: string } | { ok: false; cause: string }> {
    await img.scrollIntoViewIfNeeded().catch(() => undefined);
    await img.click({ force: true, timeout: 5000 });
    const deadline = Date.now() + 5000;
    let viewer: Locator | null = null;
    while (Date.now() < deadline) {
      const p = await probe(this.page, "imageViewer", this.sel);
      if (p.found && p.locator) {
        viewer = p.locator;
        break;
      }
      await this.page.waitForTimeout(150);
    }
    if (!viewer) return { ok: false, cause: "viewer did not open" };
    try {
      const save = await resolve(viewer, "imageSaveButton", this.sel);
      const [download] = await Promise.all([
        this.page.waitForEvent("download", { timeout: 30_000 }),
        save.click({ timeout: 5000 }),
      ]);
      if (signal.aborted) return { ok: false, cause: "aborted before write" };
      const suggested = download.suggestedFilename();
      const ext = (suggested.match(/\.([A-Za-z0-9]{2,5})$/)?.[1] ?? "png").toLowerCase();
      const file = `${n}.${ext}`;
      await download.saveAs(join(dir, file));
      return { ok: true, file };
    } finally {
      await this.closeImageViewer(viewer);
    }
  }

  private async closeImageViewer(viewer: Locator): Promise<void> {
    for (let i = 0; i < 3; i++) {
      if (!(await exists(this.page, "imageViewer", this.sel))) return;
      const close = await probe(viewer, "imageViewerClose", this.sel);
      if (close.found && close.locator)
        await close.locator.click({ timeout: 3000 }).catch(() => undefined);
      else await this.page.keyboard.press("Escape").catch(() => undefined);
      await this.page.waitForTimeout(400);
    }
  }

  /**
   * A-069: read the bytes the page already displays (same URL as the <img>), nothing else.
   *
   * A-124 (Phase 0-C-3, ChatGPT Pro redesign review §2.10): `signal` cannot itself cross the CDP
   * boundary into the page's own `fetch()` — Playwright's `evaluate()` only accepts
   * structured-clonable arguments, and an `AbortSignal` isn't one, so the in-page request was
   * never actually cancellable and `signal.aborted` was previously only checked *after* the
   * `evaluate()` call had already resolved. What this now guarantees instead: the call this
   * function makes to `evaluate()` stops waiting promptly (bounded by `signal` firing or a fixed
   * ceiling), even though the in-page fetch may continue running in the background regardless.
   */
  private async saveImageViaFetch(
    src: string,
    dir: string,
    n: number,
    signal: AbortSignal,
  ): Promise<{ ok: true; file: string } | { ok: false; cause: string }> {
    if (!src.startsWith(`${CHATGPT_ORIGIN}/`))
      return { ok: false, cause: "img.src is not on chatgpt.com" };
    const evalPromise = this.page.evaluate(async (url) => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return { ok: false as const, cause: `HTTP ${res.status}` };
      const blob = await res.blob();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000)
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { ok: true as const, type: blob.type, b64: btoa(bin) };
    }, src);
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new Error("aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    let r: { ok: true; type: string; b64: string } | { ok: false; cause: string };
    try {
      r = await Promise.race([withTimeout(evalPromise, 60_000, "saveImageViaFetch"), aborted]);
    } catch (err) {
      evalPromise.catch(() => undefined); // avoid an unhandled rejection once it eventually settles
      return { ok: false, cause: (err as Error).message };
    }
    if (!r.ok) return r;
    if (signal.aborted) return { ok: false, cause: "aborted before write" };
    const ext = r.type.includes("png")
      ? "png"
      : r.type.includes("jpeg")
        ? "jpg"
        : r.type.includes("webp")
          ? "webp"
          : "bin";
    const file = `${n}.${ext}`;
    await writeFile(join(dir, file), Buffer.from(r.b64, "base64"));
    return { ok: true, file };
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
