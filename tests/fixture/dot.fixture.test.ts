import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { collectDotReply, dotRequestForCollect } from "../../src/cli/collect.js";
import { REPO_ROOT } from "../../src/contracts/schema.js";
import {
  type DotDecision,
  decideDotCompletion,
  dotPrefix,
  dotPrompt,
} from "../../src/dot/completion.js";
import { DotPage, readDotComposerText } from "../../src/dot/page.js";
import type { Ports } from "../../src/state/ports.js";

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
    decision = decideDotCompletion(snapshot, id, performance.now(), decision?.progress, "DONE");
    await page.waitForTimeout(100);
  }
  expect(decision?.done).toBe(true);
  expect(decision?.replies).toHaveLength(2);
  const replies = decision?.replies ?? [];
  expect(dot.extract(replies).markdown).toBe(
    `requestId: ${id} First synthetic reply\n\n---\n\nrequestId: ${id} Second synthetic reply — DONE`,
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
  const collectPorts = {
    lock: { acquire: async () => ({ kind: "ok", token: "collect-test" }), release: async () => {} },
    browser: {
      checkProfilePath: async () => ({ ok: true }),
      checkProfileFree: async () => ({ free: true }),
      launch: async () => ({ ok: true }),
      close: async () => {},
    },
  } as unknown as Pick<Ports, "browser" | "lock">;
  const collectedDir = join(dir, "collected", "2026-10-01T01-00-00Z");
  const recovered = await collectDotReply(
    id,
    "DONE",
    collectPorts,
    () => ({
      navigate: async () => {},
      snapshot: fileDot.snapshot.bind(fileDot),
      currentUrl: () => "synthetic-thread",
      extract: fileDot.extract.bind(fileDot),
      files: fileDot.files.bind(fileDot),
    }),
    collectedDir,
  );
  expect(recovered).toMatchObject({ ok: true, state: "complete", replyCount: 2 });
  const saved = JSON.parse(await readFile(join(collectedDir, "collect-result.json"), "utf8"));
  expect(saved.savedFiles).toHaveLength(2);
  for (const file of saved.savedFiles)
    expect(await readFile(join(collectedDir, file.path), "utf8")).toBe(bytes.toString());
  expect(
    await page.evaluate(
      () => (window as unknown as { downloadClicks?: number }).downloadClicks ?? 0,
    ),
  ).toBe(0);
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

it("synthetic collect finds owned replies, fails ambiguous prefixes, and saves separately", async ({
  skip,
}) => {
  if (!browser) {
    skip();
    return;
  }
  const page = await browser.newPage();
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(pathToFileURL(join(REPO_ROOT, "tests/fixtures/dot-synthetic.html")).href);
  const id = "20261001T120000Z-a1b2c3d4";
  const dot = new DotPage(page);
  // Seed fixture history directly; collect itself has no submission dependencies.
  await page.evaluate((prefix) => {
    document.querySelectorAll("article.message-row").forEach((row) => {
      row.remove();
    });
    for (const [self, text] of [
      [true, prefix],
      [false, `requestId: ${prefix.match(/requestId: (\S+?)】/)?.[1]} Interim`],
      [false, "DONE"],
    ] as const) {
      const row = document.createElement("article");
      row.className = `message-row ${self ? "self" : ""}`;
      row.dataset.messageId = self ? "own" : text.slice(-7);
      row.innerHTML = `<div class="message-body"><p>${text}</p></div>`;
      document.body.append(row);
    }
  }, dotPrefix(id));
  const snapshot = await dot.snapshot();
  // Match the production self attribute used by the synthetic fixture.
  expect(snapshot.rows.length).toBe(3);

  const fixturePage = {
    navigate: async () => {},
    currentUrl: () => "https://chatgpt.com/dots/12345678-1234-1234-1234-123456789abc",
    snapshot: async () => ({
      ...(await dot.snapshot()),
      rows: (await dot.snapshot()).rows,
    }),
    extract: dot.extract.bind(dot),
    files: dot.files.bind(dot),
  };
  const ports = {
    lock: { acquire: async () => ({ kind: "ok", token: "test" }), release: async () => {} },
    browser: {
      checkProfilePath: async () => ({ ok: true }),
      checkProfileFree: async () => ({ free: true }),
      launch: async () => ({ ok: true }),
      close: async () => {},
    },
  } as unknown as Pick<Ports, "browser" | "lock">;
  const output = join(dir, "collect-case");
  await import("node:fs/promises").then((fs) => fs.mkdir(output));
  await writeFile(join(output, "result.json"), "original");
  await writeFile(join(output, "response.md"), "original response");
  const runtime = join(output, "runtime");
  const requestDir = join(runtime, "requests", id);
  await import("node:fs/promises").then((fs) => fs.mkdir(requestDir, { recursive: true }));
  await writeFile(
    join(requestDir, "request.json"),
    JSON.stringify({
      schemaVersion: "1.2",
      target: "dot",
      requestId: id,
      promptFile: "prompt.md",
      responseFormat: "markdown",
    }),
  );
  await writeFile(join(requestDir, "result.json"), JSON.stringify({ completionMarker: "DONE" }));
  const resolved = await dotRequestForCollect(runtime, id);
  expect(resolved?.completionMarker).toBe("DONE");
  expect(
    await collectDotReply(id, resolved?.completionMarker, ports, () => fixturePage),
  ).toMatchObject({
    ok: true,
    state: "complete",
    replyCount: 2,
  });
  await writeFile(join(requestDir, "result.json"), "{}");
  const old = await dotRequestForCollect(runtime, id);
  expect(await collectDotReply(id, old?.completionMarker, ports, () => fixturePage)).toMatchObject({
    ok: true,
    state: "unknown",
  });
  await expect(dotRequestForCollect(runtime, "../../escape")).rejects.toThrow("invalid requestId");
  const saveDir = join(output, "collected", "2026-10-01T00-00-00Z");
  expect(await collectDotReply(id, "DONE", ports, () => fixturePage, saveDir)).toMatchObject({
    ok: true,
    savedDir: saveDir,
  });
  expect(await readFile(join(saveDir, "response.md"), "utf8")).toContain("Interim");
  expect(JSON.parse(await readFile(join(saveDir, "collect-result.json"), "utf8"))).toMatchObject({
    schemaVersion: "1.3",
    target: "dot",
    state: "complete",
  });
  expect(await readFile(join(output, "result.json"), "utf8")).toBe("original");
  expect(await readFile(join(output, "response.md"), "utf8")).toBe("original response");
  const owned = await fixturePage.snapshot();
  expect(
    await collectDotReply(id, "DONE", ports, () => ({
      ...fixturePage,
      snapshot: async () => ({
        ...owned,
        rows: [
          ...owned.rows,
          owned.rows.find((row) => row.self) ??
            (owned.rows[0] as import("../../src/dot/completion.js").DotRow),
        ],
      }),
    })),
  ).toMatchObject({ code: "COLLECT_REPLY_AMBIGUOUS" });
  await page.close();
});

it("synthetic shared thread: collect --save keeps only this request's replies and files", async ({
  skip,
}) => {
  if (!browser) {
    skip();
    return;
  }
  const page = await browser.newPage();
  await page.route(/^https?:/, (route) => route.abort());
  const opened: string[] = [];
  // File-info responses name the file after the row id; bytes are synthetic per row.
  await page.route(/\/backend-api\/messaging\/rooms\/.*\/files\/CalpicoFile_/, (route) => {
    const rowId = route.request().url().split("CalpicoFile_")[1] ?? "";
    opened.push(rowId);
    return route.fulfill({
      json: {
        name: `${rowId}.md`,
        download_url: `https://files.oaiusercontent.com/raw?secret=synthetic&row=${rowId}`,
      },
      headers: { "access-control-allow-origin": "*" },
    });
  });
  const id = "20261001T140000Z-0a1b2c3d";
  const other = "20261001T141500Z-9f8e7d6c";
  // Entirely synthetic, fictional wording. The PO row and the rows after it model a manual
  // conversation in the same shared thread during the request.
  const thread: [string, boolean, string, boolean][] = [
    ["old", false, "Earlier fictional reply", true],
    ["own", true, `${dotPrefix(id)}\n\nSynthetic request`, false],
    ["noise", false, "Fictional reply to an earlier manual message", true],
    ["mine1", false, `requestId: ${id}\nSynthetic answer part one`, true],
    ["cont", false, "Untagged fictional continuation", true],
    ["mine2", false, `requestId: ${id}\nSynthetic final\n完了: ${id}`, true],
    ["trail", false, "", true],
    ["po", true, "Fictional manual request about something else", false],
    ["priv1", false, "Fictional private reply one", true],
    ["priv2", false, "以上で完了 fictional private reply two", true],
    ["foreign", false, `requestId: ${other}\nOther bridge request reply`, true],
  ];
  await page.setContent(
    `<main>${thread
      .map(
        ([rowId, self, text, file]) =>
          `<article class="message-row${self ? " self" : ""}" data-message-id="${rowId}"><div class="message-body">${
            file
              ? `<div class="attachment-list"><button aria-label="Open ${rowId}.md" onclick="fetch('https://fixture.invalid/backend-api/messaging/rooms/synthetic/files/CalpicoFile_${rowId}').catch(()=>{})">${rowId} caption</button></div>`
              : ""
          }${text
            .split("\n")
            .map((line) => `<p>${line}</p>`)
            .join("")}</div></article>`,
      )
      .join("")}</main>`,
  );
  const fetched: string[] = [];
  const dot = new DotPage(page, 5_000, undefined, async (url) => {
    const rowId = new URL(url).searchParams.get("row") ?? "";
    fetched.push(rowId);
    return byteResponse(Buffer.from(`synthetic bytes for ${rowId}\n`));
  });
  const ports = {
    lock: { acquire: async () => ({ kind: "ok", token: "shared" }), release: async () => {} },
    browser: {
      checkProfilePath: async () => ({ ok: true }),
      checkProfileFree: async () => ({ free: true }),
      launch: async () => ({ ok: true }),
      close: async () => {},
    },
  } as unknown as Pick<Ports, "browser" | "lock">;
  const pageDeps = () => ({
    navigate: async () => {},
    currentUrl: () => "https://chatgpt.com/dots/12345678-1234-1234-1234-123456789abc",
    snapshot: dot.snapshot.bind(dot),
    extract: dot.extract.bind(dot),
    files: dot.files.bind(dot),
  });
  const saveDir = join(dir, "shared-thread", "collected", "2026-10-01T05-00-00Z");
  const marker = `完了: ${id}`;
  const collected = await collectDotReply(id, marker, ports, pageDeps, saveDir);
  expect(collected).toMatchObject({
    ok: true,
    state: "complete",
    markerSeen: true,
    replyCount: 2,
    files: ["mine1.md", "mine2.md"],
    warnings: [
      "dot_unrelated_rows_excluded: 6 rows, 6 files",
      "dot_untagged_rows_after_own_reply: 2 rows, 2 files",
    ],
  });
  // Only chips on attributed rows were opened and fetched.
  expect(opened).toEqual(["mine1", "mine2"]);
  expect(fetched).toEqual(["mine1", "mine2"]);
  const response = await readFile(join(saveDir, "response.md"), "utf8");
  expect(response).toContain("Synthetic answer part one");
  expect(response).toContain("Synthetic final");
  expect(response).not.toMatch(/Fictional|Untagged|Other bridge|caption/);
  const { readdir } = await import("node:fs/promises");
  expect((await readdir(join(saveDir, "files"))).sort()).toEqual(["mine1.md", "mine2.md"]);
  const savedJson = await readFile(join(saveDir, "collect-result.json"), "utf8");
  expect(JSON.parse(savedJson).savedFiles).toHaveLength(2);
  // Warnings carry counts only: no excluded text, file names or signed URLs.
  expect(savedJson).not.toMatch(/priv|noise|cont\.md|trail|foreign|Fictional|secret=/);

  // Status-only collect applies the same attribution.
  expect(await collectDotReply(id, marker, ports, pageDeps)).toMatchObject({
    ok: true,
    replyCount: 2,
    files: ["mine1.md", "mine2.md"],
  });
  // The run path uses the same selection through decideDotCompletion.
  const snapshot = await dot.snapshot();
  const decision = decideDotCompletion(snapshot, id, 0, undefined, marker);
  expect(decision.replies.map((row) => row.id)).toEqual(["mine1", "mine2"]);
  expect(decision.conflict).toBe(true); // the later PO row still fails run closed

  // Only unrelated replies: nothing collected, never complete.
  await page.evaluate(() => {
    for (const rowId of ["mine1", "mine2"])
      document.querySelector(`[data-message-id="${rowId}"]`)?.remove();
  });
  opened.length = 0;
  const none = join(dir, "shared-thread", "collected", "none");
  expect(await collectDotReply(id, marker, ports, pageDeps, none)).toMatchObject({
    ok: true,
    state: "in_progress",
    markerSeen: false,
    replyCount: 0,
    files: [],
    warnings: ["dot_marker_not_seen", "dot_unrelated_rows_excluded: 6 rows, 6 files"],
  });
  expect(opened).toEqual([]);
  expect(await readFile(join(none, "response.md"), "utf8")).not.toMatch(/Fictional|Untagged/);
  expect(await readdir(join(none, "files"))).toEqual([]);

  // Two matching own rows still fail closed before anything is read or saved.
  await page.evaluate(() => {
    const own = document.querySelector('[data-message-id="own"]');
    if (own) document.querySelector("main")?.append(own.cloneNode(true));
  });
  expect(await collectDotReply(id, marker, ports, pageDeps, join(dir, "dup"))).toMatchObject({
    ok: false,
    code: "COLLECT_REPLY_AMBIGUOUS",
  });
  await page.close();
}, 30_000);
