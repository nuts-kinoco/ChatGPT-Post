import {
  type ErrorCode,
  exitCodeFor,
  type ObservedPreset,
  type StateName,
  type Submitted,
  statusFor,
  type TerminalName,
} from "../contracts/types.js";

// ---------- events (11-STATE-MACHINE §3) ----------

export type ChallengeKind = "captcha" | "consent" | "rate_limited";
export type NewChatFailure =
  | "existing_conversation"
  | "generating"
  | "composer_not_empty"
  | "conversation_not_found"
  | "project_not_found";
export type SubmitFailure = "click_failed" | "send_button_missing" | "send_button_disabled";
export type ChatErrorCause = "banner" | "network" | "output_truncated" | "multiple_responses";
export type PostChallengeKind = "login" | "captcha" | "consent";
export type ExtractionEmptyCause = "empty" | "canvas";

export type Event =
  | { type: "START" }
  | { type: "REQUEST_READ"; requestId: string | null }
  | { type: "REQUEST_UNREADABLE"; cause: string }
  | { type: "PRIOR_RESULT_FOUND" }
  | { type: "STALE_RESPONSE_FOUND" }
  | { type: "NO_PRIOR_RESULT" }
  | { type: "VALID" }
  | { type: "INVALID"; errors: string[] }
  | { type: "PROFILE_PATH_REJECTED"; cause: string }
  | { type: "LOCK_OK" }
  | { type: "LOCK_BUSY"; cause: string }
  | { type: "LOCK_LOST" }
  | { type: "PRIOR_MARKER_FOUND" }
  | { type: "NO_PRIOR_MARKER" }
  | { type: "PROFILE_FREE" }
  | { type: "PROFILE_BUSY"; cause: string }
  | { type: "BROWSER_OK" }
  | { type: "BROWSER_LAUNCH_FAILED"; cause: string }
  | { type: "BROWSER_CRASHED"; cause: string }
  | { type: "AUTH_OK" }
  | { type: "AUTH_REQUIRED" }
  | { type: "CHALLENGE"; kind: ChallengeKind }
  | { type: "WRONG_PAGE"; url: string }
  | { type: "NEW_CHAT_OK" }
  | { type: "NEW_CHAT_FAILED"; cause: NewChatFailure }
  | { type: "PRESET_OBSERVED"; preset: ObservedPreset }
  | { type: "PRESET_NOT_AVAILABLE" }
  | { type: "PRESET_NOT_VERIFIABLE"; cause: string }
  | { type: "PROMPT_OK" }
  | { type: "PROMPT_MISMATCH"; cause: string }
  | { type: "BASELINE_OK" }
  | { type: "PRESET_CHANGED" }
  | { type: "MARKER_WRITTEN" }
  | { type: "MARKER_WRITE_FAILED"; cause: string }
  | { type: "SUBMIT_DISPATCHED" }
  | { type: "SUBMIT_FAILED"; cause: SubmitFailure }
  | { type: "SUBMIT_ABORTED"; cause: "preset_changed" }
  | { type: "VERDICT_WAITING" }
  | { type: "VERDICT_GENERATING" }
  | { type: "VERDICT_STABILIZING" }
  | { type: "VERDICT_COMPLETE" }
  | { type: "VERDICT_TIMEOUT" }
  | { type: "VERDICT_CHAT_ERROR"; cause: ChatErrorCause }
  | { type: "VERDICT_RATE_LIMITED" }
  | { type: "VERDICT_CHALLENGE"; kind: PostChallengeKind }
  | { type: "EXTRACTED" }
  | { type: "EXTRACTION_EMPTY"; cause: ExtractionEmptyCause }
  | { type: "RESULT_WRITTEN" }
  | { type: "WRITE_FAILED"; file: "response" | "result"; cause: string }
  | { type: "DOM_UNEXPECTED"; element: string; tried: string[] }
  | { type: "RETRYABLE_STEP_FAILED"; step: string; cause: string }
  | { type: "TIMEOUT"; phase: StateName };

export type EventType = Event["type"];

// ---------- effects (11-STATE-MACHINE §4) ----------

