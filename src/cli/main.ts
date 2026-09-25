#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkDaemon, startDaemon, stopDaemon } from "../browser/daemon.js";
import { checkProfilePath } from "../browser/profile-guard.js";
import { buildBundle } from "../bundle/bundle.js";
import { observeAuthWithRetry } from "../chatgpt/auth-probe.js";
import { ChatGptPage } from "../chatgpt/page.js";
import { EXIT_CODES } from "../contracts/types.js";
import { formatDoctor, runDoctor } from "../diagnostics/doctor.js";
import { createLogger } from "../diagnostics/logger.js";
import { computeUsage, formatUsage, loadLimits, loadRecords } from "../diagnostics/usage.js";
import {
  POST_SUBMIT_STABILIZATION_AND_EXTRACTION_BUDGET_MS,
  RunController,
} from "../state/controller.js";
// A-132 Opus review, High #8: `node:sqlite` needs Node >=22.13 unflagged. These are imported
// dynamically ONLY inside the four Phase 1 command handlers below (never at module top level),
// so `run`/`doctor`/`worker`/`login`/etc. — the commands other projects' CLAUDE.md/SKILL.md files
// already call directly — keep working unmodified even on a Node version where node:sqlite can't
// load; only `submit`/`status`/`wait`/`result` themselves require the newer engines.node floor.
import type { JobRow } from "../state/jobstore.js";
import { unlockReclaimableStale } from "../state/lock.js";
import { markerPath, readMarker } from "../state/marker.js";
import { slotPath } from "../state/slot-lock.js";
import { buildPorts } from "./adapters.js";
import { type BridgeConfig, loadConfig } from "./config.js";
import { RunWatchdog } from "./run-watchdog.js";
import { runWorker } from "./worker.js";

export { observeAuthWithRetry } from "../chatgpt/auth-probe.js";

const USAGE = `chatgpt-bridge <command> [options]

commands:
  login                      専用ブラウザを開き、人間がログインする
  doctor [--json]            環境・プロファイル・ロック・ログイン状態を診断する
  unlock --stale [--json]    dead/reused PID の stale lock だけを明示的に削除する（生存 owner は絶対に kill しない）
  run --request <path> [--json]
                             request.json を 1 件処理する。--json は result.json の内容を標準出力に 1 行で出す
  submit --request <path> [--json]
                             （Phase 1）request.json を検証してjob台帳（runtime/jobs.db）に登録し、
                             実際の生成は別プロセス（detached）へ渡してすぐ戻る。呼び出し元CLIが
                             終了・切断しても生成は続く。同じ requestId・同じ内容の再送は既存jobを返す
  status <requestId> [--json]
                             （Phase 1）jobの現在状態を見る（result.json があれば優先）
  wait <requestId> [--timeout-ms <n>] [--json]
                             （Phase 1）jobが終端状態になるかタイムアウトするまで待つ。タイムアウトしても
                             jobそのものは止まらない
  collect <requestId> [--json]
  collect --conversation-url <url> --since <ISO> --prompt-file <path> --baseline-assistant-count <n> [--out <dir>] [--json]
                             送信せず、baseline と会話を照合して 1 件だけの回答を回収する
  result <requestId> [--out <path>] [--json]
                             （Phase 1）完了したjobのresponse.mdを取得する
  usage [--json] [--queue <dir>]
                             ブリッジ経由の送信数を窓ごとに集計し、runtime/limits.json の上限と比べる
                             （--queue でキューの done / failed / blocked も数える）
  worker --queue <dir> [--once | --drain] [--poll-ms <n>]
                             <dir>/pending/<requestId>/ を 1 件ずつ run と同じ経路で処理し、
                             done / failed / blocked へ移す。exit 3 が出たらキュー全体を停止する
  bundle --root <dir> --out <file> [--include <glob>]... [--exclude <glob>]...
         [--max-bytes <n>] [--diff <gitref>]
                             リポジトリの一部を 1 つの Markdown（ツリー + fence 付き本文 [+ git diff]）に
                             まとめる。秘密らしい内容があれば生成を拒否する（ブラウザは使わない）
  daemon start | stop | status
                             バックグラウンドでブラウザを開いたままにする（A-103）。開始しておくと
                             run/login/doctor/inspect-ui はこれを使い回し、毎回の起動・終了を避ける。
                             最小化して起動するので作業の邪魔にはならない。ウィンドウを手動で閉じた
                             場合は daemon stop で状態ファイルを片付けてから daemon start してください。
                             15 分おきに空いていれば軽い keep-alive（A-105）を行いセッション切れを防ぐ
                             （間隔は CHATGPT_BRIDGE_DAEMON_KEEPALIVE_MS[ms] で変更可）
  inspect-ui [--dump-dom] [--walk-effort]
                             UI 要素の検出状況を出力する（送信しない）。--walk-effort は
                             思考量スライダーを全段階なめてラベルを記録し、元の段階に戻す
  stealth-signals            A-140 experimental fingerprint diagnostic (no prompt is sent)

options:
  --profile-dir <path>       専用プロファイル（CHATGPT_BRIDGE_PROFILE_DIR より優先）
  --log-level <level>        debug | info | warn | error
  --allow-unverified         verifiedOn の無い selector 候補も使う（Phase 4 の実画面確認専用）

環境変数:
  CHATGPT_BRIDGE_MAX_CONCURRENCY  （Phase 3 MVP）run が daemon 経由で同時に使える生成枠の数。既定 1
                             （従来どおり単一実行・bridge.lock 排他）。2 以上にすると run は
                             daemon の共有ブラウザ上で専用タブを毎回新規に開き、終了時に閉じる
                             （タブを使い回さない）。上限 8。無効値は 1、超過値は 8 に丸めて警告する。
                             daemon が起動していない場合、Windows の 2 件目以降はプロファイル確認で
                             PROFILE_IN_USE となる（他プラットフォームでは browser launch failure の場合がある）
`;

