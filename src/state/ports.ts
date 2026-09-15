import type { Observation } from "../chatgpt/completion.js";
import type {
  BridgeRequest,
  BridgeResult,
  ExtractionMethod,
  ExtractionQuality,
  ObservedModel,
  ObservedPreset,
  RequestedModel,
  RequestedPreset,
} from "../contracts/types.js";
import type { ChallengeKind, NewChatFailure, SubmitFailure } from "./machine.js";
import type { SubmitMarker } from "./marker.js";

export interface Clock {
  now(): Date;
  /** Monotonic milliseconds. */
  monotonic(): number;
  sleep(ms: number): Promise<void>;
}

export type PriorState = "result" | "stale_response" | "none";

export interface ContractsPort {
  readRequest(
    requestPath: string,
  ): Promise<
    | { kind: "unreadable"; cause: string }
    | { kind: "read"; requestId: string | null; raw: unknown; requestDir: string }
  >;
  priorState(requestDir: string): Promise<PriorState>;
  validate(
    raw: unknown,
    requestDir: string,
  ): Promise<
    | { kind: "invalid"; errors: string[] }
    | {
        kind: "valid";
        request: BridgeRequest;
        prompt: string;
        timeoutMs: number;
        attachments: string[];
        /** Sum of attachment sizes (for the upload time budget). */
        attachmentBytes: number;
      }
  >;
  writeResponse(requestDir: string, markdown: string): Promise<string>;
  writeResult(requestDir: string, result: BridgeResult): Promise<string>;
}

export interface LockPort {
  acquire(
    command: string,
    requestId: string | null,
  ): Promise<{ kind: "ok" } | { kind: "busy"; cause: string }>;
  verify(): Promise<boolean>;
  release(): Promise<void>;
  markerExists(requestId: string): Promise<boolean>;
  writeMarker(requestId: string, marker: SubmitMarker): Promise<void>;
  updateMarker(
    requestId: string,
    patch: Pick<SubmitMarker, "dispatchedAt" | "urlAfter">,
  ): Promise<void>;
  deleteMarker(requestId: string): Promise<void>;
}

export interface BrowserPort {
  checkProfilePath(): Promise<{ ok: true } | { ok: false; cause: string }>;
  checkProfileFree(): Promise<{ free: true } | { free: false; cause: string }>;
  launch(opts: {
    copyCaptureShim: boolean;
    onCrash: (cause: string) => void;
  }): Promise<{ ok: true } | { ok: false; cause: string }>;
  /** Viewport screenshot; returns absolute path. */
  capture(artifactsDir: string): Promise<string>;
  /** Stop + sanitize trace; returns absolute path. */
  stopTrace(artifactsDir: string): Promise<string>;
  close(): Promise<void>;
}

export type AuthObservation =
  | { kind: "AUTH_OK" }
  | { kind: "AUTH_REQUIRED" }
  | { kind: "CHALLENGE"; challenge: ChallengeKind }
  | { kind: "WRONG_PAGE"; url: string }
  | { kind: "NOT_READY"; cause: string };

export type PresetResolution =
  | {
      kind: "observed";
      preset: ObservedPreset;
      label: string;
      model: ObservedModel;
      modelLabel: string;
    }
  | { kind: "not_available" }
  | { kind: "not_verifiable"; cause: string }
  | { kind: "dom_unexpected"; element: string; tried: string[] }
  | { kind: "retry"; cause: string };

export interface Baseline {
  assistantCount: number;
  url: string;
  presetLabel: string;
}

export interface Extraction {
  markdown: string;
  method: ExtractionMethod;
  quality: ExtractionQuality;
  /** data-message-model-slug of the extracted turn, if present. */
  modelSlug: string | null;
}

export interface ChatGptPort {
  navigateAndObserveAuth(): Promise<
    AuthObservation | { kind: "dom_unexpected"; element: string; tried: string[] }
  >;
  /** A-096: opens an existing conversation (newChat: false). Same checks as openNewChat. */
  openConversation(
    url: string,
  ): Promise<
    | { kind: "ok" }
    | { kind: "failed"; cause: NewChatFailure }
    | { kind: "retry"; cause: string }
    | { kind: "dom_unexpected"; element: string; tried: string[] }
  >;
  openNewChat(): Promise<
    | { kind: "ok" }
    | { kind: "failed"; cause: NewChatFailure }
    | { kind: "retry"; cause: string }
    | { kind: "dom_unexpected"; element: string; tried: string[] }
  >;
  /** Selects model (in-page radio) then effort (persisted slider); observes both; fails closed. */
  resolvePreset(requested: RequestedPreset, model: RequestedModel): Promise<PresetResolution>;
  /** Types the prompt, then attaches files and waits for their upload (send button re-enabled). */
  enterPrompt(
    text: string,
    attachments: string[],
  ): Promise<
    | { kind: "ok" }
    | { kind: "mismatch"; cause: string }
    | { kind: "retry"; cause: string }
    | { kind: "dom_unexpected"; element: string; tried: string[] }
  >;
  snapshotBaseline(
    expectedLabel: string,
  ): Promise<
    | { kind: "ok"; baseline: Baseline }
    | { kind: "preset_changed" }
    | { kind: "dom_unexpected"; element: string; tried: string[] }
  >;
  dispatchSubmit(
    baselineLabel: string,
  ): Promise<
    | { kind: "dispatched"; url: string }
    | { kind: "failed"; cause: SubmitFailure }
    | { kind: "aborted" }
  >;
  observe(t: number): Promise<Observation>;
  currentUrl(): Promise<string>;
  extractLatest(): Promise<Extraction | { kind: "empty"; cause: "empty" | "canvas" }>;
  /**
   * A-091: saves images rendered in the latest assistant turn (generated images) into `dir`.
   * Best-effort: in-page fetch of the same img.src first (A-069 / A-092); viewer download opt-in.
   * Returns relative file names in turn order; problems go to `warnings`.
   */
  captureImages(dir: string): Promise<{ saved: string[]; warnings: string[] }>;
  /**
   * Best-effort: puts the (account-persisted) effort slider back to the level seen before this run
   * changed it. No-op when nothing was changed. Called before CLOSE_BROWSER; failures are warnings.
   */
  restoreEffort(): Promise<
    { kind: "unchanged" } | { kind: "restored" } | { kind: "failed"; cause: string }
  >;
  inspectUiReport(artifactsDir: string, opts?: { walkEffort?: boolean }): Promise<string>;
}

export interface Ports {
  clock: Clock;
  contracts: ContractsPort;
  lock: LockPort;
  browser: BrowserPort;
  chatgpt: ChatGptPort;
  log: (level: "info" | "debug" | "warn" | "error", message: string) => void;
  stderr: (message: string) => void;
}
