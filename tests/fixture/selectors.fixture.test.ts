/**
 * 16-TEST-STRATEGY fixture tier: the selector module against a sanitized DOM snapshot in a real
 * Chromium (headless is fine here: no ChatGPT involved, no profile). Skipped when no browser is
 * available so `npm test` stays runnable on a bare machine.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatGptPage } from "../../src/chatgpt/page.js";
import {
  countMatches,
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
});
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

describe("ChatGptPage prompt cleanup on a fixture", () => {
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
  async function projectFixture(existingNames: string[]): Promise<Page> {
    if (!browser) throw new Error("browser unavailable");
    const fixturePage = await browser.newPage();
    const rows = existingNames
      .map(
        (name, i) => `
        <li>
          <div data-testid="project-folder-icon"></div>
          <span>${name}</span>
          <button aria-label="プロジェクトのホームを開く" data-url="/g/g-p-existing-${i}/project" style="width:16px;height:16px;display:inline-block;"></button>
        </li>`,
      )
      .join("");
    const content = `
      <ul id="sidebar">${rows}</ul>
      <button aria-label="プロジェクトを新規作成" style="width:16px;height:16px;display:inline-block;"></button>
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
        document.querySelector('[aria-label="プロジェクトを新規作成"]').addEventListener('click', () => {
          form.hidden = false;
        });
        input.addEventListener('input', () => { submit.disabled = input.value.length === 0; });
        submit.addEventListener('click', (e) => {
          e.preventDefault();
          const li = document.createElement('li');
          li.innerHTML =
            '<div data-testid="project-folder-icon"></div>' +
            '<span>' + input.value + '</span>' +
            '<button aria-label="プロジェクトのホームを開く" data-url="/g/g-p-created/project" style="width:16px;height:16px;display:inline-block;"></button>';
          document.querySelector('#sidebar').append(li);
          li.querySelector('button').addEventListener('click', () => {
            history.pushState(null, '', '/g/g-p-created/project');
          });
          form.hidden = true;
        });
      </script>
    `;
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

  // A-145: creation is temporarily disabled (see the doc comment in resolveOrCreateProject()) --
  // the sidebar Project list was confirmed live to be transient, and a single-shot "not found"
  // reading already created two real duplicate Projects before this was caught. This test now
  // pins the disabled behavior; the follow-up retry-mechanism fix should replace it with real
  // creation-path coverage once resolveOrCreateProject() requires consistent absence across
  // multiple scans before ever creating anything.
  it("no exact match: creation stays disabled rather than risk a duplicate (A-145)", async ({
    skip,
  }) => {
    if (!browser) return skip();
    const fixturePage = await projectFixture(["Other Project"]);
    try {
      const chat = new ChatGptPage(fixturePage, { verifiedOnly: false, pollIntervalMs: 0 });
      await expect(chat.resolveOrCreateProject("EMAKINOCO-Win")).resolves.toMatchObject({
        kind: "retry",
      });
    } finally {
      await fixturePage.close();
    }
  });

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
