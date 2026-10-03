/** In-flight API preflight uses an explicit synthetic executor; no process is launched. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { DemoTaskExecutor } from "../../src/ui/demo.js";
import { openUiService } from "../../src/ui/service.js";

it("shutdown aborts an accepted local start still waiting for capabilities, before durable intent", async () => {
  const path = await mkdtemp(join(tmpdir(), "ui-start-shutdown-")),
    service = await openUiService({ stateDir: path, profile: "demo" });
  try {
    let task = service.createDemo({}).task;
    const bound = () => ({
      taskSpecHash: task.result.task_spec_hash,
      taskFileHash: task.result.task_file_hash,
      sequence: task.result.observation_seq,
    });
    task = (await service.approve(task.summary.requestId, bound())).task;
    let release!: () => void;
    const future = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = service.runtime.controller.executor as DemoTaskExecutor;
    const check = vi.spyOn(executor, "checkCapabilities").mockImplementation(() => future);
    const start = service.start(task.summary.requestId, bound());
    const rejected = expect(start).rejects.toThrow("dispatch_stopped");
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    service.beginShutdown();
    release();
    await rejected;
    expect(executor.starts).toBe(0);
    expect(service.runtime.store.get(task.summary.requestId)?.intent).toBeNull();
    expect(service.task(task.summary.requestId).task.result.status).toBe("approved");
  } finally {
    service.close();
    await rm(path, { recursive: true, force: true });
  }
});
