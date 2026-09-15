import { describe, expect, it } from "vitest";
import { STATE_NAMES, type StateName } from "../../src/contracts/types.js";
import {
  type Effect,
  type Event,
  initialState,
  type MachineState,
  transition,
} from "../../src/state/machine.js";

const ALL_EVENTS: Event[] = [
  { type: "START" },
  { type: "REQUEST_READ", requestId: "x" },
  { type: "REQUEST_UNREADABLE", cause: "c" },
  { type: "PRIOR_RESULT_FOUND" },
  { type: "STALE_RESPONSE_FOUND" },
  { type: "NO_PRIOR_RESULT" },
  { type: "VALID" },
  { type: "INVALID", errors: ["e"] },
  { type: "PROFILE_PATH_REJECTED", cause: "c" },
  { type: "LOCK_OK" },
  { type: "LOCK_BUSY", cause: "c" },
  { type: "LOCK_LOST" },
  { type: "PRIOR_MARKER_FOUND" },
  { type: "NO_PRIOR_MARKER" },
  { type: "PROFILE_FREE" },
  { type: "PROFILE_BUSY", cause: "c" },
  { type: "BROWSER_OK" },
  { type: "BROWSER_LAUNCH_FAILED", cause: "c" },
  { type: "BROWSER_CRASHED", cause: "c" },
  { type: "AUTH_OK" },
  { type: "AUTH_REQUIRED" },
  { type: "CHALLENGE", kind: "captcha" },
  { type: "CHALLENGE", kind: "consent" },
  { type: "CHALLENGE", kind: "rate_limited" },
  { type: "WRONG_PAGE", url: "u" },
  { type: "NEW_CHAT_OK" },
  { type: "NEW_CHAT_FAILED", cause: "generating" },
  { type: "PRESET_OBSERVED", preset: "pro" },
  { type: "PRESET_NOT_AVAILABLE" },
  { type: "PRESET_NOT_VERIFIABLE", cause: "c" },
  { type: "PROMPT_OK" },
  { type: "PROMPT_MISMATCH", cause: "c" },
  { type: "BASELINE_OK" },
  { type: "PRESET_CHANGED" },
  { type: "MARKER_WRITTEN" },
  { type: "MARKER_WRITE_FAILED", cause: "c" },
  { type: "SUBMIT_DISPATCHED" },
  { type: "SUBMIT_FAILED", cause: "click_failed" },
  { type: "SUBMIT_ABORTED", cause: "preset_changed" },
  { type: "VERDICT_WAITING" },
  { type: "VERDICT_GENERATING" },
  { type: "VERDICT_STABILIZING" },
  { type: "VERDICT_COMPLETE" },
  { type: "VERDICT_TIMEOUT" },
  { type: "VERDICT_CHAT_ERROR", cause: "banner" },
  { type: "VERDICT_RATE_LIMITED" },
  { type: "VERDICT_CHALLENGE", kind: "login" },
  { type: "EXTRACTED" },
  { type: "EXTRACTION_EMPTY", cause: "empty" },
  { type: "RESULT_WRITTEN" },
  { type: "WRITE_FAILED", file: "response", cause: "c" },
  { type: "WRITE_FAILED", file: "result", cause: "c" },
  { type: "DOM_UNEXPECTED", element: "composer", tried: [] },
  { type: "RETRYABLE_STEP_FAILED", step: "s", cause: "c" },
  { type: "TIMEOUT", phase: "BROWSER_STARTED" },
];

function at(name: StateName, extra: Partial<MachineState> = {}): MachineState {
  const post = [
    "WAITING_FOR_RESPONSE",
    "GENERATING",
    "STABILIZING",
    "EXTRACTING",
    "WRITING_RESULT",
  ];
  return {
    name,
    phase: name,
    attempts: {},
    submitted: post.includes(name) ? "yes" : name === "PROMPT_SUBMITTING" ? "unknown" : "no",
    ...extra,
  };
}

