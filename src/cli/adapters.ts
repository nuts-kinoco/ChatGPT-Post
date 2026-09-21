import { access } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { checkDaemon } from "../browser/daemon.js";
import { BrowserSession } from "../browser/launch.js";
import { checkProfileFree, checkProfilePath } from "../browser/profile-guard.js";
import { ChatGptPage } from "../chatgpt/page.js";
import { atomicWriteFile, normaliseResponseBody } from "../contracts/atomic-write.js";
import { checkResultInvariants } from "../contracts/invariants.js";
import { readRequestFile, validateAndLoad } from "../contracts/request.js";
import type { BridgeResult } from "../contracts/types.js";
import type { Logger } from "../diagnostics/logger.js";
import { ProcessLock } from "../state/lock.js";
import {
  deleteMarker,
  markerExists,
  markerPath,
  updateMarker,
  writeMarker,
} from "../state/marker.js";
import type {
  BrowserPort,
  ChatGptPort,
  Clock,
  ContractsPort,
  LockPort,
  Ports,
} from "../state/ports.js";
import {
  type AcquiredBarrier,
  acquireAllSlots,
  acquireSlot,
  releaseAllSlots,
  verifyAllSlots,
} from "../state/slot-lock.js";
import type { BridgeConfig } from "./config.js";

