#!/usr/bin/env node
/**
 * Standalone entry for `chatgpt-bridge daemon start`. Launches one persistent-context Chrome
 * against the shared profile, exposes it over a local CDP port, writes runtime/daemon.json once
 * ready, then stays alive until stopped. Spawned detached so it survives its parent CLI exiting.
 */
import { rename, unlink, writeFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { ProcessLock } from "../state/lock.js";
import { type AcquiredBarrier, acquireAllSlots, releaseAllSlots } from "../state/slot-lock.js";
import { type ExperimentalStealthMode, STEALTH_SIGNAL_PATCH } from "./stealth-signals.js";
import { withTimeout } from "./timeout.js";

const { values } = parseArgs({
  options: {
    "profile-dir": { type: "string" },
    channel: { type: "string" },
    port: { type: "string" },
    "state-path": { type: "string" },
    "lock-path": { type: "string" },
    "keepalive-ms": { type: "string" },
    hostname: { type: "string" },
    "profile-id": { type: "string" },
    "max-concurrency": { type: "string" },
    "experimental-stealth": { type: "string" },
    "stealth-extension-dir": { type: "string" },
  },
});
if (!values["profile-dir"] || !values["state-path"] || !values["profile-id"]) {
  process.stderr.write(
    "daemon-worker: --profile-dir, --state-path and --profile-id are required\n",
  );
  process.exit(1);
}
const profileDir: string = values["profile-dir"];
const statePath: string = values["state-path"];
const profileId: string = values["profile-id"];
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
// A-136 (Phase 3 MVP, Opus review High#1): the generation-slot pool size this daemon's keepalive
// barrier-locks against for its whole lifetime — see DaemonState.maxConcurrency's doc comment.
const maxConcurrencyRaw = Number(values["max-concurrency"] ?? "1");
const maxConcurrency =
  Number.isInteger(maxConcurrencyRaw) && maxConcurrencyRaw >= 1 ? maxConcurrencyRaw : 1;
const experimentalStealth: ExperimentalStealthMode =
  values["experimental-stealth"] === "initscript" || values["experimental-stealth"] === "extension"
    ? values["experimental-stealth"]
    : "off";
const stealthExtensionDir = values["stealth-extension-dir"];
if (experimentalStealth === "extension" && channel === "chrome") {
  process.stderr.write(
    "daemon-worker: extension mode is unavailable with channel=chrome; current Chrome ignores unpacked-extension launch flags\n",
  );
  process.exit(1);
}

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
    ...(experimentalStealth === "extension" && stealthExtensionDir
      ? [
          `--disable-extensions-except=${stealthExtensionDir}`,
          `--load-extension=${stealthExtensionDir}`,
        ]
      : []),
  ],
});
// Registered before the first page is used, once for this daemon-owned context. Attached clients
// deliberately do not register it again (see BrowserSession.attach()).
if (experimentalStealth === "initscript") await context.addInitScript(STEALTH_SIGNAL_PATCH);
let page = context.pages()[0] ?? (await context.newPage());

let shuttingDown = false;
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
/**
 * Codex review of A-110, High: unlinking the state file *before* confirming the context is
 * actually closed meant a hung/failed close() could leave the real Chrome still holding the
 * profile lock while every other command already believed the daemon (and the profile) was free
 * — the two would then race a fresh launch against the still-live one. Close first (bounded, same
 * pattern as BrowserSession.close()), and only unlink after that attempt — success or timeout —
 * has actually run.
 */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  await withTimeout(context.close(), 10_000, "context.close()").catch(() => undefined);
  await unlink(statePath).catch(() => undefined);
  process.exit(0);
}

/** A-120 (Phase 0-B-4, ChatGPT Pro redesign review, reproduced by inspection & confirmed by the
 * codebase's own prior comment admitting the gap): keepalive used to only check whether the lock
 * *file existed* (`access()`), never actually acquire it — a client could acquire the real lock
 * in the window between that check and keepalive touching the page. Now keepalive is a genuine
 * participant in the same lock protocol every other command uses, closing the TOCTOU entirely
 * instead of narrowing it with a second re-check.
 *
 * A-136 (Phase 3 MVP, Opus review High#1): when maxConcurrency > 1, `cli/adapters.ts`'s pooled
 * `run` never touches this single `bridge.lock` file at all — it uses `bridge.lock.slot0..N-1`
 * instead. Acquiring only the plain lock here would mean keepalive stops being excluded from any
 * pooled generation, exactly the TOCTOU A-120 closed reopening for the new pool. Barrier-locking
 * every slot (same primitive `cli/adapters.ts fileLock()` uses for login/doctor) restores it: this
 * tick can't run while any pooled `run` is in flight, matching pre-Phase-3 behavior at N=1. */
