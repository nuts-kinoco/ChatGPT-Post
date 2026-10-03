import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readMetadataConfiguration } from "../adapters/antigravity-metadata-store.js";
import { REPO_ROOT } from "../contracts/schema.js";
import { startUiServer } from "../ui/server.js";

export const UI_HELP = `chatgpt-bridge ui [--profile production|demo] [--port 0..65535] [--deployment /trusted/deployment.mjs] [--antigravity-metadata /trusted/metadata.json]

Starts the local Bridge product UI on 127.0.0.1 only. Open the printed URL in your browser.
production (default): local ledger, validation and configured capabilities only.
demo: isolated runtime/ui-demo ledger, explicitly synthetic lifecycle, no model/process execution.
CHATGPT_BRIDGE_RUNTIME_DIR selects the host-local runtime root (default: runtime/).
--antigravity-metadata explicitly enables isolated metadata discovery only; no inference or account login.
The URL fragment is a per-launch capability. Keep it private; it is not a share link.
Ctrl+C stops this UI server. Closing the page does not delete records or reexecute tasks.
Existing run/submit/status/wait/result browser commands are unchanged.
`;

export interface UiCliDependencies {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  start?: (
    options: Parameters<typeof startUiServer>[0],
  ) => Promise<Pick<Awaited<ReturnType<typeof startUiServer>>, "url" | "close">>;
  waitForStop?: () => Promise<void>;
}

export function waitForUiStop(): Promise<void> {
  return new Promise((done) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      done();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

interface UiSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}
/** Keep explicit stop requests observable during a bounded drain; never retry on a timer. */
export function createUiStopSignalQueue(source: UiSignalSource = process): {
  next(): Promise<void>;
  dispose(): void;
} {
  let pending = false,
    disposed = false;
  let resolve: (() => void) | null = null;
  let waiting: Promise<void> | null = null;
  const stop = () => {
    if (disposed) return;
    if (resolve) {
      const done = resolve;
      resolve = null;
      waiting = null;
      done();
    } else pending = true;
  };
  source.on("SIGINT", stop);
  source.on("SIGTERM", stop);
  // Signal handlers alone need not keep Node alive after HTTP and child handles have closed.
  const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
  return {
    next: () => {
      if (disposed) throw new Error("ui_stop_queue_closed");
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      waiting ??= new Promise<void>((done) => {
        resolve = done;
      });
      return waiting;
    },
    dispose: () => {
      disposed = true;
      source.off("SIGINT", stop);
      source.off("SIGTERM", stop);
      clearInterval(keepAlive);
    },
  };
}

export async function runUiCli(
  argv: string[],
  dependencies: UiCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  const env = dependencies.env ?? process.env;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        profile: { type: "string", default: "production" },
        port: { type: "string", default: "0" },
        deployment: { type: "string" },
        "antigravity-metadata": { type: "string" },
        help: { type: "boolean", default: false },
      },
    });
    if (values.help) {
      stdout(UI_HELP);
      return 0;
    }
    if (positionals.length > 0) throw new Error("ui accepts no positional arguments");
    if (values.profile !== "production" && values.profile !== "demo")
      throw new Error("--profile must be production or demo");
    if (!/^\d{1,5}$/.test(values.port ?? "")) throw new Error("--port must be 0..65535");
    const port = Number(values.port);
    if (port > 65535) throw new Error("--port must be 0..65535");
    const deploymentModule = values.deployment ?? env.CHATGPT_BRIDGE_DEPLOYMENT_MODULE;
    const instance = await (dependencies.start ?? startUiServer)({
      profile: values.profile,
      stateDir: resolve(env.CHATGPT_BRIDGE_RUNTIME_DIR ?? join(REPO_ROOT, "runtime")),
      port,
      ...(deploymentModule ? { deploymentModule } : {}),
      ...(values["antigravity-metadata"]
        ? { antigravityMetadata: await readMetadataConfiguration(values["antigravity-metadata"]) }
        : {}),
    });
    const signals = dependencies.waitForStop ? null : createUiStopSignalQueue();
    const waitForStop =
      dependencies.waitForStop ??
      (() => {
        if (!signals) throw new Error("ui_stop_queue_missing");
        return signals.next();
      });
    try {
      try {
        stdout(`Bridge v2 UI · ${values.profile}\n${instance.url}\n`);
        stdout("このURLは本人用です。Ctrl+CでUIサーバーを終了します。\n");
        await waitForStop();
      } finally {
        for (;;) {
          try {
            await instance.close();
            break;
          } catch {
            stderr(
              "UI_SHUTDOWN_PENDING: 終了確認を待っています。同じホストを保持しています。Ctrl+Cで終了確認を再試行します。自動では再試行しません。\n",
            );
            await waitForStop();
          }
        }
      }
    } finally {
      signals?.dispose();
    }
    return 0;
  } catch (error) {
    const configured =
      argv.some(
        (value) => value === "--deployment" || value.startsWith("--antigravity-metadata"),
      ) || Boolean(env.CHATGPT_BRIDGE_DEPLOYMENT_MODULE);
    const message = error instanceof Error ? error.message : String(error);
    const safe =
      configured && !/^deployment_[a-z0-9_]{1,80}$/.test(message)
        ? "configured_deployment_start_failed"
        : message;
    stderr(`UI_START_FAILED: ${safe}\n`);
    return 2;
  }
}
