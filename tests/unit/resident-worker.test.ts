import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeResidentWorker } from "../../src/adapters/resident-worker.js";

function deferred() {
  let resolve: () => void = () => {
    throw new Error("fixture");
  };
  let reject: (e: Error) => void = () => {
    throw new Error("fixture");
  };
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("explicit resident host lifecycle (fake clock and ports)", () => {
  it("constructor/read snapshots do nothing and disabled configuration cannot start", async () => {
    const tick = vi.fn(async () => {});
    const w = new BridgeResidentWorker({ enabled: false, lanes: [{ id: "cli", tick }] });
    w.snapshot();
    w.start();
    await vi.advanceTimersByTimeAsync(100000);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await w.close();
  });
  it("starts once, schedules independent lanes and never overlaps an in-flight lane", async () => {
    const gate = deferred();
    let active = 0,
      maximum = 0;
    const cli = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await gate.promise;
      active--;
    });
    const chat = vi.fn(async () => {});
    const w = new BridgeResidentWorker({
      enabled: true,
      intervalMs: 1000,
      tickTimeoutMs: 10000,
      lanes: [
        { id: "cli:product-a", tick: cli },
        { id: "chat:product-b", tick: chat },
      ],
    });
    w.start();
    w.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(cli).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(4);
    expect(maximum).toBe(1);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await w.close();
  });
  it("a timed-out lane remains owned until settlement while the other lane continues", async () => {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const stuck = vi.fn(async (s: AbortSignal) => {
      signal = s;
      await gate.promise;
    });
    const other = vi.fn(async () => {});
    const w = new BridgeResidentWorker({
      enabled: true,
      intervalMs: 1000,
      tickTimeoutMs: 100,
      drainTimeoutMs: 50,
      lanes: [
        { id: "stuck", tick: stuck },
        { id: "other", tick: other },
      ],
    });
    w.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(stuck).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(3);
    expect(signal?.aborted).toBe(true);
    expect(w.snapshot().lanes[0]).toMatchObject({ inFlight: true, lastTickOutcome: "timed_out" });
    const closing = w.close();
    const rejection = expect(closing).rejects.toThrow("resident_worker_drain_pending");
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(w.snapshot().state).toBe("closing");
    expect(() => w.start()).toThrow("resident_worker_closed");
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await w.close();
    expect(w.snapshot().state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stop drains and explicit resume does not create a duplicate or retain an aborted signal", async () => {
    const signals: AbortSignal[] = [];
    const w = new BridgeResidentWorker({
      enabled: true,
      intervalMs: 1000,
      lanes: [
        {
          id: "cli",
          tick: async (signal) => {
            signals.push(signal);
          },
        },
      ],
    });
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    await w.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(signals).toHaveLength(1);
    expect(w.snapshot().state).toBe("stopped");
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
    await w.close();
  });
  it("stop before first scheduled tick performs zero IO", async () => {
    const tick = vi.fn(async () => {});
    const w = new BridgeResidentWorker({ enabled: true, lanes: [{ id: "cli", tick }] });
    w.start();
    await w.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).not.toHaveBeenCalled();
    await w.close();
  });
  it("stop rejects within its bound and cannot resume until the old tick settles", async () => {
    const gate = deferred();
    const w = new BridgeResidentWorker({
      enabled: true,
      drainTimeoutMs: 10,
      lanes: [{ id: "cli", tick: () => gate.promise }],
    });
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = w.stop();
    const rejection = expect(stopping).rejects.toThrow("drain_pending");
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(() => w.start()).toThrow("drain_pending");
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    await w.close();
  });
  it("exceptions are sanitized and another tick can safely reconcile later", async () => {
    let calls = 0;
    const w = new BridgeResidentWorker({
      enabled: true,
      intervalMs: 1000,
      lanes: [
        {
          id: "cli",
          tick: async () => {
            if (++calls === 1) throw new Error("private /path credential");
          },
        },
      ],
    });
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.snapshot().lanes[0]).toMatchObject({
      error: "resident_lane_failed",
      lastTickOutcome: "failed",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    expect(w.snapshot().lanes[0]).toMatchObject({ error: null, lastTickOutcome: "ok" });
    await w.close();
  });
  it("does not expose secret-shaped provider error strings as diagnostic codes", async () => {
    const secret = "abcdef0123456789".repeat(4);
    const w = new BridgeResidentWorker({
      enabled: true,
      lanes: [
        {
          id: "cli",
          tick: async () => {
            throw new Error(secret);
          },
        },
      ],
    });
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.snapshot().lanes[0]?.error).toBe("resident_lane_failed");
    expect(JSON.stringify(w.snapshot())).not.toContain(secret);
    await w.close();
  });
  it("captures configured lane functions and returns detached snapshots", async () => {
    const tick = vi.fn(async () => {}),
      replacement = vi.fn(async () => {});
    const lane = { id: "cli", tick };
    const options = { enabled: true, intervalMs: 1000, lanes: [lane] };
    const w = new BridgeResidentWorker(options);
    lane.tick = replacement;
    options.enabled = false;
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    const s = w.snapshot();
    if (!s.lanes[0]) throw new Error("fixture");
    s.lanes[0].ticks = 999;
    expect(w.snapshot().lanes[0]?.ticks).toBe(1);
    expect(tick).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    await w.close();
    await w.close();
  });
  it.each([
    { intervalMs: 0 },
    { intervalMs: NaN },
    { tickTimeoutMs: 0 },
    { drainTimeoutMs: 30001 },
  ])("rejects invalid bounds %j", (patch) => {
    expect(
      () =>
        new BridgeResidentWorker({
          enabled: true,
          lanes: [{ id: "cli", tick: async () => {} }],
          ...patch,
        }),
    ).toThrow("config_invalid");
  });
  it("rejects duplicate/unsafe lanes and enabled empty worker", () => {
    const lane = { id: "cli", tick: async () => {} };
    expect(() => new BridgeResidentWorker({ enabled: true, lanes: [lane, lane] })).toThrow(
      "lane_invalid",
    );
    expect(
      () => new BridgeResidentWorker({ enabled: true, lanes: [{ ...lane, id: "../secret" }] }),
    ).toThrow("lane_invalid");
    expect(() => new BridgeResidentWorker({ enabled: true, lanes: [] })).toThrow("config_invalid");
  });
  it("late rejection after timeout is handled and is not an unhandled replay", async () => {
    const gate = deferred();
    const tick = vi.fn(() => gate.promise);
    const w = new BridgeResidentWorker({
      enabled: true,
      intervalMs: 1000,
      tickTimeoutMs: 10,
      lanes: [{ id: "cli", tick }],
    });
    w.start();
    await vi.advanceTimersByTimeAsync(10);
    gate.reject(new Error("late_failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(w.snapshot().lanes[0]).toMatchObject({
      lastTickOutcome: "timed_out",
      error: "resident_tick_timeout",
      inFlight: false,
    });
    expect(tick).toHaveBeenCalledOnce();
    await w.close();
  });
});
