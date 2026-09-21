import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STEALTH_SIGNAL_PATCH } from "../../src/browser/stealth-signals.js";

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

beforeAll(async () => {
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      // Keep the fixture tier runnable on machines without a Playwright browser installation.
      browser = null;
    }
  }
});

afterAll(async () => {
  await browser?.close();
});

describe("experimental stealth signal init script", () => {
  it("shadows Chrome's inherited webdriver accessor on a real page", async ({ skip }) => {
    if (!browser) {
      skip();
      return;
    }
    const context = await browser.newContext();
    try {
      await context.addInitScript(STEALTH_SIGNAL_PATCH);
      const page = await context.newPage();
      await page.goto("data:text/html,<title>stealth fixture</title>");
      await expect(page.evaluate(() => navigator.webdriver)).resolves.toBeUndefined();
      await expect(page.evaluate(() => Object.hasOwn(navigator, "webdriver"))).resolves.toBe(true);
    } finally {
      await context.close();
    }
  });
});
