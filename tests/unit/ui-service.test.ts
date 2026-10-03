import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Bytes, validateTaskResult } from "../../src/contracts/task.js";
import type { UiAck, UiBinding, UiTaskResponse } from "../../src/contracts/ui.js";
import { DemoAuthority, type DemoTaskExecutor, demoTask } from "../../src/ui/demo.js";
import { openUiService, TaskUiService } from "../../src/ui/service.js";

function binding(view: UiTaskResponse): UiBinding {
  return {
    taskSpecHash: view.task.result.task_spec_hash,
    taskFileHash: view.task.result.task_file_hash,
    sequence: view.task.result.observation_seq,
  };
}
function ack(view: UiTaskResponse): UiAck {
  const terminal = view.task.handshakes.terminal_result;
  if (!terminal) throw new Error("missing terminal test fixture");
  return {
    eventId: terminal.eventId,
    payloadSha256: terminal.payloadSha256,
    sequence: terminal.sequence,
  };
}
describe("product UI service, real SQLite and controller", () => {
  let directory: string;
  const services: TaskUiService[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bridge-ui-service-"));
  });
  afterEach(async () => {
    for (const service of services.splice(0)) service.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function open(profile: "production" | "demo" = "demo") {
    const service = await openUiService({ profile, stateDir: directory });
    services.push(service);
    return service;
  }
  function close(service: TaskUiService) {
    service.close();
    services.splice(services.indexOf(service), 1);
  }
  it("fails closed in production while validating and importing immutable raw bytes", async () => {
    const service = await open("production");
    const input = demoTask({ title: "Untrusted inspection input" });
    expect(service.validate(input).valid).toBe(true);
    const task = service.import(input);
    expect(task.task.result.synthetic).toBe(false);
    expect(task.task.result.status).toBe("awaiting_approval");
    expect(task.task.preflight.ready).toBe(false);
    expect(task.task.preflight.health.state).toBe("unconfigured");
    expect(task.task.preflight.health.models).toEqual([]);
    expect(task.task.approvals).toEqual([]);
    for (const method of ["approve", "start"] as const)
      await expect(
        service[method](task.task.summary.requestId, binding(task)),
      ).rejects.toMatchObject({ code: `${method}_unavailable` });
    await expect(service.cancel(task.task.summary.requestId)).rejects.toMatchObject({
      code: "cancel_unavailable",
    });
    expect(() => service.createDemo({})).toThrow("explicit demo profile");
    expect(service.import(input).task.events).toHaveLength(2);
    expect(() => service.import({ ...input, rawSpec: `${input.rawSpec} ` })).toThrow(
      "request_id_conflict",
    );
    const changed = { ...input, taskMarkdown: `${input.taskMarkdown}\nmodified` };
    expect(service.validate(changed).valid).toBe(false);
    expect(() => service.import(changed)).toThrow("hash validation");
  });
  it("derives demo approval times from one clock sample and honors the task lifetime", async () => {
    const service = await open();
    const input = demoTask({});
    const spec = JSON.parse(input.rawSpec);
    spec.approval.max_age_seconds = 60;
    const view = service.import({ ...input, rawSpec: JSON.stringify(spec) });
    let samples = 0;
    const base = Date.now();
    const authority = new DemoAuthority(
      service.runtime.store,
      service.runtime.controller.policy,
      () => new Date(base + samples++),
    );
    const grant = await authority.approve(view.task.summary.requestId);
    expect(samples).toBe(1);
    expect(Date.parse(grant.expires_at) - Date.parse(grant.issued_at)).toBe(60_000);
  });
  it("persists the complete synthetic lifecycle, exact hash-bound approval, receipt and idempotent ACK", async () => {
    let service = await open();
    let view = service.createDemo({ title: "Safe synthetic inspection" });
    const id = view.task.summary.requestId;
    expect(view.task.result.synthetic).toBe(true);
    expect(view.task.capabilities.start.enabled).toBe(false);
    const original = view.task.rawSpec;
    await expect(
      service.approve(id, { ...binding(view), taskFileHash: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "stale_task_snapshot" });
    view = await service.approve(id, binding(view));
    expect(view.task.approvals).toHaveLength(1);
    const approved = binding(view);
    view = await service.start(id, approved);
    expect(view.task.result.status).toBe("running");
    expect(view.task.capabilities.start.enabled).toBe(false);
    await expect(service.start(id, approved)).rejects.toMatchObject({
      code: "stale_task_snapshot",
    });
    const repeated = await service.start(id, binding(view));
    expect(repeated.task.intent).toEqual(view.task.intent);
    expect((service.runtime.controller.executor as DemoTaskExecutor).starts).toBe(1);
    expect(view.task.approvals[0]?.consumed).toBe(true);
    view = await service.demoObservation(id, "succeeded");
    expect({ status: view.task.result.status, error: view.task.result.error }).toEqual({
      status: "succeeded",
      error: null,
    });
    expect(view.task.result.commands_run).toEqual([]);
    expect(view.task.result.verification.state).toBe("synthetic");
    expect(view.task.result.receipt).toBeNull();
    expect(
      validateTaskResult(view.task.result, {
        task: view.task.spec,
        taskSpecHash: view.task.result.task_spec_hash,
      }).valid,
    ).toBe(true);
    expect(view.task.handshakes.start_receipt).not.toBeNull();
    expect(view.task.handshakes.terminal_result).not.toBeNull();
    const payload = service.resultPayload(id);
    expect(sha256Bytes(Buffer.from(payload))).toBe(ack(view).payloadSha256);
    await expect(
      service.acknowledge(id, { ...ack(view), payloadSha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "delivery_identity_mismatch" });
    view = await service.acknowledge(id, ack(view));
    expect(view.task.delivery.acknowledged).toBe(true);
    await service.acknowledge(id, ack(view));
    expect(service.resultPayload(id)).toBe(payload);
    expect(view.task.rawSpec).toBe(original);
    close(service);
    service = await open();
    expect(service.task(id).task.delivery.acknowledged).toBe(true);
    expect(service.resultPayload(id)).toBe(payload);
    expect(service.task(id).task.events.map((event) => event.status)).toEqual([
      "received",
      "awaiting_approval",
      "approved",
      "unknown",
      "running",
      "succeeded",
    ]);
  });
  it("preserves consumed dispatch after restart as unknown without invoking start", async () => {
    let service = await open();
    let view = service.createDemo({});
    const id = view.task.summary.requestId;
    view = await service.approve(id, binding(view));
    view = await service.start(id, binding(view));
    const intent = view.task.intent;
    close(service);
    service = await open();
    view = service.task(id);
    expect(view.task.result.status).toBe("unknown");
    expect(view.task.result.outcome_known).toBe(false);
    expect(view.task.intent).toEqual(intent);
    expect(view.task.capabilities.start.enabled).toBe(false);
    expect(view.task.capabilities.reconcile.enabled).toBe(true);
    await service.start(id, binding(view));
    view = await service.reconcile(id);
    expect(view.task.result.status).toBe("unknown");
    expect(view.task.handshakes.terminal_result).toBeNull();
    expect((service.runtime.controller.executor as DemoTaskExecutor).starts).toBe(0);
    await expect(service.demoObservation(id, "succeeded")).rejects.toThrow(
      "demo_observation_lost_after_restart",
    );
    expect(service.createDemo({}).task.summary.requestId).not.toBe(id);
  });
  it("cancels before and after start, and reconciles synthetic disconnect with no second start", async () => {
    const service = await open();
    const unstarted = service.createDemo({});
    expect((await service.cancel(unstarted.task.summary.requestId)).task.result.status).toBe(
      "cancelled",
    );
    let view = service.createDemo({});
    const id = view.task.summary.requestId;
    view = await service.approve(id, binding(view));
    view = await service.start(id, binding(view));
    view = await service.demoObservation(id, "unknown");
    expect(view.task.result.status).toBe("unknown");
    view = await service.cancel(id);
    expect(view.task.result.status).toBe("unknown");
    expect(view.task.intent?.cancelAt).not.toBeNull();
    view = await service.demoObservation(id, "succeeded");
    expect(view.task.result.status).toBe("cancelled");
    expect(view.task.result.error?.code).toBe("cancellation_committed_first");
    expect((service.runtime.controller.executor as DemoTaskExecutor).starts).toBe(1);
  });
  it("bounds a hung authority and lets cancellation finish without waiting for it", async () => {
    const base = await open();
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const authority = {
      approve: vi.fn(() => {
        signalStarted?.();
        return new Promise<never>(() => undefined);
      }),
    };
    const service = new TaskUiService(
      { ...base.runtime, authority, authorityTimeoutMs: 40 },
      { profile: "demo" },
    );
    const view = service.createDemo({});
    const id = view.task.summary.requestId;
    const approval = service.approve(id, binding(view));
    let settled = false;
    void approval.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(approval).rejects.toMatchObject({ code: "approval_authority_timeout" });
    await started;
    const cancelled = await service.cancel(id);
    expect(settled).toBe(false);
    expect(cancelled.task.result.status).toBe("cancelled");
    expect(cancelled.task.approvals).toEqual([]);
    await rejected;
  });
  it("rejects a late authority grant after cancellation changes the inspected snapshot", async () => {
    const base = await open();
    const originalAuthority = base.runtime.authority;
    if (!originalAuthority) throw new Error("missing test authority");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authority = {
      approve: vi.fn(async (id: string) => {
        const grant = await originalAuthority.approve(id);
        await gate;
        return grant;
      }),
    };
    const service = new TaskUiService({ ...base.runtime, authority }, { profile: "demo" });
    const view = service.createDemo({});
    const id = view.task.summary.requestId;
    const approval = service.approve(id, binding(view));
    const rejected = expect(approval).rejects.toMatchObject({ code: "stale_task_snapshot" });
    await vi.waitFor(() => expect(authority.approve).toHaveBeenCalledOnce());
    await service.cancel(id);
    release?.();
    await rejected;
    expect(service.task(id).task.approvals).toEqual([]);
    expect(service.task(id).task.result.status).toBe("cancelled");
  });
  it("rejects delayed approval when the task revision changes without changing its status", async () => {
    const base = await open();
    const originalAuthority = base.runtime.authority;
    if (!originalAuthority) throw new Error("missing test authority");
    let release: (() => void) | undefined;
    let startedSignal: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedSignal = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new TaskUiService(
      {
        ...base.runtime,
        authority: {
          approve: async (id: string) => {
            const grant = await originalAuthority.approve(id);
            startedSignal?.();
            await gate;
            return grant;
          },
        },
      },
      { profile: "demo" },
    );
    const view = service.createDemo({});
    const id = view.task.summary.requestId;
    const approval = service.approve(id, binding(view));
    const rejected = expect(approval).rejects.toMatchObject({ code: "stale_task_snapshot" });
    await started;
    const current = service.runtime.store.get(id);
    if (!current) throw new Error("missing task");
    const changed = structuredClone(current);
    changed.result.observation_seq++;
    changed.result.observed_at = new Date().toISOString();
    service.runtime.store.save(changed, current.result.observation_seq);
    release?.();
    await rejected;
    expect(service.task(id).task.result.status).toBe("awaiting_approval");
    expect(service.task(id).task.approvals).toEqual([]);
  });
  it("persists cancellation promptly while an executor start response is still pending", async () => {
    const service = await open();
    const executor = service.runtime.controller.executor as DemoTaskExecutor;
    const realStart = executor.start.bind(executor);
    let release: (() => void) | undefined;
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(executor, "start").mockImplementation(async (...args) => {
      const observation = await realStart(...args);
      entered = true;
      await gate;
      return observation;
    });
    let view = service.createDemo({});
    const id = view.task.summary.requestId;
    view = await service.approve(id, binding(view));
    const starting = service.start(id, binding(view));
    await vi.waitFor(() => expect(entered).toBe(true));
    view = await service.cancel(id);
    expect(view.task.intent?.cancelAt).not.toBeNull();
    expect(view.task.result.status).toBe("cancelled");
    release?.();
    expect((await starting).task.result.status).toBe("cancelled");
    expect(executor.starts).toBe(1);
  });
  it("does not forge ACK authority for a different requester in the same ledger", async () => {
    const service = await open();
    const input = demoTask({ title: "External requester task" });
    const record = service.runtime.controller.receive(
      Buffer.from(input.rawSpec),
      Buffer.from(input.taskMarkdown),
      null,
      "external-recipient",
    );
    const id = record.result.request_id;
    let view = service.task(id);
    view = await service.approve(id, binding(view));
    view = await service.start(id, binding(view));
    view = await service.demoObservation(id, "succeeded");
    expect(view.task.capabilities.ack.enabled).toBe(false);
    await expect(service.acknowledge(id, ack(view))).rejects.toMatchObject({
      code: "ack_unavailable",
    });
    expect(service.runtime.store.handshake(id, "result_ack")).toBeNull();
  });
  it("refuses schema-valid terminal row changes that disagree with the immutable receipt", async () => {
    const service = await open();
    let view = service.createDemo({});
    const id = view.task.summary.requestId;
    view = await service.approve(id, binding(view));
    view = await service.start(id, binding(view));
    view = await service.demoObservation(id, "succeeded");
    const originalPayload = service.runtime.store.deliveryPayload(id);
    const altered = service.runtime.store.get(id);
    if (!altered) throw new Error("fixture missing");
    altered.result.observed_at = new Date(
      Date.parse(altered.result.observed_at) + 1000,
    ).toISOString();
    expect(
      validateTaskResult(altered.result, {
        task: view.task.spec,
        taskSpecHash: altered.result.task_spec_hash,
      }).valid,
    ).toBe(true);
    const db = new DatabaseSync(join(directory, "ui-demo", "jobs.db"));
    try {
      db.prepare("UPDATE task_jobs SET snapshot=? WHERE request_id=?").run(
        JSON.stringify(altered),
        id,
      );
    } finally {
      db.close();
    }
    expect(() => service.task(id)).toThrow("immutable delivery evidence");
    expect(() => service.bootstrap()).toThrow("immutable delivery evidence");
    await expect(service.acknowledge(id, ack(view))).rejects.toMatchObject({
      code: "terminal_snapshot_mismatch",
    });
    expect(service.runtime.store.deliveryPayload(id)).toEqual(originalPayload);
    expect(service.runtime.store.handshake(id, "result_ack")).toBeNull();
  });
  it("keeps production and demo ledgers isolated and does not seed invented tasks", async () => {
    const production = await open("production");
    const demo = await open();
    expect(production.bootstrap().tasks).toEqual([]);
    expect(demo.bootstrap().tasks).toEqual([]);
    demo.createDemo({});
    expect(production.bootstrap().tasks).toEqual([]);
  });
});