export type Effect =
  | { kind: "READ_REQUEST" }
  | { kind: "CHECK_PRIOR_RESULT" }
  | { kind: "VALIDATE" }
  | { kind: "ACQUIRE_LOCK" }
  | { kind: "CHECK_MARKER" }
  | { kind: "CHECK_PROFILE_FREE" }
  | { kind: "LAUNCH_BROWSER" }
  | { kind: "WAIT_BEFORE_RETRY" }
  | { kind: "NAVIGATE_AND_CHECK_AUTH" }
  | { kind: "OPEN_NEW_CHAT" }
  | { kind: "RESOLVE_PRESET" }
  | { kind: "ENTER_PROMPT" }
  | { kind: "SNAPSHOT_BASELINE" }
  | { kind: "VERIFY_LOCK" }
  | { kind: "WRITE_SUBMIT_MARKER" }
  | { kind: "DISPATCH_SUBMIT" }
  | { kind: "UPDATE_MARKER" }
  | { kind: "DELETE_MARKER" }
  | { kind: "START_OBSERVATION_LOOP" }
  | { kind: "STOP_OBSERVATION_LOOP" }
  | { kind: "EXTRACT_LATEST" }
  | { kind: "WRITE_RESPONSE_MD" }
  | { kind: "STOP_TRACE"; mode: "failure" | "success" | "best-effort" }
  | { kind: "CAPTURE"; bestEffort: boolean }
  | { kind: "INSPECT_UI_REPORT" }
  | { kind: "WRITE_RESULT" }
  | { kind: "CLOSE_BROWSER"; bestEffort: boolean }
  | { kind: "RELEASE_LOCK" }
  | { kind: "STDERR"; message: string }
  | { kind: "EXIT"; code: number };

export type EffectKind = Effect["kind"];

/** Effects that never produce an event; failures go to result.json.warnings[] (11 §1). */
export const BEST_EFFORT_EFFECTS: ReadonlySet<EffectKind> = new Set<EffectKind>([
  "CAPTURE",
  "STOP_TRACE",
  "INSPECT_UI_REPORT",
  "UPDATE_MARKER",
  "DELETE_MARKER",
  "CLOSE_BROWSER",
]);

// ---------- state ----------

export interface Terminal {
  name: TerminalName;
  code: ErrorCode | null;
  cause: string | null;
  exitCode: number;
  /** false for ALREADY_PROCESSED / ALREADY_RUNNING / unreadable request / result write failure */
  writesResult: boolean;
}

export interface MachineState {
  name: StateName | TerminalName;
  /** Number of RETRYABLE_STEP_FAILED received per state (11 §1). */
  attempts: Partial<Record<StateName, number>>;
  submitted: Submitted;
  /** Last non-terminal state; used to derive `submitted` and error.phase. */
  phase: StateName;
  terminal?: Terminal;
}

export interface Transition {
  next: MachineState;
  effects: Effect[];
}

export const RETRY_LIMITS: Partial<Record<StateName, number>> = {
  BROWSER_STARTED: 3,
  AUTH_CHECKED: 3,
  NEW_CHAT_READY: 2,
  PRESET_VERIFIED: 2,
};

const RETRY_EXCEEDED_CODE: Partial<Record<StateName, ErrorCode>> = {
  BROWSER_STARTED: "INVALID_STATE",
  AUTH_CHECKED: "DOM_CHANGED",
  NEW_CHAT_READY: "MODEL_NOT_VERIFIABLE",
  PRESET_VERIFIED: "PROMPT_INPUT_FAILED",
};

const RETRY_EFFECT: Partial<Record<StateName, Effect>> = {
  BROWSER_STARTED: { kind: "NAVIGATE_AND_CHECK_AUTH" },
  AUTH_CHECKED: { kind: "OPEN_NEW_CHAT" },
  NEW_CHAT_READY: { kind: "RESOLVE_PRESET" },
  PRESET_VERIFIED: { kind: "ENTER_PROMPT" },
};

const PRE_BROWSER: ReadonlySet<string> = new Set([
  "IDLE",
  "REQUEST_RECEIVED",
  "PRIOR_RESULT_CHECKED",
  "VALIDATED",
  "LOCK_ACQUIRED",
  "MARKER_CHECKED",
  "PROFILE_CHECKED",
]);
const POST_SUBMIT_WAITING: ReadonlySet<string> = new Set([
  "WAITING_FOR_RESPONSE",
  "GENERATING",
  "STABILIZING",
]);

