import {
  type CompletionConfig,
  DEFAULT_COMPLETION_CONFIG,
  judge,
  type Observation,
} from "../chatgpt/completion.js";
import { slugMatches } from "../chatgpt/selectors.js";
import { uploadBudgetMs } from "../contracts/attachments.js";
import type {
  BridgeRequest,
  BridgeResult,
  ErrorCode,
  ObservedModel,
  ObservedPreset,
  StateName,
} from "../contracts/types.js";
import { redactSecrets } from "../diagnostics/redact.js";
import {
  BEST_EFFORT_EFFECTS,
  type Effect,
  type Event,
  initialState,
  type MachineState,
  transition,
} from "./machine.js";
import type { Baseline, Ports } from "./ports.js";

/** 15 §4: result.json carries no secrets — cause/warnings are redacted and length-capped. */
export const RESULT_TEXT_MAX = 500;
export function sanitiseResultText(text: string): string {
  const r = redactSecrets(text);
  return r.length <= RESULT_TEXT_MAX ? r : `${r.slice(0, RESULT_TEXT_MAX)}…`;
}

/** 13 §6: conversationUrl is origin + path only (no query / fragment / credentials). */
export function sanitiseConversationUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

export interface ControllerOptions {
  requestPath: string;
  artifactsRoot: string;
  bridgeVersion: string;
  traceOnSuccess: boolean;
  observationIntervalMs?: number;
  completion?: Partial<Omit<CompletionConfig, "timeoutMs">>;
  /** Phase limits for pre-submit states (11 §5). */
  phaseLimitsMs?: Partial<Record<StateName, number>>;
}

export const DEFAULT_PHASE_LIMITS_MS: Partial<Record<StateName, number>> = {
  BROWSER_STARTED: 60_000,
  AUTH_CHECKED: 30_000,
  NEW_CHAT_READY: 30_000,
  PRESET_VERIFIED: 60_000,
};

export interface RunOutcome {
  exitCode: number;
  state: MachineState;
  result: BridgeResult | null;
  resultPath: string | null;
}

class PhaseTimeout extends Error {
  constructor(public readonly phase: StateName) {
    super(`phase timeout: ${phase}`);
  }
}

/**
 * Drives the pure state machine: executes effects in order, feeds resulting events back,
 * stops the effect list when an event is produced (11 §1). Best-effort effects never produce events.
 */
export class RunController {
  private state = initialState();
  private request: BridgeRequest | null = null;
  private requestId: string | null = null;
  private requestDir = "";
  private prompt = "";
  private attachments: string[] = [];
  private attachmentBytes = 0;
  private timeoutMs = 0;
  private lockHeld = false;
  private browserUp = false;
  private observing = false;
  private crashCause: string | null = null;
  private baseline: Baseline | null = null;
  private observedPreset: ObservedPreset | null = null;
  private observedLabel = "";
  private observedModel: ObservedModel | null = null;
  private observedModelSlug: string | null = null;
  private conversationUrl: string | null = null;
  private responseFile: string | null = null;
  private extraction: {
    markdown: string;
    method: BridgeResult["extractionMethod"];
    quality: BridgeResult["extractionQuality"];
  } | null = null;
  private readonly artifacts: string[] = [];
  private readonly warnings: string[] = [];
  private startedAt: Date;
  private readonly startedMono: number;
  private phaseEnteredAt: number;
  private result: BridgeResult | null = null;
  private resultPath: string | null = null;
  private exitCode = 1;

  constructor(
    private readonly ports: Ports,
    private readonly opts: ControllerOptions,
  ) {
    this.startedAt = ports.clock.now();
    this.startedMono = ports.clock.monotonic();
    this.phaseEnteredAt = this.startedMono;
  }

  get artifactsDir(): string {
    return `${this.opts.artifactsRoot}/${this.requestId ?? "unknown"}`;
  }

  async run(): Promise<RunOutcome> {
    try {
      await this.dispatch({ type: "START" });
      while (this.observing && !this.state.terminal) await this.observeLoop();
    } catch (err) {
      // Defensive: anything escaping the effect layer becomes INTERNAL_ERROR (11 §4 catch-all).
      this.warnings.push(`controller_exception: ${String((err as Error).message ?? err)}`);
      try {
        await this.dispatch({ type: "DOM_UNEXPECTED", element: "controller", tried: [] });
      } catch {
        /* give up */
      }
    }
    return {
      exitCode: this.exitCode,
      state: this.state,
      result: this.result,
      resultPath: this.resultPath,
    };
  }

