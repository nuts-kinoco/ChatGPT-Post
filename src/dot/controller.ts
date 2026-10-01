import { join } from "node:path";
import type { BridgeRequest, BridgeResult, ErrorCode, StateName } from "../contracts/types.js";
import { exitCodeFor, statusFor } from "../contracts/types.js";
import { containsSecret, redactSecrets } from "../diagnostics/redact.js";
import type { ControllerOptions, RunOutcome } from "../state/controller.js";
import { initialState, type MachineState } from "../state/machine.js";
import type { Ports } from "../state/ports.js";
import {
  DOT_ACCEPTANCE_MS,
  DOT_POLL_MS,
  type DotProgress,
  type DotReplySelection,
  type DotRow,
  decideDotCompletion,
  dotCompletionToken,
  dotMarkerSeen,
  dotPrefix,
  dotPrompt,
  dotSelectionWarnings,
  dotWarnings,
} from "./completion.js";
import { DotFailure, type DotPage, isDotThread } from "./page.js";

/** Separate target controller; shares all durable contracts/profile/lock adapters with chat. */
export class DotController {
  private state: MachineState = initialState();
  private result: BridgeResult | null = null;
  private resultPath: string | null = null;
  private request: BridgeRequest | null = null;
  private requestId: string | null = null;
  private dir = "";
  private locked = false;
  private lockToken: string | null = null;
  private browserUp = false;
  private interrupted: string | null = null;
  private crashCause: string | null = null;
  private startedAt: Date;
  private warnings: string[] = [];
  private completionMarker: string | undefined;
  private url: string | null = null;
  private responseFile: string | null = null;
  private files: NonNullable<BridgeResult["files"]> = [];
  private replies: DotRow[] = [];
  private selection: DotReplySelection | null = null;
  private terminalPromise: Promise<RunOutcome> | null = null;
  private quality: BridgeResult["extractionQuality"] = null;
  constructor(
    private readonly ports: Ports,
    private readonly opts: ControllerOptions,
    private readonly getPage: () => Pick<
      DotPage,
      "navigate" | "prepare" | "send" | "safety" | "snapshot" | "extract" | "files" | "currentUrl"
    >,
  ) {
    this.startedAt = ports.clock.now();
  }
  private phase(name: StateName): void {
    this.state.name = name;
    this.state.phase = name;
  }
  async interrupt(cause: string): Promise<void> {
    this.interrupted ??= cause;
    await this.ports.browser.close().catch(() => undefined);
  }
  releaseLockSync(): void {
    if (this.locked) {
      this.ports.lock.releaseSync?.();
      this.locked = false;
    }
  }
  forceTerminal(cause: string): Promise<RunOutcome> {
    this.interrupted ??= cause;
    return this.finish("INTERNAL_ERROR", cause);
  }
  private async checkpoint(): Promise<void> {
    if (this.interrupted || this.state.terminal)
      throw new DotFailure("INTERNAL_ERROR", this.interrupted ?? "run stopped");
    if (this.crashCause) {
      const cause = this.crashCause;
      this.crashCause = null;
      if (this.state.phase !== "EXTRACTING") throw new DotFailure("BROWSER_CRASHED", cause);
      this.warnings.push(`file_download_failed: browser: ${cause}`);
    }
    if (!(await this.ports.lock.verify())) throw new DotFailure("INTERNAL_ERROR", "lock lost");
    const stop = await this.ports.lock.readStopRequest(this.requestId ?? "");
    if (stop?.token === this.lockToken)
      throw new DotFailure("INTERNAL_ERROR", "user_stop_requested");
  }
  private async readWithin<T>(
    operation: () => Promise<T>,
    remainingMs: number,
    code: ErrorCode,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new DotFailure(code, "dot observation deadline exceeded; never resend")),
            Math.max(1, remainingMs),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async run(): Promise<RunOutcome> {
    try {
      const read = await this.ports.contracts.readRequest(this.opts.requestPath);
      if (read.kind === "unreadable") {
        this.ports.stderr(read.cause);
        return this.noResult("INVALID_REQUEST", read.cause);
      }
      this.requestId = read.requestId;
      this.dir = read.requestDir;
      this.phase("REQUEST_RECEIVED");
      const prior = await this.ports.contracts.priorState(this.dir);
      if (prior === "result") return this.noResult("ALREADY_PROCESSED", "prior result exists");
      if (prior === "stale_response") throw new DotFailure("INVALID_REQUEST", "stale_response");
      this.phase("PRIOR_RESULT_CHECKED");
      const loaded = await this.ports.contracts.validate(read.raw, this.dir);
      if (loaded.kind === "invalid")
        throw new DotFailure("INVALID_REQUEST", loaded.errors.join("; "));
      this.request = loaded.request;
      if (this.request.target !== "dot")
        throw new DotFailure("INVALID_REQUEST", "dot target required");
      this.warnings = dotWarnings(this.request);
      this.completionMarker =
        this.request.completionMarker ?? dotCompletionToken(this.request.requestId);
      const prompt = dotPrompt(this.request.requestId, loaded.prompt, this.completionMarker);
      if (containsSecret(prompt))
        throw new DotFailure("INVALID_REQUEST", "prompt matches a secret pattern");
      this.opts.onPreSubmitBudgetKnown?.(120_000);
      const guard = await this.ports.browser.checkProfilePath();
      if (!guard.ok) throw new DotFailure("INVALID_CONFIG", guard.cause);
      this.phase("VALIDATED");
      const lock = await this.ports.lock.acquire("run", this.requestId);
      if (lock.kind === "busy") return this.noResult("ALREADY_RUNNING", lock.cause);
      this.locked = true;
      this.lockToken = lock.token;
      await this.ports.lock.deleteStopRequest(this.request.requestId);
      this.phase("LOCK_ACQUIRED");
      if (await this.ports.lock.markerExists(this.request.requestId)) {
        this.state.submitted = "unknown";
        throw new DotFailure(
          "SUBMIT_STATE_UNKNOWN",
          "prior submit marker; never resend; inspect dot thread manually",
        );
      }
      this.phase("MARKER_CHECKED");
      const free = await this.ports.browser.checkProfileFree();
      if (!free.free) throw new DotFailure("PROFILE_IN_USE", free.cause);
      this.phase("PROFILE_CHECKED");
      await this.checkpoint();
      const launch = await this.ports.browser.launch({
        trace: false,
        copyCaptureShim: false,
        onCrash: (cause) => {
          this.crashCause = cause;
        },
      });
      if (!launch.ok) throw new DotFailure("BROWSER_LAUNCH_FAILED", launch.cause);
      this.browserUp = true;
      this.phase("BROWSER_STARTED");
      await this.checkpoint();
      const dot = this.getPage();
      await dot.navigate();
      this.url = dot.currentUrl().split(/[?#]/)[0] ?? null;
      this.phase("AUTH_CHECKED");
      await this.checkpoint();
      const baseline = await dot.snapshot();
      if (
        baseline.rows.some(
          (row) => row.self && row.text.startsWith(dotPrefix(this.request?.requestId ?? "")),
        )
      )
        throw new DotFailure("SUBMIT_STATE_UNKNOWN", "requestId already exists in thread");
      await dot.prepare(prompt);
      this.phase("PROMPT_ENTERED");
      await this.checkpoint();
      await dot.safety();
      await this.ports.lock.writeMarker(this.request.requestId, {
        target: "dot",
        completionMarker: this.completionMarker,
        requestId: this.request.requestId,
        requestPath: this.opts.requestPath,
        writtenAt: this.ports.clock.now().toISOString(),
        urlBefore: this.url ?? "",
        baselineAssistantCount: baseline.rows.filter((row) => !row.self).length,
        presetLabelBefore: "",
      });
      await this.checkpoint();
      this.phase("PROMPT_SUBMITTING");
      this.state.submitted = "unknown";
      const submittedAt = this.ports.clock.monotonic();
      this.opts.onSubmitDispatched?.(loaded.timeoutMs);
      await dot.send();
      let progress: DotProgress | undefined;
      const deadline = submittedAt + loaded.timeoutMs;
      while (true) {
        const confirmed = this.state.submitted === "yes";
        const readDeadline = confirmed
          ? deadline
          : Math.min(deadline, submittedAt + DOT_ACCEPTANCE_MS);
        const snapshot = await this.readWithin(
          async () => {
            await this.checkpoint();
            await dot.safety();
            if (!isDotThread(dot.currentUrl()) || dot.currentUrl().split(/[?#]/)[0] !== this.url)
              throw new DotFailure(
                "CONVERSATION_MISMATCH",
                "dot thread URL changed; inspect original thread manually",
              );
            return dot.snapshot();
          },
          readDeadline - this.ports.clock.monotonic(),
          confirmed ? "GENERATION_TIMEOUT" : "SUBMIT_STATE_UNKNOWN",
        );
        const now = this.ports.clock.monotonic();
        const decision = decideDotCompletion(
          snapshot,
          this.request.requestId,
          now,
          progress,
          this.completionMarker,
        );
        progress = decision.progress;
        if (decision.conflictPersistent)
          throw new DotFailure(
            "CONVERSATION_MISMATCH",
            "another self row or duplicate requestId; ownership uncertain",
          );
        if (decision.ownRow && this.state.submitted !== "yes") {
          this.state.submitted = "yes";
          this.phase("WAITING_FOR_RESPONSE");
          await this.ports.lock
            .updateMarker(this.request.requestId, {
              dispatchedAt: this.ports.clock.now().toISOString(),
              urlAfter: this.url ?? "",
            })
            .catch(() => this.warnings.push("marker_update_failed"));
        }
        if (this.state.submitted === "yes" && !decision.ownRow && !decision.conflict)
          throw new DotFailure(
            "CONVERSATION_MISMATCH",
            "confirmed own row disappeared; inspect thread manually",
          );
        this.replies = decision.replies;
        this.selection = decision.selection;
        if (!decision.ownRow && now - submittedAt >= DOT_ACCEPTANCE_MS)
          throw new DotFailure(
            "SUBMIT_STATE_UNKNOWN",
            "own row not confirmed within 15 seconds; never resend",
          );
        if (now >= deadline)
          throw new DotFailure(
            this.state.submitted === "yes" ? "GENERATION_TIMEOUT" : "SUBMIT_STATE_UNKNOWN",
            "dot wait timed out; inspect thread manually; never resend",
          );
        if (decision.done) break;
        await this.ports.clock.sleep(DOT_POLL_MS);
      }
      this.phase("EXTRACTING");
      await this.checkpoint();
      await dot.safety();
      const extracted = dot.extract(this.replies);
      this.warnings.push(...extracted.warnings);
      this.quality = extracted.warnings.length ? "degraded" : "full";
      const downloaded = await dot.files(this.replies, this.dir, (files) => {
        this.files = [...files];
      });
      this.files = downloaded.files;
      this.warnings.push(...downloaded.warnings);
      await this.checkpoint();
      this.phase("WRITING_RESULT");
      try {
        this.responseFile = await this.ports.contracts.writeResponse(this.dir, extracted.markdown);
      } catch {
        throw new DotFailure("WRITE_FAILED", "response.md write failed");
      }
      return await this.finish(null, "");
    } catch (error) {
      if (
        error instanceof DotFailure &&
        error.code === "GENERATION_TIMEOUT" &&
        this.completionMarker !== undefined
      ) {
        if (!this.replies.some((row) => dotMarkerSeen(row.text, this.completionMarker ?? "")))
          this.warnings.push("dot_marker_not_seen");
        try {
          const dot = this.getPage();
          const extracted = dot.extract(this.replies);
          this.warnings.push(...extracted.warnings);
          this.responseFile = await this.ports.contracts.writeResponse(
            this.dir,
            extracted.markdown,
          );
          const downloaded = await dot.files(this.replies, this.dir, (files) => {
            this.files = [...files];
          });
          this.files = downloaded.files;
          this.warnings.push(...downloaded.warnings);
        } catch {
          this.warnings.push("dot_partial_save_failed");
        }
      }
      return await this.finish(
        error instanceof DotFailure ? error.code : "INTERNAL_ERROR",
        (error as Error).message,
      );
    } finally {
      if (this.state.terminal) await this.cleanup();
    }
  }
  private async cleanup(): Promise<void> {
    if (this.browserUp) {
      this.browserUp = false;
      await this.ports.browser.close().catch(() => undefined);
    }
    if (this.locked) {
      this.locked = false;
      if (this.requestId)
        await this.ports.lock.deleteStopRequest(this.requestId).catch(() => undefined);
      await this.ports.lock.release().catch(() => undefined);
    }
  }
  private noResult(code: ErrorCode, cause: string): RunOutcome {
    const exitCode = exitCodeFor(code);
    this.state.terminal = { name: "FAILED", code, cause, exitCode, writesResult: false };
    this.state.name = "FAILED";
    this.ports.stderr(`${code}: ${cause}`);
    return { exitCode, state: this.state, result: null, resultPath: null };
  }
  private finish(code: ErrorCode | null, cause: string): Promise<RunOutcome> {
    this.terminalPromise ??= this.finishOnce(code, cause);
    return this.terminalPromise;
  }
  private async finishOnce(code: ErrorCode | null, cause: string): Promise<RunOutcome> {
    const exitCode = code ? exitCodeFor(code) : 0;
    const completedAt = this.ports.clock.now();
    const status = code ? statusFor(code) : "completed";
    this.state.terminal = {
      name: !code
        ? "COMPLETED"
        : status === "manual_intervention_required"
          ? "MANUAL_INTERVENTION"
          : "FAILED",
      code,
      cause,
      exitCode,
      writesResult: true,
    };
    this.state.name = this.state.terminal.name;
    // Only counts of unattributed shared-thread rows are reported, never their content (A-200).
    if (this.selection) this.warnings.push(...dotSelectionWarnings(this.selection));
    this.result = {
      schemaVersion: "1.3",
      target: "dot",
      ...(this.completionMarker !== undefined ? { completionMarker: this.completionMarker } : {}),
      replyCount: this.replies.length,
      files: this.files,
      bridgeVersion: this.opts.bridgeVersion,
      requestId: this.requestId,
      status,
      requestedPreset: null,
      observedPreset: null,
      requestedModel: null,
      observedModel: null,
      observedModelSlug: null,
      submitted: this.state.submitted,
      conversationUrl: this.url,
      responseFile: code ? null : this.responseFile,
      extractionMethod: code ? null : "dom",
      extractionQuality: code ? null : this.quality,
      startedAt: this.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - this.startedAt.getTime()),
      artifacts: this.files.map((file) => join(this.dir, file.path)),
      images: [],
      warnings: this.warnings.map((warning) => redactSecrets(warning).slice(0, 500)),
      error: code
        ? {
            code,
            message:
              code === "SUBMIT_STATE_UNKNOWN" || code === "GENERATION_TIMEOUT"
                ? "Do not resend; use collect <requestId> to check the persistent dot thread."
                : code,
            cause: redactSecrets(cause).slice(0, 200),
            retryable: false,
            phase: this.state.phase,
          }
        : null,
    };
    try {
      this.resultPath = await this.ports.contracts.writeResult(this.dir, this.result);
      // Retain dot identity for read-only collect, including successful requests.
    } catch (error) {
      this.ports.stderr(`WRITE_FAILED: ${(error as Error).message}`);
      return { exitCode: 1, state: this.state, result: null, resultPath: null };
    } finally {
      await this.cleanup();
    }
    return { exitCode, state: this.state, result: this.result, resultPath: this.resultPath };
  }
}
