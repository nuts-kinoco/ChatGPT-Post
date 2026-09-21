import { describe, expect, it, vi } from "vitest";

const { connectOverCDP } = vi.hoisted(() => ({ connectOverCDP: vi.fn() }));

vi.mock("playwright", () => ({
  chromium: { connectOverCDP },
}));

import { BrowserSession } from "../../src/browser/launch.js";

function page() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(true),
    on: vi.fn(),
  };
}

function context(p: ReturnType<typeof page>) {
  return {
    addInitScript: vi.fn(),
    newPage: vi.fn().mockResolvedValue(p),
    on: vi.fn(),
    pages: vi.fn().mockReturnValue([]),
    tracing: { start: vi.fn(), stop: vi.fn() },
  };
}

function session(): BrowserSession {
  return new BrowserSession({
    channel: "chromium",
    dedicatedPage: true,
    profileDir: "unused-in-unit-test",
  });
}

const launchOptions = { copyCaptureShim: true, onCrash: () => undefined };

describe("BrowserSession.attach() cleanup", () => {
  it("closes only the dedicated page created by a failed attach", async () => {
    const dedicatedPage = page();
    const daemonContext = context(dedicatedPage);
    daemonContext.addInitScript.mockRejectedValue(new Error("shim registration failed"));
    const browser = {
      close: vi.fn().mockResolvedValue(undefined),
      contexts: vi.fn().mockReturnValue([daemonContext]),
    };
    connectOverCDP.mockResolvedValue(browser);

    const result = await session().attach("http://daemon.test", launchOptions);

    expect(result).toEqual({ ok: false, cause: "shim registration failed" });
    expect(dedicatedPage.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("disposes its init-script registration when detaching from the daemon", async () => {
    const dedicatedPage = page();
    const daemonContext = context(dedicatedPage);
    const dispose = vi.fn().mockResolvedValue(undefined);
    daemonContext.addInitScript.mockResolvedValue({ dispose });
    const browser = {
      close: vi.fn().mockResolvedValue(undefined),
      contexts: vi.fn().mockReturnValue([daemonContext]),
    };
    connectOverCDP.mockResolvedValue(browser);
    const browserSession = session();

    await expect(browserSession.attach("http://daemon.test", launchOptions)).resolves.toEqual({
      ok: true,
    });
    await browserSession.close();

    expect(dispose).toHaveBeenCalledOnce();
    expect(dedicatedPage.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });
});

describe("BrowserSession experimental extension mode", () => {
  it("fails closed on the installed Chrome channel instead of pretending its launch flags worked", async () => {
    const chromeSession = new BrowserSession({
      channel: "chrome",
      experimentalStealth: "extension",
      profileDir: "unused-in-unit-test",
      stealthExtensionDir: "unused-in-unit-test",
    });

    await expect(chromeSession.launch(launchOptions)).resolves.toEqual({
      ok: false,
      cause: expect.stringContaining("unavailable with channel=chrome"),
    });
  });
});