const HAPPY: Array<[StateName, Event, StateName]> = [
  ["IDLE", { type: "START" }, "REQUEST_RECEIVED"],
  ["REQUEST_RECEIVED", { type: "NO_PRIOR_RESULT" }, "PRIOR_RESULT_CHECKED"],
  ["PRIOR_RESULT_CHECKED", { type: "VALID" }, "VALIDATED"],
  ["VALIDATED", { type: "LOCK_OK" }, "LOCK_ACQUIRED"],
  ["LOCK_ACQUIRED", { type: "NO_PRIOR_MARKER" }, "MARKER_CHECKED"],
  ["MARKER_CHECKED", { type: "PROFILE_FREE" }, "PROFILE_CHECKED"],
  ["PROFILE_CHECKED", { type: "BROWSER_OK" }, "BROWSER_STARTED"],
  ["BROWSER_STARTED", { type: "AUTH_OK" }, "AUTH_CHECKED"],
  ["AUTH_CHECKED", { type: "NEW_CHAT_OK" }, "NEW_CHAT_READY"],
  ["NEW_CHAT_READY", { type: "PRESET_OBSERVED", preset: "pro" }, "PRESET_VERIFIED"],
  ["PRESET_VERIFIED", { type: "PROMPT_OK" }, "PROMPT_ENTERED"],
  ["PROMPT_ENTERED", { type: "MARKER_WRITTEN" }, "PROMPT_SUBMITTING"],
  ["PROMPT_SUBMITTING", { type: "SUBMIT_DISPATCHED" }, "WAITING_FOR_RESPONSE"],
  ["WAITING_FOR_RESPONSE", { type: "VERDICT_GENERATING" }, "GENERATING"],
  ["GENERATING", { type: "VERDICT_STABILIZING" }, "STABILIZING"],
  ["STABILIZING", { type: "VERDICT_COMPLETE" }, "EXTRACTING"],
  ["EXTRACTING", { type: "EXTRACTED" }, "WRITING_RESULT"],
];