async function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((r) => rl.question(prompt, () => r()));
  rl.close();
}

/** Set by the browser's onCrash callback; `fn` reads it to detect a mid-command crash. */
export interface CrashState {
  cause: string | null;
}

async function withBrowser<T>(
  cfg: BridgeConfig,
  command: string,
  verifiedOnly: boolean,
  fn: (ports: ReturnType<typeof buildPorts>, crash: CrashState) => Promise<T>,
): Promise<T | number> {
  const logger = createLogger(cfg.logLevel);
  const ports = buildPorts(cfg, logger, verifiedOnly);
  const guard = await ports.browser.checkProfilePath();
  if (!guard.ok) {
    logger.stderr(`INVALID_CONFIG: ${guard.cause}`);
    return EXIT_CODES.invalidInput;
  }
  const lock = await ports.lock.acquire(command, null);
  if (lock.kind === "busy") {
    logger.stderr(`ALREADY_RUNNING: ${lock.cause}`);
    return EXIT_CODES.beforeBrowser;
  }
  try {
    const free = await ports.browser.checkProfileFree();
    if (!free.free) {
      logger.stderr(`PROFILE_IN_USE: ${free.cause}`);
      return EXIT_CODES.beforeBrowser;
    }
    const crash: CrashState = { cause: null };
    const launched = await ports.browser.launch({
      copyCaptureShim: false,
      onCrash: (c) => {
        logger.log("warn", `browser: ${c}`);
        crash.cause = c;
      },
    });
    if (!launched.ok) {
      logger.stderr(`BROWSER_LAUNCH_FAILED: ${launched.cause}`);
      return EXIT_CODES.beforeBrowser;
    }
    try {
      return await fn(ports, crash);
    } finally {
      await ports.browser.close().catch(() => undefined);
    }
  } finally {
    await ports.lock.release();
  }
}

/**
 * `login`/`doctor` drive ChatGptPage directly (no RunController, so no FR-042 retry). NOT_READY is
 * a transient navigation hiccup (goto timeout, net::ERR_ABORTED); real auth states (AUTH_REQUIRED,
 * CHALLENGE, WRONG_PAGE) are never retried — retrying those would mask a genuine fail-closed signal.
 */
async function cmdLogin(cfg: BridgeConfig, verifiedOnly: boolean): Promise<number> {
  const r = await withBrowser(cfg, "login", verifiedOnly, async (ports, crash) => {
    const page = new ChatGptPage(ports.session.currentPage, { verifiedOnly });
    const auth = await observeAuthWithRetry(page, crash);
    // Codex review of 80f816d, Medium #3: a crash must win even if the last observation looks like
    // AUTH_OK (a stale-but-well-formed read taken just before the crash was reported).
    if (crash.cause) {
      process.stdout.write(
        `ブラウザがクラッシュしました（${crash.cause}）。ログインを完了できませんでした。もう一度 chatgpt-bridge login を実行してください（同じプロファイルを開いている他のウィンドウが無いか確認してください）。\n`,
      );
      return 1;
    }
    if (auth.kind === "AUTH_OK") {
      process.stdout.write("ログイン済みです。ブラウザを閉じます。\n");
      return 0;
    }
    process.stdout.write(
      [
        "ブラウザでログインしてください。ログインを検出すると自動で終了します（Enter で強制終了）。",
        "注意: Google ログインは自動操作中のブラウザを拒否します（ブリッジはこれを回避しません）。",
        "その場合はこのウィンドウを閉じ、通常の Chrome を専用プロファイルで起動してログインしてください:",
        `  & "<chrome.exe>" --user-data-dir="${cfg.profileDir}" https://chatgpt.com/`,
        "「私はロボットではありません」等の Cloudflare チェックが出た場合は、このウィンドウ内でそのまま",
        "人間がクリックして通過してください（ブリッジは自動で突破しません）。新しいプロファイルほど出やすく、",
        "何度か通過すると頻度は下がっていきます。",
        "ログイン後にそのウィンドウを閉じてから chatgpt-bridge doctor で確認してください。",
        "",
      ].join("\n"),
    );
    let done = false;
    const poll = (async (): Promise<"auth_ok" | "crashed" | "gave_up"> => {
      while (!done) {
        if (crash.cause) return "crashed";
        await new Promise((r) => setTimeout(r, 2000));
        if (crash.cause) return "crashed";
        // Codex review of 80f816d, High #2: currentUrl() rejecting outside the .catch() used to
        // reject this whole poll loop uncaught. Both calls now share one try/catch.
        let a: Awaited<ReturnType<ChatGptPage["observeAuth"]>> | null = null;
        try {
          a = await page.observeAuth(await page.currentUrl());
        } catch {
          a = null;
        }
        if (crash.cause) return "crashed";
        if (a?.kind === "AUTH_OK") return "auth_ok";
      }
      return "gave_up";
    })();
    const enter = waitForEnter("").then((): "manual" => "manual");
    const outcome = await Promise.race([poll, enter]);
    done = true;
    if (outcome === "crashed") {
      process.stdout.write(
        `ブラウザがクラッシュしました（${crash.cause}）。ログインを完了できませんでした。もう一度 chatgpt-bridge login を実行してください（同じプロファイルを開いている他のウィンドウが無いか確認してください）。\n`,
      );
      return 1;
    }
    const loggedIn = outcome === "auth_ok";
    process.stdout.write(loggedIn ? "ログインを検出しました。\n" : "手動終了しました。\n");
    return loggedIn ? 0 : 1;
  });
  return typeof r === "number" ? r : 1;
}