export function initialState(): MachineState {
  return { name: "IDLE", attempts: {}, submitted: "no", phase: "IDLE" };
}

export function isTerminal(s: MachineState): boolean {
  return s.terminal !== undefined;
}

function submittedFor(phase: StateName, code: ErrorCode, cause: string | null): Submitted {
  if (code === "SUBMIT_STATE_UNKNOWN") return "unknown";
  if (phase === "PROMPT_SUBMITTING") {
    return code === "MODEL_NOT_VERIFIABLE" && cause === "preset_changed" ? "no" : "unknown";
  }
  if (POST_SUBMIT_WAITING.has(phase) || phase === "EXTRACTING" || phase === "WRITING_RESULT")
    return "yes";
  return "no";
}

function move(s: MachineState, name: StateName, effects: Effect[]): Transition {
  const submitted: Submitted =
    POST_SUBMIT_WAITING.has(name) || name === "EXTRACTING" || name === "WRITING_RESULT"
      ? "yes"
      : name === "PROMPT_SUBMITTING"
        ? "unknown"
        : "no";
  return { next: { ...s, name, phase: name, submitted }, effects };
}

function stay(s: MachineState, effects: Effect[]): Transition {
  return { next: s, effects };
}

const FAIL_BEFORE_BROWSER: Effect[] = [{ kind: "WRITE_RESULT" }, { kind: "RELEASE_LOCK" }];
const FAIL_AFTER_BROWSER: Effect[] = [
  { kind: "CAPTURE", bestEffort: true },
  { kind: "STOP_TRACE", mode: "failure" },
  { kind: "WRITE_RESULT" },
  { kind: "CLOSE_BROWSER", bestEffort: true },
  { kind: "RELEASE_LOCK" },
];

interface FailOptions {
  cause?: string | null;
  writesResult?: boolean;
  effects?: Effect[];
  submitted?: Submitted;
}

function fail(s: MachineState, code: ErrorCode, opts: FailOptions = {}): Transition {
  const phase = s.phase;
  const cause = opts.cause ?? null;
  const status = statusFor(code);
  const name: TerminalName =
    status === "manual_intervention_required" ? "MANUAL_INTERVENTION" : "FAILED";
  const writesResult = opts.writesResult ?? true;
  const exitCode = exitCodeFor(code);
  const submitted = opts.submitted ?? submittedFor(phase, code, cause);
  const effects: Effect[] =
    opts.effects ?? (PRE_BROWSER.has(phase) ? FAIL_BEFORE_BROWSER : FAIL_AFTER_BROWSER);
  const finalEffects: Effect[] = [...effects];
  if (!writesResult) {
    // drop WRITE_RESULT for codes that never write a result
    const idx = finalEffects.findIndex((e) => e.kind === "WRITE_RESULT");
    if (idx >= 0) finalEffects.splice(idx, 1);
    finalEffects.unshift({ kind: "STDERR", message: `${code}${cause ? `: ${cause}` : ""}` });
  }
  finalEffects.push({ kind: "EXIT", code: exitCode });
  return {
    next: { ...s, name, submitted, terminal: { name, code, cause, exitCode, writesResult } },
    effects: finalEffects,
  };
}

function complete(s: MachineState): Transition {
  return {
    next: {
      ...s,
      name: "COMPLETED",
      submitted: "yes",
      terminal: { name: "COMPLETED", code: null, cause: null, exitCode: 0, writesResult: true },
    },
    effects: [
      { kind: "CLOSE_BROWSER", bestEffort: true },
      { kind: "RELEASE_LOCK" },
      { kind: "EXIT", code: 0 },
    ],
  };
}

function retry(
  s: MachineState,
  state: StateName,
  ev: Extract<Event, { type: "RETRYABLE_STEP_FAILED" }>,
): Transition {
  const max = RETRY_LIMITS[state] ?? 0;
  const n = (s.attempts[state] ?? 0) + 1;
  const attempts = { ...s.attempts, [state]: n };
  if (n < max) {
    const effects: Effect[] = state === "BROWSER_STARTED" ? [{ kind: "WAIT_BEFORE_RETRY" }] : [];
    const retryEffect = RETRY_EFFECT[state];
    if (retryEffect) effects.push(retryEffect);
    return { next: { ...s, attempts }, effects };
  }
  const opts: FailOptions = { cause: `retry limit exceeded at ${ev.step}: ${ev.cause}` };
  if (state === "AUTH_CHECKED")
    opts.effects = [{ kind: "INSPECT_UI_REPORT" }, ...FAIL_AFTER_BROWSER];
  return fail({ ...s, attempts }, RETRY_EXCEEDED_CODE[state] ?? "INTERNAL_ERROR", opts);
}