  private async dispatch(ev: Event): Promise<void> {
    const before = this.state.name;
    const { next, effects } = transition(this.state, ev);
    if (next.name !== before) {
      this.phaseEnteredAt = this.ports.clock.monotonic();
      this.ports.log("debug", `${before} --${ev.type}--> ${next.name}`);
    }
    this.state = next;
    for (const effect of effects) {
      const produced = await this.execute(effect);
      if (produced) {
        await this.dispatch(produced);
        return;
      }
    }
  }

  private async execute(effect: Effect): Promise<Event | null> {
    const bestEffort = BEST_EFFORT_EFFECTS.has(effect.kind);
    try {
      const ev = await this.runEffect(effect);
      if (this.crashCause && !this.state.terminal && effect.kind !== "CLOSE_BROWSER") {
        const cause = this.crashCause;
        this.crashCause = null;
        return { type: "BROWSER_CRASHED", cause };
      }
      return ev;
    } catch (err) {
      if (err instanceof PhaseTimeout) return { type: "TIMEOUT", phase: err.phase };
      const message = err instanceof Error ? err.message : String(err);
      if (bestEffort) {
        this.warnings.push(`${effect.kind.toLowerCase()}_failed: ${message.slice(0, 200)}`);
        this.ports.log("warn", `${effect.kind} failed (best-effort): ${message}`);
        return null;
      }
      throw err;
    }
  }

