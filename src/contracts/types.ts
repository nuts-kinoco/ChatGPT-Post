export const REQUESTED_PRESETS = [
  "current",
  "instant",
  "medium",
  "high",
  "extra_high",
  "pro",
] as const;
export type RequestedPreset = (typeof REQUESTED_PRESETS)[number];

export const OBSERVED_PRESETS = ["instant", "medium", "high", "extra_high", "pro"] as const;
export type ObservedPreset = (typeof OBSERVED_PRESETS)[number];

/** Contract 1.1 (A-067): model is the radio in the picker; preset is the effort slider. */
export const REQUESTED_MODELS = ["current", "latest", "gpt-5.6-sol", "gpt-5.5"] as const;
export type RequestedModel = (typeof REQUESTED_MODELS)[number];
export const OBSERVED_MODELS = ["latest", "gpt-5.6-sol", "gpt-5.5"] as const;
export type ObservedModel = (typeof OBSERVED_MODELS)[number];

export interface BridgeRequest {
  schemaVersion: "1.0" | "1.1";
  requestId: string;
  promptFile: string;
  preset: RequestedPreset;
  /** 1.1: optional, default "current" (observe only; the UI resets the radio to 最新 on every page load). */
  model?: RequestedModel;
  newChat: true;
  timeoutMs?: number;
  responseFormat: "markdown";
}

export const DEFAULT_TIMEOUT_MS = 900_000;

export const ERROR_CODES = [
  "INVALID_REQUEST",
  "INVALID_CONFIG",
  "ALREADY_PROCESSED",
  "ALREADY_RUNNING",
  "SUBMIT_STATE_UNKNOWN",
  "PROFILE_IN_USE",
  "BROWSER_LAUNCH_FAILED",
  "INVALID_STATE",
  "AUTH_REQUIRED",
  "CAPTCHA_OR_CHALLENGE",
  "MANUAL_INTERVENTION_REQUIRED",
  "RATE_LIMITED",
  "MODEL_NOT_AVAILABLE",
  "MODEL_NOT_VERIFIABLE",
  "PROMPT_INPUT_FAILED",
  "PROMPT_SUBMIT_FAILED",
  "GENERATION_TIMEOUT",
  "CHAT_ERROR",
  "DOM_CHANGED",
  "EXTRACTION_FAILED",
  "BROWSER_CRASHED",
  "WRITE_FAILED",
  "INTERNAL_ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const MANUAL_INTERVENTION_CODES: readonly ErrorCode[] = [
  "AUTH_REQUIRED",
  "CAPTCHA_OR_CHALLENGE",
  "MANUAL_INTERVENTION_REQUIRED",
  "RATE_LIMITED",
];

/** Codes that never appear in a result.json (the bridge only reports them on stderr). */
export const NO_RESULT_CODES: readonly ErrorCode[] = ["ALREADY_PROCESSED", "ALREADY_RUNNING"];

export const STATE_NAMES = [
  "IDLE",
  "REQUEST_RECEIVED",
  "PRIOR_RESULT_CHECKED",
  "VALIDATED",
  "LOCK_ACQUIRED",
  "MARKER_CHECKED",
  "PROFILE_CHECKED",
  "BROWSER_STARTED",
  "AUTH_CHECKED",
  "NEW_CHAT_READY",
  "PRESET_VERIFIED",
  "PROMPT_ENTERED",
  "PROMPT_SUBMITTING",
  "WAITING_FOR_RESPONSE",
  "GENERATING",
  "STABILIZING",
  "EXTRACTING",
  "WRITING_RESULT",
] as const;
export type StateName = (typeof STATE_NAMES)[number];

export type TerminalName = "COMPLETED" | "FAILED" | "MANUAL_INTERVENTION";
export type Submitted = "yes" | "no" | "unknown";
export type ResultStatus = "completed" | "failed" | "manual_intervention_required";
export type ExtractionMethod = "copy" | "dom" | "innerText";
export type ExtractionQuality = "full" | "degraded";

export interface BridgeError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  phase: StateName;
  cause: string | null;
}

export interface BridgeResult {
  schemaVersion: "1.1";
  bridgeVersion: string;
  requestId: string | null;
  status: ResultStatus;
  requestedPreset: RequestedPreset | null;
  observedPreset: ObservedPreset | null;
  requestedModel: RequestedModel | null;
  observedModel: ObservedModel | null;
  /** data-message-model-slug of the extracted assistant turn (post-hoc evidence, not a gate). */
  observedModelSlug: string | null;
  submitted: Submitted;
  conversationUrl: string | null;
  responseFile: string | null;
  extractionMethod: ExtractionMethod | null;
  extractionQuality: ExtractionQuality | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  artifacts: string[];
  warnings: string[];
  error: BridgeError | null;
}

export const EXIT_CODES = {
  completed: 0,
  afterBrowser: 1,
  invalidInput: 2,
  manualIntervention: 3,
  beforeBrowser: 4,
} as const;

export function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case "INVALID_REQUEST":
    case "INVALID_CONFIG":
      return EXIT_CODES.invalidInput;
    case "ALREADY_PROCESSED":
    case "ALREADY_RUNNING":
    case "PROFILE_IN_USE":
    case "BROWSER_LAUNCH_FAILED":
      return EXIT_CODES.beforeBrowser;
    case "AUTH_REQUIRED":
    case "CAPTCHA_OR_CHALLENGE":
    case "MANUAL_INTERVENTION_REQUIRED":
    case "RATE_LIMITED":
      return EXIT_CODES.manualIntervention;
    default:
      return EXIT_CODES.afterBrowser;
  }
}

export function statusFor(code: ErrorCode): ResultStatus {
  return MANUAL_INTERVENTION_CODES.includes(code) ? "manual_intervention_required" : "failed";
}
