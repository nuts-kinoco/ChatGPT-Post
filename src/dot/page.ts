import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import type { APIResponse, Page } from "playwright";
import { exists } from "../chatgpt/selectors.js";
import type { BridgeResult, ErrorCode } from "../contracts/types.js";
import { htmlToMarkdown } from "../extraction/markdown.js";
import { verifyCandidate, verifyCompleteness, verifyStructure } from "../extraction/verify.js";
import {
  DOT_FILE_TIMEOUT_MS,
  DOT_HISTORY_CAP_MS,
  DOT_HISTORY_POLL_MS,
  DOT_MAX_FILE_BYTES,
  DOT_MAX_FILES,
  type DotRow,
  type DotSnapshot,
  hasTypingIndicator,
  isHistorySettled,
  sanitizeDotFilename,
} from "./completion.js";

/** Japanese selectors were observed on 2026-10-01; English equivalents remain unverified. */
export const DOT_SELECTORS = {
  composer: "[contenteditable='true']",
  row: "article.message-row",
  body: "div.message-body",
  chip: /を開く$|^Open /i,
  send: /^(送信|Send)$/i,
  close: /^(ビューアーを閉じる|Close viewer)$/i,
};
export class DotFailure extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export function isDotThread(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.origin === "https://chatgpt.com" &&
      /^\/dots\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(u.pathname)
    );
  } catch {
    return false;
  }
}
export class DotPage {
  private threadUrl: string | null = null;
  private preparedPrompt: string | null = null;
  private preparedRows: string | null = null;
  constructor(
    public readonly page: Page,
    private readonly fileTimeoutMs = DOT_FILE_TIMEOUT_MS,
    private readonly maxFileBytes = DOT_MAX_FILE_BYTES,
    private readonly fetchFileBytes: (
      url: string,
    ) => Promise<Pick<APIResponse, "ok" | "headers" | "body">> = (url) =>
      page.context().request.get(url, { timeout: fileTimeoutMs, maxRedirects: 0 }),
  ) {}
  currentUrl(): string {
    return this.page.url();
  }

