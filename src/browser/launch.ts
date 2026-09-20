import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { COPY_CAPTURE_SHIM } from "../extraction/copy-capture.js";
import { withTimeout } from "./timeout.js";
import { sanitizeTraceZip } from "./trace-sanitizer.js";

/** Codex review of A-110: page.evaluate() has no built-in timeout, so a half-dead CDP connection
 * could hang the liveness check (and the bridge lock it's held under) indefinitely. */
const PAGE_LIVENESS_TIMEOUT_MS = 5000;

export interface BrowserConfig {
  profileDir: string;
  channel: "chrome" | "chromium";
  closeTimeoutMs?: number;
  /** Phase 3 MVP (A-136): when attaching to a daemon, always claim a brand-new Page instead of
   * `getUsablePage()`'s "reuse whatever's already open" — required once more than one `run` can be
   * attached to the same daemon context at once, so two concurrent attaches never grab the same
   * Page. Closed again on detach (see `close()`) instead of left open, so slots don't accumulate
   * stray tabs across many jobs. No effect on `launch()` (a fresh, exclusively-owned browser). */
  dedicatedPage?: boolean;
}

export interface LaunchOptions {
  copyCaptureShim: boolean;
  onCrash: (cause: string) => void;
}

/** A-108: macOS Chrome encrypts cookies with the OS Keychain by default, and the key differs by
 * how Chrome was invoked — a mismatch between this launch and scripts/manual-login.mjs's manual
 * fallback made a real login look like AUTH_REQUIRED here. No-op on other platforms. */
const DARWIN_COOKIE_STORE_ARGS =
  process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : [];

