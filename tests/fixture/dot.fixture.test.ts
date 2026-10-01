import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { REPO_ROOT } from "../../src/contracts/schema.js";
import {
  type DotDecision,
  decideDotCompletion,
  dotPrefix,
  dotPrompt,
} from "../../src/dot/completion.js";
import { DotPage, readDotComposerText } from "../../src/dot/page.js";

let browser: Browser | null = null;
let dir: string;
beforeAll(async () => {
  if (process.env.BRIDGE_SKIP_BROWSER_TESTS === "1") return;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      browser = null;
    }
  }
  if (browser) dir = await mkdtemp(join(REPO_ROOT, ".dot-fixture-"));
}, 30_000);
afterAll(async () => {
  await browser?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
it("synthetic only: one send, multi-row poller, captions excluded, exact-byte downloads and suffixes", async ({
  skip,
}) => {
  if (!browser) {
    skip();
    return;
  }
  const page = await browser.newPage({ acceptDownloads: true });
  // Fail closed against every network request: fixtures use file: and blob: exclusively.
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(pathToFileURL(join(REPO_ROOT, "tests/fixtures/dot-synthetic.html")).href);
  const dot = new DotPage(page);
  const id = "20261001T120000Z-a1b2c3d4";
  await dot.prepare(dotPrompt(id, "Synthetic prompt"));
  await dot.send();
  let decision: DotDecision | undefined;
  const start = performance.now();
  while (!decision?.done && performance.now() - start < 6000) {
    const snapshot = await dot.snapshot();
    decision = decideDotCompletion(
      snapshot,
      dotPrefix(id),
      performance.now(),
      decision?.progress,
      "DONE",
    );
    await page.waitForTimeout(100);
  }
  expect(decision?.done).toBe(true);
  expect(decision?.replies).toHaveLength(2);
  const replies = decision?.replies ?? [];
  expect(dot.extract(replies).markdown).toBe(
    "First synthetic reply\n\n---\n\nSecond synthetic reply — DONE",
  );
  expect(dot.extract(replies).markdown).not.toContain("FILE CHIP CAPTION");
  expect(replies.every((row) => !row.text.includes("FILE CHIP CAPTION"))).toBe(true);
  expect(replies[0]?.text).not.toContain("DONE");
  await routeFiles(page);
  const bytes = Buffer.from("# Synthetic file\n- exact bytes\n");
  const fileDot = new DotPage(page, 30_000, undefined, async () => byteResponse(bytes));
  const eventSpy = vi.spyOn(page, "waitForEvent");
  const onSpy = vi.spyOn(page, "on");
  const downloaded = await fileDot.files(replies, dir);
  expect(eventSpy).not.toHaveBeenCalled();
  expect(onSpy).not.toHaveBeenCalled();
  expect(
    await page.evaluate(
      () => (window as unknown as { downloadClicks?: number }).downloadClicks ?? 0,
    ),
  ).toBe(0);
  expect(downloaded.warnings).toEqual([]);
  expect(downloaded.files).toHaveLength(2);
  expect(new Set(downloaded.files.map((f) => f.path)).size).toBe(2);
  for (const file of downloaded.files) {
    expect(await readFile(join(dir, file.path), "utf8")).toBe("# Synthetic file\n- exact bytes\n");
    expect(file.bytes).toBe(Buffer.byteLength("# Synthetic file\n- exact bytes\n"));
  }
  expect(await page.evaluate(() => (window as unknown as { sendCount: number }).sendCount)).toBe(1);
  await page.close();
}, 15_000);
it("synthetic visible approval dialog halts without clicking inside", async ({ skip }) => {
  if (!browser) {
    skip();
    return;
  }
  const page = await browser.newPage();
  await page.route(/^https?:/, (route) => route.abort());
  await page.setContent('<main><div role="dialog"><button>Approve</button></div></main>');
  await expect(new DotPage(page).safety()).rejects.toMatchObject({
    code: "MANUAL_INTERVENTION_REQUIRED",
  });
  await page.close();
});
it("synthetic draft and changed thread are preserved without sending", async ({ skip }) => {
  if (!browser) {
    skip();
    return;
  }
  const page = await browser.newPage();
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(pathToFileURL(join(REPO_ROOT, "tests/fixtures/dot-synthetic.html")).href);
  const dot = new DotPage(page);
  await page.locator("[contenteditable]").fill("PO draft");
  await expect(dot.prepare("new prompt")).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(await page.locator("[contenteditable]").innerText()).toBe("PO draft");
  await page.locator("[contenteditable]").fill("");
  await dot.prepare("synthetic prompt");
  await page.evaluate(() => {
    const row = document.createElement("article");
    row.className = "message-row self";
    row.dataset.messageId = "human";
    row.innerHTML = '<div class="message-body">PO typed</div>';
    document.querySelector("#thread")?.append(row);
  });
  await expect(dot.send()).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
  expect(
    await page.evaluate(() => (window as unknown as { sendCount?: number }).sendCount ?? 0),
  ).toBe(0);
  await page.close();
});
it("synthetic standalone resource card excludes captions and completion markers", async ({
  skip,
}) => {
  if (!browser) {
    skip();
    return;
  }
  const page = await browser.newPage();
  await page.route(/^https?:/, (route) => route.abort());
  await page.setContent(
    '<main><article class="message-row self" data-message-id="own"><div class="message-body">prefix</div></article><article class="message-row" data-message-id="reply"><div class="message-body"><div class="group/resource-card"><span>caption DONE</span><button aria-label="Open test.md">Open</button></div><p>Reply text</p></div></article></main>',
  );
  const dot = new DotPage(page);
  const snapshot = await dot.snapshot();
  expect(snapshot.rows[1]?.text).toBe("Reply text");
  expect(snapshot.rows[1]?.files).toEqual(["Open test.md"]);
  expect(dot.extract(snapshot.rows.slice(1)).markdown).toBe("Reply text");
  const first = decideDotCompletion(snapshot, "prefix", 0, undefined, "DONE");
  expect(decideDotCompletion(snapshot, "prefix", 3000, first.progress, "DONE").done).toBe(false);
  await page.close();
});

const fileBytes = Buffer.from("exact bytes\n");
function byteResponse(bytes: Buffer, length?: string) {
  return {
    ok: () => true,
    headers: () => (length === undefined ? {} : { "content-length": length }),
    body: async () => bytes,
  };
}
async function routeFiles(
  page: import("playwright").Page,
  metadata: unknown = {
    name: "report.md",
    download_url: "https://files.oaiusercontent.com/raw?secret=synthetic",
  },
) {
  await page.route(/\/backend-api\/messaging\/rooms\/.*\/files\/CalpicoFile_/, (route) =>
    route.fulfill({ json: metadata, headers: { "access-control-allow-origin": "*" } }),
  );
}
for (const [mode, metadata, cause] of [
  [
    "rejected host",
    { download_url: "https://evil.example/raw?secret=synthetic" },
    "unexpected download host",
  ],
  [
    "suffix spoof",
    { download_url: "https://oaiusercontent.com.evil.example/raw" },
    "unexpected download host",
  ],
  [
    "insecure protocol",
    { download_url: "http://files.oaiusercontent.com/raw" },
    "unexpected download host",
  ],
  ["missing URL", {}, "missing download_url"],
  [
    "oversize header",
    { download_url: "https://files.oaiusercontent.com/raw" },
    "file exceeds 20 MB",
  ],
  ["oversize body", { download_url: "https://files.oaiusercontent.com/raw" }, "file exceeds 20 MB"],
  [
    "secret error",
    { download_url: "https://files.oaiusercontent.com/raw?secret=synthetic" },
    "file fetch failed",
  ],
  ["hung fetch", { download_url: "https://files.oaiusercontent.com/raw" }, "timeout"],
  ["closed page", { download_url: "https://files.oaiusercontent.com/raw" }, "file fetch failed"],
] as const) {
  it(`synthetic API file failure: ${mode}`, async ({ skip }) => {
    if (!browser) {
      skip();
      return;
    }
    const page = await browser.newPage();
    await page.route(/^https?:/, (route) => route.abort());
    await routeFiles(page, metadata);
    await page.goto(pathToFileURL(join(REPO_ROOT, "tests/fixtures/dot-synthetic.html")).href);
    const body = vi.fn(async () => (mode === "oversize body" ? Buffer.alloc(33) : fileBytes));
    const fetch = vi.fn(async () => {
      if (mode === "closed page") {
        await page.close();
        throw new Error("closed");
      }
      if (mode === "secret error")
        throw new Error("https://files.oaiusercontent.com/raw?secret=synthetic");
      if (mode === "hung fetch") return new Promise<never>(() => {});
      return { ...byteResponse(fileBytes, mode === "oversize header" ? "33" : undefined), body };
    });
    const dot = new DotPage(page, 1000, 32, fetch);
    await dot.prepare("synthetic prompt");
    await dot.send();
    await page.waitForTimeout(400);
    const rows = (await dot.snapshot()).rows.filter((row) => row.files.length);
    const result = await dot.files(mode === "closed page" ? rows : rows.slice(0, 1), dir);
    expect(result.files).toEqual([]);
    expect(result.warnings).toEqual([`file_download_failed: ../report.md: ${cause}`]);
    expect(JSON.stringify(result)).not.toContain("secret=synthetic");
    if (mode === "oversize header") expect(body).not.toHaveBeenCalled();
    if (cause === "unexpected download host" || cause === "missing download_url")
      expect(fetch).not.toHaveBeenCalled();
    if (mode === "closed page") expect(fetch).toHaveBeenCalledTimes(1);
    await page.close();
  });
}

it("synthetic API files enforce ten-file cap and closed-page stop", async ({ skip }) => {
  if (!browser) {
    skip();
    return;
  }
  const page = await browser.newPage();
  await page.route(/^https?:/, (route) => route.abort());
  await routeFiles(page);
  await page.goto(pathToFileURL(join(REPO_ROOT, "tests/fixtures/dot-synthetic.html")).href);
  const dot = new DotPage(page, 3000, undefined, async () => byteResponse(fileBytes));
  await dot.prepare("synthetic prompt");
  await dot.send();
  await page.waitForTimeout(400);
  const row = (await dot.snapshot()).rows.find((row) => row.files.length);
  if (!row) throw new Error("missing fixture row");
  const result = await dot.files([{ ...row, files: Array(11).fill(row.files[0]) }], dir);
  expect(result.files).toHaveLength(10);
  expect(result.warnings).toEqual(["file_download_failed: ../report.md: max 10 files"]);
  await page.close();
  const closed = await dot.files([row, row], dir);
  expect(closed.warnings).toEqual(["file_download_failed: ../report.md: page closed"]);
});

it("synthetic ProseMirror composer preserves LF text and excludes decorations", async ({
  skip,
}) => {
  if (!browser) {
    skip();
    return;
  }
  const page = await browser.newPage();
  await page.route(/^https?:/, (route) => route.abort());
  try {
    await page.setContent(
      '<div contenteditable="true"><p>日本語 Markdown</p><p data-empty-paragraph="true"><br class="ProseMirror-trailingBreak"></p><p>色 <span class="inline-markdown">#798171</span><span aria-hidden="true" class="inline-block">hidden decoration<br><span>hidden text</span></span><br class="ProseMirror-trailingBreak"></p><p>  - 文字 `code`</p><p>https://example.test/path</p><p>soft<br>break</p><div>DIV boundary</div><li>first</li><li>second</li><p data-empty-paragraph="true"><br class="ProseMirror-trailingBreak"></p></div>',
    );
    expect(await page.locator("[contenteditable]").evaluate(readDotComposerText)).toBe(
      "日本語 Markdown\n\n色 #798171\n  - 文字 `code`\nhttps://example.test/path\nsoft\nbreak\nDIV boundary\nfirst\nsecond\n",
    );
    await page.setContent('<div contenteditable="true"><br></div>');
    expect(await page.locator("[contenteditable]").evaluate(readDotComposerText)).toBe("\n");
  } finally {
    await page.close();
  }
});
