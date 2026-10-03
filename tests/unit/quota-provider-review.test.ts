import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridgeDeployment, type DeploymentOptions } from "../../src/adapters/deployment.js";
import type { GitHubTaskBus } from "../../src/adapters/github-transport.js";
import { TransportJournal } from "../../src/adapters/github-transport.js";
import { TaskController } from "../../src/state/task-controller.js";
import type { AccountRateLimits } from "../../src/state/task-quota.js";
import { openTaskStore, type TaskStore } from "../../src/state/task-store.js";
import { adapterPolicy, adapterTask, adapterTaskBytes } from "../helpers/adapter-fixture.js";
import { FakeTaskExecutor } from "../helpers/fake-task-executor.js";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("fixture_missing");
  return value;
}
describe("independent provider-bound quota review", () => {
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
    policy.agents.codex = ["fake-model"];
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
    task.agent = "codex";
    runtime.controller.receive(Buffer.from(JSON.stringify(task)), adapterTaskBytes);
    const grant = await runtime.authority.approve(task.request_id);
    runtime.controller.approve(task.request_id, grant);
    return { task, grant };
  }

  it("never admits a manual percentage as provider evidence through TaskController", async () => {
    const runtime = createBridgeDeployment(options);
    const { task, grant } = await approve(runtime);
    const direct = new TaskController(store, fake, options.policy, () => now, {
      providerId: "codex",
      observation: {
        source: "user",
        observedAt: now.toISOString(),
        windowEndsAt: new Date(now.getTime() + 60000).toISOString(),
        remainingPercent: 99,
        maxAgeSeconds: 60,
      },
      fallback: null,
      strictMoneyBudget: false,
    });
    await expect(direct.start(task.request_id, grant.approval_id)).rejects.toThrow(
      "quota_observation_or_authorization_required",
    );
    expect(fake.starts).toBe(0);
  });
  it("manual percentage cannot bypass the explicit unknown fallback runtime bound", async () => {
    const runtime = createBridgeDeployment(options);
    const { task, grant } = await approve(runtime);
    const direct = new TaskController(store, fake, options.policy, () => now, {
      providerId: "codex",
      observation: {
        source: "user",
        observedAt: now.toISOString(),
        windowEndsAt: new Date(now.getTime() + 60000).toISOString(),
        remainingPercent: 99,
        maxAgeSeconds: 60,
      },
      fallback: { preauthorized: true, maxStarts: 1, maxRunSeconds: 3 },
      strictMoneyBudget: false,
    });
    const started = await direct.start(task.request_id, grant.approval_id);
    expect(Date.parse(required(started.intent).deadlineAt) - now.getTime()).toBe(3000);
  });
  it("snapshot mutation and original config mutation cannot enable fallback", async () => {
    options.quotaGuard = {
      observation: {
        source: "unknown",
        observedAt: null,
        windowEndsAt: null,
        remainingPercent: null,
        maxAgeSeconds: 60,
      },
      fallback: { preauthorized: false, maxStarts: 1, maxRunSeconds: 3 },
      strictMoneyBudget: false,
    };
    const runtime = createBridgeDeployment(options);
    const snapshot = runtime.quotaSnapshot();
    required(snapshot.fallback).preauthorized = true;
    required(options.quotaGuard.fallback).preauthorized = true;
    const { task, grant } = await approve(runtime);
    await expect(runtime.controller.start(task.request_id, grant.approval_id)).rejects.toThrow(
      "quota_observation_or_authorization_required",
    );
    expect(fake.starts).toBe(0);
  });
  it("strict money budget is not relaxed by matching provider or fallback", async () => {
    options.quota = { providerId: "codex", readRateLimits: async () => observed(0) };
    options.quotaLimitId = "codex";
    options.quotaGuard = {
      observation: {
        source: "unknown",
        observedAt: null,
        windowEndsAt: null,
        remainingPercent: null,
        maxAgeSeconds: 60,
      },
      fallback: { preauthorized: true, maxStarts: 1, maxRunSeconds: 3 },
      strictMoneyBudget: true,
    };
    const runtime = createBridgeDeployment(options);
    const { task, grant } = await approve(runtime);
    await expect(runtime.controller.start(task.request_id, grant.approval_id)).rejects.toThrow(
      "strict_cost_bound_not_established",
    );
    expect(fake.starts).toBe(0);
  });
  it("wrong selected bucket stays unknown despite other available percentages", async () => {
    options.quota = { providerId: "codex", readRateLimits: async () => observed(0) };
    options.quotaLimitId = "different-bucket";
    const runtime = createBridgeDeployment(options);
    const { task, grant } = await approve(runtime);
    await expect(runtime.controller.start(task.request_id, grant.approval_id)).rejects.toThrow(
      "quota_observation_or_authorization_required",
    );
    expect(runtime.quotaSnapshot().observation.source).toBe("unknown");
    expect(fake.starts).toBe(0);
  });
  it("expired windows cannot authorize a dispatch", async () => {
    options.quota = {
      providerId: "codex",
      readRateLimits: async () => {
        const result = observed(0);
        required(required(result.limits[0]).primary).resetsAt = now.getTime() / 1000;
        return result;
      },
    };
    options.quotaLimitId = "codex";
    const runtime = createBridgeDeployment(options);
    const { task, grant } = await approve(runtime);
    await expect(runtime.controller.start(task.request_id, grant.approval_id)).rejects.toThrow(
      "quota_observation_or_authorization_required",
    );
    expect(fake.starts).toBe(0);
  });
  it("secondary exhaustion cannot be hidden by an available primary window", async () => {
    options.quota = {
      providerId: "codex",
      readRateLimits: async () => {
        const result = observed(0);
        required(result.limits[0]).secondary = {
          usedPercent: 100,
          windowDurationMins: 10080,
          resetsAt: now.getTime() / 1000 + 600,
        };
        return result;
      },
    };
    options.quotaLimitId = "codex";
    const runtime = createBridgeDeployment(options);
    const { task, grant } = await approve(runtime);
    await expect(runtime.controller.start(task.request_id, grant.approval_id)).rejects.toThrow();
    expect(runtime.quotaSnapshot().observation.remainingPercent).toBe(0);
    expect(fake.starts).toBe(0);
  });
  it("late timed-out provider result cannot change the actual deployment snapshot", async () => {
    let release: (v: AccountRateLimits) => void = () => {
      throw new Error("fixture_pending_missing");
    };
    options.quota = {
      providerId: "codex",
      readRateLimits: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    options.quotaLimitId = "codex";
    options.quotaTimeoutMs = 2;
    const runtime = createBridgeDeployment(options);
    const { task, grant } = await approve(runtime);
    await expect(runtime.controller.start(task.request_id, grant.approval_id)).rejects.toThrow();
    release(observed(0));
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.quotaSnapshot().observation.source).toBe("unknown");
    expect(fake.starts).toBe(0);
  });
});