  private async withPhaseLimit<T>(p: Promise<T>, extraMs = 0): Promise<T> {
    const limits = this.opts.phaseLimitsMs ?? DEFAULT_PHASE_LIMITS_MS;
    const name = this.state.name as StateName;
    const base = limits[name];
    if (!base) return p;
    const limit = base + extraMs;
    const elapsed = this.ports.clock.monotonic() - this.phaseEnteredAt;
    const remaining = limit - elapsed;
    if (remaining <= 0) throw new PhaseTimeout(name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PhaseTimeout(name)), remaining);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async runEffect(effect: Effect): Promise<Event | null> {
    const { contracts, lock, browser, chatgpt } = this.ports;
    switch (effect.kind) {
      case "READ_REQUEST": {
        const r = await contracts.readRequest(this.opts.requestPath);
        if (r.kind === "unreadable") return { type: "REQUEST_UNREADABLE", cause: r.cause };
        this.requestId = r.requestId;
        this.requestDir = r.requestDir;
        this.rawRequest = r.raw;
        return { type: "REQUEST_READ", requestId: r.requestId };
      }
      case "CHECK_PRIOR_RESULT": {
        if (this.requestId === null) return { type: "NO_PRIOR_RESULT" };
        const prior = await contracts.priorState(this.requestDir);
        if (prior === "result") return { type: "PRIOR_RESULT_FOUND" };
        if (prior === "stale_response") return { type: "STALE_RESPONSE_FOUND" };
        return { type: "NO_PRIOR_RESULT" };
      }
      case "VALIDATE": {
        const v = await contracts.validate(this.rawRequest, this.requestDir);
        if (v.kind === "invalid") return { type: "INVALID", errors: v.errors };
        this.request = v.request;
        this.prompt = v.prompt;
        this.timeoutMs = v.timeoutMs;
        this.attachments = v.attachments;
        this.attachmentBytes = v.attachmentBytes;
        const profile = await browser.checkProfilePath();
        if (!profile.ok) return { type: "PROFILE_PATH_REJECTED", cause: profile.cause };
        return { type: "VALID" };
      }
      case "ACQUIRE_LOCK": {
        const a = await lock.acquire("run", this.requestId);
        if (a.kind === "busy") return { type: "LOCK_BUSY", cause: a.cause };
        this.lockHeld = true;
        return { type: "LOCK_OK" };
      }
      case "CHECK_MARKER":
        return (await lock.markerExists(this.requireId()))
          ? { type: "PRIOR_MARKER_FOUND" }
          : { type: "NO_PRIOR_MARKER" };
      case "CHECK_PROFILE_FREE": {
        const f = await browser.checkProfileFree();
        return f.free ? { type: "PROFILE_FREE" } : { type: "PROFILE_BUSY", cause: f.cause };
      }
      case "LAUNCH_BROWSER": {
        const l = await browser.launch({
          copyCaptureShim: true,
          onCrash: (cause) => {
            this.crashCause = cause;
          },
        });
        if (!l.ok) return { type: "BROWSER_LAUNCH_FAILED", cause: l.cause };
        this.browserUp = true;
        return { type: "BROWSER_OK" };
      }
      case "WAIT_BEFORE_RETRY":
        await this.ports.clock.sleep(1000);
        return null;
      case "NAVIGATE_AND_CHECK_AUTH": {
        const a = await this.withPhaseLimit(chatgpt.navigateAndObserveAuth());
        switch (a.kind) {
          case "AUTH_OK":
            return { type: "AUTH_OK" };
          case "AUTH_REQUIRED":
            return { type: "AUTH_REQUIRED" };
          case "CHALLENGE":
            return { type: "CHALLENGE", kind: a.challenge };
          case "WRONG_PAGE":
            return { type: "WRONG_PAGE", url: a.url };
          case "NOT_READY":
            return { type: "RETRYABLE_STEP_FAILED", step: "auth", cause: a.cause };
          case "dom_unexpected":
            return { type: "DOM_UNEXPECTED", element: a.element, tried: a.tried };
        }
        break;
      }
      case "OPEN_NEW_CHAT": {
        const n = await this.withPhaseLimit(chatgpt.openNewChat());
        if (n.kind === "ok") return { type: "NEW_CHAT_OK" };
        if (n.kind === "failed") return { type: "NEW_CHAT_FAILED", cause: n.cause };
        if (n.kind === "retry")
          return { type: "RETRYABLE_STEP_FAILED", step: "new_chat", cause: n.cause };
        return { type: "DOM_UNEXPECTED", element: n.element, tried: n.tried };
      }
      case "RESOLVE_PRESET": {
        const req = this.requireRequest();
        const p = await this.withPhaseLimit(
          chatgpt.resolvePreset(req.preset, req.model ?? "current"),
        );
        switch (p.kind) {
          case "observed":
            this.observedPreset = p.preset;
            this.observedLabel = p.label;
            this.observedModel = p.model;
            return { type: "PRESET_OBSERVED", preset: p.preset };
          case "not_available":
            return { type: "PRESET_NOT_AVAILABLE" };
          case "not_verifiable":
            return { type: "PRESET_NOT_VERIFIABLE", cause: p.cause };
          case "retry":
            return { type: "RETRYABLE_STEP_FAILED", step: "preset", cause: p.cause };
          case "dom_unexpected":
            return { type: "DOM_UNEXPECTED", element: p.element, tried: p.tried };
        }
        break;
      }
      case "ENTER_PROMPT": {
        // A-084: the 60 s pre-submit limit is extended by the upload budget when files are attached
        const e = await this.withPhaseLimit(
          chatgpt.enterPrompt(this.prompt, this.attachments),
          this.attachments.length > 0 ? uploadBudgetMs(this.attachmentBytes) : 0,
        );
        if (e.kind === "ok") return { type: "PROMPT_OK" };
        if (e.kind === "mismatch") return { type: "PROMPT_MISMATCH", cause: e.cause };
        if (e.kind === "retry")
          return { type: "RETRYABLE_STEP_FAILED", step: "prompt", cause: e.cause };
        return { type: "DOM_UNEXPECTED", element: e.element, tried: e.tried };
      }
      case "SNAPSHOT_BASELINE": {
        const b = await chatgpt.snapshotBaseline(this.observedLabel);
        if (b.kind === "ok") {
          this.baseline = b.baseline;
          return { type: "BASELINE_OK" };
        }
        if (b.kind === "preset_changed") return { type: "PRESET_CHANGED" };
        return { type: "DOM_UNEXPECTED", element: b.element, tried: b.tried };
      }
      case "VERIFY_LOCK":
        return (await lock.verify()) ? null : { type: "LOCK_LOST" };
      case "WRITE_SUBMIT_MARKER": {
        const b = this.requireBaseline();
        try {
          await lock.writeMarker(this.requireId(), {
            requestId: this.requireId(),
            writtenAt: this.ports.clock.now().toISOString(),
            urlBefore: b.url,
            baselineAssistantCount: b.assistantCount,
            presetLabelBefore: b.presetLabel,
          });
          return { type: "MARKER_WRITTEN" };
        } catch (err) {
          return { type: "MARKER_WRITE_FAILED", cause: (err as Error).message };
        }
      }
      case "DISPATCH_SUBMIT": {
        const d = await chatgpt.dispatchSubmit(this.requireBaseline().presetLabel);
        if (d.kind === "dispatched") {
          this.conversationUrl = d.url.startsWith("https://chatgpt.com/") ? d.url : null;
          this.dispatchedAt = this.ports.clock.monotonic();
          return { type: "SUBMIT_DISPATCHED" };
        }
        if (d.kind === "failed") return { type: "SUBMIT_FAILED", cause: d.cause };
        return { type: "SUBMIT_ABORTED", cause: "preset_changed" };
      }
      case "UPDATE_MARKER":
        await lock.updateMarker(this.requireId(), {
          dispatchedAt: this.ports.clock.now().toISOString(),
          urlAfter: this.conversationUrl ?? "",
        });
        return null;
      case "DELETE_MARKER":
        await lock.deleteMarker(this.requireId());
        return null;
      case "START_OBSERVATION_LOOP":
        this.observing = true;
        this.history = [];
        return null;
      case "STOP_OBSERVATION_LOOP":
        this.observing = false;
        return null;
      case "EXTRACT_LATEST": {
        const x = await chatgpt.extractLatest();
        if ("kind" in x) return { type: "EXTRACTION_EMPTY", cause: x.cause };
        this.extraction = { markdown: x.markdown, method: x.method, quality: x.quality };
        this.observedModelSlug = x.modelSlug;
        // Post-hoc evidence only (A-067 / 21 §1): a mismatch is a warning, never a failure.
        if (x.modelSlug) {
          const m = slugMatches(this.observedModel, this.observedPreset, x.modelSlug);
          if (!m.ok) this.warnings.push(`model_slug_mismatch: ${m.cause}`);
        }
        return { type: "EXTRACTED" };
      }
      case "WRITE_RESPONSE_MD": {
        try {
          this.responseFile = await contracts.writeResponse(
            this.requestDir,
            this.extraction?.markdown ?? "",
          );
          return null;
        } catch (err) {
          return { type: "WRITE_FAILED", file: "response", cause: (err as Error).message };
        }
      }
      case "CAPTURE": {
        if (!this.browserUp) return null;
        this.artifacts.push(await browser.capture(this.artifactsDir));
        return null;
      }
      case "STOP_TRACE": {
        if (!this.browserUp) return null;
        if (effect.mode === "success" && !this.opts.traceOnSuccess) return null;
        this.artifacts.push(await browser.stopTrace(this.artifactsDir));
        return null;
      }
      case "INSPECT_UI_REPORT": {
        if (!this.browserUp) return null;
        this.artifacts.push(await chatgpt.inspectUiReport(this.artifactsDir));
        return null;
      }
      case "WRITE_RESULT": {
        const result = this.buildResult();
        try {
          this.resultPath = await contracts.writeResult(this.requestDir, result);
          this.result = result;
          return this.state.terminal ? null : { type: "RESULT_WRITTEN" };
        } catch (err) {
          if (!this.state.terminal)
            return { type: "WRITE_FAILED", file: "result", cause: (err as Error).message };
          this.ports.stderr(`WRITE_FAILED (result.json): ${(err as Error).message}`);
          return null;
        }
      }
      case "CLOSE_BROWSER":
        if (this.browserUp) {
          // A-073: leave the account's effort setting as we found it (best-effort, bounded).
          if (!this.crashCause) {
            const r = await Promise.race([
              chatgpt
                .restoreEffort()
                .catch((e: Error) => ({ kind: "failed" as const, cause: e.message })),
              this.ports.clock
                .sleep(15_000)
                .then(() => ({ kind: "failed" as const, cause: "timeout" })),
            ]);
            if (r.kind === "failed") this.warnings.push(`restore_effort_failed: ${r.cause}`);
            else if (r.kind === "restored") this.ports.log("info", "effort slider restored");
          }
          this.browserUp = false;
          await browser.close();
        }
        return null;
      case "RELEASE_LOCK":
        if (this.lockHeld) {
          this.lockHeld = false;
          await lock.release();
        }
        return null;
      case "STDERR":
        this.ports.stderr(effect.message);
        return null;
      case "EXIT":
        this.exitCode = effect.code;
        return null;
    }
    return null;
  }

