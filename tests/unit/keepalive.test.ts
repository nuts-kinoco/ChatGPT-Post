import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KEEPALIVE_MS,
  type KeepaliveTimers,
  MIN_KEEPALIVE_MS,
  parseKeepaliveInterval,
  startKeepalive,
} from "../../src/browser/keepalive.js";

function fakeTimers(): { timers: KeepaliveTimers; fire(): void; interval: number | null } {
  let handler: (() => void) | undefined;
  let interval: number | null = null;
  return {
    timers: {
      setInterval: (next, ms) => {
        handler = next;
        interval = ms;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: vi.fn(),
    },
    fire: () => handler?.(),
    get interval() {
      return interval;
    },
  };
}

describe("daemon keepalive (A-158)", () => {
  it("does not touch the idle page while a run holds the pool lock", async () => {
    const timers = fakeTimers();
    const probeLogin = vi.fn(async () => ({ ok: true, detail: "logged in", recoverable: false }));
    const logs: string[] = [];
    const keepalive = startKeepalive(
      {
        lock: { acquire: async () => ({ kind: "busy" as const }), release: vi.fn() },
        probeLogin,
        replacePage: vi.fn(),
        shutdown: vi.fn(),
        maxConsecutiveFailures: 2,
        log: (m) => logs.push(m),
      },
      DEFAULT_KEEPALIVE_MS,
      true,
      timers.timers,
    );
    await keepalive.tick();
    expect(probeLogin).not.toHaveBeenCalled();
    expect(logs).toContain("skipped: browser busy");
    expect(timers.interval).toBe(DEFAULT_KEEPALIVE_MS);
  });

  it("uses the login probe as the only home-page load and skips logged-out sessions", async () => {
    const release = vi.fn(async () => undefined);
    const probeLogin = vi.fn(async () => ({
      ok: false,
      detail: "CHALLENGE: captcha",
      recoverable: false,
    }));
    const logs: string[] = [];
    const keepalive = startKeepalive(
      {
        lock: { acquire: async () => ({ kind: "ok" as const }), release },
        probeLogin,
        replacePage: vi.fn(),
        shutdown: vi.fn(),
        maxConsecutiveFailures: 2,
        log: (m) => logs.push(m),
      },
      DEFAULT_KEEPALIVE_MS,
      true,
      fakeTimers().timers,
    );
    await keepalive.tick();
    expect(probeLogin).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(logs).toContain("skipped: login not OK (CHALLENGE: captcha)");
  });

  it("replaces a page after a recoverable probe failure", async () => {
    const replacePage = vi.fn(async () => undefined);
    const keepalive = startKeepalive(
      {
        lock: { acquire: async () => ({ kind: "ok" as const }), release: vi.fn() },
        probeLogin: async () => ({ ok: false, detail: "navigation failed", recoverable: true }),
        replacePage,
        shutdown: vi.fn(),
        maxConsecutiveFailures: 2,
        log: vi.fn(),
      },
      DEFAULT_KEEPALIVE_MS,
      true,
      fakeTimers().timers,
    );
    await keepalive.tick();
    expect(replacePage).toHaveBeenCalledTimes(1);
  });

  it("shuts down after repeated failed recovery attempts", async () => {
    const shutdown = vi.fn(async () => undefined);
    const keepalive = startKeepalive(
      {
        lock: { acquire: async () => ({ kind: "ok" as const }), release: vi.fn() },
        probeLogin: async () => ({ ok: false, detail: "navigation failed", recoverable: true }),
        replacePage: async () => {
          throw new Error("context closed");
        },
        shutdown,
        maxConsecutiveFailures: 2,
        log: vi.fn(),
      },
      DEFAULT_KEEPALIVE_MS,
      true,
      fakeTimers().timers,
    );
    await keepalive.tick();
    expect(shutdown).not.toHaveBeenCalled();
    await keepalive.tick();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("resets the failure count after a successful probe", async () => {
    const shutdown = vi.fn(async () => undefined);
    const probeLogin = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, detail: "navigation failed", recoverable: true })
      .mockResolvedValueOnce({ ok: true, detail: "logged in", recoverable: false })
      .mockResolvedValueOnce({ ok: false, detail: "navigation failed", recoverable: true });
    const keepalive = startKeepalive(
      {
        lock: { acquire: async () => ({ kind: "ok" as const }), release: vi.fn() },
        probeLogin,
        replacePage: async () => {
          throw new Error("context closed");
        },
        shutdown,
        maxConsecutiveFailures: 2,
        log: vi.fn(),
      },
      DEFAULT_KEEPALIVE_MS,
      true,
      fakeTimers().timers,
    );
    await keepalive.tick();
    await keepalive.tick();
    await keepalive.tick();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("is disableable and accepts only hour-scale interval overrides", async () => {
    const timers = fakeTimers();
    const probeLogin = vi.fn();
    const keepalive = startKeepalive(
      {
        lock: null,
        probeLogin,
        replacePage: vi.fn(),
        shutdown: vi.fn(),
        maxConsecutiveFailures: 2,
        log: vi.fn(),
      },
      DEFAULT_KEEPALIVE_MS,
      false,
      timers.timers,
    );
    timers.fire();
    await keepalive.tick();
    expect(probeLogin).not.toHaveBeenCalled();
    expect(timers.interval).toBeNull();
    expect(parseKeepaliveInterval(undefined)).toBe(DEFAULT_KEEPALIVE_MS);
    expect(parseKeepaliveInterval(String(MIN_KEEPALIVE_MS))).toBe(MIN_KEEPALIVE_MS);
    expect(parseKeepaliveInterval("60000")).toBe(DEFAULT_KEEPALIVE_MS);
  });
});
