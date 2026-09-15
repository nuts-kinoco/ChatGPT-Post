import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
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

/** ADR-002: dedicated persistent profile, headed, no stealth/UA arguments. */
export class BrowserSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private tracing = false;

  constructor(private readonly cfg: BrowserConfig) {}

  get currentPage(): Page {
    if (!this.page) throw new Error("browser not started");
    return this.page;
  }

  get isOpen(): boolean {
    return this.context !== null;
  }

  async launch(opts: LaunchOptions): Promise<{ ok: true } | { ok: false; cause: string }> {
    await mkdir(this.cfg.profileDir, { recursive: true });
    try {
      const context = await chromium.launchPersistentContext(this.cfg.profileDir, {
        ...(this.cfg.channel === "chrome" ? { channel: "chrome" } : {}),
        headless: false,
        viewport: null,
        acceptDownloads: true,
      });
      this.context = context;
      if (opts.copyCaptureShim) await context.addInitScript(COPY_CAPTURE_SHIM);
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      this.tracing = true;
      const page = context.pages()[0] ?? (await context.newPage());
      this.page = page;
      context.on("close", () => {
        if (this.context) opts.onCrash("browser context closed");
      });
      page.on("crash", () => opts.onCrash("page crashed"));
      page.on("close", () => {
        if (this.context) opts.onCrash("page closed");
      });
      return { ok: true };
    } catch (err) {
      this.context = null;
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

  /** 10 §5: bounded close, then kill. */
  async close(): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    this.context = null;
    this.page = null;
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