export const systemClock: Clock = {
  now: () => new Date(),
  monotonic: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function fileContracts(): ContractsPort {
  return {
    readRequest: (p) => readRequestFile(p),
    priorState: async (dir) => {
      if (await fileExists(join(dir, "result.json"))) return "result";
      if (await fileExists(join(dir, "response.md"))) return "stale_response";
      return "none";
    },
    validate: async (raw, dir) => {
      const v = await validateAndLoad(raw, dir);
      return v.kind === "invalid"
        ? v
        : {
            kind: "valid",
            request: v.request,
            prompt: v.prompt,
            timeoutMs: v.timeoutMs,
            attachments: v.attachments,
            attachmentBytes: v.attachmentBytes,
          };
    },
    writeResponse: async (dir, md) => {
      const p = join(dir, "response.md");
      await atomicWriteFile(p, normaliseResponseBody(md));
      return p;
    },
    writeResult: async (dir, result: BridgeResult) => {
      const problems = checkResultInvariants(result);
      if (problems.length > 0)
        throw new Error(`result.json violates contract: ${problems.join("; ")}`);
      const p = join(dir, "result.json");
      await atomicWriteFile(p, `${JSON.stringify(result, null, 2)}\n`);
      return p;
    },
  };
}

/**
 * `login`/`doctor`/`inspect-ui`, and the default (maxConcurrency=1) `run` path.
 *
 * Opus review of A-136, High#1: when `cfg.maxConcurrency > 1`, pooled `run`s never touch this
 * plain `bridge.lock` file at all (they use `poolLock` below) — so if this kept acquiring just that
 * one file, it would no longer exclude anything a pooled generation is doing, silently dropping the
 * "single driver of the browser at a time" guarantee A-120 built the daemon keepalive's own
 * participation in this exact lock around. Acquiring *every* generation slot as a barrier
 * (`acquireAllSlots`) restores that guarantee: nothing here can proceed while any pooled slot is
 * held, and no pooled slot can be acquired while this holds the barrier. maxConcurrency=1 (default)
 * is untouched — a pool of size 1 degenerates to `acquireAllSlots(base, 1, ...)`, but to keep the
 * default path byte-for-byte identical to pre-Phase-3 (`bridge.lock`, no `.slot0` suffix), the
 * n<=1 case still goes through the original plain single-file `ProcessLock`.
 */
export function fileLock(cfg: BridgeConfig): LockPort & { raw: ProcessLock | null } {
  if (cfg.maxConcurrency > 1) {
    const basePath = join(cfg.locksDir, "bridge.lock");
    let barrier: AcquiredBarrier | null = null;
    return {
      raw: null,
      acquire: async (command, requestId) => {
        const res = await acquireAllSlots(basePath, cfg.maxConcurrency, command, requestId);
        if (res.kind === "busy") return { kind: "busy", cause: res.cause };
        barrier = res.barrier;
        return { kind: "ok" };
      },
      verify: () => (barrier ? verifyAllSlots(barrier) : Promise.resolve(false)),
      release: async () => {
        const b = barrier;
        barrier = null;
        if (b) await releaseAllSlots(b);
      },
      markerExists: (id) => markerExists(markerPath(cfg.stateDir, id)),
      writeMarker: (id, m) => writeMarker(markerPath(cfg.stateDir, id), m),
      updateMarker: (id, patch) => updateMarker(markerPath(cfg.stateDir, id), patch),
      deleteMarker: (id) => deleteMarker(markerPath(cfg.stateDir, id)),
    };
  }
  const lock = new ProcessLock(join(cfg.locksDir, "bridge.lock"));
  return {
    raw: lock,
    acquire: async (command, requestId) => {
      const a = await lock.acquire(command, requestId);
      return a.kind === "ok" ? { kind: "ok" } : { kind: "busy", cause: a.cause };
    },
    verify: () => lock.verify(),
    release: () => lock.release(),
    markerExists: (id) => markerExists(markerPath(cfg.stateDir, id)),
    writeMarker: (id, m) => writeMarker(markerPath(cfg.stateDir, id), m),
    updateMarker: (id, patch) => updateMarker(markerPath(cfg.stateDir, id), patch),
    deleteMarker: (id) => deleteMarker(markerPath(cfg.stateDir, id)),
  };
}

/**
 * Phase 3 MVP (A-136): a generation-slot pool built on N independent `ProcessLock`s instead of the
 * single `bridge.lock` — only used for `run` when `cfg.maxConcurrency > 1` (see `buildPorts`'s
 * `pooled` param). `login`/`doctor`/`inspect-ui` always keep `fileLock` below, unchanged.
 */
export function poolLock(cfg: BridgeConfig): LockPort {
  const basePath = join(cfg.locksDir, "bridge.lock");
  let active: ProcessLock | null = null;
  return {
    acquire: async (command, requestId) => {
      if (active) {
        return {
          kind: "busy",
          cause: "this poolLock instance already holds a slot; release it before acquiring again",
        };
      }
      const res = await acquireSlot(basePath, cfg.maxConcurrency, command, requestId);
      if (res.kind === "busy") return { kind: "busy", cause: res.cause };
      active = res.slot.lock;
      return { kind: "ok" };
    },
    verify: () => (active ? active.verify() : Promise.resolve(false)),
    release: async () => {
      const lock = active;
      active = null;
      if (lock) await lock.release();
    },
    markerExists: (id) => markerExists(markerPath(cfg.stateDir, id)),
    writeMarker: (id, m) => writeMarker(markerPath(cfg.stateDir, id), m),
    updateMarker: (id, patch) => updateMarker(markerPath(cfg.stateDir, id), patch),
    deleteMarker: (id) => deleteMarker(markerPath(cfg.stateDir, id)),
  };
}

export function playwrightBrowser(
  cfg: BridgeConfig,
  dedicatedPage = false,
): BrowserPort & { session: BrowserSession } {
  const session = new BrowserSession({
    profileDir: cfg.profileDir,
    channel: cfg.channel,
    dedicatedPage,
    experimentalStealth: cfg.experimentalStealth,
    stealthExtensionDir: join(cfg.repoRoot, "experimental", "stealth-extension"),
  });
  const daemonCfg = {
    runtimeDir: cfg.runtimeDir,
    profileDir: cfg.profileDir,
    channel: cfg.channel,
    experimentalStealth: cfg.experimentalStealth,
    stealthExtensionDir: join(cfg.repoRoot, "experimental", "stealth-extension"),
  };
  return {
    session,
    checkProfilePath: async () => {
      const v = await checkProfilePath(cfg.profileDir);
      return v.ok ? { ok: true } : { ok: false, cause: v.cause };
    },
    // A-103: a healthy daemon legitimately holds the profile lockfile, so it isn't contention —
    // launch() below will attach to it over CDP instead of starting a fresh browser. Applies to
    // every caller (run/worker via RunController, and login/doctor/inspect-ui via withBrowser),
    // since both drive the browser exclusively through this BrowserPort.
    // A-108 (Codex review, High): a *foreign* daemon (another host, on shared runtime/) must be
    // treated as busy too — its Chrome may hold the profile in a way an SMB-mounted lockfile check
    // can't reliably see, so silently falling through to checkProfileFree()/launch() below would
    // risk two hosts' Chrome instances colliding on the same profile (the exact class of incident
    // A-101 was about). Never attach to it either — its CDP port is on that host, unreachable here.
    checkProfileFree: async () => {
      const daemon = await checkDaemon(daemonCfg);
      if (daemon.alive) return { free: true };
      if (daemon.foreign)
        return { free: false, cause: `${daemon.reason} (cannot verify or use it from here)` };
      return checkProfileFree(cfg.profileDir);
    },
    launch: async (opts) => {
      const daemon = await checkDaemon(daemonCfg);
      if (daemon.alive) {
        // A-136 (Phase 3 MVP, Opus review High#1): this process's own CHATGPT_BRIDGE_MAX_CONCURRENCY
        // (cfg.maxConcurrency) must agree with the pool size the running daemon's own keepalive is
        // actually barrier-locking against (daemon.state.maxConcurrency, baked in at `daemon start`
        // — see daemon-worker.ts). A mismatch would mean either side's exclusion covers the wrong
        // set of slot files: e.g. this process pools over 4 slots while the daemon's keepalive only
        // barrier-locks 2, so slots 2/3 would never actually exclude a concurrent keepalive touch.
        // Refuse outright (never silently fall through to a fresh launch below) — that fresh launch
        // would only fail closed anyway (PROFILE_IN_USE), but with a far less actionable message.
        if (daemon.state.maxConcurrency !== cfg.maxConcurrency) {
          return {
            ok: false,
            cause: `CHATGPT_BRIDGE_MAX_CONCURRENCY mismatch: this process asked for ${cfg.maxConcurrency}, but the running daemon was started with ${daemon.state.maxConcurrency} (daemon start bakes it in for the lifetime of the daemon). Run "daemon stop" then "daemon start" with CHATGPT_BRIDGE_MAX_CONCURRENCY=${cfg.maxConcurrency} set, or unset it here to match the daemon's ${daemon.state.maxConcurrency}`,
          };
        }
        if (daemon.state.experimentalStealth !== cfg.experimentalStealth) {
          return {
            ok: false,
            cause: `CHATGPT_BRIDGE_EXPERIMENTAL_STEALTH mismatch: this process requested ${cfg.experimentalStealth}, but the running daemon was started with ${daemon.state.experimentalStealth}. Run "daemon stop" then "daemon start" with the desired experimental mode; it is fixed for the daemon lifetime.`,
          };
        }
        const attached = await session.attach(`http://127.0.0.1:${daemon.state.port}`, opts);
        if (attached.ok) return attached;
        // Daemon looked alive but attach failed (e.g. port stopped answering); fall back below.
      } else if (daemon.foreign) {
        // Belt-and-suspenders: checkProfileFree() above already refuses this case, but launch()
        // must never be called out of order and silently proceed if it somehow is.
        return { ok: false, cause: `${daemon.reason} (cannot verify or use it from here)` };
      }
      return session.launch(opts);
    },
    capture: (dir) => session.capture(dir),
    stopTrace: (dir) => session.stopTrace(dir),
    close: (opts) => session.close(opts),
  };
}

export function chatgptPort(
  session: BrowserSession,
  logger: Logger,
  verifiedOnly: boolean,
  imageViaViewer = false,
): ChatGptPort {
  let page: ChatGptPage | null = null;
  const get = (): ChatGptPage => {
    page ??= new ChatGptPage(session.currentPage, {
      verifiedOnly,
      log: (m) => logger.log("debug", m),
      imageViaViewer,
    });
    return page;
  };
  return {
    navigateAndObserveAuth: () => get().navigateAndObserveAuth(),
    openNewChat: () => get().openNewChat(),
    openConversation: (u) => get().openConversation(u),
    openProject: (u) => get().openProject(u),
    resolvePreset: (p, m) => get().resolvePreset(p, m),
    enterPrompt: (t, a) => get().enterPrompt(t, a),
    snapshotBaseline: (l) => get().snapshotBaseline(l),
    dispatchSubmit: (l) => get().dispatchSubmit(l),
    observe: (t) => get().observe(t),
    currentUrl: () => get().currentUrl(),
    extractLatest: () => get().extractLatest(),
    inspectUiReport: (dir, o) => get().inspectUiReport(dir, o),
    restoreEffort: () => get().restoreEffort(),
    captureImages: (dir, signal) => get().captureImages(dir, signal),
  };
}

/**
 * `pooled`: only `true` for the `run` command's own wiring (`cli/main.ts cmdRun`), and only takes
 * effect when `cfg.maxConcurrency > 1` — every other call site (`login`/`doctor`/`inspect-ui` via
 * `withBrowser`) always goes through `fileLock`, never `poolLock`. When `cfg.maxConcurrency > 1`,
 * `fileLock` itself barrier-locks every slot (Opus review of A-136, High#1) so those commands stay
 * mutually exclusive against any concurrently-pooled `run`, not just against each other; at the
 * default `maxConcurrency` of 1 both paths degenerate to the exact pre-Phase-3 single `bridge.lock`.
 */
export function buildPorts(
  cfg: BridgeConfig,
  logger: Logger,
  verifiedOnly = true,
  pooled = false,
): Ports & { lockRaw: ProcessLock | null; session: BrowserSession } {
  const usePool = pooled && cfg.maxConcurrency > 1;
  const lock = usePool ? poolLock(cfg) : fileLock(cfg);
  const browser = playwrightBrowser(cfg, usePool);
  return {
    clock: systemClock,
    contracts: fileContracts(),
    lock,
    browser,
    chatgpt: chatgptPort(browser.session, logger, verifiedOnly, cfg.imageViaViewer),
    log: logger.log,
    stderr: logger.stderr,
    lockRaw: usePool ? null : (lock as LockPort & { raw: ProcessLock | null }).raw,
    session: browser.session,
  };
}
