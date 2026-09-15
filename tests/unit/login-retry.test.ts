/**
 * Regression tests for the login/doctor reliability fix (A-101, Codex review of 80f816d).
 * observeAuthWithRetry() is the pure, testable core extracted from cmdLogin/cmdDoctor/cmdInspectUi,
 * which otherwise drive a real ChatGptPage and aren't unit-testable without a much larger refactor
 * (Codex Medium #5 notes this gap; the poll-loop crash-priority ordering itself is exercised only
 * by code review + the live doctor/login smoke test, not by a unit test here).
 */
import { describe, expect, it } from "vitest";
import { type CrashState, observeAuthWithRetry } from "../../src/cli/main.js";
import type { AuthObservation, ChatGptPort } from "../../src/state/ports.js";

type Page = Pick<ChatGptPort, "navigateAndObserveAuth">;

function fakePage(...results: Array<AuthObservation | Error>): Page & { calls: number } {
  let i = 0;
  const calls = { n: 0 };
  return {
    get calls() {
      return calls.n;
    },
    navigateAndObserveAuth: async () => {
      calls.n++;
      const r = results[Math.min(i, results.length - 1)];
      i++;
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe("observeAuthWithRetry (A-101)", () => {
  it("retries NOT_READY up to `attempts` times with backoff, then returns the last NOT_READY", async () => {
    const page = fakePage(
      { kind: "NOT_READY", cause: "1" },
      { kind: "NOT_READY", cause: "2" },
      { kind: "NOT_READY", cause: "3" },
    );
    const crash: CrashState = { cause: null };
    const t0 = Date.now();
    const r = await observeAuthWithRetry(page, crash, 3);
    expect(r).toEqual({ kind: "NOT_READY", cause: "3" });
    expect(page.calls).toBe(3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500 + 3000 - 50); // 1.5s + 3s backoff, generous slop
  });

  it("returns immediately on the first non-NOT_READY result without retrying", async () => {
    const page = fakePage(
      { kind: "AUTH_OK" },
      { kind: "NOT_READY", cause: "should not be reached" },
    );
    const crash: CrashState = { cause: null };
    const r = await observeAuthWithRetry(page, crash, 3);
    expect(r).toEqual({ kind: "AUTH_OK" });
    expect(page.calls).toBe(1);
  });

  it("never retries real auth states (fail closed is preserved)", async () => {
    const states: AuthObservation[] = [
      { kind: "AUTH_REQUIRED" },
      { kind: "CHALLENGE", challenge: "captcha" },
      { kind: "WRONG_PAGE", url: "https://chatgpt.com/auth/x" },
    ];
    for (const state of states) {
      const page = fakePage(state);
      const crash: CrashState = { cause: null };
      const r = await observeAuthWithRetry(page, crash, 3);
      expect(r).toEqual(state);
      expect(page.calls).toBe(1);
    }
  });

  it("stops retrying immediately once a crash is reported after an attempt (Codex High #1)", async () => {
    const page = fakePage({ kind: "NOT_READY", cause: "1" }, { kind: "NOT_READY", cause: "2" });
    const crash: CrashState = { cause: null };
    const orig = page.navigateAndObserveAuth.bind(page);
    page.navigateAndObserveAuth = async () => {
      const r = await orig();
      crash.cause = "page crashed"; // simulate onCrash firing right after the first attempt returns
      return r;
    };
    const r = await observeAuthWithRetry(page, crash, 3);
    expect(r).toEqual({ kind: "NOT_READY", cause: "1" });
    expect(page.calls).toBe(1); // no second attempt against the dead page
  });

  it("never touches the page if a crash was already reported before the first attempt", async () => {
    const page = fakePage({ kind: "AUTH_OK" });
    const crash: CrashState = { cause: "page crashed" };
    const r = await observeAuthWithRetry(page, crash, 3);
    expect(r).toEqual({ kind: "NOT_READY", cause: "not attempted" });
    expect(page.calls).toBe(0);
  });

  it("converts a thrown navigation error into NOT_READY instead of rejecting", async () => {
    const page = fakePage(new Error("target closed"));
    const crash: CrashState = { cause: null };
    const r = await observeAuthWithRetry(page, crash, 1);
    expect(r).toEqual({ kind: "NOT_READY", cause: "threw: target closed" });
  });
});