  private rawRequest: unknown = null;
  private history: Observation[] = [];
  private dispatchedAt = 0;

  private async observeLoop(): Promise<void> {
    const cfg: CompletionConfig = {
      timeoutMs: this.timeoutMs,
      stabilizationMs:
        this.opts.completion?.stabilizationMs ?? DEFAULT_COMPLETION_CONFIG.stabilizationMs,
      fallbackStabilizationMs:
        this.opts.completion?.fallbackStabilizationMs ??
        DEFAULT_COMPLETION_CONFIG.fallbackStabilizationMs,
    };
    const interval = this.opts.observationIntervalMs ?? 250;
    const baseline = this.requireBaseline().assistantCount;
    while (this.observing && !this.state.terminal) {
      if (this.crashCause) {
        const cause = this.crashCause;
        this.crashCause = null;
        this.observing = false;
        await this.dispatch({ type: "BROWSER_CRASHED", cause });
        return;
      }
      const t = this.ports.clock.monotonic() - this.dispatchedAt;
      let obs: Observation;
      try {
        obs = await this.ports.chatgpt.observe(t);
      } catch (err) {
        this.warnings.push(`observe_failed: ${(err as Error).message.slice(0, 200)}`);
        await this.ports.clock.sleep(interval);
        continue;
      }
      this.history.push(obs);
      if (this.history.length > 4000) this.history.splice(0, this.history.length - 4000);
      // The URL right after dispatch may be a transient client id (e.g. /c/WEB:...); keep the latest.
      const url = await this.ports.chatgpt.currentUrl();
      if (url.startsWith("https://chatgpt.com/c/")) this.conversationUrl = url;
      const verdict = judge(this.history, baseline, cfg);
      const wasObserving = this.observing;
      await this.dispatch(verdict);
      if (!wasObserving || !this.observing) return;
      await this.ports.clock.sleep(interval);
    }
  }

