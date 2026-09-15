import { access } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
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

export function fileLock(cfg: BridgeConfig): LockPort & { raw: ProcessLock } {
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

export function playwrightBrowser(cfg: BridgeConfig): BrowserPort & { session: BrowserSession } {
  const session = new BrowserSession({ profileDir: cfg.profileDir, channel: cfg.channel });
  return {
    session,
    checkProfilePath: async () => {
      const v = await checkProfilePath(cfg.profileDir);
      return v.ok ? { ok: true } : { ok: false, cause: v.cause };
    },
    checkProfileFree: () => checkProfileFree(cfg.profileDir),
    launch: (opts) => session.launch(opts),
    capture: (dir) => session.capture(dir),
    stopTrace: (dir) => session.stopTrace(dir),
    close: () => session.close(),
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

export function buildPorts(
  cfg: BridgeConfig,
  logger: Logger,
  verifiedOnly = true,
): Ports & { lockRaw: ProcessLock; session: BrowserSession } {
  const lock = fileLock(cfg);
  const browser = playwrightBrowser(cfg);
  return {
    clock: systemClock,
    contracts: fileContracts(),
    lock,
    browser,
    chatgpt: chatgptPort(browser.session, logger, verifiedOnly, cfg.imageViaViewer),
    log: logger.log,
    stderr: logger.stderr,
    lockRaw: lock.raw,
    session: browser.session,
  };
}
