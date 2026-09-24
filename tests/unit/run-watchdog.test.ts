import { describe, expect, it, vi } from "vitest";
import {
  armRunWatchdog,
  RUN_CLEANUP_BUDGET_MS,
  RUN_WATCHDOG_HARD_GRACE_MS,
  RunWatchdog,
} from "../../src/cli/run-watchdog.js";

describe("run watchdog (A-152)", () => {
  it("forces a terminal result and exits when a fake main run remains hung", async () => {
    vi.useFakeTimers();
    const forceTerminal = vi.fn(async () => ({ exitCode: 1 }));
    const terminate = vi.fn();
    try {
      armRunWatchdog(10, { forceTerminal }, { terminate });
      await vi.advanceTimersByTimeAsync(10 + RUN_CLEANUP_BUDGET_MS);
      expect(forceTerminal).toHaveBeenCalledWith(expect.stringMatching(/watchdog deadline/));
      expect(terminate).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not charge a 120-second pre-submit phase to timeoutMs after dispatch", async () => {
    vi.useFakeTimers();
    const forceTerminal = vi.fn(async () => ({ exitCode: 1 }));
    const terminate = vi.fn();
    const watchdog = new RunWatchdog({ forceTerminal }, { terminate });
    try {
      // The pre-submit deadline is independent. A real run uses the much larger sum of
      // documented phase limits; 130 s here leaves room for the incident's 120 s path.
      watchdog.armBeforeSubmit(130_000);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(forceTerminal).not.toHaveBeenCalled();

      // dispatch re-anchors the completion window; completion just before timeoutMs cancels it.
      watchdog.armAfterSubmit(10_000, 5_000);
      await vi.advanceTimersByTimeAsync(9_999);
      watchdog.cancel();
      await vi.advanceTimersByTimeAsync(RUN_CLEANUP_BUDGET_MS + RUN_WATCHDOG_HARD_GRACE_MS);
      expect(forceTerminal).not.toHaveBeenCalled();
      expect(terminate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a pre-submit hang with its own deadline", async () => {
    vi.useFakeTimers();
    const forceTerminal = vi.fn(async () => ({ exitCode: 1 }));
    const terminate = vi.fn();
    const watchdog = new RunWatchdog({ forceTerminal }, { terminate });
    try {
      watchdog.armBeforeSubmit(10);
      await vi.advanceTimersByTimeAsync(10 + RUN_CLEANUP_BUDGET_MS);
      expect(forceTerminal).toHaveBeenCalledTimes(1);
      expect(terminate).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hard-exits and synchronously releases its owned lock when forceTerminal never settles", async () => {
    vi.useFakeTimers();
    const forceTerminal = vi.fn(() => new Promise<{ exitCode: number }>(() => undefined));
    const releaseLockSync = vi.fn();
    const terminate = vi.fn();
    try {
      armRunWatchdog(10, { forceTerminal, releaseLockSync }, { terminate });
      await vi.advanceTimersByTimeAsync(10 + RUN_CLEANUP_BUDGET_MS + RUN_WATCHDOG_HARD_GRACE_MS);
      expect(forceTerminal).toHaveBeenCalledTimes(1);
      expect(releaseLockSync).toHaveBeenCalledTimes(1);
      expect(terminate).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