function internalError(s: MachineState, ev: Event): Transition {
  return fail(s, "INTERNAL_ERROR", { cause: `unexpected event ${ev.type} in state ${s.name}` });
}

// ---------- transition (11-STATE-MACHINE §4) ----------

export function transition(s: MachineState, ev: Event): Transition {
  if (s.terminal) return stay(s, []);

  // Global handlers (browser started or later)
  if (ev.type === "BROWSER_CRASHED" && !PRE_BROWSER.has(s.name)) {
    return fail(s, "BROWSER_CRASHED", {
      cause: ev.cause,
      effects: [
        { kind: "STOP_OBSERVATION_LOOP" },
        { kind: "CAPTURE", bestEffort: true },
        { kind: "STOP_TRACE", mode: "best-effort" },
        { kind: "WRITE_RESULT" },
        { kind: "CLOSE_BROWSER", bestEffort: true },
        { kind: "RELEASE_LOCK" },
      ],
    });
  }
  if (ev.type === "DOM_UNEXPECTED") {
    const allowed = [
      "BROWSER_STARTED",
      "AUTH_CHECKED",
      "NEW_CHAT_READY",
      "PRESET_VERIFIED",
      "PROMPT_ENTERED",
    ];
    if (allowed.includes(s.name)) {
      return fail(s, "DOM_CHANGED", {
        cause: `${ev.element}: tried ${ev.tried.join(", ")}`,
        effects: [{ kind: "INSPECT_UI_REPORT" }, ...FAIL_AFTER_BROWSER],
      });
    }
    return internalError(s, ev);
  }

  switch (s.name) {
    case "IDLE":
      if (ev.type === "START") return move(s, "REQUEST_RECEIVED", [{ kind: "READ_REQUEST" }]);
      break;

    case "REQUEST_RECEIVED":
      switch (ev.type) {
        case "REQUEST_READ":
          return stay(s, [{ kind: "CHECK_PRIOR_RESULT" }]);
        case "REQUEST_UNREADABLE":
          return fail(s, "INVALID_REQUEST", { cause: ev.cause, writesResult: false, effects: [] });
        case "PRIOR_RESULT_FOUND":
          return fail(s, "ALREADY_PROCESSED", { writesResult: false, effects: [] });
        case "STALE_RESPONSE_FOUND":
          return fail(s, "INVALID_REQUEST", {
            cause: "stale_response",
            effects: [{ kind: "WRITE_RESULT" }],
          });
        case "NO_PRIOR_RESULT":
          return move(s, "PRIOR_RESULT_CHECKED", [{ kind: "VALIDATE" }]);
      }
      break;

    case "PRIOR_RESULT_CHECKED":
      switch (ev.type) {
        case "VALID":
          return move(s, "VALIDATED", [{ kind: "ACQUIRE_LOCK" }]);
        case "INVALID":
          return fail(s, "INVALID_REQUEST", {
            cause: ev.errors.join("; "),
            effects: [{ kind: "WRITE_RESULT" }],
          });
        case "PROFILE_PATH_REJECTED":
          return fail(s, "INVALID_CONFIG", {
            cause: ev.cause,
            effects: [{ kind: "WRITE_RESULT" }],
          });
      }
      break;

    case "VALIDATED":
      switch (ev.type) {
        case "LOCK_OK":
          return move(s, "LOCK_ACQUIRED", [{ kind: "CHECK_MARKER" }]);
        case "LOCK_BUSY":
          return fail(s, "ALREADY_RUNNING", { cause: ev.cause, writesResult: false, effects: [] });
        case "LOCK_LOST":
          return fail(s, "ALREADY_RUNNING", {
            cause: "lock_lost",
            writesResult: false,
            effects: [],
          });
      }
      break;

    case "LOCK_ACQUIRED":
      switch (ev.type) {
        case "NO_PRIOR_MARKER":
          return move(s, "MARKER_CHECKED", [{ kind: "CHECK_PROFILE_FREE" }]);
        case "PRIOR_MARKER_FOUND":
          return fail(s, "SUBMIT_STATE_UNKNOWN", { submitted: "unknown" });
      }
      break;

    case "MARKER_CHECKED":
      switch (ev.type) {
        case "PROFILE_FREE":
          return move(s, "PROFILE_CHECKED", [{ kind: "LAUNCH_BROWSER" }]);
        case "PROFILE_BUSY":
          return fail(s, "PROFILE_IN_USE", { cause: ev.cause });
      }
      break;

    case "PROFILE_CHECKED":
      switch (ev.type) {
        case "BROWSER_OK":
          return move(s, "BROWSER_STARTED", [{ kind: "NAVIGATE_AND_CHECK_AUTH" }]);
        case "BROWSER_LAUNCH_FAILED":
          return fail(s, "BROWSER_LAUNCH_FAILED", { cause: ev.cause });
      }
      break;

    case "BROWSER_STARTED":
      switch (ev.type) {
        case "AUTH_OK":
          return move(s, "AUTH_CHECKED", [{ kind: "OPEN_NEW_CHAT" }]);
        case "AUTH_REQUIRED":
          return fail(s, "AUTH_REQUIRED");
        case "CHALLENGE":
          return fail(
            s,
            ev.kind === "captcha"
              ? "CAPTCHA_OR_CHALLENGE"
              : ev.kind === "consent"
                ? "MANUAL_INTERVENTION_REQUIRED"
                : "RATE_LIMITED",
          );
        case "WRONG_PAGE":
          return fail(s, "INVALID_STATE", { cause: `unexpected page: ${ev.url}` });
        case "RETRYABLE_STEP_FAILED":
          return retry(s, "BROWSER_STARTED", ev);
        case "TIMEOUT":
          return fail(s, "INVALID_STATE", { cause: "phase timeout" });
      }
      break;

    case "AUTH_CHECKED":
      switch (ev.type) {
        case "NEW_CHAT_OK":
          return move(s, "NEW_CHAT_READY", [{ kind: "RESOLVE_PRESET" }]);
        case "NEW_CHAT_FAILED":
          return fail(s, "PROMPT_SUBMIT_FAILED", { cause: ev.cause });
        case "RETRYABLE_STEP_FAILED":
          return retry(s, "AUTH_CHECKED", ev);
        case "TIMEOUT":
          return fail(s, "DOM_CHANGED", {
            cause: "phase timeout",
            effects: [{ kind: "INSPECT_UI_REPORT" }, ...FAIL_AFTER_BROWSER],
          });
      }
      break;

    case "NEW_CHAT_READY":
      switch (ev.type) {
        case "PRESET_OBSERVED":
          return move(s, "PRESET_VERIFIED", [{ kind: "ENTER_PROMPT" }]);
        case "PRESET_NOT_AVAILABLE":
          return fail(s, "MODEL_NOT_AVAILABLE");
        case "PRESET_NOT_VERIFIABLE":
          return fail(s, "MODEL_NOT_VERIFIABLE", { cause: ev.cause });
        case "RETRYABLE_STEP_FAILED":
          return retry(s, "NEW_CHAT_READY", ev);
        case "TIMEOUT":
          return fail(s, "MODEL_NOT_VERIFIABLE", { cause: "phase timeout" });
      }
      break;

    case "PRESET_VERIFIED":
      switch (ev.type) {
        case "PROMPT_OK":
          return move(s, "PROMPT_ENTERED", [{ kind: "SNAPSHOT_BASELINE" }]);
        case "PROMPT_MISMATCH":
          return fail(s, "PROMPT_INPUT_FAILED", { cause: ev.cause });
        case "RETRYABLE_STEP_FAILED":
          return retry(s, "PRESET_VERIFIED", ev);
        case "TIMEOUT":
          return fail(s, "PROMPT_INPUT_FAILED", { cause: "phase timeout" });
      }
      break;

    case "PROMPT_ENTERED":
      switch (ev.type) {
        case "BASELINE_OK":
          return stay(s, [{ kind: "VERIFY_LOCK" }, { kind: "WRITE_SUBMIT_MARKER" }]);
        case "PRESET_CHANGED":
          return fail(s, "MODEL_NOT_VERIFIABLE", { cause: "preset_changed_before_marker" });
        case "LOCK_LOST":
          return fail(s, "ALREADY_RUNNING", {
            cause: "lock_lost",
            writesResult: false,
            effects: [
              { kind: "CAPTURE", bestEffort: true },
              { kind: "STOP_TRACE", mode: "failure" },
              { kind: "CLOSE_BROWSER", bestEffort: true },
            ],
          });
        case "MARKER_WRITTEN":
          return move(s, "PROMPT_SUBMITTING", [{ kind: "DISPATCH_SUBMIT" }]);
        case "MARKER_WRITE_FAILED":
          return fail(s, "WRITE_FAILED", { cause: `marker: ${ev.cause}` });
      }
      break;

    case "PROMPT_SUBMITTING":
      switch (ev.type) {
        case "SUBMIT_DISPATCHED":
          return move(s, "WAITING_FOR_RESPONSE", [
            { kind: "UPDATE_MARKER" },
            { kind: "START_OBSERVATION_LOOP" },
          ]);
        case "SUBMIT_FAILED":
          return fail(s, "PROMPT_SUBMIT_FAILED", { cause: ev.cause });
        case "SUBMIT_ABORTED":
          return fail(s, "MODEL_NOT_VERIFIABLE", {
            cause: "preset_changed",
            submitted: "no",
            effects: [{ kind: "DELETE_MARKER" }, ...FAIL_AFTER_BROWSER],
          });
      }
      break;

    case "WAITING_FOR_RESPONSE":
    case "GENERATING":
    case "STABILIZING": {
      const verdictFail = (code: ErrorCode, cause?: string): Transition =>
        fail(s, code, {
          cause: cause ?? null,
          effects: [{ kind: "STOP_OBSERVATION_LOOP" }, ...FAIL_AFTER_BROWSER],
        });
      switch (ev.type) {
        case "VERDICT_WAITING":
          return s.name === "STABILIZING" ? move(s, "GENERATING", []) : stay(s, []);
        case "VERDICT_GENERATING":
          return s.name === "GENERATING" ? stay(s, []) : move(s, "GENERATING", []);
        case "VERDICT_STABILIZING":
          return s.name === "STABILIZING" ? stay(s, []) : move(s, "STABILIZING", []);
        case "VERDICT_COMPLETE":
          return move(s, "EXTRACTING", [
            { kind: "STOP_OBSERVATION_LOOP" },
            { kind: "EXTRACT_LATEST" },
          ]);
        case "VERDICT_TIMEOUT":
          return verdictFail("GENERATION_TIMEOUT");
        case "VERDICT_CHAT_ERROR":
          return verdictFail("CHAT_ERROR", ev.cause);
        case "VERDICT_RATE_LIMITED":
          return verdictFail("RATE_LIMITED");
        case "VERDICT_CHALLENGE":
          return verdictFail(
            ev.kind === "login"
              ? "AUTH_REQUIRED"
              : ev.kind === "captcha"
                ? "CAPTCHA_OR_CHALLENGE"
                : "MANUAL_INTERVENTION_REQUIRED",
          );
      }
      break;
    }

    case "EXTRACTING":
      switch (ev.type) {
        case "EXTRACTED":
          return move(s, "WRITING_RESULT", [
            { kind: "WRITE_RESPONSE_MD" },
            { kind: "STOP_TRACE", mode: "success" },
            { kind: "WRITE_RESULT" },
          ]);
        case "EXTRACTION_EMPTY":
          return fail(s, "EXTRACTION_FAILED", { cause: ev.cause });
      }
      break;

    case "WRITING_RESULT":
      switch (ev.type) {
        case "RESULT_WRITTEN":
          return complete(s);
        case "WRITE_FAILED":
          if (ev.file === "result") {
            return fail(s, "WRITE_FAILED", {
              cause: `result: ${ev.cause}`,
              writesResult: false,
              effects: [{ kind: "CLOSE_BROWSER", bestEffort: true }, { kind: "RELEASE_LOCK" }],
            });
          }
          return fail(s, "WRITE_FAILED", { cause: `response: ${ev.cause}` });
      }
      break;
  }
  return internalError(s, ev);
}
