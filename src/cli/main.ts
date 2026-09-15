#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { ChatGptPage } from "../chatgpt/page.js";
import { EXIT_CODES } from "../contracts/types.js";
import { formatDoctor, runDoctor } from "../diagnostics/doctor.js";
import { createLogger } from "../diagnostics/logger.js";
import { RunController } from "../state/controller.js";
import { buildPorts } from "./adapters.js";
import { type BridgeConfig, loadConfig } from "./config.js";

const USAGE = `chatgpt-bridge <command> [options]

commands:
  login                      専用ブラウザを開き、人間がログインする
  doctor                     環境・プロファイル・ロック・ログイン状態を診断する
  run --request <path>       request.json を 1 件処理する
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

async function withBrowser<T>(
  cfg: BridgeConfig,
  command: string,
  verifiedOnly: boolean,
  fn: (ports: ReturnType<typeof buildPorts>) => Promise<T>,
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
    const launched = await ports.browser.launch({
      copyCaptureShim: false,
      onCrash: (c) => logger.log("warn", `browser: ${c}`),
    });
    if (!launched.ok) {
      logger.stderr(`BROWSER_LAUNCH_FAILED: ${launched.cause}`);
      return EXIT_CODES.beforeBrowser;
    }
    try {
      return await fn(ports);
    } finally {
      await ports.browser.close().catch(() => undefined);
    }
  } finally {
    await ports.lock.release();
  }
}

async function cmdLogin(cfg: BridgeConfig, verifiedOnly: boolean): Promise<number> {
  const r = await withBrowser(cfg, "login", verifiedOnly, async (ports) => {
    const page = new ChatGptPage(ports.session.currentPage, { verifiedOnly });
    const auth = await page.navigateAndObserveAuth();
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
    const poll = (async () => {
      while (!done) {
        await new Promise((r) => setTimeout(r, 2000));
        const a = await page.observeAuth(await page.currentUrl()).catch(() => null);
        if (a?.kind === "AUTH_OK") return true;
      }
      return false;
    })();
    const enter = waitForEnter("").then(() => false);
    const loggedIn = await Promise.race([poll, enter]);
    done = true;
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
      const r = await withBrowser(cfg, "doctor", verifiedOnly, async (ports) => {
        const page = new ChatGptPage(ports.session.currentPage, { verifiedOnly });
        const a = await page.navigateAndObserveAuth();
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
): Promise<number> {
  const logger = createLogger(cfg.logLevel);
  const ports = buildPorts(cfg, logger, verifiedOnly);
  const controller = new RunController(ports, {
    requestPath: resolve(requestPath),
    artifactsRoot: cfg.artifactsDir,
    bridgeVersion: cfg.bridgeVersion,
    traceOnSuccess: cfg.traceOnSuccess,
  });
  process.stdout.write(`run: ${resolve(requestPath)}\n`);
  const outcome = await controller.run();
  const res = outcome.result;
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

async function cmdInspectUi(
  cfg: BridgeConfig,
  dumpDom: boolean,
  walkEffort: boolean,
  verifiedOnly: boolean,
): Promise<number> {
  const r = await withBrowser(cfg, "inspect-ui", verifiedOnly, async (ports) => {
    const page = new ChatGptPage(ports.session.currentPage, { verifiedOnly });
    const auth = await page.navigateAndObserveAuth();
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
      return cmdRun(cfg, values.request, verifiedOnly);
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

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (invokedDirectly || process.env.CHATGPT_BRIDGE_MAIN === "1") {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`INTERNAL_ERROR: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