async function cmdDoctor(cfg: BridgeConfig, verifiedOnly: boolean, json: boolean): Promise<number> {
  const logger = createLogger(cfg.logLevel);
  const items = await runDoctor({
    cfg,
    loginProbe: async () => {
      const r = await withBrowser(cfg, "doctor", verifiedOnly, async (ports, crash) => {
        const page = new ChatGptPage(ports.session.currentPage, { verifiedOnly });
        const a = await observeAuthWithRetry(page, crash);
        if (crash.cause) return { ok: false, detail: `browser crashed: ${crash.cause}` };
        return {
          ok: a.kind === "AUTH_OK",
          detail:
            a.kind === "AUTH_OK" ? "logged in" : `${a.kind}${"cause" in a ? `: ${a.cause}` : ""}`,
        };
      });
      return typeof r === "number" ? { ok: false, detail: `browser probe failed (exit ${r})` } : r;
    },
  });
  const { text, ok } = formatDoctor(items);
  process.stdout.write(json ? `${JSON.stringify({ ok, items })}\n` : `${text}\n`);
  logger.log("debug", `doctor: ${ok ? "all ok" : "has NG"}`);
  return ok ? 0 : 1;
}

async function cmdUnlock(cfg: BridgeConfig, stale: boolean, json: boolean): Promise<number> {
  if (!stale) {
    printCommandError(json, "INVALID_REQUEST", "unlock requires --stale");
    return EXIT_CODES.invalidInput;
  }
  const base = join(cfg.locksDir, "bridge.lock");
  const paths =
    cfg.maxConcurrency > 1
      ? Array.from({ length: cfg.maxConcurrency }, (_, index) => slotPath(base, index))
      : [base];
  const results = await Promise.all(paths.map((path) => unlockReclaimableStale(path)));
  const ok = results.every((r) => r.ok || r.detail === "lock vanished");
  if (json) process.stdout.write(`${JSON.stringify({ stale: true, results })}\n`);
  else
    results.forEach((r, index) => {
      process.stdout.write(`${paths[index]}: ${r.detail}\n`);
    });
  return ok ? 0 : EXIT_CODES.beforeBrowser;
}

async function cmdRun(
  cfg: BridgeConfig,
  requestPath: string,
  verifiedOnly: boolean,
  json: boolean,
): Promise<number> {
  const logger = createLogger(cfg.logLevel);
  // A-136 (Phase 3 MVP): only `run` ever pools — `pooled: true` takes effect only when
  // cfg.maxConcurrency > 1 (buildPorts falls back to the unchanged single-lock path otherwise).
  const ports = buildPorts(cfg, logger, verifiedOnly, true);
  let watchdog: RunWatchdog | null = null;
  const controller = new RunController(ports, {
    requestPath: resolve(requestPath),
    artifactsRoot: cfg.artifactsDir,
    bridgeVersion: cfg.bridgeVersion,
    traceOnSuccess: cfg.traceOnSuccess,
    onPreSubmitBudgetKnown: (budgetMs) => watchdog?.armBeforeSubmit(budgetMs),
    onSubmitDispatched: (timeoutMs) =>
      watchdog?.armAfterSubmit(timeoutMs, POST_SUBMIT_STABILIZATION_AND_EXTRACTION_BUDGET_MS),
  });
  watchdog = new RunWatchdog(controller);
  if (!json) process.stdout.write(`run: ${resolve(requestPath)}\n`);
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  // Node exposes SIGBREAK on Windows consoles. It is intentionally not registered elsewhere so
  // non-Windows shells keep their ordinary signal set.
  if (process.platform === "win32") signals.push("SIGBREAK");
  const onSignal = (signal: NodeJS.Signals) => {
    void controller.interrupt(signal);
  };
  for (const signal of signals) process.once(signal, onSignal);
  let outcome: Awaited<ReturnType<RunController["run"]>>;
  try {
    outcome = await controller.run();
  } finally {
    watchdog.cancel();
    for (const signal of signals) process.removeListener(signal, onSignal);
  }
  const res = outcome.result;
  if (json) {
    // one JSON document on stdout for orchestrators (result.json content, or a stub when none was written)
    const doc = res ?? {
      status: "not_started",
      terminal: outcome.state.name,
      code: outcome.state.terminal?.code ?? null,
    };
    process.stdout.write(
      `${JSON.stringify({ ...doc, exitCode: outcome.exitCode, resultPath: outcome.resultPath })}\n`,
    );
    return outcome.exitCode;
  }
  if (res) {
    process.stdout.write(
      `status=${res.status} submitted=${res.submitted}${res.error ? ` code=${res.error.code}` : ""}\n`,
    );
    if (outcome.resultPath) process.stdout.write(`result: ${outcome.resultPath}\n`);
  } else {
    process.stdout.write(
      `terminal=${outcome.state.name}${outcome.state.terminal?.code ? ` code=${outcome.state.terminal.code}` : ""} (no result.json)\n`,
    );
  }
  return outcome.exitCode;
}