describe("state machine (11-STATE-MACHINE)", () => {
  it("walks the happy path", () => {
    for (const [from, ev, to] of HAPPY) {
      expect(transition(at(from), ev).next.name).toBe(to);
    }
    const done = transition(at("WRITING_RESULT"), { type: "RESULT_WRITTEN" });
    expect(done.next.name).toBe("COMPLETED");
    expect(done.next.submitted).toBe("yes");
    expect(done.next.terminal?.exitCode).toBe(0);
  });

  it("success path effects are WRITE_RESPONSE_MD, STOP_TRACE(success), WRITE_RESULT", () => {
    const t = transition(at("EXTRACTING"), { type: "EXTRACTED" });
    expect(t.effects.map((e) => e.kind)).toEqual([
      "WRITE_RESPONSE_MD",
      "STOP_TRACE",
      "WRITE_RESULT",
    ]);
  });

  it("DISPATCH_SUBMIT only appears on PROMPT_ENTERED --MARKER_WRITTEN--> PROMPT_SUBMITTING", () => {
    for (const name of STATE_NAMES) {
      for (const ev of ALL_EVENTS) {
        const t = transition(at(name), ev);
        const has = t.effects.some((e: Effect) => e.kind === "DISPATCH_SUBMIT");
        if (has) {
          expect(name).toBe("PROMPT_ENTERED");
          expect(ev.type).toBe("MARKER_WRITTEN");
          expect(t.next.name).toBe("PROMPT_SUBMITTING");
        }
      }
    }
  });

  it("never returns from post-boundary states to pre-boundary states", () => {
    const order = [...STATE_NAMES];
    const boundary = order.indexOf("PROMPT_SUBMITTING");
    for (const name of order.slice(boundary)) {
      for (const ev of ALL_EVENTS) {
        const t = transition(at(name), ev);
        if (t.next.terminal) continue;
        expect(order.indexOf(t.next.name as StateName)).toBeGreaterThanOrEqual(boundary);
      }
    }
  });

  it("post-submit states accept every VERDICT_* (3 states x 9 verdicts)", () => {
    const verdicts = ALL_EVENTS.filter((e) => e.type.startsWith("VERDICT_"));
    for (const name of ["WAITING_FOR_RESPONSE", "GENERATING", "STABILIZING"] as const) {
      for (const ev of verdicts) {
        const t = transition(at(name), ev);
        expect(t.next.terminal?.code).not.toBe("INTERNAL_ERROR");
      }
    }
  });

  it("DOM_UNEXPECTED is only accepted between BROWSER_STARTED and PROMPT_ENTERED", () => {
    const ev: Event = { type: "DOM_UNEXPECTED", element: "x", tried: [] };
    for (const name of STATE_NAMES) {
      const t = transition(at(name), ev);
      const allowed = [
        "BROWSER_STARTED",
        "AUTH_CHECKED",
        "NEW_CHAT_READY",
        "PRESET_VERIFIED",
        "PROMPT_ENTERED",
      ].includes(name);
      expect(t.next.terminal?.code).toBe(allowed ? "DOM_CHANGED" : "INTERNAL_ERROR");
    }
  });

  it("derives submitted from the phase at termination", () => {
    expect(
      transition(at("PROMPT_SUBMITTING"), { type: "SUBMIT_FAILED", cause: "click_failed" }).next
        .submitted,
    ).toBe("unknown");
    expect(
      transition(at("PROMPT_SUBMITTING"), { type: "SUBMIT_ABORTED", cause: "preset_changed" }).next
        .submitted,
    ).toBe("no");
    expect(transition(at("GENERATING"), { type: "VERDICT_TIMEOUT" }).next.submitted).toBe("yes");
    expect(
      transition(at("PRESET_VERIFIED"), { type: "PROMPT_MISMATCH", cause: "c" }).next.submitted,
    ).toBe("no");
    expect(transition(at("LOCK_ACQUIRED"), { type: "PRIOR_MARKER_FOUND" }).next.submitted).toBe(
      "unknown",
    );
  });

  it("retry limits: 3/3/2/2 with the documented exceed codes", () => {
    const cases: Array<[StateName, number, string]> = [
      ["BROWSER_STARTED", 3, "INVALID_STATE"],
      ["AUTH_CHECKED", 3, "DOM_CHANGED"],
      ["NEW_CHAT_READY", 2, "MODEL_NOT_VERIFIABLE"],
      ["PRESET_VERIFIED", 2, "PROMPT_INPUT_FAILED"],
    ];
    for (const [name, max, code] of cases) {
      let s = at(name);
      for (let i = 1; i < max; i++) {
        const t = transition(s, { type: "RETRYABLE_STEP_FAILED", step: "s", cause: "c" });
        expect(t.next.terminal).toBeUndefined();
        expect(t.next.name).toBe(name);
        s = t.next;
      }
      const t = transition(s, { type: "RETRYABLE_STEP_FAILED", step: "s", cause: "c" });
      expect(t.next.terminal?.code).toBe(code);
    }
  });

  it("pre-browser codes never write result.json where the contract says so", () => {
    expect(
      transition(at("REQUEST_RECEIVED"), { type: "PRIOR_RESULT_FOUND" }).next.terminal
        ?.writesResult,
    ).toBe(false);
    expect(
      transition(at("VALIDATED"), { type: "LOCK_BUSY", cause: "c" }).next.terminal?.writesResult,
    ).toBe(false);
    expect(
      transition(at("PROMPT_ENTERED"), { type: "LOCK_LOST" }).next.terminal?.writesResult,
    ).toBe(false);
    expect(
      transition(at("MARKER_CHECKED"), { type: "PROFILE_BUSY", cause: "c" }).next.terminal
        ?.writesResult,
    ).toBe(true);
    expect(
      transition(at("WRITING_RESULT"), { type: "WRITE_FAILED", file: "result", cause: "c" }).next
        .terminal?.writesResult,
    ).toBe(false);
  });

  it("failure effects after browser: CAPTURE, STOP_TRACE, WRITE_RESULT, CLOSE_BROWSER, RELEASE_LOCK", () => {
    const t = transition(at("GENERATING"), { type: "VERDICT_TIMEOUT" });
    expect(t.effects.map((e) => e.kind)).toEqual([
      "STOP_OBSERVATION_LOOP",
      "CAPTURE",
      "STOP_TRACE",
      "WRITE_RESULT",
      "CLOSE_BROWSER",
      "RELEASE_LOCK",
      "EXIT",
    ]);
    expect(t.next.terminal?.exitCode).toBe(1);
  });

  it("exit codes per 13-ERROR-MODEL §3", () => {
    expect(
      transition(at("PRIOR_RESULT_CHECKED"), { type: "INVALID", errors: [] }).next.terminal
        ?.exitCode,
    ).toBe(2);
    expect(
      transition(at("PRIOR_RESULT_CHECKED"), { type: "PROFILE_PATH_REJECTED", cause: "c" }).next
        .terminal?.exitCode,
    ).toBe(2);
    expect(
      transition(at("BROWSER_STARTED"), { type: "AUTH_REQUIRED" }).next.terminal?.exitCode,
    ).toBe(3);
    expect(
      transition(at("GENERATING"), { type: "VERDICT_RATE_LIMITED" }).next.terminal?.exitCode,
    ).toBe(3);
    expect(
      transition(at("PROFILE_CHECKED"), { type: "BROWSER_LAUNCH_FAILED", cause: "c" }).next.terminal
        ?.exitCode,
    ).toBe(4);
    expect(
      transition(at("LOCK_ACQUIRED"), { type: "PRIOR_MARKER_FOUND" }).next.terminal?.exitCode,
    ).toBe(1);
  });

  it("terminal states ignore further events", () => {
    const t = transition(at("BROWSER_STARTED"), { type: "AUTH_REQUIRED" });
    const again = transition(t.next, { type: "VERDICT_COMPLETE" });
    expect(again.next).toBe(t.next);
    expect(again.effects).toEqual([]);
  });

  it("initial state", () => {
    expect(initialState().name).toBe("IDLE");
  });
});