/** ADR-002: dedicated persistent profile, headed, no stealth/UA arguments. */
export class BrowserSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private tracing = false;
  /** true when `context` belongs to an external daemon reached via CDP: close() must detach
   * instead of tearing the browser down (A-103). */
  private attached = false;
  /** True when `this.page` was created by `createDedicatedPage()` for this attach() and therefore
   * belongs solely to this session — `close()` must close it, not just detach (A-136). */
  private ownsDedicatedPage = false;
  /** Set only in attached mode: the CDP `Browser` handle from connectOverCDP(), so close() can
   * disconnect it cleanly (C-6, Codex Medium). Per Playwright's docs, closing a Browser obtained
   * via connectOverCDP() only ends that connection — it does not terminate the remote browser. */
  private cdpBrowser: Browser | null = null;

  constructor(private readonly cfg: BrowserConfig) {}

  get currentPage(): Page {
    if (!this.page) throw new Error("browser not started");
    return this.page;
  }

  get isOpen(): boolean {
    return this.context !== null;
  }

  private async attachHandlers(
    context: BrowserContext,
    opts: LaunchOptions,
    page: Page,
  ): Promise<Page> {
    if (opts.copyCaptureShim) await context.addInitScript(COPY_CAPTURE_SHIM);
    this.page = page;
    context.on("close", () => {
      if (this.context) opts.onCrash("browser context closed");
    });
    page.on("crash", () => opts.onCrash("page crashed"));
    page.on("close", () => {
      if (this.context) opts.onCrash("page closed");
    });
    return page;
  }

  /**
   * A-110: a daemon's single tracked page can go unusable (closed, or its frame detached — a Mac
   * session observed this under macOS memory pressure on a backgrounded tab) while the CDP
   * connection and context otherwise still respond. `isClosed()` alone doesn't catch the detached-
   * frame case, so confirm the page can actually run JS (bounded — Codex review, High: evaluate()
   * has no built-in timeout and could hang forever against a half-dead connection) before trusting
   * it; otherwise open a fresh one and verify *that* too (Codex review, High: newPage() succeeding
   * doesn't by itself prove the page is usable). If nothing usable can be produced, the error
   * propagates out of attach() so the caller falls back to a fresh local launch instead of handing
   * back a broken page.
   */
  private async getUsablePage(context: BrowserContext): Promise<Page> {
    const candidate = context.pages().find((p) => !p.isClosed());
    if (candidate) {
      try {
        await withTimeout(
          candidate.evaluate(() => true),
          PAGE_LIVENESS_TIMEOUT_MS,
          "page liveness check",
        );
        return candidate;
      } catch {
        // Don't leave a broken tab lying around for the next attach() to trip over too.
        await candidate.close().catch(() => undefined);
      }
    }
    const fresh = await context.newPage();
    await withTimeout(
      fresh.evaluate(() => true),
      PAGE_LIVENESS_TIMEOUT_MS,
      "new page liveness check",
    );
    return fresh;
  }

  /** A-136 (Phase 3 MVP pool mode): unlike `getUsablePage()`, never looks at `context.pages()` —
   * under concurrency those may include tabs other slots are actively using mid-generation, and
   * touching (or worse, closing) one of those would corrupt that job. */
  private async createDedicatedPage(context: BrowserContext): Promise<Page> {
    const fresh = await context.newPage();
    await withTimeout(
      fresh.evaluate(() => true),
      PAGE_LIVENESS_TIMEOUT_MS,
      "new page liveness check (dedicated)",
    );
    return fresh;
  }

  async launch(opts: LaunchOptions): Promise<{ ok: true } | { ok: false; cause: string }> {
    await mkdir(this.cfg.profileDir, { recursive: true });
    try {
      const context = await chromium.launchPersistentContext(this.cfg.profileDir, {
        ...(this.cfg.channel === "chrome" ? { channel: "chrome" } : {}),
        headless: false,
        viewport: null,
        acceptDownloads: true,
        args: DARWIN_COOKIE_STORE_ARGS,
      });
      this.context = context;
      this.attached = false;
      const page = context.pages()[0] ?? (await context.newPage());
      await this.attachHandlers(context, opts, page);
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      this.tracing = true;
      return { ok: true };
    } catch (err) {
      this.context = null;
      return { ok: false, cause: (err as Error).message };
    }
  }

  /** A-103: reuse an already-running daemon browser over CDP instead of launching a fresh one. */
  async attach(
    cdpUrl: string,
    opts: LaunchOptions,
  ): Promise<{ ok: true } | { ok: false; cause: string }> {
    // Codex review of A-110, Medium: kept outside the try's local scope so the catch below can
    // always close a connected-but-not-yet-committed CDP session instead of leaking it.
    let browser: Browser | undefined;
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close().catch(() => undefined);
        return { ok: false, cause: "daemon browser exposes no persistent context" };
      }
      // Resolved (and verified live, with a bounded timeout) before committing `this.context`/
      // `this.cdpBrowser` — if this throws, the catch below closes `browser` and this.* stays
      // exactly as it was, rather than pointing at a half-attached session (A-110).
      const page = this.cfg.dedicatedPage
        ? await this.createDedicatedPage(context)
        : await this.getUsablePage(context);
      this.context = context;
      this.attached = true;
      this.ownsDedicatedPage = Boolean(this.cfg.dedicatedPage);
      this.cdpBrowser = browser;
      await this.attachHandlers(context, opts, page);
      // A-136 (Phase 3 MVP, Opus review High#2): Playwright tracing is per-BrowserContext, not
      // per-Page — it records every page in the context. In dedicated-page (pool) mode, more than
      // one `run` can be attached to this same daemon context at once, so a shared trace.zip would
      // capture other concurrent jobs' prompts/responses too (their tabs, not just this session's).
      // `stopTrace()`'s existing "tracing not active" throw is already a BEST_EFFORT_EFFECTS entry
      // (machine.ts) — controller.ts turns it into a result.json warning, never a failure — so
      // simply never starting a trace here degrades safely instead of risking a cross-request leak.
      if (!this.cfg.dedicatedPage) {
        try {
          await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
          this.tracing = true;
        } catch {
          // Not fatal: expected when a previous command's close() didn't detach cleanly (e.g. it
          // crashed) and tracing is still active from that command. This command proceeds without
          // its own trace chunk rather than treating a benign, expected condition as a crash
          // (deliberately NOT routed through opts.onCrash — that would wrongly abort this command).
          this.tracing = false;
        }
      }
      return { ok: true };
    } catch (err) {
      this.context = null;
      this.attached = false;
      this.ownsDedicatedPage = false;
      this.cdpBrowser = null;
      if (browser) await browser.close().catch(() => undefined);
      return { ok: false, cause: (err as Error).message };
    }
  }

  async capture(artifactsDir: string): Promise<string> {
    await mkdir(artifactsDir, { recursive: true });
    const path = join(artifactsDir, "screenshot.png");
    await this.currentPage.screenshot({ path, fullPage: false });
    return path;
  }

  async stopTrace(artifactsDir: string): Promise<string> {
    if (!this.context || !this.tracing) throw new Error("tracing not active");
    this.tracing = false;
    await mkdir(artifactsDir, { recursive: true });
    const tmp = join(tmpdir(), `bridge-trace-${process.pid}-${Date.now()}.zip`);
    await this.context.tracing.stop({ path: tmp });
    const out = join(artifactsDir, "trace.zip");
    try {
      await sanitizeTraceZip(tmp, out);
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
    return out;
  }

  /** 10 §5: bounded close, then kill. When attached to a daemon, only detach — the daemon owns
   * the browser's lifecycle, so it must survive this command returning (A-103).
   *
   * A-121 (Phase 0-B-5, ChatGPT Pro redesign review §3.6): `ctx.tracing.stop()` had no timeout at
   * all, and the post-timeout fallback `ctx.close()` was itself a second, genuinely unbounded
   * await — the "bounded close, then kill" comment didn't match what the code did. Persistent
   * contexts expose no process handle, so there is nothing to literally kill from here; the
   * achievable guarantee is that `close()` itself always returns within a bound, even if the
   * underlying Playwright call is still hung in the background. */
  async close(opts?: { keepPage?: boolean }): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    // A-136: captured before this.page is nulled below — only closed once detach (tracing.stop)
    // has run, only when this session itself created it (never a Page some other slot or the
    // daemon's own keepalive still owns), and never when the caller asked to keep it (Opus review
    // Medium#3: a non-"completed" outcome's own tab is the human's only evidence of what actually
    // happened — see controller.ts's CLOSE_BROWSER handler for what decides `keepPage`).
    const dedicatedPage = this.ownsDedicatedPage && !opts?.keepPage ? this.page : null;
    this.context = null;
    this.page = null;
    if (this.attached) {
      this.attached = false;
      this.ownsDedicatedPage = false;
      if (this.tracing) {
        this.tracing = false;
        await withTimeout(ctx.tracing.stop(), 10_000, "tracing.stop() (detach)").catch(
          () => undefined,
        );
      }
      if (dedicatedPage) {
        await withTimeout(dedicatedPage.close(), 5_000, "page.close() (dedicated)").catch(
          () => undefined,
        );
      }
      // C-6 (Codex Medium): disconnect the CDP session explicitly instead of just dropping the
      // reference. For a Browser obtained via connectOverCDP(), .close() ends only this
      // connection — the daemon's actual browser process keeps running.
      const cdp = this.cdpBrowser;
      this.cdpBrowser = null;
      if (cdp) await withTimeout(cdp.close(), 10_000, "cdp.close()").catch(() => undefined);
      return;
    }
    const limit = this.cfg.closeTimeoutMs ?? 15_000;
    if (this.tracing) {
      this.tracing = false;
      await withTimeout(ctx.tracing.stop(), 10_000, "tracing.stop()").catch(() => undefined);
    }
    const result = await withTimeout(
      ctx.close().then(() => "closed" as const),
      limit,
      "context.close()",
    ).catch(() => "timeout" as const);
    if (result === "timeout") {
      // Second chance, still bounded — never the unbounded await the old code fell back to.
      await withTimeout(ctx.close(), limit, "context.close() (second attempt)").catch(
        () => undefined,
      );
    }
  }
}