function printJob(job: JobRow, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(job)}\n`);
    return;
  }
  process.stdout.write(`requestId=${job.requestId} status=${job.status}\n`);
  if (job.errorCode) process.stdout.write(`errorCode=${job.errorCode}\n`);
  if (job.resultPath) process.stdout.write(`result: ${job.resultPath}\n`);
  // A-134/A-135 Opus review, Medium #4: status/exitCode alone don't distinguish this from any
  // other plain failure — a caller that only checks those could still retry into a double submit.
  if (job.errorCode === "SUBMIT_STATE_UNKNOWN") {
    process.stdout.write(
      "⚠️ 送信状態が不明です。プロンプトがChatGPTへ実際に届いている可能性があります。このrequestIdを再送しないでください。人間がconversationUrl（result.jsonまたはブラウザ）を確認してください。\n",
    );
  }
  if (
    ["GENERATION_TIMEOUT", "GENERATION_TIMEOUT_ACTIVE", "CONVERSATION_MISMATCH"].includes(
      job.errorCode ?? "",
    )
  ) {
    process.stdout.write(
      "Recovery: do not resubmit yet; run chatgpt-bridge collect <requestId> to prove and recover a visible reply without sending.\n",
    );
  }
}

/** JSON mode is a protocol, including failures: stdout contains exactly one object a caller can
 * parse instead of an error that only existed on stderr. */
function printCommandError(json: boolean, code: string, message: string): void {
  if (json) process.stdout.write(`${JSON.stringify({ error: { code, message } })}\n`);
  else process.stderr.write(`${message}\n`);
}

async function cmdSubmit(cfg: BridgeConfig, requestPath: string, json: boolean): Promise<number> {
  const { submitJob } = await import("./submit.js");
  const outcome = await submitJob(cfg, requestPath);
  if (!outcome.ok) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ error: { code: outcome.code, message: outcome.cause } })}\n`,
      );
    } else {
      process.stderr.write(`${outcome.cause}\n`);
    }
    return outcome.code === "ALREADY_RUNNING"
      ? EXIT_CODES.beforeBrowser
      : outcome.code === "SUBMIT_SPAWN_FAILED"
        ? EXIT_CODES.spawnFailure
        : EXIT_CODES.invalidInput;
  }
  if (!json && outcome.alreadySubmitted) {
    process.stdout.write("(already submitted with the same content; returning the existing job)\n");
  }
  printJob(outcome.job, json);
  return 0;
}

async function cmdStatus(cfg: BridgeConfig, requestId: string, json: boolean): Promise<number> {
  const { jobStorePath, reconcileJob } = await import("./submit.js");
  const { openJobStore } = await import("../state/jobstore.js");
  const store = await openJobStore(jobStorePath(cfg));
  try {
    const job = store.get(requestId);
    if (!job) {
      printCommandError(json, "INVALID_REQUEST", `no such job: ${requestId}`);
      return EXIT_CODES.invalidInput;
    }
    printJob(await reconcileJob(store, job, cfg), json);
    return 0;
  } finally {
    store.close();
  }
}

async function cmdWait(
  cfg: BridgeConfig,
  requestId: string,
  timeoutMs: number,
  json: boolean,
): Promise<number> {
  const { jobStorePath, waitForJob } = await import("./submit.js");
  const { openJobStore } = await import("../state/jobstore.js");
  const store = await openJobStore(jobStorePath(cfg));
  try {
    const { job, timedOut } = await waitForJob(store, requestId, timeoutMs, cfg);
    if (!job) {
      printCommandError(json, "INVALID_REQUEST", `no such job: ${requestId}`);
      return EXIT_CODES.invalidInput;
    }
    if (json) {
      process.stdout.write(
        timedOut
          ? `${JSON.stringify(waitingTimeoutPayload(job))}\n`
          : `${JSON.stringify({ ...job, timedOut: false })}\n`,
      );
    } else {
      if (timedOut) {
        // The CLI's own wait gave up; the detached run keeps going regardless
        // (11-STATE-MACHINE §5.4: CLI待機期限は「CLIだけ終了」— the job itself is untouched,
        // poll status/wait again later.
        process.stdout.write(`${waitingTimeoutText(job)}\n`);
      } else {
        printJob(job, false);
      }
    }
    if (timedOut) return EXIT_CODES.waitingTimeout;
    return job.status === "completed" ? 0 : job.status === "manual_intervention_required" ? 3 : 1;
  } finally {
    store.close();
  }
}

export function waitingTimeoutPayload(job: JobRow) {
  return {
    status: "waiting_timeout" as const,
    requestId: job.requestId,
    retryable: true,
    guidance:
      "The job is still non-terminal. Call wait again, or collect <requestId> if a reply may already be visible.",
    job,
  };
}

export function waitingTimeoutText(job: JobRow): string {
  return `status=waiting_timeout requestId=${job.requestId} retryable=true (current job status=${job.status}; this is not a final result). Run wait again or collect <requestId>.`;
}

