import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../contracts/schema.js";
import { startUiServer } from "../ui/server.js";

export const UI_HELP = `chatgpt-bridge ui [--profile production|demo] [--port 0..65535] [--deployment /trusted/deployment.mjs]

Starts the local Bridge product UI on 127.0.0.1 only. Open the printed URL in your browser.
production (default): local ledger, validation and configured capabilities only.
demo: isolated runtime/ui-demo ledger, explicitly synthetic lifecycle, no model/process execution.
CHATGPT_BRIDGE_RUNTIME_DIR selects the host-local runtime root (default: runtime/).
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
    });
    try {
      stdout(`Bridge v2 UI · ${values.profile}\n${instance.url}\n`);
      stdout("このURLは本人用です。Ctrl+CでUIサーバーを終了します。\n");
      await (dependencies.waitForStop ?? waitForUiStop)();
    } finally {
      await instance.close();
    }
    return 0;
  } catch (error) {
    const configured =
      argv.includes("--deployment") || Boolean(env.CHATGPT_BRIDGE_DEPLOYMENT_MODULE);
    const message = error instanceof Error ? error.message : String(error);
    const safe =
      configured && !/^deployment_[a-z0-9_]{1,80}$/.test(message)
        ? "configured_deployment_start_failed"
        : message;
    stderr(`UI_START_FAILED: ${safe}\n`);
    return 2;
  }
}
