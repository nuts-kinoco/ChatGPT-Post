import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { COPY_CAPTURE_SHIM } from "../extraction/copy-capture.js";
import { sanitizeTraceZip } from "./trace-sanitizer.js";

export interface BrowserConfig {
  profileDir: string;
  channel: "chrome" | "chromium";
  closeTimeoutMs?: number;
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

  private async attachHandlers(context: BrowserContext, opts: LaunchOptions): Promise<Page> {
    if (opts.copyCaptureShim) await context.addInitScript(COPY_CAPTURE_SHIM);
    const page = context.pages()[0] ?? (await context.newPage());
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
      await this.attachHandlers(context, opts);
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
    try {
      const browser = await chromium.connectOverCDP(cdpUrl);
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close().catch(() => undefined);
        return { ok: false, cause: "daemon browser exposes no persistent context" };
      }
      this.context = context;
      this.attached = true;
      this.cdpBrowser = browser;
      await this.attachHandlers(context, opts);
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
      return { ok: true };
    } catch (err) {
      this.context = null;
      this.attached = false;
      this.cdpBrowser = null;
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
   * the browser's lifecycle, so it must survive this command returning (A-103). */
  async close(): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    this.context = null;
    this.page = null;
    if (this.attached) {
      this.attached = false;
      if (this.tracing) {
        this.tracing = false;
        await ctx.tracing.stop().catch(() => undefined);
      }
      // C-6 (Codex Medium): disconnect the CDP session explicitly instead of just dropping the
      // reference. For a Browser obtained via connectOverCDP(), .close() ends only this
      // connection — the daemon's actual browser process keeps running.
      const cdp = this.cdpBrowser;
      this.cdpBrowser = null;
      if (cdp) await cdp.close().catch(() => undefined);
      return;
    }
    const limit = this.cfg.closeTimeoutMs ?? 15_000;
    if (this.tracing) {
      this.tracing = false;
      await ctx.tracing.stop().catch(() => undefined);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), limit);
    });
    const result = await Promise.race([ctx.close().then(() => "closed" as const), timeout]);
    if (timer) clearTimeout(timer);
    if (result === "timeout") {
      // Persistent contexts expose no process handle; fall back to a forced close.
      await ctx.close().catch(() => undefined);
    }
  }
}
