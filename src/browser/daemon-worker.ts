#!/usr/bin/env node
/**
 * Standalone entry for `chatgpt-bridge daemon start`. Launches one persistent-context Chrome
 * against the shared profile, exposes it over a local CDP port, writes runtime/daemon.json once
 * ready, then stays alive until stopped. Spawned detached so it survives its parent CLI exiting.
 */
import { access, rename, unlink, writeFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values } = parseArgs({
  options: {
    "profile-dir": { type: "string" },
    channel: { type: "string" },
    port: { type: "string" },
    "state-path": { type: "string" },
    "lock-path": { type: "string" },
    "keepalive-ms": { type: "string" },
    hostname: { type: "string" },
  },
});
if (!values["profile-dir"] || !values["state-path"]) {
  process.stderr.write("daemon-worker: --profile-dir and --state-path are required\n");
  process.exit(1);
}
const profileDir: string = values["profile-dir"];
const statePath: string = values["state-path"];
const lockPath = values["lock-path"];
const channel = values.channel === "chromium" ? "chromium" : "chrome";
const port = Number(values.port ?? "9876");
// A-108: caller (daemon.ts) passes its own os.hostname() explicitly rather than this process
// computing it, so the recorded owner is unambiguous even if start and worker ever ran on
// different hosts for some reason.
const hostname = values.hostname ?? osHostname();
// A-105: ChatGPT's own guidance is that an idle session needs interaction roughly every
// 15-30 minutes; default to the low end of that window with margin to spare.
const keepAliveMs = Number(values["keepalive-ms"] ?? 15 * 60 * 1000);

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
    // A-108: keep cookie storage consistent with scripts/manual-login.mjs and browser/launch.ts
    // on macOS (Keychain-encrypted cookies from one invocation aren't readable by another).
    ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
  ],
});
const page = context.pages()[0] ?? (await context.newPage());

let shuttingDown = false;
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  await unlink(statePath).catch(() => undefined);
  await context.close().catch(() => undefined);
  process.exit(0);
}

async function isLockHeld(): Promise<boolean> {
  if (!lockPath) return false;
  try {
    await access(lockPath);
    return true;
  } catch {
    return false;
  }
}

/** A-105: periodic real navigation as an activity signal, skipped whenever a command holds the
 * bridge lock so it can't collide with one in flight (small residual race between the check and
 * the goto below; accepted for a single-user machine, same as the rest of A-103/A-104). */
async function keepAliveTick(): Promise<void> {
  if (shuttingDown) return;
  if (await isLockHeld()) {
    process.stdout.write(`[keepalive ${new Date().toISOString()}] skipped: lock held\n`);
    return;
  }
  try {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    process.stdout.write(`[keepalive ${new Date().toISOString()}] reloaded, url=${page.url()}\n`);
  } catch (err) {
    process.stdout.write(
      `[keepalive ${new Date().toISOString()}] failed: ${(err as Error).message}\n`,
    );
  }
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
    hostname,
  }),
  "utf8",
);
await rename(tmpStatePath, statePath);
process.stdout.write(`daemon ready: pid=${process.pid} port=${port}\n`);

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
context.on("close", () => void shutdown());

keepAliveTimer = setInterval(() => void keepAliveTick(), keepAliveMs);
process.stdout.write(`[keepalive] interval=${keepAliveMs}ms lockPath=${lockPath ?? "(none)"}\n`);

// Keep the process alive until a shutdown signal arrives or the browser context closes.
await new Promise(() => undefined);
