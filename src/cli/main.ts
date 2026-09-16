#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkDaemon, startDaemon, stopDaemon } from "../browser/daemon.js";
import { checkProfilePath } from "../browser/profile-guard.js";
import { buildBundle } from "../bundle/bundle.js";
import { ChatGptPage } from "../chatgpt/page.js";
import { EXIT_CODES } from "../contracts/types.js";
import { formatDoctor, runDoctor } from "../diagnostics/doctor.js";
import { createLogger } from "../diagnostics/logger.js";
import { computeUsage, formatUsage, loadLimits, loadRecords } from "../diagnostics/usage.js";
import { RunController } from "../state/controller.js";
import { buildPorts } from "./adapters.js";
import { type BridgeConfig, loadConfig } from "./config.js";
import { runWorker } from "./worker.js";

const USAGE = `chatgpt-bridge <command> [options]

commands:
  login                      専用ブラウザを開き、人間がログインする
  doctor                     環境・プロファイル・ロック・ログイン状態を診断する
  run --request <path> [--json]
                             request.json を 1 件処理する。--json は result.json の内容を標準出力に 1 行で出す
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

options:
  --profile-dir <path>       専用プロファイル（CHATGPT_BRIDGE_PROFILE_DIR より優先）
  --log-level <level>        debug | info | warn | error
  --allow-unverified         verifiedOn の無い selector 候補も使う（Phase 4 の実画面確認専用）
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
export async function observeAuthWithRetry(
  page: Pick<ChatGptPage, "navigateAndObserveAuth">,
  crash: CrashState,
  attempts = 3,
): Promise<Awaited<ReturnType<ChatGptPage["navigateAndObserveAuth"]>>> {
  let last: Awaited<ReturnType<ChatGptPage["navigateAndObserveAuth"]>> = {
    kind: "NOT_READY",
    cause: "not attempted",
  };
  for (let i = 0; i < attempts; i++) {
    // Codex review of 80f816d, High #1: a crash must stop retries against the dead page immediately.
    if (crash.cause) return last;
    last = await page.navigateAndObserveAuth().catch(
      (err): Awaited<ReturnType<ChatGptPage["navigateAndObserveAuth"]>> => ({
        kind: "NOT_READY",
        cause: `threw: ${(err as Error).message}`,
      }),
    );
    if (crash.cause) return last;
    if (last.kind !== "NOT_READY") return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return last;
}

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

async function cmdDoctor(cfg: BridgeConfig, verifiedOnly: boolean): Promise<number> {
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
  process.stdout.write(`${text}\n`);
  logger.log("debug", `doctor: ${ok ? "all ok" : "has NG"}`);
  return ok ? 0 : 1;
}

async function cmdRun(
  cfg: BridgeConfig,
  requestPath: string,
  verifiedOnly: boolean,
  json: boolean,
): Promise<number> {
  const logger = createLogger(cfg.logLevel);
  const ports = buildPorts(cfg, logger, verifiedOnly);
  const controller = new RunController(ports, {
    requestPath: resolve(requestPath),
    artifactsRoot: cfg.artifactsDir,
    bridgeVersion: cfg.bridgeVersion,
    traceOnSuccess: cfg.traceOnSuccess,
  });
  if (!json) process.stdout.write(`run: ${resolve(requestPath)}\n`);
  const outcome = await controller.run();
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
        const r = await startDaemon(daemonCfg);
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
      return cmdDoctor(cfg, verifiedOnly);
    case "run":
      if (!values.request) {
        process.stderr.write("run requires --request <path>\n");
        return EXIT_CODES.invalidInput;
      }
      return cmdRun(cfg, values.request, verifiedOnly, values.json ?? false);
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
