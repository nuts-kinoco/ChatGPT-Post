/**
 * 16-TEST-STRATEGY fixture tier: the selector module against a sanitized DOM snapshot in a real
 * Chromium (headless is fine here: no ChatGPT involved, no profile). Skipped when no browser is
 * available so `npm test` stays runnable on a bare machine.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