  private buildResult(): BridgeResult {
    const term = this.state.terminal;
    const completedAt = this.ports.clock.now();
    const completed = term?.name === "COMPLETED" || (!term && this.state.name === "WRITING_RESULT");
    const safeCause = term?.cause == null ? null : sanitiseResultText(term.cause);
    return {
      schemaVersion: "1.1",
      bridgeVersion: this.opts.bridgeVersion,
      requestId: this.requestId,
      status: completed
        ? "completed"
        : term?.name === "MANUAL_INTERVENTION"
          ? "manual_intervention_required"
          : "failed",
      requestedPreset: this.request?.preset ?? null,
      observedPreset: this.observedPreset,
      requestedModel: this.request ? (this.request.model ?? "current") : null,
      observedModel: this.observedModel,
      observedModelSlug: this.observedModelSlug,
      submitted: this.state.submitted,
      conversationUrl: sanitiseConversationUrl(this.conversationUrl),
      responseFile: completed ? this.responseFile : null,
      extractionMethod: completed ? (this.extraction?.method ?? null) : null,
      extractionQuality: completed ? (this.extraction?.quality ?? null) : null,
      startedAt: this.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - this.startedAt.getTime()),
      artifacts: [...this.artifacts],
      warnings: this.warnings.map((w) => sanitiseResultText(w)),
      error:
        completed || !term || !term.code
          ? null
          : {
              code: term.code,
              message: messageFor(term.code, safeCause),
              retryable: false,
              phase: this.state.phase,
              cause: safeCause,
            },
    };
  }

  private requireId(): string {
    if (this.requestId === null) throw new Error("requestId missing");
    return this.requestId;
  }
  private requireRequest(): BridgeRequest {
    if (!this.request) throw new Error("request missing");
    return this.request;
  }
  private requireBaseline(): Baseline {
    if (!this.baseline) throw new Error("baseline missing");
    return this.baseline;
  }
}

