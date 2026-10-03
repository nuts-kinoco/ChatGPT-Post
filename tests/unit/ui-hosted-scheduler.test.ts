import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { HostedOperationBinding } from "../../src/contracts/operations.js";
import {
  HostedUiScheduler,
  type HostedUiService,
  hostedOperationsPort,
} from "../../src/ui/hosted-operations.js";
import type { HostedOperationsRecord } from "../../src/ui/operations.js";

function fixture() {
  // Minimal synthetic scheduler fixture, never a runnable browser/model job.
  let job = {
    revision: 1,
    issued: { requestId: randomUUID(), taskSpecHash: "a".repeat(64) },
    attemptId: null,
    attempted: false,
    cancelRequestedAt: null,
    state: "approved",
  } as HostedOperationsRecord;
  let finish!: (value: HostedOperationsRecord) => void;
  const future = new Promise<HostedOperationsRecord>((resolve) => {
    finish = resolve;
  });
  const service: HostedUiService = {
    get: () => structuredClone(job),
    listPage: () => ({ requestIds: [job.issued.requestId], next: null }),
    approve: vi.fn(),
    start: vi.fn(() => {
      job = {
        ...job,
        revision: job.revision + 1,
        attempted: true,
        attemptId: randomUUID(),
        state: "unknown",
      };
      return future;
    }),
    cancel: vi.fn(async () => {
      job = { ...job, revision: job.revision + 1, cancelRequestedAt: new Date().toISOString() };
    }),
    reconcile: vi.fn(async () => structuredClone(job)),
  };
  const binding = (): HostedOperationBinding => ({
    kind: "hosted_delivery",
    requestId: job.issued.requestId,
    taskSpecHash: job.issued.taskSpecHash,
    attemptId: job.attemptId,
    revision: job.revision,
  });
  return { service, binding, finish: () => finish(job) };
}
describe("hosted UI future ownership", () => {
  it("returns after durable intent without awaiting generation and never starts twice", async () => {
    const f = fixture(),
      scheduler = new HostedUiScheduler(f.service),
      before = f.binding();
    expect(scheduler.scheduleStart(before)).toEqual({ accepted: true });
    expect(f.service.get(before.requestId)?.attempted).toBe(true);
    expect(() => scheduler.scheduleStart(before)).toThrow("already owns");
    expect(f.service.start).toHaveBeenCalledTimes(1);
    await scheduler.cancel(f.binding());
    expect(f.service.cancel).toHaveBeenCalledTimes(1);
    expect(f.service.get(before.requestId)?.state).toBe("unknown");
    f.finish();
    await scheduler.close();
  });
  it("rejects changed hash/revision before calling authority or runner", () => {
    const f = fixture(),
      scheduler = new HostedUiScheduler(f.service);
    expect(() => scheduler.scheduleStart({ ...f.binding(), revision: 0 })).toThrow("changed");
    expect(() =>
      scheduler.approve(
        { ...f.binding(), taskSpecHash: "b".repeat(64) },
        "trusted-user",
        "2030-01-01T00:00:00.000Z",
      ),
    ).toThrow("changed");
    expect(f.service.start).not.toHaveBeenCalled();
    expect(f.service.approve).not.toHaveBeenCalled();
  });
  it("fails closed if a start port has not persisted its intent synchronously", async () => {
    const f = fixture();
    f.service.start = vi.fn(() => new Promise(() => {}));
    const scheduler = new HostedUiScheduler(f.service);
    expect(() => scheduler.scheduleStart(f.binding())).toThrow("Durable hosted attempt");
    expect(() => scheduler.scheduleStart(f.binding())).toThrow("already owns");
    await expect(scheduler.close(5)).rejects.toThrow("hosted_shutdown_pending");
  });
  it("bounds shutdown even if the cancellation adapter itself hangs", async () => {
    const f = fixture();
    f.service.cancel = vi.fn(() => new Promise(() => {}));
    const scheduler = new HostedUiScheduler(f.service);
    scheduler.scheduleStart(f.binding());
    await expect(scheduler.close(5)).rejects.toThrow("hosted_shutdown_pending");
    expect(() => scheduler.scheduleStart(f.binding())).toThrow("capacity");
    f.finish();
  });
  it("wraps only explicit host ports and fixes approval actor/expiry at the authority boundary", () => {
    const f = fixture();
    const port = hostedOperationsPort(f.service, {
      policyHash: "a".repeat(64),
      conversationId: null,
      destinationId: null,
      capabilities: () => ({}),
      now: () => new Date("2026-10-03T08:00:00.000Z"),
      approvalSeconds: 30,
    });
    port.source.approve?.(f.binding(), "trusted-user");
    expect(f.service.approve).toHaveBeenCalledWith(f.binding().requestId, {
      actorId: "trusted-user",
      taskSpecHash: "a".repeat(64),
      expiresAt: "2026-10-03T08:00:30.000Z",
      authenticated: true,
    });
  });
  it("emits provisional telemetry only at the newly persisted start boundary, never on reads or cancel", async () => {
    const f = fixture(),
      telemetry = vi.fn(),
      scheduler = new HostedUiScheduler(f.service, 4, telemetry);
    f.service.get(f.binding().requestId);
    expect(telemetry).not.toHaveBeenCalled();
    scheduler.scheduleStart(f.binding());
    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(telemetry.mock.calls[0]?.[0]).toMatchObject({ attempted: true, state: "unknown" });
    await scheduler.cancel(f.binding());
    expect(telemetry).toHaveBeenCalledTimes(1);
    f.finish();
    await scheduler.close();
  });
});