async function readResultIfPresent(
  path: string,
): Promise<import("../contracts/types.js").BridgeResult | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as import("../contracts/types.js").BridgeResult;
  } catch {
    return null;
  }
}

async function cmdCollect(
  cfg: BridgeConfig,
  requestId: string | undefined,
  v: {
    conversationUrl?: string | undefined;
    since?: string | undefined;
    baselineAssistantCount?: string | undefined;
    promptFile?: string | undefined;
    out?: string | undefined;
    json: boolean;
  },
): Promise<number> {
  const {
    buildRecoveredResult,
    collectLatestReply,
    confirmedConversationUrl,
    requestPathForCollect,
    writeRecoveredResult,
  } = await import("./collect.js");
  const { jobStorePath, reconcileJob } = await import("./submit.js");
  const { openJobStore } = await import("../state/jobstore.js");
  const explicit = Boolean(
    v.conversationUrl || v.since || v.baselineAssistantCount || v.promptFile,
  );
  if (requestId && explicit) {
    printCommandError(
      v.json,
      "INVALID_REQUEST",
      "collect accepts either <requestId> or explicit recovery evidence, not both",
    );
    return EXIT_CODES.invalidInput;
  }
  let identity: import("./collect.js").CollectIdentity;
  let job: JobRow | null = null;
  let requestDir: string | null = null;
  if (requestId) {
    const store = await openJobStore(jobStorePath(cfg));
    try {
      job = store.get(requestId);
      if (job) job = await reconcileJob(store, job, cfg);
      if (job?.status === "completed") {
        printCommandError(v.json, "INVALID_REQUEST", `job ${requestId} is already completed`);
        return EXIT_CODES.invalidInput;
      }
      const marker = await readMarker(markerPath(cfg.stateDir, requestId));
      if (!marker || !Number.isInteger(marker.baselineAssistantCount)) {
        printCommandError(
          v.json,
          "INVALID_REQUEST",
          `collect requires a readable submit.marker for ${requestId}`,
        );
        return EXIT_CODES.invalidInput;
      }
      const resolvedRequestPath =
        job?.requestPath ?? requestPathForCollect(marker.requestPath, cfg.runtimeDir, requestId);
      requestDir = job?.requestDir ?? dirname(resolvedRequestPath);
      const original = await readResultIfPresent(
        job?.resultPath ?? join(requestDir, "result.json"),
      );
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(resolvedRequestPath, "utf8"));
      } catch (err) {
        printCommandError(
          v.json,
          "INVALID_REQUEST",
          `collect requires the request.json recorded by the marker: ${(err as Error).message}`,
        );
        return EXIT_CODES.invalidInput;
      }
      const { validateAndLoad } = await import("../contracts/request.js");
      const loaded = await validateAndLoad(raw, requestDir);
      if (loaded.kind !== "valid" || loaded.request.requestId !== requestId) {
        printCommandError(
          v.json,
          "INVALID_REQUEST",
          `request cannot support collect: ${loaded.kind === "valid" ? "requestId does not match marker" : loaded.errors.join("; ")}`,
        );
        return EXIT_CODES.invalidInput;
      }
      const conversationUrl = confirmedConversationUrl(
        original?.conversationUrl,
        marker.urlAfter,
        loaded.request.conversationUrl,
      );
      if (!conversationUrl) {
        printCommandError(
          v.json,
          "INVALID_REQUEST",
          "no confirmed real conversation URL is available; refusing to navigate to a temporary or guessed id",
        );
        return EXIT_CODES.invalidInput;
      }
      identity = {
        requestId,
        conversationUrl,
        submittedAt: marker.dispatchedAt ?? marker.writtenAt,
        baselineAssistantCount: marker.baselineAssistantCount,
        request: loaded.request,
        original,
        submittedPrompt: loaded.prompt,
        attachmentNames: loaded.attachments.map((path) => basename(path)),
      };
    } finally {
      store.close();
    }
  } else {
    const baseline = Number(v.baselineAssistantCount);
    if (
      !v.conversationUrl ||
      !v.since ||
      !v.promptFile ||
      !Number.isInteger(baseline) ||
      baseline < 0 ||
      Number.isNaN(Date.parse(v.since))
    ) {
      printCommandError(
        v.json,
        "INVALID_REQUEST",
        "explicit collect requires --conversation-url, --since <ISO>, --prompt-file <path>, and --baseline-assistant-count <non-negative integer>",
      );
      return EXIT_CODES.invalidInput;
    }
    let submittedPrompt: string;
    try {
      submittedPrompt = await readFile(resolve(v.promptFile), "utf8");
    } catch (err) {
      printCommandError(
        v.json,
        "INVALID_REQUEST",
        `cannot read --prompt-file: ${(err as Error).message}`,
      );
      return EXIT_CODES.invalidInput;
    }
    identity = {
      requestId: null,
      conversationUrl: v.conversationUrl,
      submittedAt: new Date(v.since).toISOString(),
      baselineAssistantCount: baseline,
      submittedPrompt,
    };
  }
  const outputDir = requestId
    ? join(requestDir as string, "recovered")
    : v.out
      ? resolve(v.out)
      : join(
          cfg.runtimeDir,
          "recovered",
          `collect-${createHash("sha256").update(`${identity.conversationUrl}\0${identity.submittedAt}`).digest("hex").slice(0, 16)}`,
        );
  const ports = buildPorts(cfg, createLogger(cfg.logLevel), true, false);
  const attempt = await collectLatestReply(identity, ports, join(outputDir, "images"));
  if (!attempt.ok) {
    printCommandError(
      v.json,
      attempt.code,
      `${attempt.message}. No prompt was sent and no result was written.`,
    );
    return attempt.code === "COLLECT_LOCK_BUSY"
      ? EXIT_CODES.beforeBrowser
      : EXIT_CODES.afterBrowser;
  }
  const responsePath = join(outputDir, "response.md");
  const recovered = buildRecoveredResult(
    identity,
    attempt.extraction,
    responsePath,
    cfg.bridgeVersion,
    new Date(),
    attempt.images,
    attempt.warnings,
  );
  const written = await writeRecoveredResult(outputDir, recovered, attempt.extraction.markdown);
  if (job) {
    const store = await openJobStore(jobStorePath(cfg));
    try {
      store.update(job.requestId, {
        status: "completed",
        resultPath: written.resultPath,
        errorCode: null,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      store.close();
    }
  }
  if (v.json)
    process.stdout.write(
      `${JSON.stringify({ result: recovered, resultPath: written.resultPath })}\n`,
    );
  else process.stdout.write(`recovered result: ${written.resultPath}\n`);
  return EXIT_CODES.completed;
}

async function cmdResult(
  cfg: BridgeConfig,
  requestId: string,
  out: string | undefined,
  json: boolean,
): Promise<number> {
  const { jobStorePath, reconcileJob } = await import("./submit.js");
  const { openJobStore } = await import("../state/jobstore.js");
  const store = await openJobStore(jobStorePath(cfg));
  let job: JobRow | null;
  try {
    job = store.get(requestId);
    if (!job) {
      printCommandError(json, "INVALID_REQUEST", `no such job: ${requestId}`);
      return EXIT_CODES.invalidInput;
    }
    job = await reconcileJob(store, job, cfg);
  } finally {
    store.close();
  }
  if (job.status !== "completed") {
    printCommandError(
      json,
      "INVALID_REQUEST",
      `job ${requestId} is not completed (status=${job.status})`,
    );
    return EXIT_CODES.invalidInput;
  }
  const storedResult = await readResultIfPresent(
    job.resultPath ?? join(job.requestDir, "result.json"),
  );
  const responsePath = storedResult?.responseFile ?? join(job.requestDir, "response.md");
  let markdown: string;
  try {
    markdown = await readFile(responsePath, "utf8");
  } catch (err) {
    printCommandError(
      json,
      "INTERNAL_ERROR",
      `response.md missing for a completed job: ${(err as Error).message}`,
    );
    return 1;
  }
  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, markdown, "utf8");
    if (!json) process.stdout.write(`wrote ${out}\n`);
  } else if (!json) {
    process.stdout.write(markdown);
  }
  // A-132 Opus review, Low #12: --json used to discard the response body entirely unless --out
  // was also given, defeating the command's own purpose for a JSON-consuming caller.
  if (json) process.stdout.write(`${JSON.stringify({ ...job, responseMarkdown: markdown })}\n`);
  return 0;
}