  async safety(): Promise<void> {
    const url = new URL(this.page.url());
    if (/auth\.openai\.com|auth0\.com|accounts\.google\.com/i.test(url.hostname))
      throw new DotFailure("AUTH_REQUIRED", "login required");
    if (await exists(this.page, "challengeFrame", { verifiedOnly: false }))
      throw new DotFailure("CAPTCHA_OR_CHALLENGE", "challenge detected");
    if (await exists(this.page, "loginCta", { verifiedOnly: false }))
      throw new DotFailure("AUTH_REQUIRED", "login CTA detected");
    if (this.threadUrl && this.page.url().split(/[?#]/)[0] !== this.threadUrl)
      throw new DotFailure("CONVERSATION_MISMATCH", "dot thread URL changed");
    const dialogs = this.page.locator('[role="dialog"], [aria-modal="true"]');
    for (const dialog of await dialogs.all()) {
      if (await dialog.isVisible())
        throw new DotFailure("MANUAL_INTERVENTION_REQUIRED", "blocking dialog detected");
    }
  }
  async navigate(): Promise<void> {
    try {
      await this.page.goto("https://chatgpt.com/dots/home", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } catch {
      await this.safety();
      throw new DotFailure("INVALID_STATE", "dot navigation failed");
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await this.safety();
      if (
        isDotThread(this.page.url()) &&
        (await this.page.locator(DOT_SELECTORS.composer).isVisible())
      ) {
        this.threadUrl = this.page.url().split(/[?#]/)[0] ?? null;
        await this.waitForHistory();
        return;
      }
      await this.page.waitForTimeout(450);
    }
    throw new DotFailure("INVALID_STATE", "dot thread/composer not ready");
  }
  private async waitForHistory(): Promise<void> {
    const deadline = performance.now() + DOT_HISTORY_CAP_MS;
    const samples: { count: number; at: number }[] = [];
    while (performance.now() < deadline) {
      await this.safety();
      samples.push({
        count: await this.page.locator(DOT_SELECTORS.row).count(),
        at: performance.now(),
      });
      if (isHistorySettled(samples)) return;
      await this.page.waitForTimeout(
        Math.min(DOT_HISTORY_POLL_MS, Math.max(0, deadline - performance.now())),
      );
    }
  }
  private async composerText(): Promise<string> {
    // Chromium innerText adds layout newlines to insertText block boundaries. Read logical
    // text/BR/block boundaries instead; do not collapse arbitrary prompt whitespace.
    return this.page.locator(DOT_SELECTORS.composer).evaluate((el) => {
      const read = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
        let text = "";
        const children = Array.from(node.childNodes);
        for (const [index, child] of children.entries()) {
          if (child instanceof HTMLElement && child.tagName === "BR") {
            if (children.length !== 1) text += "\n";
          } else {
            if (index > 0 && child instanceof HTMLElement && /^(DIV|P|LI)$/.test(child.tagName))
              text += "\n";
            text += read(child);
          }
        }
        return text;
      };
      return read(el).replace(/\r\n/g, "\n");
    });
  }
  async prepare(prompt: string): Promise<void> {
    await this.safety();
    const composer = this.page.locator(DOT_SELECTORS.composer);
    if ((await composer.innerText()).trim())
      throw new DotFailure("INVALID_STATE", "existing composer draft preserved");
    const before = await this.snapshot();
    if (before.typing) throw new DotFailure("INVALID_STATE", "dot is already typing");
    this.preparedRows = JSON.stringify(before.rows);
    this.preparedPrompt = prompt;
    await composer.click({ timeout: 5_000 });
    await this.page.keyboard.insertText(prompt);
    if ((await this.composerText()) !== prompt)
      throw new DotFailure("PROMPT_INPUT_FAILED", "composer text mismatch");
  }
  async send(): Promise<void> {
    await this.safety();
    const snapshot = await this.snapshot();
    if (
      snapshot.typing ||
      JSON.stringify(snapshot.rows) !== this.preparedRows ||
      (await this.composerText()) !== this.preparedPrompt
    )
      throw new DotFailure(
        "SUBMIT_STATE_UNKNOWN",
        "thread or composer changed before send; marker retained",
      );
    const send = this.page.getByRole("button", { name: DOT_SELECTORS.send });
    if ((await send.count()) !== 1 || !(await send.isEnabled()))
      throw new DotFailure(
        "SUBMIT_STATE_UNKNOWN",
        "send button not uniquely enabled; marker retained",
      );
    // There is exactly one click call. An exception cannot prove non-delivery.
    await send.click({ timeout: 5_000 }).catch(() => {
      throw new DotFailure("SUBMIT_STATE_UNKNOWN", "send click outcome unknown");
    });
  }
  async snapshot(): Promise<DotSnapshot> {
    const rows = await this.page.locator(DOT_SELECTORS.row).evaluateAll((elements) =>
      elements.map((el) => {
        const body = el.querySelector<HTMLElement>("div.message-body");
        const clone = body?.cloneNode(true) as HTMLElement | undefined;
        const chips = Array.from(el.querySelectorAll("button[aria-label]"))
          .map((b) => b.getAttribute("aria-label") ?? "")
          .filter((s) => /を開く$|^Open /i.test(s));
        for (const attachment of Array.from(clone?.querySelectorAll(".attachment-list") ?? []))
          attachment.remove();
        for (const button of Array.from(clone?.querySelectorAll("button[aria-label]") ?? [])) {
          if (/\u3092\u958b\u304f|^Open /i.test(button.getAttribute("aria-label") ?? ""))
            (button.closest('[class~="group/resource-card"], .resource-card') ?? button).remove();
        }
        // innerText needs a rendered clone to retain paragraph/line boundaries.
        let text = "";
        if (clone) {
          clone.style.position = "absolute";
          clone.style.opacity = "0";
          clone.style.pointerEvents = "none";
          el.append(clone);
          text = clone.innerText;
          clone.remove();
        }
        return {
          id: el.getAttribute("data-message-id") ?? "",
          self: el.classList.contains("self"),
          text: text.trim(),
          html: clone?.innerHTML ?? "",
          files: chips,
        };
      }),
    );
    // Read visible main text; history message bodies must not masquerade as a live indicator.
    const main = this.page.locator("main");
    const text = await ((await main.count()) === 1 ? main : this.page.locator("body")).innerText({
      timeout: 5_000,
    });
    const withoutMessages = rows.reduce((s, row) => s.replace(row.text, ""), text);
    return { rows, typing: hasTypingIndicator(withoutMessages) };
  }
  extract(rows: DotRow[]): { markdown: string; warnings: string[] } {
    const warnings: string[] = [];
    const markdown = rows
      .map((row) => {
        const md = htmlToMarkdown(row.html);
        if (row.text.trim()) {
          const candidate = verifyCandidate(md, row.text);
          if (!candidate.ok) throw new DotFailure("EXTRACTION_FAILED", candidate.reason);
        }
        const structure = verifyStructure(md, row.html);
        if (!structure.ok) warnings.push(`extraction_structure_degraded: ${structure.reason}`);
        const complete = verifyCompleteness(md);
        if (!complete.ok) warnings.push(`extraction_possibly_truncated: ${complete.reason}`);
        return md.trim();
      })
      .join(rows.length > 1 ? "\n\n---\n\n" : "");
    return { markdown, warnings };
  }
  async files(
    rows: DotRow[],
    requestDir: string,
    onSaved?: (files: NonNullable<BridgeResult["files"]>) => void,
  ): Promise<{ files: NonNullable<BridgeResult["files"]>; warnings: string[] }> {
    const files: NonNullable<BridgeResult["files"]> = [];
    const warnings: string[] = [];
    const chips = rows.flatMap((row) => row.files.map((label) => ({ row, label })));
    for (const [index, chip] of chips.entries()) {
      let name = chip.label.replace(/を開く$|^Open /i, "");
      if (index >= DOT_MAX_FILES) {
        warnings.push(`file_download_failed: ${name}: max 10 files`);
        continue;
      }
      if (this.page.isClosed()) {
        warnings.push(`file_download_failed: ${name}: page closed`);
        break;
      }
      const warningCount = warnings.length;
      let path: string | null = null;
      let timedOut = false;
      let humanError: DotFailure | null = null;
      const deadline = performance.now() + this.fileTimeoutMs;
      const remaining = () => Math.max(1, Math.min(5_000, deadline - performance.now()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const work = async () => {
        await this.safety();
        if (!chip.row.id) throw new Error("missing message id");
        const escapedId = chip.row.id.replace(/["\\]/g, (char) => `\\${char}`);
        const matching = this.page.locator(`${DOT_SELECTORS.row}[data-message-id="${escapedId}"]`);
        const event = this.page.waitForResponse(
          (r) =>
            /\/backend-api\/messaging\/rooms\/[^/]+\/files\/CalpicoFile_[^/?]+(\?|$)/.test(
              r.url(),
            ) &&
            r.request().method() === "GET" &&
            r.ok(),
          { timeout: remaining() },
        );
        void event.catch(() => undefined);
        await matching
          .getByRole("button", { name: chip.label, exact: true })
          .click({ timeout: remaining() });
        const response = await event;
        await this.safety();
        let metadata: { name?: unknown; download_url?: unknown };
        try {
          metadata = await response.json();
        } catch {
          throw new Error("invalid file metadata");
        }
        if (!metadata || typeof metadata !== "object") throw new Error("invalid file metadata");
        if (typeof metadata.name === "string" && metadata.name) name = metadata.name;
        if (typeof metadata.download_url !== "string") throw new Error("missing download_url");
        let url: URL;
        try {
          url = new URL(metadata.download_url);
        } catch {
          throw new Error("unexpected download host");
        }
        if (
          url.protocol !== "https:" ||
          !(url.hostname === "oaiusercontent.com" || url.hostname.endsWith(".oaiusercontent.com"))
        )
          throw new Error("unexpected download host");
        let bytes: Buffer;
        try {
          const fetched = await this.fetchFileBytes(url.href);
          if (!fetched.ok()) throw new Error("file fetch failed");
          const length = fetched.headers()["content-length"];
          if (length !== undefined && Number(length) > this.maxFileBytes)
            throw new Error("file exceeds 20 MB");
          bytes = await fetched.body();
        } catch (error) {
          // Request errors can contain the signed URL. Never expose their raw text.
          if (error instanceof Error && error.message === "file exceeds 20 MB") throw error;
          throw new Error("file fetch failed");
        }
        if (timedOut) throw new Error("timeout");
        if (bytes.length > this.maxFileBytes) throw new Error("file exceeds 20 MB");
        const dir = join(requestDir, "files");
        await mkdir(dir, { recursive: true });
        if ((await lstat(dir)).isSymbolicLink()) throw new Error("files directory is a symlink");
        const base = sanitizeDotFilename(name);
        const ext = extname(base);
        let candidate = base;
        for (let suffix = 1; ; suffix++) {
          if (timedOut) throw new Error("timeout");
          try {
            const handle = await open(join(dir, candidate), "wx");
            await handle.close();
            path = join(dir, candidate);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            candidate = `${base.slice(0, base.length - ext.length)}-${suffix}${ext}`;
          }
        }
        const target = path;
        try {
          const handle = await open(target, "r+");
          try {
            await handle.writeFile(bytes);
          } finally {
            await handle.close();
          }
          if (timedOut) throw new Error("timeout");
        } finally {
          if (timedOut) await unlink(target).catch(() => undefined);
        }
        files.push({ name, path: `files/${candidate}`, bytes: bytes.length });
        onSaved?.(files);
        path = null;
      };
      try {
        await Promise.race([
          work(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error("timeout"));
            }, this.fileTimeoutMs);
          }),
        ]);
      } catch (error) {
        if (error instanceof DotFailure) humanError = error;
        else {
          if (path) await unlink(path).catch(() => undefined);
          warnings.push(
            `file_download_failed: ${name}: ${timedOut ? "timeout" : (error as Error).message}`,
          );
        }
      } finally {
        clearTimeout(timer);
      }
      if (this.page.isClosed()) {
        if (warnings.length === warningCount)
          warnings.push(`file_download_failed: ${name}: page closed`);
        break;
      }
      if (humanError) throw humanError;
      // Never click through an approval dialog, including during viewer cleanup.
      let safeToClose = true;
      try {
        await this.safety();
      } catch (error) {
        if (error instanceof DotFailure) throw error;
        if (this.page.isClosed()) {
          warnings.push(`file_download_failed: ${name}: page closed`);
          break;
        }
        safeToClose = false;
        warnings.push(`file_download_failed: ${name}: viewer safety check failed`);
      }
      const close = this.page.getByRole("button", { name: DOT_SELECTORS.close });
      if (safeToClose && (await close.isVisible().catch(() => false))) {
        await close
          .click({ timeout: 5_000 })
          .catch(() => warnings.push(`file_download_failed: ${name}: close viewer failed`));
      }
    }
    return { files, warnings };
  }
}
