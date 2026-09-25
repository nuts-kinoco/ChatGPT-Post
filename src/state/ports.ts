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
  /** Hard-watchdog-only synchronous release; implementations must check their exact token. */
  releaseSync?(): boolean;
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
  /** Stop the context trace at submit, before the unbounded-in-practice response wait. */
  sealTrace(artifactsDir: string): Promise<void>;
  /** Promote a bounded pending trace or discard it under the terminal trace policy. */
  finalizeTrace(artifactsDir: string, keep: boolean): Promise<string | null>;
  /** A-136 (Phase 3 MVP, Opus review Medium#3): in dedicated-page (pool) mode, `keepPage: true`
   * leaves the job's own tab open on the daemon instead of closing it — the only human-inspectable
   * evidence of what actually happened in a non-`completed` outcome (the same tab A-135's own
   * `SUBMIT_STATE_UNKNOWN` guidance and `GENERATION_TIMEOUT_ACTIVE`'s message tell the operator to
   * go look at). No effect outside dedicated-page mode (the daemon's shared page is never closed
   * either way; a fresh non-daemon launch's own browser closing is unaffected). */
  close(opts?: { keepPage?: boolean }): Promise<void>;
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

export type ProjectResolution =
  | { kind: "ok"; url: string; created: boolean }
  /** The create submit may have reached ChatGPT; never retry this request automatically. */
  | { kind: "creation_uncertain"; cause: string }
  | { kind: "failed"; cause: NewChatFailure }
  | { kind: "retry"; cause: string }
  | { kind: "dom_unexpected"; element: string; tried: string[] };

/**
 * A-148: the controller owns the timeout cancellation and the page owns the exact point at
 * which a create submit can no longer be safely retried. `markSubmitted()` must be called
 * immediately before the irreversible confirm click.
 */
export interface ProjectCreateControl {
  signal: AbortSignal;
  markSubmitted(): void;
}

export interface Baseline {
  assistantCount: number;
  /** A-155: a new user turn is direct acceptance evidence after the send click. */
  userTurnCount: number;
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
  /**
   * Recovery-only variant of openConversation. It validates the same conversation and generation
   * state, but deliberately never inspects, clears, or changes a saved composer draft.
   */
  openConversationForCollect(
    url: string,
  ): Promise<
    | { kind: "ok"; draftPresent: boolean }
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
  /** A-106: opens a ChatGPT Project's home and starts the new chat there (newChat: true + project). */
  openProject(
    url: string,
  ): Promise<
    | { kind: "ok" }
    | { kind: "failed"; cause: NewChatFailure }
    | { kind: "retry"; cause: string }
    | { kind: "dom_unexpected"; element: string; tried: string[] }
  >;
  /** A-144: exact-name lookup in the sidebar, creating only after a no-match result. */
  resolveOrCreateProject(name: string, control?: ProjectCreateControl): Promise<ProjectResolution>;
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
    baseline: Baseline,
    opts: { newChat: boolean },
  ): Promise<
    | { kind: "dispatched"; url: string }
    /** The click may have sent; never retry when acceptance evidence is incomplete. */
    | { kind: "unknown"; cause: string; url: string }
    /** The composer still contains the exact prompt and no acceptance signal appeared. */
    | { kind: "not_confirmed"; cause: string; url: string }
    | { kind: "failed"; cause: SubmitFailure }
    | { kind: "aborted" }
  >;
  /** Clears only a currently exact, proven-unsent draft (including its composer attachment chips). */
  clearUnsentPrompt(
    expectedPrompt: string,
  ): Promise<{ kind: "cleared" } | { kind: "failed"; cause: string }>;
  observe(t: number): Promise<Observation>;
  currentUrl(): Promise<string>;
  /** Proves that the user turn immediately before the latest assistant turn is this request. */
  verifyLatestReplyOwnership(
    prompt: string,
    attachmentNames: string[],
  ): Promise<{ kind: "match" } | { kind: "mismatch"; cause: string }>;
  extractLatest(): Promise<Extraction | { kind: "empty"; cause: "empty" | "canvas" }>;
  /**
   * A-091: saves images rendered in the latest assistant turn (generated images) into `dir`.
   * Best-effort: in-page fetch of the same img.src first (A-069 / A-092); viewer download opt-in.
   * Returns relative file names in turn order; problems go to `warnings`.
   */
  captureImages(dir: string, signal: AbortSignal): Promise<{ saved: string[]; warnings: string[] }>;
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