interface KeepaliveLock {
  acquire(command: string, requestId: string | null): Promise<{ kind: "ok" } | { kind: "busy" }>;
  release(): Promise<void>;
}
function buildKeepaliveLock(path: string, concurrency: number): KeepaliveLock {
  if (concurrency <= 1) {
    const lock = new ProcessLock(path);
    return {
      acquire: async (command, requestId) => {
        const r = await lock.acquire(command, requestId);
        return { kind: r.kind };
      },
      release: () => lock.release(),
    };
  }
  let barrier: AcquiredBarrier | null = null;
  return {
    acquire: async (command, requestId) => {
      const r = await acquireAllSlots(path, concurrency, command, requestId);
      if (r.kind !== "ok") return { kind: "busy" };
      barrier = r.barrier;
      return { kind: "ok" };
    },
    release: async () => {
      const b = barrier;
      barrier = null;
      if (b) await releaseAllSlots(b);
    },
  };
}
const keepaliveLock = lockPath ? buildKeepaliveLock(lockPath, maxConcurrency) : null;

/**
 * A-110: a Mac session reported the daemon's single tracked `page` going unusable (closed /
 * detached — observed with macOS reclaiming a backgrounded tab under memory pressure) while the
 * *context* stayed open, so `context.on("close")` below never fired and the daemon sat reporting
 * "running" for 13 hours while every keepalive tick and every command's attach() failed against
 * the dead page. `run`/`doctor` surfaced this as confusing errors (INVALID_STATE / NOT_READY)
 * instead of the clean PROFILE_IN_USE-then-fresh-launch path a genuinely absent daemon gets.
 */
let consecutiveFailures = 0;
/** After this many consecutive ticks where even opening a replacement page failed, give up on the
 * browser entirely and self-shutdown — doctor/run then correctly see "no daemon" and fall back to
 * a fresh launch, instead of a daemon that looks alive but can never serve a page again. Kept low
 * (worst case ~2 keepalive intervals) since a repeated newPage() failure is already a strong
 * signal the underlying context is dead, not a transient blip. */
const MAX_CONSECUTIVE_FAILURES = 2;

function log(msg: string): void {
  process.stdout.write(`[keepalive ${new Date().toISOString()}] ${msg}\n`);
}

/** Codex review of A-110, Medium: setInterval doesn't wait for a slow tick before starting the
 * next one; without this guard, two overlapping ticks could fight over replacing `page` and
 * `consecutiveFailures`, or one could close a page the other just opened. */
let tickInFlight = false;

/** A-105: periodic real navigation as an activity signal. A-120 (Phase 0-B-4): the lock is held
 * for the entire duration of this tick's page-touching work via keepaliveLock.acquire()/release()
 * above, not just checked once — a genuine mutual-exclusion participant, not a presence check
 * with a re-check bolted on. */
async function keepAliveTick(): Promise<void> {
  if (shuttingDown || tickInFlight) return;
  tickInFlight = true;
  let acquired = false;
  try {
    if (!keepaliveLock) {
      log("skipped: no lock-path configured");
      return;
    }
    const outcome = await keepaliveLock.acquire("daemon-keepalive", null);
    if (outcome.kind !== "ok") {
      log("skipped: lock held");
      return;
    }
    acquired = true;
    // A-136 (Phase 3 MVP): used to fall back to "any non-closed page in context.pages()" here, but
    // now that more than one `run` can hold a dedicated Page concurrently (state/slot-lock.ts), any
    // of those pages may belong to a generation actively in flight — navigating (or worse, later
    // closing) one out from under it would corrupt that job. Always open a fresh page of our own
    // instead; the old A-110 rationale (avoid piling up a stray blank tab) no longer applies once
    // concurrent jobs routinely open and close their own dedicated tabs anyway.
    if (page.isClosed()) {
      try {
        page = await context.newPage();
      } catch (err) {
        log(`could not open a replacement page: ${(err as Error).message}`);
        return; // try again next tick rather than letting this throw out of keepAliveTick()
      }
    }
    try {
      await withTimeout(
        page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30000 }),
        35_000,
        "keepalive goto",
      );
      log(`reloaded, url=${page.url()}`);
      consecutiveFailures = 0;
      return;
    } catch (err) {
      consecutiveFailures++;
      log(`failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${(err as Error).message}`);
    }
    // A-120: no second lock-held re-check needed here — we've held the real lock since before
    // touching `page` above, so no client could have acquired it in between.
    // A-110: the page itself (not necessarily the context) may be the thing that died. Try opening
    // a replacement page on the same context before giving up on the whole daemon. Codex review,
    // High: newPage() succeeding doesn't by itself prove the new page is usable — verify it too
    // (bounded) before trusting it and resetting the failure count.
    try {
      const fresh = await context.newPage();
      await withTimeout(
        fresh.evaluate(() => true),
        5000,
        "replacement page liveness check",
      );
      await page.close().catch(() => undefined);
      page = fresh;
      log("opened a replacement page");
      consecutiveFailures = 0;
      return;
    } catch (err) {
      log(
        `could not open a usable replacement page (context likely dead too): ${(err as Error).message}`,
      );
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log(
        `giving up after ${consecutiveFailures} consecutive failures; shutting down so doctor/run see "no daemon" instead of a stuck one`,
      );
      await shutdown();
    }
  } finally {
    if (acquired) await keepaliveLock?.release();
    tickInFlight = false;
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
    profileId,
    maxConcurrency,
    // Preserve the pre-experiment daemon.json shape for the default path. Readers treat a missing
    // field as off; only an explicitly selected experiment is persisted for attach-time matching.
    ...(experimentalStealth === "off" ? {} : { experimentalStealth }),
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
