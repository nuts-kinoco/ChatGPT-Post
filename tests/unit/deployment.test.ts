import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridgeDeployment, type DeploymentOptions } from "../../src/adapters/deployment.js";
import type { GitHubTaskBus } from "../../src/adapters/github-transport.js";
import { TransportJournal } from "../../src/adapters/github-transport.js";
import type { AccountRateLimits } from "../../src/state/task-quota.js";
import { openTaskStore, type TaskStore } from "../../src/state/task-store.js";
import { adapterPolicy, adapterTask, adapterTaskBytes } from "../helpers/adapter-fixture.js";
import { FakeTaskExecutor } from "../helpers/fake-task-executor.js";

describe("configured quota dispatch boundary", () => {
  let root: string;
  let store: TaskStore;
  let journal: TransportJournal;
  let options: DeploymentOptions;
  let fake: FakeTaskExecutor;
  const now = new Date("2026-10-03T05:00:00Z");
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "deployment-"));
    await mkdir(join(root, "src"));
    store = await openTaskStore(join(root, "jobs.db"));
    journal = new TransportJournal(join(root, "bus.db"));
    fake = new FakeTaskExecutor(() => now);
    const policy = adapterPolicy(root, now);
    options = {
      store,
      executor: fake,
      policy,
      journal,
      bus: { codec: { signer: { actorId: "recipient" } } } as unknown as GitHubTaskBus,
      autoDispatch: true,
      evaluateBoundedPolicy: false,
      now: () => now,
      authoritySession: () => ({
        actorId: "operator",
        bridgeId: policy.bridgeId,
        sessionId: policy.sessionId,
        expiresAt: policy.expiresAt,
        capabilities: ["approve_task"],
        authenticated: true,
      }),
    };
  });
  afterEach(async () => {
    journal.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const observed = (usedPercent: number): AccountRateLimits => ({
    source: "account/rateLimits/read",
    cliVersion: "fixture",
    protocolVersion: "fixture",
    limits: [
      {
        limitId: "codex",
        primary: { usedPercent, windowDurationMins: 300, resetsAt: now.getTime() / 1000 + 300 },
        secondary: null,
      },
    ],
  });
  async function approve(runtime: ReturnType<typeof createBridgeDeployment>) {
    const task = adapterTask();
    runtime.controller.receive(Buffer.from(JSON.stringify(task)), adapterTaskBytes);
    const grant = await runtime.authority.approve(task.request_id);
    runtime.controller.approve(task.request_id, grant);
    return { task, grant };
  }
  it("denies unknown quota by default", async () => {
    const runtime = createBridgeDeployment(options);
    const { task, grant } = await approve(runtime);
    await expect(runtime.controller.start(task.request_id, grant.approval_id)).rejects.toThrow();
    expect(fake.starts).toBe(0);
  });
  it.each([0, 100])(
    "fresh selected quota %i percent controls the real start gate",
    async (used) => {
      options.quota = { readRateLimits: async () => observed(used) };
      options.quotaLimitId = "codex";
      const runtime = createBridgeDeployment(options);
      const { task, grant } = await approve(runtime);
      if (used === 100)
        await expect(
          runtime.controller.start(task.request_id, grant.approval_id),
        ).rejects.toThrow();
      else await runtime.controller.start(task.request_id, grant.approval_id);
      expect(fake.starts).toBe(used === 100 ? 0 : 1);
    },
  );
  it("an old timed-out quota reply cannot replace a newer unknown observation", async () => {
    let resolveOld: (value: AccountRateLimits) => void = () => {};
    let calls = 0;
    options.quotaGuard = {
      observation: {
        source: "unknown",
        observedAt: null,
        windowEndsAt: null,
        remainingPercent: null,
        maxAgeSeconds: 60,
      },
      fallback: null,
      strictMoneyBudget: false,
    };
    options.quotaTimeoutMs = 3;
    options.quotaLimitId = "codex";
    options.quota = {
      readRateLimits: () => {
        calls++;
        return calls === 1
          ? new Promise((resolve) => {
              resolveOld = resolve;
            })
          : Promise.reject(new Error("unavailable"));
      },
    };
    const runtime = createBridgeDeployment(options);
    const { task, grant } = await approve(runtime);
    await expect(runtime.controller.start(task.request_id, grant.approval_id)).rejects.toThrow();
    await expect(runtime.controller.start(task.request_id, grant.approval_id)).rejects.toThrow();
    resolveOld(observed(0));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(options.quotaGuard.observation.source).toBe("unknown");
    expect(fake.starts).toBe(0);
  });
  it("supports only an explicitly bounded unknown-quota fallback", async () => {
    options.quotaGuard = {
      observation: {
        source: "unknown",
        observedAt: null,
        windowEndsAt: null,
        remainingPercent: null,
        maxAgeSeconds: 60,
      },
      fallback: { preauthorized: true, maxStarts: 1, maxRunSeconds: 10 },
      strictMoneyBudget: false,
    };
    const runtime = createBridgeDeployment(options);
    const { task, grant } = await approve(runtime);
    await runtime.controller.start(task.request_id, grant.approval_id);
    expect(fake.starts).toBe(1);
  });
});
