/** Explicit host lifecycle, not an authority or job ledger. Constructor/import performs no work.
 * A timed-out tick retains its in-flight ownership until it actually settles: never overlap/replay.
 */
export interface ResidentWorkerLifecycle {
  start(): void;
  close(): Promise<void>;
  snapshot(): ResidentWorkerSnapshot;
}
export interface ResidentLane {
  id: string;
  /** Signal fences new work; it does not prove an existing model/process was terminated. */
  tick(signal: AbortSignal): Promise<unknown>;
}
export interface ResidentWorkerOptions {
  enabled: boolean;
  lanes: readonly ResidentLane[];
  intervalMs?: number;
  tickTimeoutMs?: number;
  drainTimeoutMs?: number;
  now?: () => number;
}
export interface ResidentWorkerSnapshot {
  version: "bridge-resident-worker-1";
  enabled: boolean;
  state: "disabled" | "idle" | "running" | "stopping" | "stopped" | "closing" | "closed";
  lanes: {
    id: string;
    inFlight: boolean;
    scheduled: boolean;
    ticks: number;
    lastStartedAt: number | null;
    lastFinishedAt: number | null;
    lastTickOutcome: "ok" | "failed" | "aborted" | "timed_out" | null;
    error: string | null;
  }[];
}
interface LaneState {
  port: ResidentLane;
  timer: ReturnType<typeof setTimeout> | undefined;
  pending: Promise<void> | null;
  abort: AbortController | null;
  watchdog: ReturnType<typeof setTimeout> | undefined;
  timedOut: boolean;
  ticks: number;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastTickOutcome: "ok" | "failed" | "aborted" | "timed_out" | null;
  error: string | null;
}
function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error("resident_worker_config_invalid");
  return value;
}
export class BridgeResidentWorker implements ResidentWorkerLifecycle {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly tickTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly now: () => number;
  private readonly lanes: LaneState[];
  private running = false;
  private started = false;
  private closeRequested = false;
  private closed = false;
  private drain: Promise<void> | null = null;
  constructor(options: ResidentWorkerOptions) {
    if (
      typeof options.enabled !== "boolean" ||
      !Array.isArray(options.lanes) ||
      options.lanes.length > 16 ||
      (options.enabled && !options.lanes.length)
    )
      throw new Error("resident_worker_config_invalid");
    this.enabled = options.enabled;
    this.intervalMs = bounded(options.intervalMs ?? 30000, 1000, 300000);
    this.tickTimeoutMs = bounded(options.tickTimeoutMs ?? 30000, 1, 300000);
    this.drainTimeoutMs = bounded(options.drainTimeoutMs ?? 5000, 1, 30000);
    this.now = options.now ?? Date.now;
    const ids = new Set<string>();
    this.lanes = options.lanes.map((port) => {
      if (
        !/^[a-z][a-z0-9_.:-]{0,63}(?![\s\S])/.test(port.id) ||
        ids.has(port.id) ||
        typeof port.tick !== "function"
      )
        throw new Error("resident_worker_lane_invalid");
      ids.add(port.id);
      // Capture the callable/identity once; mutable catalogue objects cannot replace a running lane.
      return {
        port: { id: port.id, tick: port.tick.bind(port) },
        timer: undefined,
        pending: null,
        abort: null,
        watchdog: undefined,
        timedOut: false,
        ticks: 0,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastTickOutcome: null,
        error: null,
      };
    });
  }
  start(): void {
    if (this.closeRequested || this.closed) throw new Error("resident_worker_closed");
    if (!this.enabled || this.running) return;
    if (this.lanes.some((lane) => lane.pending)) throw new Error("resident_worker_drain_pending");
    this.running = true;
    this.started = true;
    for (const lane of this.lanes) this.schedule(lane, 0);
  }
  private schedule(lane: LaneState, delay: number): void {
    if (!this.running || this.closeRequested || lane.pending || lane.timer !== undefined) return;
    lane.timer = setTimeout(() => {
      lane.timer = undefined;
      this.launch(lane);
    }, delay);
  }
  private launch(lane: LaneState): void {
    if (!this.running || this.closeRequested || lane.pending) return;
    const abort = new AbortController();
    lane.abort = abort;
    lane.timedOut = false;
    lane.ticks++;
    lane.lastStartedAt = this.now();
    lane.error = null;
    lane.watchdog = setTimeout(() => {
      lane.timedOut = true;
      lane.lastTickOutcome = "timed_out";
      lane.error = "resident_tick_timeout";
      abort.abort();
      // Keep lane.pending: a hung source cannot be replaced by a concurrent second tick.
    }, this.tickTimeoutMs);
    lane.pending = Promise.resolve()
      .then(() => (abort.signal.aborted ? undefined : lane.port.tick(abort.signal)))
      .then(
        () => {
          lane.lastTickOutcome = lane.timedOut
            ? "timed_out"
            : abort.signal.aborted
              ? "aborted"
              : "ok";
        },
        () => {
          lane.lastTickOutcome = lane.timedOut
            ? "timed_out"
            : abort.signal.aborted
              ? "aborted"
              : "failed";
          // Provider error text is not a trusted enum; even a lowercase token can look like a code.
          lane.error = lane.timedOut ? "resident_tick_timeout" : "resident_lane_failed";
        },
      )
      .finally(() => {
        if (lane.watchdog !== undefined) clearTimeout(lane.watchdog);
        lane.watchdog = undefined;
        lane.pending = null;
        lane.abort = null;
        lane.lastFinishedAt = this.now();
        this.schedule(lane, this.intervalMs);
      });
  }
  /** Pauses only this worker; existing process/server generation is not cancelled or declared ended. */
  stop(): Promise<void> {
    this.running = false;
    for (const lane of this.lanes) {
      if (lane.timer !== undefined) clearTimeout(lane.timer);
      lane.timer = undefined;
      lane.abort?.abort();
    }
    if (this.drain) return this.drain;
    const pending = this.lanes.flatMap((lane) => (lane.pending ? [lane.pending] : []));
    if (!pending.length) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = Promise.race([
      Promise.all(pending).then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("resident_worker_drain_pending")),
          this.drainTimeoutMs,
        );
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      if (this.drain === wait) this.drain = null;
    });
    this.drain = wait;
    return wait;
  }
  /** Rejection means callers MUST retain all stores. Retry close after in-flight work settles. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closeRequested = true;
    await this.stop();
    this.closed = true;
  }
  snapshot(): ResidentWorkerSnapshot {
    const active = this.lanes.some((lane) => lane.pending);
    return {
      version: "bridge-resident-worker-1",
      enabled: this.enabled,
      state: this.closed
        ? "closed"
        : this.closeRequested
          ? "closing"
          : !this.enabled
            ? "disabled"
            : this.running
              ? "running"
              : active
                ? "stopping"
                : this.started
                  ? "stopped"
                  : "idle",
      lanes: this.lanes.map((lane) => ({
        id: lane.port.id,
        inFlight: !!lane.pending,
        scheduled: lane.timer !== undefined,
        ticks: lane.ticks,
        lastStartedAt: lane.lastStartedAt,
        lastFinishedAt: lane.lastFinishedAt,
        lastTickOutcome: lane.lastTickOutcome,
        error: lane.error,
      })),
    };
  }
}
