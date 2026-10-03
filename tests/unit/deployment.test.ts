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
  it("denies unknown quota by default", async () => {
    const runtime = createBridgeDeployment(options);
    const { task, grant } = await approve(runtime);
    await expect(runtime.controller.start(task.request_id, grant.approval_id)).rejects.toThrow();
    expect(fake.starts).toBe(0);
  });
  it.each([0, 100])(
    "fresh selected quota %i percent controls the real start gate",
    async (used) => {
      options.quota = { providerId: "codex", readRateLimits: async () => observed(used) };
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
      providerId: "codex",
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
  it.each(["claude", "antigravity", "chatgpt-browser"])(
    "never uses Codex quota or polls it for %s",
    async (agent) => {
      let reads = 0;
      options.policy.agents[agent] = ["fake-model"];
      options.quota = {
        providerId: "codex",
        readRateLimits: async () => {
          reads++;
          return observed(0);
        },
      };
      options.quotaLimitId = "codex";
      const runtime = createBridgeDeployment(options);
      const task = adapterTask();
      task.agent = agent;
      runtime.controller.receive(Buffer.from(JSON.stringify(task)), adapterTaskBytes);
      const grant = await runtime.authority.approve(task.request_id);
      runtime.controller.approve(task.request_id, grant);
      await expect(runtime.controller.start(task.request_id, grant.approval_id)).rejects.toThrow(
        "quota_observation_or_authorization_required",
      );
      expect(reads).toBe(0);
      expect(fake.starts).toBe(0);
      expect(store.quotaObservations(task.request_id)[0]).toMatchObject({
        providerId: "codex",
        requestedAgent: agent,
        state: "unknown",
        error: "quota_provider_mismatch",
      });
    },
  );
  it("captures provider and selected bucket configuration rather than mutable caller options", async () => {
    let original = 0,
      replacement = 0;
    options.quota = {
      providerId: "codex",
      readRateLimits: async () => {
        original++;
        return observed(0);
      },
    };
    options.quotaLimitId = "codex";
    const runtime = createBridgeDeployment(options);
    options.quota = {
      providerId: "codex",
      readRateLimits: async () => {
        replacement++;
        throw new Error("wrong_provider");
      },
    };
    options.quotaLimitId = "other";
    const { task, grant } = await approve(runtime);
    await runtime.controller.start(task.request_id, grant.approval_id);
    expect(original).toBe(1);
    expect(replacement).toBe(0);
  });
  it("quotaSnapshot is cloned, provider-bound, and makes no provider calls", async () => {
    let reads = 0;
    options.quota = {
      providerId: "codex",
      readRateLimits: async () => {
        reads++;
        return observed(20);
      },
    };
    options.quotaLimitId = "codex";
    const runtime = createBridgeDeployment(options);
    const initial = runtime.quotaSnapshot();
    expect(initial).toMatchObject({
      version: "bridge-quota-snapshot-1",
      providerId: "codex",
      observation: { source: "unknown" },
    });
    expect(reads).toBe(0);
    initial.observation.source = "provider";
    initial.observation.remainingPercent = 100;
    expect(runtime.quotaSnapshot().observation.source).toBe("unknown");
    const { task, grant } = await approve(runtime);
    await runtime.controller.start(task.request_id, grant.approval_id);
    expect(reads).toBe(1);
    expect(runtime.quotaSnapshot().observation.remainingPercent).toBe(80);
    runtime.quotaSnapshot();
    runtime.quotaSnapshot();
    expect(reads).toBe(1);
  });
  it("does not promote a configured percentage to observed evidence merely because a Codex port exists", () => {
    let reads = 0;
    options.quota = {
      providerId: "codex",
      readRateLimits: async () => {
        reads++;
        return observed(0);
      },
    };
    options.quotaLimitId = "codex";
    options.quotaGuard = {
      observation: {
        source: "provider",
        observedAt: now.toISOString(),
        windowEndsAt: new Date(now.getTime() + 60000).toISOString(),
        remainingPercent: 99,
        maxAgeSeconds: 60,
      },
      fallback: null,
      strictMoneyBudget: false,
    };
    const runtime = createBridgeDeployment(options);
    expect(runtime.quotaSnapshot()).toMatchObject({
      providerId: "codex",
      observation: { source: "unknown", observedAt: null, remainingPercent: null },
    });
    expect(reads).toBe(0);
  });
  it("unbound legacy ports and configured percentages stay unknown without polling", async () => {
    let reads = 0;
    options.quota = {
      readRateLimits: async () => {
        reads++;
        return observed(0);
      },
    } as unknown as import("../../src/state/task-quota.js").AccountQuotaPort;
    options.quotaLimitId = "codex";
    options.quotaGuard = {
      observation: {
        source: "provider",
        observedAt: now.toISOString(),
        windowEndsAt: new Date(now.getTime() + 60000).toISOString(),
        remainingPercent: 100,
        maxAgeSeconds: 60,
      },
      fallback: null,
      strictMoneyBudget: false,
    };
    const runtime = createBridgeDeployment(options);
    const { task, grant } = await approve(runtime);
    await expect(runtime.controller.start(task.request_id, grant.approval_id)).rejects.toThrow();
    expect(reads).toBe(0);
    expect(runtime.quotaSnapshot()).toMatchObject({
      providerId: null,
      observation: { source: "unknown" },
    });
  });
  it("a different provider can use only its explicit bounded unknown fallback", async () => {
    let reads = 0;
    options.policy.agents.claude = ["fake-model"];
    options.quota = {
      providerId: "codex",
      readRateLimits: async () => {
        reads++;
        return observed(0);
      },
    };
    options.quotaLimitId = "codex";
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
    const task = adapterTask();
    task.agent = "claude";
    runtime.controller.receive(Buffer.from(JSON.stringify(task)), adapterTaskBytes);
    const grant = await runtime.authority.approve(task.request_id);
    runtime.controller.approve(task.request_id, grant);
    await runtime.controller.start(task.request_id, grant.approval_id);
    expect(reads).toBe(0);
    expect(fake.starts).toBe(1);
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
  it("quota snapshot reads clone the existing guard without provider calls", () => {
    let reads = 0;
    options.quota = {
      readRateLimits: async () => {
        reads++;
        return observed(20);
      },
    };
    options.quotaLimitId = "codex";
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
    const runtime = createBridgeDeployment(options),
      snapshot = runtime.quotaSnapshot();
    snapshot.observation.remainingPercent = 100;
    if (snapshot.fallback) snapshot.fallback.maxStarts = 999;
    expect(runtime.quotaSnapshot().observation.remainingPercent).toBeNull();
    expect(runtime.quotaSnapshot().fallback?.maxStarts).toBe(1);
    expect(reads).toBe(0);
    expect(fake.starts).toBe(0);
  });
});