async function cmdBundle(v: {
  root?: string | undefined;
  out?: string | undefined;
  include?: string[] | undefined;
  exclude?: string[] | undefined;
  maxBytes?: string | undefined;
  diff?: string | undefined;
}): Promise<number> {
  if (!v.root || !v.out) {
    process.stderr.write("bundle requires --root <dir> and --out <file>\n");
    return EXIT_CODES.invalidInput;
  }
  const maxBytes = Number(v.maxBytes ?? "200000");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    process.stderr.write("--max-bytes must be a positive number\n");
    return EXIT_CODES.invalidInput;
  }
  const r = await buildBundle({
    root: resolve(v.root),
    include: v.include ?? [],
    exclude: v.exclude ?? [],
    maxBytes,
    ...(v.diff ? { diffRef: v.diff } : {}),
  });
  if (!r.ok) {
    process.stderr.write(`bundle refused:\n${r.errors.map((e) => `  ${e}`).join("\n")}\n`);
    return EXIT_CODES.invalidInput;
  }
  await mkdir(dirname(resolve(v.out)), { recursive: true });
  await writeFile(resolve(v.out), r.result.markdown, "utf8");
  process.stdout.write(
    `bundle: ${resolve(v.out)} (${r.result.included.length} files, ${r.result.totalBytes} bytes${r.result.omitted.length ? `, ${r.result.omitted.length} omitted` : ""})\n`,
  );
  return 0;
}

