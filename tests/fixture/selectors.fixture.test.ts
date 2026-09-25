/**
 * 16-TEST-STRATEGY fixture tier: the selector module against a sanitized DOM snapshot in a real
 * Chromium (headless is fine here: no ChatGPT involved, no profile). Skipped when no browser is
 * available so `npm test` stays runnable on a bare machine.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ChatGptPage } from "../../src/chatgpt/page.js";
import {
  all,
  countMatches,
  ELEMENTS,
  exists,
  latest,
  parseTriggerLabel,
  probe,
  resolve,
} from "../../src/chatgpt/selectors.js";
import { REPO_ROOT } from "../../src/contracts/schema.js";
import { htmlToMarkdown } from "../../src/extraction/markdown.js";

let browser: Browser | null = null;
let page: Page;

beforeAll(async () => {
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      browser = null;
    }
  }
  if (!browser) return;
  page = await browser.newPage();
  await page.setContent(
    await readFile(join(REPO_ROOT, "tests", "fixtures", "chatgpt-2026-09-15.html"), "utf8"),
  );
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const sel = { verifiedOnly: true };

describe("selectors on the 2026-09-15 fixture", () => {
  it("run-critical elements resolve with verified candidates only", async ({ skip }) => {
    if (!browser) skip();
    expect(await (await resolve(page, "composer", sel)).getAttribute("id")).toBe("prompt-textarea");
    expect(await (await resolve(page, "sendButton", sel)).getAttribute("data-testid")).toBe(
      "send-button",
    );
    expect(await (await resolve(page, "modelPicker", sel)).innerText()).toBe("5.5 高");
    expect(await exists(page, "stopButton", sel)).toBe(false);
    expect(await exists(page, "loginCta", sel)).toBe(false);
    expect(await countMatches(page, "assistantTurn", sel)).toBe(1);
    expect(await countMatches(page, "userTurn", sel)).toBe(1);
    expect(await countMatches(page, "attachmentChip", sel)).toBe(2);
    const fileInput = await probe(page, "fileInput", sel);
    expect(fileInput.matches).toBe(0); // hidden inputs are not "visible": attachFiles uses count(), not probe()
    expect(await page.locator('form input[type="file"]#upload-files').count()).toBe(1);
  });

  it("turn body, copy button and image are found inside the latest turn", async ({ skip }) => {
    if (!browser) skip();
    const turn = await latest(page, "assistantTurn", sel);
    expect(turn).not.toBeNull();
    if (!turn) return;
    const body = await probe(turn, "assistantTurnBody", sel);
    expect(body.found).toBe(true);
    expect(
      await turn
        .locator("[data-message-model-slug]")
        .first()
        .getAttribute("data-message-model-slug"),
    ).toBe("gpt-5-6-thinking");
    expect(await turn.locator('[data-testid="copy-turn-action-button"]').count()).toBe(1);
    expect(await countMatches(turn, "turnImage", sel)).toBe(1);
    // a code-block "コピーする" must not be mistaken for the turn copy button
    expect(
      await turn.getByRole("button", { name: /^(回答をコピーする|Copy response)$/ }).count(),
    ).toBe(1);
  });

  it("trigger label with a model prefix parses; dom fallback converts the nested code block", async ({
    skip,
  }) => {
    if (!browser) skip();
    const label = await (await resolve(page, "modelPickerCurrentLabel", sel)).innerText();
    expect(parseTriggerLabel(label.trim(), "ja")).toEqual({
      preset: "high",
      effortLabel: "高",
      modelHint: "5.5",
    });
    const turn = await latest(page, "assistantTurn", sel);
    const html = await (await probe(turn ?? page, "assistantTurnBody", sel)).locator?.innerHTML();
    const md = htmlToMarkdown(html ?? "");
    expect(md).toContain("# Bridge Smoke Test");
    expect(md).toMatch(
      /```typescript\nfunction hello_bridge\(\) \{\n {2}console\.log\("hello"\);\n\}\n```/,
    );
    expect(md).not.toMatch(/コピーする/);
  });
});

describe("REL-3 route-origin fixture", () => {
  it("records the supplied 173-second SPA transition as unsolicited History API evidence", async ({
    skip,
  }) => {
    if (!browser) return skip();
    const p = await browser.newPage();
    const bridge = new ChatGptPage(p, { verifiedOnly: true });
    const dir = await mkdtemp(join(tmpdir(), "chatgpt-bridge-route-"));
    try {
      await p.goto(
        pathToFileURL(join(REPO_ROOT, "tests", "fixtures", "route-drift-20260923.html")).href,
      );
      await p.evaluate(() => history.pushState({}, "", "#unrelated-conversation-6ab2c806"));
      const artifact = await bridge.recordRouteTelemetry(dir, {
        expectedUrl: "https://chatgpt.com/c/6ab17047",
        observedUrl: "https://chatgpt.com/c/6ab2c806",
        recoveryAttempt: 1,
        processNavigationInFlight: false,
      });
      expect(artifact).not.toBeNull();
      const line = JSON.parse(await readFile(artifact as string, "utf8")) as {
        processNavigationInFlight: boolean;
        routeEvents: Array<{ source: string; processCommand?: string | null }>;
      };
      expect(line.processNavigationInFlight).toBe(false);
      expect(line.routeEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "history.pushState" }),
          expect.objectContaining({ source: "framenavigated", processCommand: null }),
        ]),
      );
    } finally {
      await p.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("A-157 selectors on the 2026-09-24 redesign fixture", () => {
  async function redesignPage(): Promise<Page> {
    if (!browser) throw new Error("browser unavailable");
    const fixturePage = await browser.newPage();
    await fixturePage.setContent(
      await readFile(
        join(REPO_ROOT, "tests", "fixtures", "chatgpt-2026-09-24-redesign.html"),
        "utf8",
      ),
    );
    return fixturePage;
  }

  it("resolves the redesigned composer and the generated-id file input shape", async ({ skip }) => {
    if (!browser) return skip();
    const fixturePage = await redesignPage();
    try {
      const composerCandidate = ELEMENTS.composer.candidates[0];
      expect(composerCandidate).toMatchObject({
        kind: "css",
        selector: 'form[data-chatgpt-composer] [contenteditable="true"][data-composer-markdown]',
      });
      const composer = await resolve(fixturePage, "composer", sel);
      expect(await composer.getAttribute("data-composer-markdown")).toBe("");
      expect(await composer.getAttribute("aria-label")).toBe("ChatGPT に聞く");
      const fileInputCandidate = ELEMENTS.fileInput.candidates[0];
      expect(fileInputCandidate).toMatchObject({
        kind: "css",
        selector: 'form[data-chatgpt-composer] input[type="file"]:not([accept])',
      });
      if (fileInputCandidate?.kind !== "css") throw new Error("expected A-157 file-input CSS");
      expect(await fixturePage.locator(fileInputCandidate.selector).count()).toBe(1);
    } finally {
      await fixturePage.close();
    }
  });

  it("resolves the redesigned model trigger and its visible effort label", async ({ skip }) => {
    if (!browser) return skip();
    const fixturePage = await redesignPage();
    try {
      expect(
        await (await resolve(fixturePage, "modelPicker", sel)).getAttribute(
          "data-codex-intelligence-trigger",
        ),
      ).toBe("true");
      expect(await (await resolve(fixturePage, "modelPickerCurrentLabel", sel)).innerText()).toBe(
        "中程度",
      );
    } finally {
      await fixturePage.close();
    }
  });

  it("resolves the aria-labelled new-chat button without matching the sidebar text row", async ({
    skip,
  }) => {
    if (!browser) return skip();
    const fixturePage = await redesignPage();
    try {
      expect(
        await (await resolve(fixturePage, "newChatButton", sel)).getAttribute("aria-label"),
      ).toBe("新しいチャット");
    } finally {
      await fixturePage.close();
    }
  });

  it("resolves redesigned Project rows, their row-as-home control, and the create control", async ({
    skip,
  }) => {
    if (!browser) return skip();
    const fixturePage = await redesignPage();
    try {
      expect(await countMatches(fixturePage, "projectSidebarItem", sel)).toBe(1);
      const item = fixturePage.locator("[data-app-action-sidebar-project-row]").first();
      expect(
        await (await resolve(item, "projectOpenHomeButton", sel)).getAttribute(
          "data-app-action-sidebar-project-row",
        ),
      ).toBe("");
      expect(
        await (await resolve(fixturePage, "newProjectButton", sel)).getAttribute(
          "data-app-action-sidebar-project-create",
        ),
      ).toBe("");
    } finally {
      await fixturePage.close();
    }
  });

  it("resolves the typed send control and all open-picker controls from their new attributes", async ({
    skip,
  }) => {
    if (!browser) return skip();
    const fixturePage = await redesignPage();
    try {
      expect(await (await resolve(fixturePage, "sendButton", sel)).getAttribute("aria-label")).toBe(
        "送信",
      );
      const menu = await resolve(fixturePage, "pickerMenu", sel);
      expect(await menu.getAttribute("data-radix-menu-content")).toBe("");
      expect(
        await (await resolve(menu, "effortSliderRow", sel)).getAttribute("data-reasoning-slider"),
      ).toBe("true");
      expect(await (await resolve(menu, "effortSlider", sel)).getAttribute("aria-valuenow")).toBe(
        "1",
      );
      expect(
        await (await resolve(menu, "modelExpander", sel)).getAttribute(
          "data-model-picker-view-toggle",
        ),
      ).toBe("true");
    } finally {
      await fixturePage.close();
    }
  });

  it("scopes attachment removal to the redesigned composer chip", async ({ skip }) => {
    if (!browser) return skip();
    const fixturePage = await redesignPage();
    try {
      expect(await countMatches(fixturePage, "attachmentChip", sel)).toBe(1);
      const removeButtons = await all(fixturePage, "attachmentRemoveButton", sel);
      expect(removeButtons).toHaveLength(1);
      const removeButton = removeButtons[0];
      if (!removeButton) throw new Error("expected redesigned attachment remove button");
      expect(await removeButton.getAttribute("aria-label")).toBe("sample.ts を削除");
    } finally {
      await fixturePage.close();
    }
  });

  it("uses turn wrappers that scope each assistant body and copy action", async ({ skip }) => {
    if (!browser) return skip();
    const fixturePage = await redesignPage();
    try {
      expect(await countMatches(fixturePage, "assistantTurn", sel)).toBe(2);
      expect(await countMatches(fixturePage, "userTurn", sel)).toBe(2);
      const user = await latest(fixturePage, "userTurn", sel);
      if (!user) throw new Error("expected redesigned user turn");
      expect(await user.innerText()).toBe("Reply with exactly: ok");
      const assistant = await latest(fixturePage, "assistantTurn", sel);
      const body = await probe(assistant ?? fixturePage, "assistantTurnBody", sel);
      expect(body.found).toBe(true);
      if (!body.locator) throw new Error("expected redesigned assistant Markdown body");
      expect(await body.locator.innerText()).toBe("ok");
      expect(await exists(assistant ?? fixturePage, "copyTurnButton", sel)).toBe(true);
    } finally {
      await fixturePage.close();
    }
  });
});

describe("ChatGptPage model picker readiness on a fixture", () => {
  it("waits for a briefly absent verified model picker before resolving the preset", async ({
    skip,
  }) => {
    if (!browser) {
      skip();
      return;
    }
    const fixturePage = await browser.newPage();
    try {
      await fixturePage.setContent(`
        <form><div data-composer-transition-slot="trailing"></div></form>
        <script>
          const trailing = document.querySelector('[data-composer-transition-slot="trailing"]');
          const addPicker = () => {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('aria-haspopup', 'menu');
            button.textContent = 'Instant';
            button.addEventListener('click', () => {
              const menu = document.createElement('div');
              menu.dataset.testid = 'composer-intelligence-picker-content';
              menu.innerHTML = '<div role="menuitem" aria-expanded="true">Models</div>' +
                '<div role="menuitemradio" aria-checked="true">最新</div>';
              document.body.append(menu);
            });
            trailing.append(button);
          };
          setTimeout(addPicker, 100);
          document.addEventListener('click', (event) => {
            if (event.target !== trailing.querySelector('button')) document.querySelector('[data-testid="composer-intelligence-picker-content"]')?.remove();
          });
        </script>
      `);
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: true });

      await expect(chat.resolvePreset("current", "current")).resolves.toMatchObject({
        kind: "observed",
        preset: "instant",
        model: "latest",
      });
    } finally {
      await fixturePage.close();
    }
  }, 10_000);
});

describe("ChatGptPage recovery ownership fixtures (A-154)", () => {
  it("matches only the user turn immediately preceding the recovered reply", async ({ skip }) => {
    if (!browser) {
      skip();
      return;
    }
    const recovery = await browser.newPage();
    try {
      await recovery.setContent(`
        <div data-message-author-role="user">older prompt</div>
        <div data-message-author-role="assistant">older reply</div>
        <div data-message-author-role="user">Submitted\r\nprompt</div>
        <div data-message-author-role="assistant">candidate reply</div>
      `);
      const chatgpt = new ChatGptPage(recovery, { verifiedOnly: true });
      await expect(chatgpt.verifyLatestReplyOwnership("Submitted\nprompt", [])).resolves.toEqual({
        kind: "match",
      });
      await expect(
        chatgpt.verifyLatestReplyOwnership("different prompt", []),
      ).resolves.toMatchObject({
        kind: "mismatch",
      });
    } finally {
      await recovery.close();
    }
  });

  it("opens collect with a saved draft without altering its text", async ({ skip }) => {
    if (!browser) {
      skip();
      return;
    }
    const recovery = await browser.newPage();
    const url = "https://chatgpt.com/c/recovery-proof";
    try {
      await recovery.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `
            <section data-turn="assistant">existing reply</section>
            <div id="prompt-textarea" contenteditable="true">human saved draft</div>
          `,
        }),
      );
      const chatgpt = new ChatGptPage(recovery, { verifiedOnly: true, newChatTimeoutMs: 2_000 });
      await expect(chatgpt.openConversationForCollect(url)).resolves.toEqual({
        kind: "ok",
        draftPresent: true,
      });
      await expect(recovery.locator("#prompt-textarea").innerText()).resolves.toBe(
        "human saved draft",
      );
    } finally {
      await recovery.close();
    }
  });
});

describe("ChatGptPage prompt cleanup on a fixture", () => {
  async function submitFixture(
    body: string,
    timeoutMs = 200,
  ): Promise<{ page: Page; chat: ChatGptPage; acceptanceEvidence: string[] }> {
    if (!browser) throw new Error("browser unavailable");
    const fixturePage = await browser.newPage();
    await fixturePage.setContent(`
      <form>
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <button type="button" data-testid="send-button">send</button>
        ${body}
      </form>
    `);
    const acceptanceEvidence: string[] = [];
    const chat = new ChatGptPage(fixturePage, {
      verifiedOnly: true,
      pollIntervalMs: 10,
      submitAcceptanceTimeoutMs: timeoutMs,
      acceptanceLog: (message) => acceptanceEvidence.push(message),
    });
    // The submit fixtures deliberately isolate acceptance from picker mechanics.
    (chat as unknown as { readPresetLabel: () => Promise<string> }).readPresetLabel = async () =>
      "Pro";
    await expect(chat.enterPrompt("expected prompt", [])).resolves.toEqual({ kind: "ok" });
    return { page: fixturePage, chat, acceptanceEvidence };
  }

  it("A-155: a click that does nothing is not sent, cleans the composer, and is never re-clicked", async ({
    skip,
  }) => {
    if (!browser) {
      skip();
      return;
    }
    const { page: fixturePage, chat } = await submitFixture(`
      <script>
        window.clicks = 0;
        document.querySelector('[data-testid=send-button]').addEventListener('click', () => window.clicks++);
      </script>
    `);
    try {
      await expect(
        chat.dispatchSubmit(
          { assistantCount: 0, userTurnCount: 0, url: "about:blank", presetLabel: "Pro" },
          { newChat: false },
        ),
      ).resolves.toMatchObject({ kind: "not_confirmed" });
      await expect(fixturePage.locator("#prompt-textarea").textContent()).resolves.toBe("");
      await expect(
        fixturePage.evaluate(() => (window as typeof window & { clicks: number }).clicks),
      ).resolves.toBe(1);
    } finally {
      await fixturePage.close();
    }
  });

  it("A-155b: a draft cleared then restored remains unknown, never retryable", async ({ skip }) => {
    if (!browser) {
      skip();
      return;
    }
    const { page: fixturePage, chat } = await submitFixture(`
      <script>
        document.querySelector('[data-testid=send-button]').addEventListener('click', () => {
          const composer = document.querySelector('#prompt-textarea');
          composer.textContent = '';
          setTimeout(() => { composer.textContent = 'expected prompt'; }, 20);
        });
      </script>
    `);
    try {
      await expect(
        chat.dispatchSubmit(
          { assistantCount: 0, userTurnCount: 0, url: "about:blank", presetLabel: "Pro" },
          { newChat: false },
        ),
      ).resolves.toMatchObject({ kind: "unknown" });
      await expect(fixturePage.locator("#prompt-textarea").innerText()).resolves.toBe(
        "expected prompt",
      );
    } finally {
      await fixturePage.close();
    }
  });

  it("A-155: slow acceptance inside the bounded window is dispatched", async ({ skip }) => {
    if (!browser) {
      skip();
      return;
    }
    const {
      page: fixturePage,
      chat,
      acceptanceEvidence,
    } = await submitFixture(
      `
      <script>
        window.clicks = 0;
        document.querySelector('[data-testid=send-button]').addEventListener('click', () => {
          window.clicks++;
          setTimeout(() => {
            document.querySelector('#prompt-textarea').textContent = '';
            document.body.insertAdjacentHTML('beforeend', '<section data-turn="user">expected prompt</section>');
          }, 30);
        });
      </script>
    `,
      500,
    );
    try {
      await expect(
        chat.dispatchSubmit(
          { assistantCount: 0, userTurnCount: 0, url: "about:blank", presetLabel: "Pro" },
          { newChat: false },
        ),
      ).resolves.toMatchObject({ kind: "dispatched" });
      expect(acceptanceEvidence).toContain("submit acceptance evidence: userTurn");
      await expect(
        fixturePage.evaluate(() => (window as typeof window & { clicks: number }).clicks),
      ).resolves.toBe(1);
    } finally {
      await fixturePage.close();
    }
  });

  it("A-155b: a matching user turn that appears at 25 seconds is dispatched", async ({ skip }) => {
    if (!browser) {
      skip();
      return;
    }
    const { page: fixturePage, chat } = await submitFixture(
      `
      <script>
        document.querySelector('[data-testid=send-button]').addEventListener('click', () => {
          setTimeout(() => {
            document.querySelector('#prompt-textarea').textContent = '';
            document.body.insertAdjacentHTML('beforeend', '<section data-turn="user">expected prompt</section>');
          }, 25000);
        });
      </script>
    `,
      30_000,
    );
    try {
      await expect(
        chat.dispatchSubmit(
          { assistantCount: 0, userTurnCount: 0, url: "about:blank", presetLabel: "Pro" },
          { newChat: false },
        ),
      ).resolves.toMatchObject({ kind: "dispatched" });
    } finally {
      await fixturePage.close();
    }
  }, 35_000);

  it("A-155b: a retained draft plus a moved new-chat URL is unknown", async ({ skip }) => {
    if (!browser) {
      skip();
      return;
    }
    const fixturePage = await browser.newPage();
    await fixturePage.route("https://chatgpt.com/", (route) =>
      route.fulfill({ body: "<html></html>" }),
    );
    await fixturePage.goto("https://chatgpt.com/");
    try {
      await fixturePage.setContent(`
        <form>
          <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
          <button type="button" data-testid="send-button">send</button>
        </form>
        <script>
          document.querySelector('[data-testid=send-button]').addEventListener('click', () => {
            history.pushState({}, '', '/c/accepted-request');
          });
        </script>
      `);
      const chat = new ChatGptPage(fixturePage, {
        verifiedOnly: true,
        pollIntervalMs: 10,
        submitAcceptanceTimeoutMs: 200,
      });
      (chat as unknown as { readPresetLabel: () => Promise<string> }).readPresetLabel = async () =>
        "Pro";
      await expect(chat.enterPrompt("expected prompt", [])).resolves.toEqual({ kind: "ok" });
      await expect(
        chat.dispatchSubmit(
          { assistantCount: 0, userTurnCount: 0, url: "https://chatgpt.com/", presetLabel: "Pro" },
          { newChat: true },
        ),
      ).resolves.toMatchObject({ kind: "dispatched" });
      await expect(fixturePage.locator("#prompt-textarea").innerText()).resolves.toBe(
        "expected prompt",
      );
    } finally {
      await fixturePage.close();
    }
  });

  it("A-155b: not-sent cleanup removes composer text and every verified attachment chip", async ({
    skip,
  }) => {
    if (!browser) {
      skip();
      return;
    }
    const { page: fixturePage, chat } = await submitFixture(`
      <div role="group" aria-label="one.png"><button aria-label="ファイル 1 を削除：one.png"></button></div>
      <div role="group" aria-label="two.png"><button aria-label="ファイル 2 を削除：two.png"></button></div>
      <script>
        document.querySelectorAll('[aria-label*="削除"]').forEach((button) =>
          button.addEventListener('click', () => button.parentElement.remove()),
        );
      </script>
    `);
    try {
      await expect(
        chat.dispatchSubmit(
          { assistantCount: 0, userTurnCount: 0, url: "about:blank", presetLabel: "Pro" },
          { newChat: false },
        ),
      ).resolves.toMatchObject({ kind: "not_confirmed" });
      await expect(fixturePage.locator("#prompt-textarea").innerText()).resolves.toMatch(/^\s*$/);
      await expect(fixturePage.locator('form [role="group"]').count()).resolves.toBe(0);
    } finally {
      await fixturePage.close();
    }
  });

  it("A-155: a cleared composer without a turn remains conservatively unknown", async ({
    skip,
  }) => {
    if (!browser) {
      skip();
      return;
    }
    const { page: fixturePage, chat } = await submitFixture(`
      <script>
        window.clicks = 0;
        document.querySelector('[data-testid=send-button]').addEventListener('click', () => {
          window.clicks++;
          document.querySelector('#prompt-textarea').textContent = '';
        });
      </script>
    `);
    try {
      await expect(
        chat.dispatchSubmit(
          { assistantCount: 0, userTurnCount: 0, url: "about:blank", presetLabel: "Pro" },
          { newChat: false },
        ),
      ).resolves.toMatchObject({ kind: "unknown" });
      await expect(
        fixturePage.evaluate(() => (window as typeof window & { clicks: number }).clicks),
      ).resolves.toBe(1);
    } finally {
      await fixturePage.close();
    }
  });

  it("A-155: aria-disabled send during upload is never clicked", async ({ skip }) => {
    if (!browser) {
      skip();
      return;
    }
    const { page: fixturePage, chat } = await submitFixture(`
      <script>
        window.clicks = 0;
        const button = document.querySelector('[data-testid=send-button]');
        button.setAttribute('aria-disabled', 'true');
        button.addEventListener('click', () => window.clicks++);
      </script>
    `);
    try {
      await expect(
        chat.dispatchSubmit(
          { assistantCount: 0, userTurnCount: 0, url: "about:blank", presetLabel: "Pro" },
          { newChat: false },
        ),
      ).resolves.toEqual({ kind: "failed", cause: "send_button_disabled" });
      await expect(
        fixturePage.evaluate(() => (window as typeof window & { clicks: number }).clicks),
      ).resolves.toBe(0);
    } finally {
      await fixturePage.close();
    }
  });

  it("clears a mismatched composer before returning", async ({ skip }) => {
    if (!browser) {
      skip();
      return;
    }
    const fixturePage = await browser.newPage();
    try {
      await fixturePage.setContent(`
        <form><div id="prompt-textarea" contenteditable="true" role="textbox"></div></form>
        <script>
          const composer = document.querySelector('#prompt-textarea');
          composer.addEventListener('input', () => {
            if (composer.textContent) queueMicrotask(() => { composer.textContent = 'mismatch'; });
          });
        </script>
      `);
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: true });

      await expect(chat.enterPrompt("expected prompt", [])).resolves.toEqual({
        kind: "mismatch",
        cause: "composer content differs (expected 15 chars, saw 8 chars)",
      });
      await expect(fixturePage.locator("#prompt-textarea").textContent()).resolves.toBe("");
    } finally {
      await fixturePage.close();
    }
  });

  it("accepts the ProseMirror block rendering that caused A-142 without accepting wrong text", async ({
    skip,
  }) => {
    if (!browser) {
      skip();
      return;
    }
    const fixturePage = await browser.newPage();
    const numberedListPrompt = [
      "Introduction",
      "",
      "Situation:",
      "- first item",
      "- second item",
      "",
      "Questions:",
      "1. first question",
      "2. second question",
      "",
      "Conclusion",
    ].join("\n");
    try {
      await fixturePage.setContent(`
        <form><div id="prompt-textarea" contenteditable="true" role="textbox"></div></form>
        <script>
          const composer = document.querySelector('#prompt-textarea');
          let corrupt = false;
          let transformTimer;
          composer.addEventListener('input', () => {
            clearTimeout(transformTimer);
            transformTimer = setTimeout(() => {
              // Chromium's raw contenteditable insertion represents one blank line as three
              // newlines. ProseMirror normalizes it back to one empty paragraph.
              const lines = composer.innerText.replace(/\\n{3}/g, '\\n\\n').split('\\n');
              composer.replaceChildren(...lines.map((line) => {
                const paragraph = document.createElement('p');
                paragraph.textContent = corrupt ? line.replace('second', 'broken') : line;
                if (!line) paragraph.append(document.createElement('br'));
                return paragraph;
              }));
            }, 0);
          });
          window.setComposerCorrupt = () => { corrupt = true; };
        </script>
      `);
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: true });

      // Real Chromium renders the block tree as 1 -> 2 and 2 -> 5 newlines, as in A-142's trace.
      await expect(chat.enterPrompt(numberedListPrompt, [])).resolves.toEqual({ kind: "ok" });
      await expect(fixturePage.locator("#prompt-textarea").innerText()).resolves.toContain(
        "\n\n\n\n\nSituation:",
      );

      await fixturePage.evaluate(() => {
        (window as typeof window & { setComposerCorrupt: () => void }).setComposerCorrupt();
      });
      await expect(chat.enterPrompt(numberedListPrompt, [])).resolves.toMatchObject({
        kind: "mismatch",
      });
      await expect(fixturePage.locator("#prompt-textarea").textContent()).resolves.toBe("");
    } finally {
      await fixturePage.close();
    }
  });
});

describe("A-144 Project resolve-or-create fixture", () => {
  // Mirrors the real, live-verified (2026-09-22) DOM shape: sidebar rows are `<li>`s containing a
  // `[data-testid="project-folder-icon"]` marker (no `<a href>` -- real rows are client-routed
  // divs), each with a "プロジェクトのホームを開く" button that navigates via `history.pushState`
  // (this fixture's stand-in for the real client-side router) rather than exposing a URL directly.
  async function projectFixture(
    existingNames: string[],
    options: {
      initiallyHiddenNames?: string[];
      revealInitiallyHiddenAfterMs?: number;
      flickerSidebar?: boolean;
      createdRowDelayMs?: number;
      hideSidebarAfterCreationMs?: number;
      bootstrapDelayMs?: number;
      collapsedProjectSection?: boolean;
      suppressCreatedRow?: boolean;
    } = {},
  ): Promise<Page> {
    if (!browser) throw new Error("browser unavailable");
    const fixturePage = await browser.newPage();
    const initiallyHiddenNames = new Set(options.initiallyHiddenNames ?? []);
    const collapsedAttribute = options.collapsedProjectSection === true ? " hidden" : "";
    const rows = existingNames
      .map(
        (name, i) => `
        <li data-project-name="${name}"${initiallyHiddenNames.has(name) ? " hidden" : ""}>
          <div class="group/project-unfurl-row relative">
            <div data-testid="project-folder-icon"></div>
            <span>${name}</span>
            <button aria-label="プロジェクトのホームを開く" data-url="/g/g-p-existing-${i}/project" style="width:16px;height:16px;display:inline-block;"></button>
          </div>
        </li>`,
      )
      .join("");
    const content = `
      <ul id="sidebar"${collapsedAttribute}>${rows}</ul>
      <button id="new-project-button" aria-label="プロジェクトを新規作成"${collapsedAttribute} style="width:16px;height:16px;display:inline-block;"></button>
      <form data-testid="create-new-project-form" hidden>
        <input id="project-name" name="projectName" />
        <button type="submit" disabled style="width:16px;height:16px;display:inline-block;"></button>
      </form>
      <script>
        document.querySelectorAll('button[aria-label="プロジェクトのホームを開く"]').forEach((btn) => {
          btn.addEventListener('click', () => {
            history.pushState(null, '', btn.dataset.url);
          });
        });
        const form = document.querySelector('form');
        const input = document.querySelector('#project-name');
        const submit = form.querySelector('button[type="submit"]');
        document.body.dataset.projectCreations = '0';
        const bootstrapDelayMs = ${options.bootstrapDelayMs ?? 0};
        if (bootstrapDelayMs > 0) {
          const sidebar = document.querySelector('#sidebar');
          sidebar.hidden = true;
          const newProjectButton = document.querySelector('#new-project-button');
          newProjectButton.hidden = true;
          fetch('/fixture-project-bootstrap').finally(() => {
            sidebar.hidden = false;
            newProjectButton.hidden = false;
          });
        }
        const revealAfterMs = ${options.revealInitiallyHiddenAfterMs ?? -1};
        if (revealAfterMs >= 0) {
          window.setTimeout(() => {
            document.querySelectorAll('li[hidden]').forEach((li) => { li.hidden = false; });
          }, revealAfterMs);
        }
        if (${options.flickerSidebar === true}) {
          window.setInterval(() => {
            const sidebar = document.querySelector('#sidebar');
            sidebar.hidden = !sidebar.hidden;
          }, 3000);
        }
        document.querySelector('[aria-label="プロジェクトを新規作成"]').addEventListener('click', () => {
          form.hidden = false;
        });
        input.addEventListener('input', () => { submit.disabled = input.value.length === 0; });
        submit.addEventListener('click', (e) => {
          e.preventDefault();
          document.body.dataset.projectCreations = String(Number(document.body.dataset.projectCreations) + 1);
          if (${options.hideSidebarAfterCreationMs ?? 0} > 0) {
            const sidebar = document.querySelector('#sidebar');
            sidebar.hidden = true;
            window.setTimeout(() => { sidebar.hidden = false; }, ${options.hideSidebarAfterCreationMs ?? 0});
          }
          if (!${options.suppressCreatedRow === true}) {
            window.setTimeout(() => {
              const li = document.createElement('li');
              li.innerHTML =
                '<div class="group/project-unfurl-row relative">' +
                '<div data-testid="project-folder-icon"></div>' +
                '<span>' + input.value + '</span>' +
                '<button aria-label="プロジェクトのホームを開く" data-url="/g/g-p-created/project" style="width:16px;height:16px;display:inline-block;"></button>' +
                '</div>';
              document.querySelector('#sidebar').append(li);
              li.querySelector('button').addEventListener('click', () => {
                history.pushState(null, '', '/g/g-p-created/project');
              });
            }, ${options.createdRowDelayMs ?? 0});
          }
          form.hidden = true;
        });
      </script>
    `;
    if ((options.bootstrapDelayMs ?? 0) > 0) {
      await fixturePage.route("https://chatgpt.com/fixture-project-bootstrap", async (route) => {
        await new Promise<void>((done) => setTimeout(done, options.bootstrapDelayMs));
        await route.fulfill({ status: 204 });
      });
    }
    await fixturePage.route("https://chatgpt.com/", (route) =>
      // Explicit charset matters: without it, Chrome guesses the response's encoding and can
      // misdecode the literal Japanese aria-label text below, silently breaking every CSS
      // attribute-value selector that depends on it (confirmed live -- the same markup served via
      // setContent() matched fine, only the HTTP-served route.fulfill() path needed this).
      route.fulfill({ contentType: "text/html; charset=utf-8", body: content }),
    );
    return fixturePage;
  }

  it("uses one exact existing match without creating", async ({ skip }) => {
    if (!browser) return skip();
    const fixturePage = await projectFixture(["EMAKINOCO-Win"]);
    try {
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: false, pollIntervalMs: 0 });
      await expect(chat.resolveOrCreateProject("EMAKINOCO-Win")).resolves.toEqual({
        kind: "ok",
        url: "https://chatgpt.com/g/g-p-existing-0/project",
        created: false,
      });
    } finally {
      await fixturePage.close();
    }
  });

  it("creates after six stable no-match scans and survives a transient empty sidebar while polling", async ({
    skip,
  }) => {
    if (!browser) return skip();
    const fixturePage = await projectFixture(["Other Project"], {
      // The row is created immediately, but the entire list disappears for the first two post-click
      // polls. This verifies that the creation-result polling is not a single unreliable read.
      hideSidebarAfterCreationMs: 2_100,
    });
    try {
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: false, pollIntervalMs: 0 });
      await expect(chat.resolveOrCreateProject("EMAKINOCO-Win")).resolves.toEqual({
        kind: "ok",
        url: "https://chatgpt.com/g/g-p-created/project",
        created: true,
      });
      await expect(
        fixturePage.evaluate(() => Number(document.body.dataset.projectCreations)),
      ).resolves.toBe(1);
    } finally {
      await fixturePage.close();
    }
  }, 35_000);

  it("A-147: a zero-Project account fails closed without a verified empty-state signal", async ({
    skip,
  }) => {
    if (!browser) return skip();
    const fixturePage = await projectFixture([]);
    const originalWait = fixturePage.waitForTimeout.bind(fixturePage);
    const waitSpy = vi
      .spyOn(fixturePage, "waitForTimeout")
      .mockImplementation(async (ms) => originalWait(ms === 4_000 || ms === 1_000 ? 1 : ms));
    try {
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: false, pollIntervalMs: 0 });
      await expect(chat.resolveOrCreateProject("EMAKINOCO-Zero")).resolves.toMatchObject({
        kind: "retry",
        cause: expect.stringContaining("no visible Project rows"),
      });
      await expect(
        fixturePage.evaluate(() => Number(document.body.dataset.projectCreations)),
      ).resolves.toBe(0);
    } finally {
      waitSpy.mockRestore();
      await fixturePage.close();
    }
  }, 30_000);

  it("A-146 follow-up: a collapsed Project section fails closed without creating", async ({
    skip,
  }) => {
    if (!browser) return skip();
    const fixturePage = await projectFixture([], { collapsedProjectSection: true });
    const loadStateSpy = vi.spyOn(fixturePage, "waitForLoadState").mockResolvedValue();
    const originalWait = fixturePage.waitForTimeout.bind(fixturePage);
    const waitSpy = vi
      .spyOn(fixturePage, "waitForTimeout")
      .mockImplementation(async (ms) => originalWait(ms === 4_000 || ms === 1_000 ? 1 : ms));
    try {
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: false, pollIntervalMs: 0 });
      await expect(chat.resolveOrCreateProject("EMAKINOCO-Collapsed")).resolves.toMatchObject({
        kind: "retry",
        cause: expect.stringContaining("sidebar may be collapsed"),
      });
      await expect(
        fixturePage.evaluate(() => Number(document.body.dataset.projectCreations)),
      ).resolves.toBe(0);
    } finally {
      waitSpy.mockRestore();
      loadStateSpy.mockRestore();
      await fixturePage.close();
    }
  }, 30_000);

  it("A-146 follow-up: a submitted create whose row times out is uncertain, never retryable", async ({
    skip,
  }) => {
    if (!browser) return skip();
    const fixturePage = await projectFixture(["Other Project"], { suppressCreatedRow: true });
    const originalWait = fixturePage.waitForTimeout.bind(fixturePage);
    const waitSpy = vi
      .spyOn(fixturePage, "waitForTimeout")
      .mockImplementation(async (ms) => originalWait(ms === 4_000 || ms === 1_000 ? 1 : ms));
    try {
      const chat = new ChatGptPage(fixturePage, {
        verifiedOnly: false,
        pollIntervalMs: 0,
        newChatTimeoutMs: 1,
      });
      await expect(chat.resolveOrCreateProject("EMAKINOCO-Timeout")).resolves.toMatchObject({
        kind: "creation_uncertain",
        cause: expect.stringContaining("submitted but not confirmed"),
      });
      await expect(
        fixturePage.evaluate(() => Number(document.body.dataset.projectCreations)),
      ).resolves.toBe(1);
    } finally {
      waitSpy.mockRestore();
      await fixturePage.close();
    }
  }, 30_000);

  it("A-148: an aborted name-resolution task never reaches the confirm click", async ({ skip }) => {
    if (!browser) return skip();
    const fixturePage = await projectFixture(["Other Project"]);
    const originalWait = fixturePage.waitForTimeout.bind(fixturePage);
    const waitSpy = vi
      .spyOn(fixturePage, "waitForTimeout")
      .mockImplementation(async (ms) => originalWait(ms === 4_000 || ms === 1_000 ? 1 : ms));
    const abort = new AbortController();
    abort.abort();
    try {
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: false, pollIntervalMs: 0 });
      await expect(
        chat.resolveOrCreateProject("EMAKINOCO-Aborted", {
          signal: abort.signal,
          markSubmitted: () => {
            throw new Error("an aborted create must not cross the submit boundary");
          },
        }),
      ).resolves.toMatchObject({
        kind: "retry",
        cause: expect.stringContaining("aborted before confirm"),
      });
      await expect(
        fixturePage.evaluate(() => Number(document.body.dataset.projectCreations)),
      ).resolves.toBe(0);
    } finally {
      waitSpy.mockRestore();
      await fixturePage.close();
    }
  }, 30_000);

  it("A-146 follow-up: an error after the confirm click is uncertain, never retryable", async ({
    skip,
  }) => {
    if (!browser) return skip();
    const fixturePage = await projectFixture(["Other Project"], { suppressCreatedRow: true });
    const originalWait = fixturePage.waitForTimeout.bind(fixturePage);
    const waitSpy = vi.spyOn(fixturePage, "waitForTimeout").mockImplementation(async (ms) => {
      const creations = await fixturePage.locator("body").getAttribute("data-project-creations");
      if (creations === "1") throw new Error("simulated post-confirm failure");
      return ms === 4_000 ? undefined : originalWait(ms);
    });
    try {
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: false, pollIntervalMs: 0 });
      await expect(chat.resolveOrCreateProject("EMAKINOCO-Thrown")).resolves.toMatchObject({
        kind: "creation_uncertain",
        cause: expect.stringContaining("post-confirm failure"),
      });
      await expect(
        fixturePage.evaluate(() => Number(document.body.dataset.projectCreations)),
      ).resolves.toBe(1);
    } finally {
      waitSpy.mockRestore();
      await fixturePage.close();
    }
  }, 30_000);

  it("waits for client hydration before starting the six absence scans", async ({ skip }) => {
    if (!browser) return skip();
    // Without the post-goto network-idle wait, scan one observes the hidden sidebar and only five
    // later scans can establish absence, so creation must refuse. The held bootstrap request makes
    // network-idle a concrete, fixture-controlled hydration boundary.
    const fixturePage = await projectFixture(["Other Project"], { bootstrapDelayMs: 100 });
    try {
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: false, pollIntervalMs: 0 });
      await expect(chat.resolveOrCreateProject("EMAKINOCO-Win")).resolves.toEqual({
        kind: "ok",
        url: "https://chatgpt.com/g/g-p-created/project",
        created: true,
      });
      await expect(
        fixturePage.evaluate(() => Number(document.body.dataset.projectCreations)),
      ).resolves.toBe(1);
    } finally {
      await fixturePage.close();
    }
  }, 40_000);

  it("does not create when an initially missing exact row reappears during A-145 confirmation", async ({
    skip,
  }) => {
    if (!browser) return skip();
    // The first scan sees a different, still-visible Project. The requested existing row appears
    // before the next four-second scan. A pre-fix single scan would create a duplicate here.
    const fixturePage = await projectFixture(["Other Project", "EMAKINOCO-Win"], {
      initiallyHiddenNames: ["EMAKINOCO-Win"],
      revealInitiallyHiddenAfterMs: 1_000,
    });
    try {
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: false, pollIntervalMs: 0 });
      await expect(chat.resolveOrCreateProject("EMAKINOCO-Win")).resolves.toEqual({
        kind: "ok",
        url: "https://chatgpt.com/g/g-p-existing-1/project",
        created: false,
      });
      await expect(
        fixturePage.evaluate(() => Number(document.body.dataset.projectCreations)),
      ).resolves.toBe(0);
    } finally {
      await fixturePage.close();
    }
  }, 15_000);

  it("refuses creation when sidebar flicker never yields confident absence (A-145)", async ({
    skip,
  }) => {
    if (!browser) return skip();
    const fixturePage = await projectFixture(["Other Project"], { flickerSidebar: true });
    try {
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: false, pollIntervalMs: 0 });
      await expect(chat.resolveOrCreateProject("EMAKINOCO-Win")).resolves.toMatchObject({
        kind: "retry",
      });
      await expect(
        fixturePage.evaluate(() => Number(document.body.dataset.projectCreations)),
      ).resolves.toBe(0);
    } finally {
      await fixturePage.close();
    }
  }, 30_000);

  it("fails closed when more than one Project has the exact requested name", async ({ skip }) => {
    if (!browser) return skip();
    const fixturePage = await projectFixture(["EMAKINOCO-Win", "EMAKINOCO-Win"]);
    try {
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: false, pollIntervalMs: 0 });
      await expect(chat.resolveOrCreateProject("EMAKINOCO-Win")).resolves.toMatchObject({
        kind: "dom_unexpected",
        element: "projectSidebarItem",
      });
    } finally {
      await fixturePage.close();
    }
  });
});
