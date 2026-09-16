#!/usr/bin/env node
/**
 * Standalone entry for `chatgpt-bridge daemon start`. Launches one persistent-context Chrome
 * against the shared profile, exposes it over a local CDP port, writes runtime/daemon.json once
 * ready, then stays alive until stopped. Spawned detached so it survives its parent CLI exiting.
 */
import { rename, unlink, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values } = parseArgs({
  options: {
    "profile-dir": { type: "string" },
    channel: { type: "string" },
    port: { type: "string" },
    "state-path": { type: "string" },
  },
});
if (!values["profile-dir"] || !values["state-path"]) {
  process.stderr.write("daemon-worker: --profile-dir and --state-path are required\n");
  process.exit(1);
}
const profileDir: string = values["profile-dir"];
const statePath: string = values["state-path"];
const channel = values.channel === "chromium" ? "chromium" : "chrome";
const port = Number(values.port ?? "9876");

const context = await chromium.launchPersistentContext(profileDir, {
  ...(channel === "chrome" ? { channel: "chrome" as const } : {}),
  headless: false,
  viewport: null,
  acceptDownloads: true,
  args: [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--start-minimized",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});
if (context.pages().length === 0) await context.newPage();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await unlink(statePath).catch(() => undefined);
  await context.close().catch(() => undefined);
  process.exit(0);
}

// C-4 (Codex Medium): atomic write (tmp + rename) so a reader never observes a partial file.
const tmpStatePath = `${statePath}.tmp-${process.pid}`;
await writeFile(
  tmpStatePath,
  JSON.stringify({
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    profileDir,
  }),
  "utf8",
);
await rename(tmpStatePath, statePath);
process.stdout.write(`daemon ready: pid=${process.pid} port=${port}\n`);

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
context.on("close", () => void shutdown());

// Keep the process alive until a shutdown signal arrives or the browser context closes.
await new Promise(() => undefined);
