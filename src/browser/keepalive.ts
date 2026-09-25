/** A-158: six hours means at most four read-only home loads per day, not minute-scale traffic. */
export const DEFAULT_KEEPALIVE_MS = 6 * 60 * 60 * 1000;
export const MIN_KEEPALIVE_MS = 60 * 60 * 1000;

export interface KeepaliveLock {
  acquire(command: string, requestId: string | null): Promise<{ kind: "ok" } | { kind: "busy" }>;
  release(): Promise<void>;
}

export interface KeepalivePorts {
  lock: KeepaliveLock | null;
  /** This is the doctor's existing home-page auth probe; an AUTH_OK result is also the keepalive load. */
  probeLogin(): Promise<KeepaliveProbe>;
  /** Opens and verifies a new daemon-owned page, replacing the unusable old one on success. */
  replacePage(): Promise<void>;
  /** The daemon's existing shutdown path, invoked once repeated recovery attempts fail. */
  shutdown(): Promise<void>;
  /** Kept by daemon-worker with the original A-110 value. */
  maxConsecutiveFailures: number;
  log(message: string): void;
}

export interface KeepaliveProbe {
  ok: boolean;
  detail: string;
  /** Auth-required and challenge states are healthy pages, not daemon liveness failures. */
  recoverable: boolean;
}

export interface KeepaliveTimers {
  setInterval(handler: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export interface KeepaliveScheduler {
  tick(): Promise<void>;
  stop(): void;
}

export function parseKeepaliveInterval(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_KEEPALIVE_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= MIN_KEEPALIVE_MS ? ms : DEFAULT_KEEPALIVE_MS;
}

/**
 * Schedules only a daemon-owned idle-page home navigation. Acquiring the ordinary lock (or every
 * pooled slot) is the atomic idle check: a busy result never probes or touches the browser.
 */
export function startKeepalive(
  ports: KeepalivePorts,
  intervalMs: number,
  enabled: boolean,
  timers: KeepaliveTimers = globalThis,
): KeepaliveScheduler {
  let inFlight = false;
  let consecutiveFailures = 0;
  const tick = async (): Promise<void> => {
    if (!enabled || inFlight) return;
    inFlight = true;
    let acquired = false;
    let shouldShutdown = false;
    try {
      if (!ports.lock) {
        ports.log("skipped: no lock-path configured");
        return;
      }
      const outcome = await ports.lock.acquire("daemon-keepalive", null);
      if (outcome.kind !== "ok") {
        ports.log("skipped: browser busy");
        return;
      }
      acquired = true;
      let login: KeepaliveProbe;
      try {
        login = await ports.probeLogin();
      } catch (err) {
        login = { ok: false, detail: (err as Error).message, recoverable: true };
      }
      if (login.ok) {
        consecutiveFailures = 0;
        ports.log(`success: login OK; home page loaded (${login.detail})`);
        return;
      }
      if (!login.recoverable) {
        ports.log(`skipped: login not OK (${login.detail})`);
        return;
      }
      consecutiveFailures++;
      ports.log(`failed (${consecutiveFailures}/${ports.maxConsecutiveFailures}): ${login.detail}`);
      try {
        await ports.replacePage();
        consecutiveFailures = 0;
        ports.log("opened a replacement page");
      } catch (err) {
        ports.log(
          `could not open a usable replacement page (context likely dead too): ${(err as Error).message}`,
        );
        shouldShutdown = consecutiveFailures >= ports.maxConsecutiveFailures;
        if (shouldShutdown) {
          ports.log(
            `giving up after ${consecutiveFailures} consecutive failures; shutting down so doctor/run see "no daemon" instead of a stuck one`,
          );
        }
      }
    } catch (err) {
      ports.log(`failed: ${(err as Error).message}`);
    } finally {
      if (acquired) await ports.lock?.release();
      inFlight = false;
    }
    if (shouldShutdown) await ports.shutdown();
  };
  if (!enabled) ports.log("disabled");
  const timer = enabled ? timers.setInterval(() => void tick(), intervalMs) : undefined;
  return { tick, stop: () => timer && timers.clearInterval(timer) };
}