/** 13-ERROR-MODEL §2: human-facing Japanese guidance. */
export function messageFor(code: ErrorCode, cause: string | null): string {
  switch (code) {
    case "INVALID_REQUEST":
      return cause === "stale_response"
        ? "result.json が無いのに response.md が残っています。古い response.md を退避し、新しい requestId で再実行してください。"
        : "request.json または prompt.md が不正です。内容を修正してください。";
    case "INVALID_CONFIG":
      return "プロファイルパスが通常のブラウザプロファイルを指すか、symlink / junction を含みます。CHATGPT_BRIDGE_PROFILE_DIR を専用ディレクトリにしてください。";
    case "SUBMIT_STATE_UNKNOWN":
      return "前回の実行が送信直前〜終端前に終了したため送信状態が不明です。ChatGPT の会話一覧を確認し、再送する場合は新しい requestId を使ってください。";
    case "PROFILE_IN_USE":
      return "専用プロファイルを別の Chrome が開いています。そのウィンドウを閉じてから再実行してください。";
    case "BROWSER_LAUNCH_FAILED":
      return "ブラウザを起動できませんでした。chatgpt-bridge doctor でブラウザ実行ファイルを確認してください。";
    case "INVALID_STATE":
      return "chatgpt.com 以外のページ、またはページを読み込めませんでした。chatgpt-bridge login で専用ブラウザの状態を確認してください。";
    case "AUTH_REQUIRED":
      return "ChatGPT へのログインが必要です。chatgpt-bridge login を実行してください。";
    case "CAPTCHA_OR_CHALLENGE":
      return "CAPTCHA またはセキュリティチャレンジが表示されています。chatgpt-bridge login で開いたブラウザで人間が完了してください。";
    case "MANUAL_INTERVENTION_REQUIRED":
      return "同意画面などの人間の操作が必要な画面が表示されています。chatgpt-bridge login で開いたブラウザで対応してください。";
    case "RATE_LIMITED":
      return "ChatGPT の利用上限に達しています。時間を置いてから新しい requestId で再実行してください（自動待機はしません）。";
    case "MODEL_NOT_AVAILABLE":
      return "要求した preset の選択肢が UI にありません。chatgpt-bridge inspect-ui で選択肢を確認してください。";
    case "MODEL_NOT_VERIFIABLE":
      return "モデル / effort の表示を確認できなかったため送信しませんでした。chatgpt-bridge inspect-ui で表示を確認してください。";
    case "PROMPT_INPUT_FAILED":
      return "入力欄の内容がプロンプトと一致しませんでした（長さ上限など）。プロンプトを見直してください。";
    case "PROMPT_SUBMIT_FAILED":
      return "送信操作に失敗しました。submitted が unknown の場合は ChatGPT の会話一覧で送信有無を確認してください。";
    case "GENERATION_TIMEOUT":
      return "回答の生成が timeoutMs 内に終わりませんでした。conversationUrl を開いて確認し、再送する場合は新しい requestId を使ってください。";
    case "CHAT_ERROR":
      return `ChatGPT 側でエラーが発生しました（${cause ?? "unknown"}）。conversationUrl を開いて確認してください。`;
    case "DOM_CHANGED":
      return "ChatGPT の UI 構造が想定と異なります。artifacts の inspect-ui.json を基に selectors を更新してください。";
    case "EXTRACTION_FAILED":
      return `回答本文を取得できませんでした（${cause ?? "unknown"}）。conversationUrl から手動で取得してください。`;
    case "BROWSER_CRASHED":
      return "ブラウザが終了または切断されました。submitted を確認し、yes なら conversationUrl を確認してください。";
    case "WRITE_FAILED":
      return "ファイルの書き出しに失敗しました。ディスク容量・権限・他アプリによるロックを確認してください。";
    case "INTERNAL_ERROR":
      return "ブリッジ内部のエラーです。cause と trace を添えて報告してください。";
    case "ALREADY_PROCESSED":
      return "同じ requestId は処理済みです。既存の result.json を読んでください。";
    case "ALREADY_RUNNING":
      return "別のブリッジが実行中です。終了を待って再実行してください。";
  }
  return "不明なエラーです。";
}