async function cmdWorker(
  cfg: BridgeConfig,
  verifiedOnly: boolean,
  v: { queue?: string | undefined; once: boolean; drain: boolean; pollMs?: string | undefined },
): Promise<number> {
  if (!v.queue) {
    process.stderr.write("worker requires --queue <dir>" + "\n");
    return EXIT_CODES.invalidInput;
  }
  const pollMs = Number(v.pollMs ?? "5000");
  if (!Number.isFinite(pollMs) || pollMs < 500) {
    process.stderr.write("--poll-ms must be >= 500" + "\n");
    return EXIT_CODES.invalidInput;
  }
  let stop = false;
  const onSignal = () => {
    stop = true;
    process.stdout.write("worker: stop requested; finishing the current item" + "\n");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const r = await runWorker(
    {
      queueDir: resolve(v.queue),
      once: v.once,
      drain: v.drain,
      pollMs,
      maxBusyRetries: 3,
    },
    (requestPath) => cmdRun(cfg, requestPath, verifiedOnly, true),
    (m) => process.stderr.write(`${m}\n`),
    (ms) => new Promise((res) => setTimeout(res, ms)),
    () => stop,
  );
  process.stdout.write(`${JSON.stringify({ processed: r.processed, stoppedBy: r.stoppedBy })}\n`);
  if (r.stoppedBy === "blocked") return EXIT_CODES.manualIntervention;
  return r.stoppedBy === "error" ? EXIT_CODES.afterBrowser : 0;
}

async function cmdUsage(cfg: BridgeConfig, json: boolean, queue?: string): Promise<number> {
  const records = await loadRecords(join(cfg.runtimeDir, "requests"));
  if (queue) {
    // queue items end up in done / failed / blocked (A-094); count them too
    for (const d of ["done", "failed", "blocked"]) {
      records.push(...(await loadRecords(join(resolve(queue), d))));
    }
  }
  const limits = await loadLimits(join(cfg.runtimeDir, "limits.json"), (reason) =>
    process.stderr.write(`limits.json is invalid (${reason}); using built-in defaults\n`),
  );
  const report = computeUsage(records, limits, new Date());
  process.stdout.write(
    json
      ? `${JSON.stringify(report, null, 2)}
`
      : `${formatUsage(report)}
`,
  );
  return 0;
}

async function cmdDaemon(cfg: BridgeConfig, action: string | undefined): Promise<number> {
  const daemonCfg = {
    runtimeDir: cfg.runtimeDir,
    profileDir: cfg.profileDir,
    channel: cfg.channel,
    experimentalStealth: cfg.experimentalStealth,
    stealthExtensionDir: join(cfg.repoRoot, "experimental", "stealth-extension"),
  };
  // C-3 (Codex High): daemon start/stop must not bypass the same profile-path safety border and
  // bridge-lock exclusion every other command goes through.
  if (action === "start" || action === "stop") {
    const guard = await checkProfilePath(cfg.profileDir);
    if (!guard.ok) {
      process.stderr.write(`INVALID_CONFIG: ${guard.cause}\n`);
      return EXIT_CODES.invalidInput;
    }
    const logger = createLogger(cfg.logLevel);
    const ports = buildPorts(cfg, logger, true);
    const lock = await ports.lock.acquire(`daemon-${action}`, null);
    if (lock.kind === "busy") {
      logger.stderr(`ALREADY_RUNNING: ${lock.cause}`);
      return EXIT_CODES.beforeBrowser;
    }
    try {
      if (action === "start") {
        const r = await startDaemon(daemonCfg, cfg.maxConcurrency);
        if (!r.ok) {
          process.stderr.write(`DAEMON_START_FAILED: ${r.cause}\n`);
          return 1;
        }
        process.stdout.write(
          `${r.alreadyRunning ? "既に起動しています" : "起動しました"}: pid=${r.state.pid} port=${r.state.port}\n`,
        );
        return 0;
      }
      const r = await stopDaemon(daemonCfg);
      process.stdout.write(`${r.detail}\n`);
      return r.ok ? 0 : 1;
    } finally {
      await ports.lock.release();
    }
  }
  switch (action) {
    case "status": {
      const h = await checkDaemon(daemonCfg);
      if (h.alive) {
        process.stdout.write(
          `running: pid=${h.state.pid} port=${h.state.port} since=${h.state.startedAt}\n`,
        );
        return 0;
      }
      process.stdout.write(`not running: ${h.reason}\n`);
      return 1;
    }
    default:
      process.stderr.write("daemon requires a subcommand: start | stop | status\n");
      return EXIT_CODES.invalidInput;
  }
}

async function cmdInspectUi(
  cfg: BridgeConfig,
  dumpDom: boolean,
  walkEffort: boolean,
  verifiedOnly: boolean,
): Promise<number> {
  const r = await withBrowser(cfg, "inspect-ui", verifiedOnly, async (ports, crash) => {
    const page = new ChatGptPage(ports.session.currentPage, { verifiedOnly });
    const auth = await observeAuthWithRetry(page, crash);
    // Codex review of 80f816d, Medium #4: don't keep operating the page after a crash.
    if (crash.cause) {
      process.stdout.write(`browser crashed: ${crash.cause}\n`);
      return 1;
    }
    process.stdout.write(`auth: ${auth.kind}\n`);
    const dir = join(cfg.artifactsDir, "inspect-ui");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportDir = join(dir, stamp);
    const report = await page.inspectUiReport(reportDir, { walkEffort });
    process.stdout.write(`report: ${report}\n`);
    if (dumpDom) {
      const html = await ports.session.currentPage.content();
      const raw = join(reportDir, "dom.raw.html");
      await writeFile(raw, html, "utf8");
      process.stdout.write(`raw dom (do not share): ${raw}\n`);
    }
    return 0;
  });
  return typeof r === "number" ? r : 1;
}

/** A-140 follow-up: diagnostic-only comparison point. It sends no prompt or page interaction. */
async function cmdStealthSignals(cfg: BridgeConfig): Promise<number> {
  const r = await withBrowser(cfg, "stealth-signals", true, async (ports, crash) => {
    const page = ports.session.currentPage;
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (crash.cause) {
      process.stderr.write(`browser crashed: ${crash.cause}\n`);
      return 1;
    }
    const webdriver = await page.evaluate(() => String(navigator.webdriver));
    process.stdout.write(`experimentalStealth=${cfg.experimentalStealth}\n`);
    process.stdout.write(`navigator.webdriver=${webdriver}\n`);
    return 0;
  });
  return typeof r === "number" ? r : r;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      request: { type: "string" },
      "profile-dir": { type: "string" },
      "log-level": { type: "string" },
      "dump-dom": { type: "boolean", default: false },
      "walk-effort": { type: "boolean", default: false },
      stale: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      queue: { type: "string" },
      once: { type: "boolean", default: false },
      drain: { type: "boolean", default: false },
      "poll-ms": { type: "string" },
      root: { type: "string" },
      out: { type: "string" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      "max-bytes": { type: "string" },
      diff: { type: "string" },
      "allow-unverified": { type: "boolean", default: false },
      "timeout-ms": { type: "string" },
      "conversation-url": { type: "string" },
      since: { type: "string" },
      "prompt-file": { type: "string" },
      "baseline-assistant-count": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command ? 0 : EXIT_CODES.invalidInput;
  }
  const cfg = loadConfig(process.env, {
    profileDir: values["profile-dir"],
    logLevel: values["log-level"],
  });
  const verifiedOnly = !values["allow-unverified"];
  switch (command) {
    case "login":
      return cmdLogin(cfg, verifiedOnly);
    case "doctor":
      return cmdDoctor(cfg, verifiedOnly, values.json ?? false);
    case "unlock":
      return cmdUnlock(cfg, values.stale ?? false, values.json ?? false);
    case "run":
      if (!values.request) {
        printCommandError(values.json ?? false, "INVALID_REQUEST", "run requires --request <path>");
        return EXIT_CODES.invalidInput;
      }
      return cmdRun(cfg, values.request, verifiedOnly, values.json ?? false);
    case "submit":
      if (!values.request) {
        printCommandError(
          values.json ?? false,
          "INVALID_REQUEST",
          "submit requires --request <path>",
        );
        return EXIT_CODES.invalidInput;
      }
      return cmdSubmit(cfg, values.request, values.json ?? false);
    case "status":
      if (!positionals[1]) {
        printCommandError(values.json ?? false, "INVALID_REQUEST", "status requires <requestId>");
        return EXIT_CODES.invalidInput;
      }
      return cmdStatus(cfg, positionals[1], values.json ?? false);
    case "wait": {
      if (!positionals[1]) {
        printCommandError(values.json ?? false, "INVALID_REQUEST", "wait requires <requestId>");
        return EXIT_CODES.invalidInput;
      }
      // A-132 Opus review, Medium #7: Number(undefined-ish garbage) silently produces NaN, and
      // `Date.now() >= NaN` is always false — an unvalidated --timeout-ms made `wait` poll forever
      // instead of ever taking its timeout exit, exactly the "CLI blocked forever" failure this
      // phase exists to eliminate.
      const timeoutMs = Number(values["timeout-ms"] ?? 900_000);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        printCommandError(
          values.json ?? false,
          "INVALID_REQUEST",
          `--timeout-ms must be a non-negative number, got "${values["timeout-ms"]}"`,
        );
        return EXIT_CODES.invalidInput;
      }
      return cmdWait(cfg, positionals[1], timeoutMs, values.json ?? false);
    }
    case "collect":
      return cmdCollect(cfg, positionals[1], {
        conversationUrl: values["conversation-url"],
        since: values.since,
        promptFile: values["prompt-file"],
        baselineAssistantCount: values["baseline-assistant-count"],
        out: values.out,
        json: values.json ?? false,
      });
    case "result":
      if (!positionals[1]) {
        printCommandError(values.json ?? false, "INVALID_REQUEST", "result requires <requestId>");
        return EXIT_CODES.invalidInput;
      }
      return cmdResult(cfg, positionals[1], values.out, values.json ?? false);
    case "bundle":
      return cmdBundle({
        root: values.root,
        out: values.out,
        include: values.include,
        exclude: values.exclude,
        maxBytes: values["max-bytes"],
        diff: values.diff,
      });
    case "worker":
      return cmdWorker(cfg, verifiedOnly, {
        queue: values.queue,
        once: values.once ?? false,
        drain: values.drain ?? false,
        pollMs: values["poll-ms"],
      });
    case "usage":
      return cmdUsage(cfg, values.json ?? false, values.queue);
    case "daemon":
      return cmdDaemon(cfg, positionals[1]);
    case "inspect-ui":
      return cmdInspectUi(
        cfg,
        values["dump-dom"] ?? false,
        values["walk-effort"] ?? false,
        verifiedOnly,
      );
    case "stealth-signals":
      return cmdStealthSignals(cfg);
    default:
      process.stderr.write(`unknown command: ${command}\n${USAGE}`);
      return EXIT_CODES.invalidInput;
  }
}

function invokedDirectlyCheck(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  // npm link / global installs go through a symlink; ESM resolves import.meta.url to the real path.
  let real = argv1;
  try {
    real = realpathSync(argv1);
  } catch {
    /* keep argv1 */
  }
  return import.meta.url === pathToFileURL(real).href;
}
const invokedDirectly = invokedDirectlyCheck();
if (invokedDirectly || process.env.CHATGPT_BRIDGE_MAIN === "1") {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`INTERNAL_ERROR: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
