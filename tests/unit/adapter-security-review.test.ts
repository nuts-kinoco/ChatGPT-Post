import { fixtureAccept } from "../helpers/materialization-fixture.js";
import {
  fixtureGitDestination,
  fixtureHostedOutputPolicy,
  fixtureOutputContract,
  fixtureProjectRegistry,
} from "../helpers/output-contract-fixture.js";
/** Independent security-regression coverage. Every browser, provider, GitHub and process authority
 * is fake; no network socket, model CLI, account or real browser is opened. */

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserDeliveryPolicy,
  BrowserDeliveryService,
  type BrowserRun,
  type BrowserRunControl,
  productionBrowserRun,
} from "../../src/adapters/browser-delivery.js";
import { CodexQuotaClient } from "../../src/adapters/codex-quota.js";
import { createBridgeDeployment } from "../../src/adapters/deployment.js";
import {
  type GitObjectStore,
  type GitSnapshot,
  gitBlobSha,
} from "../../src/adapters/github-client.js";
import {
  GitHubRecipientPump,
  GitHubTaskBus,
  type HostedEvent,
  SignedBusCodec,
  TransportJournal,
} from "../../src/adapters/github-transport.js";
import { buildRecoveredResult } from "../../src/cli/collect.js";
import { type BridgeConfig, loadConfig } from "../../src/cli/config.js";
import { encodeResponseFrame } from "../../src/contracts/response-frame.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import type { TaskSpec } from "../../src/contracts/task-types.js";
import { TaskController } from "../../src/state/task-controller.js";
import type { QuotaObservation } from "../../src/state/task-preflight.js";
import type { AccountQuotaPort, AccountRateLimits } from "../../src/state/task-quota.js";
import { openTaskStore } from "../../src/state/task-store.js";
import {
  adapterPolicy,
  adapterTask,
  adapterTaskBytes as prompt,
} from "../helpers/adapter-fixture.js";
import { FakeTaskExecutor } from "../helpers/fake-task-executor.js";

class MemoryGit implements GitObjectStore {
  files = new Map<string, string>();
  blobs = new Map<string, Uint8Array>();
  async snapshot() {
    return { commit: "a".repeat(40), tree: "b".repeat(40), files: new Map(this.files) };
  }
  async read(s: GitSnapshot, p: string) {
    return this.blobs.get(s.files.get(p) ?? "") ?? null;
  }
  async append(files: ReadonlyMap<string, Uint8Array>) {
    for (const [p, b] of files)
      if (this.files.has(p) && this.files.get(p) !== gitBlobSha(b))
        throw new Error("github_immutable_conflict");
    for (const [p, b] of files) {
      const h = gitBlobSha(b);
      this.files.set(p, h);
      this.blobs.set(h, b);
    }
    return "a".repeat(40);
  }
}
const keys = {
  requester: generateKeyPairSync("ed25519"),
  recipient: generateKeyPairSync("ed25519"),
};
const bus = (g: GitObjectStore, id: keyof typeof keys) =>
  new GitHubTaskBus(
    fixtureGitDestination(g),
    new SignedBusCodec(
      Object.entries(keys).map(([actorId, k]) => ({
        actorId,
        publicKeyPem: k.publicKey.export({ type: "spki", format: "pem" }).toString(),
        roles: [actorId as "requester" | "recipient"],
      })),
      { actorId: id, sign: async (b) => sign(null, b, keys[id].privateKey) },
    ),
    "bridge-v2",
    {},
    fixtureProjectRegistry,
  );
let clock = Date.parse("2026-10-03T05:00:00Z");
const now = () => new Date(clock);
const policy = (): BrowserDeliveryPolicy => ({
  recipientId: "recipient",
  requesterIds: ["requester"],
  expectedOutputPolicy: fixtureHostedOutputPolicy(),
  conversationUrl: "https://chatgpt.com/c/fixture",
  model: "current",
  preset: "current",
  maxStarts: 100,
  deadlineAt: "2026-10-03T06:00:00Z",
  maxResponseBytes: 10000,
});
let dirs: string[] = [];
let services: BrowserDeliveryService[] = [];
let close: (() => void)[] = [];
afterEach(async () => {
  for (const s of services) s.close();
  for (const c of close) c();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  services = [];
  dirs = [];
  close = [];
  clock = Date.parse("2026-10-03T05:00:00Z");
});
async function directory() {
  const d = await mkdtemp(join(tmpdir(), "bridge-review-"));
  dirs.push(d);
  return d;
}
async function service(g: GitObjectStore, run: BrowserRun, pol = policy()) {
  const d = await directory();
  const s = new BrowserDeliveryService(
    bus(g, "recipient"),
    loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: d }),
    pol,
    run,
    now,
  );
  services.push(s);
  return s;
}
async function issue(g: GitObjectStore, s: BrowserDeliveryService) {
  const t = adapterTask();
  t.agent = "chatgpt-browser";
  t.requested_model = "current";
  t.policy_snapshot_sha256 = s.policyHash;
  await bus(g, "requester").issue(
    Buffer.from(JSON.stringify(t)),
    prompt,
    "recipient",
    "ordinary_chat_browser",
    fixtureOutputContract(Buffer.from(JSON.stringify(t))),
  );
  return t;
}
function approve(s: BrowserDeliveryService, t: TaskSpec) {
  s.approve(t.request_id, {
    actorId: "operator",
    taskSpecHash: sha256Bytes(Buffer.from(JSON.stringify(t))),
    expiresAt: "2026-10-03T05:05:00Z",
    authenticated: true,
  });
}
async function result(path: string) {
  const q = JSON.parse(await readFile(path, "utf8"));
  const r = buildRecoveredResult(
    {
      requestId: q.requestId,
      conversationUrl: q.conversationUrl,
      submittedAt: now().toISOString(),
      baselineAssistantCount: 0,
    },
    { markdown: "fixture response", method: "dom", quality: "full", modelSlug: null },
    join(dirname(path), "response.md"),
    "test",
    now(),
  );
  await writeFile(
    join(dirname(path), "response.md"),
    encodeResponseFrame(
      "fixture response",
      JSON.parse(await readFile(join(dirname(path), "framing.json"), "utf8")),
    ),
  );
  await writeFile(join(dirname(path), "result.json"), JSON.stringify(r));
  return r;
}
describe("independent offline adversarial adapter checks", () => {
  it("only one independent durable host may claim one recipient request", async () => {
    const g = new MemoryGit();
    let sends = 0;
    const a = await service(g, async (p) => {
        sends++;
        return result(p);
      }),
      b = await service(g, async (p) => {
        sends++;
        return result(p);
      });
    const t = await issue(g, a);
    expect((await a.poll()).received).toEqual([t.request_id]);
    expect((await b.poll()).blocked).toHaveLength(1);
    expect(b.get(t.request_id)).toBeNull();
    approve(a, t);
    await a.start(t.request_id);
    expect(sends).toBe(1);
  });
  it("reconcile before start returns preserves already-published event and accepts reordered ACK", async () => {
    const g = new MemoryGit();
    let release = () => {};
    let written = () => {};
    const wait = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (written = r));
    const s = await service(g, async (p) => {
      const r = await result(p);
      written();
      await wait;
      return r;
    });
    const t = await issue(g, s);
    await s.poll();
    approve(s, t);
    const starting = s.start(t.request_id);
    await ready;
    await s.reconcile(t.request_id);
    const event = s.get(t.request_id)?.event;
    if (!event) throw new Error("fixture_event_missing");
    release();
    await starting;
    expect(s.get(t.request_id)?.event?.eventId).toBe(event.eventId);
    await s.reconcile(t.request_id);
    const ack: HostedEvent = { ...event, actorId: "requester", stage: "hosted_ack" };
    const requesterBus = bus(g, "requester");
    await fixtureAccept(bus(g, "recipient"), requesterBus, t.request_id, true);
    // A valid signature over the same semantic ACK may use another JSON key order.
    const path = requesterBus.path("hosted", t.request_id, "hosted_ack.json");
    g.files.delete(path);
    await g.append(
      new Map([
        [
          path,
          await requesterBus.codec.encode({
            kind: "hosted",
            event: Object.fromEntries(Object.entries(ack).reverse()) as unknown as HostedEvent,
          }),
        ],
      ]),
    );
    expect((await s.reconcile(t.request_id)).acknowledged).toBe(true);
  });
  it("cancellation persists and signals an active browser invocation", async () => {
    const g = new MemoryGit();
    let control: BrowserRunControl | undefined;
    let release = () => {};
    let entered = () => {};
    const wait = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (entered = r));
    const s = await service(g, async (_p, c) => {
      control = c;
      entered();
      await wait;
      return null;
    });
    const t = await issue(g, s);
    await s.poll();
    approve(s, t);
    const starting = s.start(t.request_id);
    await ready;
    await s.cancel(t.request_id);
    expect(control?.signal.aborted).toBe(true);
    expect(control?.shouldCancel()).toBe(true);
    release();
    await starting;
    expect(s.get(t.request_id)?.cancelRequestedAt).toBeTruthy();
    await expect(s.start(t.request_id)).rejects.toThrow("denied");
  });
  it("approval lifetime is capped by exact task age and long sessions do not extend task timeout", async () => {
    const g = new MemoryGit();
    let request: { timeoutMs?: number; conversationUrl?: string } = {};
    const s = await service(g, async (p) => {
      request = JSON.parse(await readFile(p, "utf8"));
      return null;
    });
    const t = await issue(g, s);
    await s.poll();
    approve(s, t);
    expect(Date.parse(s.get(t.request_id)?.approval?.expiresAt ?? "") - clock).toBe(60000);
    await s.start(t.request_id);
    expect(request.timeoutMs).toBe(10000);
    expect(Date.parse(s.get(t.request_id)?.deadlineAt ?? "") - clock).toBe(10000);
  });
  it("bound hosted policy is unaffected by caller object mutations", async () => {
    const g = new MemoryGit();
    const p = policy();
    let request: { timeoutMs?: number; conversationUrl?: string } = {};
    const s = await service(
      g,
      async (path) => {
        request = JSON.parse(await readFile(path, "utf8"));
        return null;
      },
      p,
    );
    const t = await issue(g, s);
    await s.poll();
    approve(s, t);
    try {
      p.conversationUrl = "https://chatgpt.com/c/changed";
    } catch {}
    await s.start(t.request_id);
    expect(request.conversationUrl).toBe("https://chatgpt.com/c/fixture");
  });
  it("rotates reconciliation past 32 unknown requests", async () => {
    const g = new MemoryGit(),
      s = await service(g, async () => null);
    const tasks = [];
    for (let i = 0; i < 33; i++) tasks.push(await issue(g, s));
    await s.poll(256);
    for (const t of tasks) {
      approve(s, t);
      await s.start(t.request_id);
    }
    const one = await s.tick(),
      two = await s.tick();
    expect(new Set([...one.reconciled, ...two.reconciled]).size).toBe(33);
  });
  it("does not publish unrelated locally received tasks to GitHub", async () => {
    const g = new MemoryGit(),
      d = await directory();
    const st = await openTaskStore(join(d, "jobs.db")),
      j = new TransportJournal(join(d, "transport.db"));
    close.push(
      () => st.close(),
      () => j.close(),
    );
    const t = adapterTask();
    const c = new TaskController(st, new FakeTaskExecutor(now), adapterPolicy(d, now()), now);
    c.receive(Buffer.from(JSON.stringify(t)), prompt);
    const tick = await new GitHubRecipientPump(bus(g, "recipient"), c, j, () => clock).tick();
    expect(tick.delivered).toEqual([]);
    expect(g.files.size).toBe(0);
  });
  it("retains no accumulating quota buffer after malformed/oversized stream failure", async () => {
    const input = new PassThrough(),
      output = new PassThrough(),
      c = new CodexQuotaClient(input, output, "fake", "fake");
    output.write(Buffer.alloc(1048577, 97));
    output.write(Buffer.alloc(2097152, 97));
    const state = c as unknown as { ended: boolean; buffer: Buffer };
    expect(state.ended).toBe(true);
    expect(state.buffer.length).toBe(0);
    c.close();
  });
  it("late quota read cannot overwrite the unknown state of a newer failed refresh", async () => {
    const g = new MemoryGit(),
      d = await directory();
    const st = await openTaskStore(join(d, "jobs.db")),
      j = new TransportJournal(join(d, "transport.db"));
    close.push(
      () => st.close(),
      () => j.close(),
    );
    let resolve: (value: AccountRateLimits) => void = () => {};
    let calls = 0;
    const pending = new Promise<AccountRateLimits>((r) => (resolve = r));
    const dep = createBridgeDeployment({
      store: st,
      journal: j,
      executor: new FakeTaskExecutor(now),
      policy: adapterPolicy(d, now()),
      bus: bus(g, "recipient"),
      authoritySession: () => {
        throw Error("unused");
      },
      quota: {
        readRateLimits: async () => {
          if (++calls === 1) return pending;
          throw Error("quota_unavailable");
        },
      },
      quotaLimitId: "codex",
      autoDispatch: false,
      evaluateBoundedPolicy: false,
      now,
    });
    const quota = dep.controller as unknown as {
      quotaSource: AccountQuotaPort;
      quotaGuard: { observation: QuotaObservation };
    };
    const old = quota.quotaSource.readRateLimits();
    await expect(quota.quotaSource.readRateLimits()).rejects.toThrow("unavailable");
    resolve({
      source: "account/rateLimits/read",
      cliVersion: "fake",
      protocolVersion: "fake",
      limits: [
        {
          limitId: "codex",
          primary: {
            usedPercent: 10,
            windowDurationMins: 300,
            resetsAt: Math.floor(clock / 1000) + 3600,
          },
          secondary: null,
        },
      ],
    });
    await old.catch(() => {});
    expect(quota.quotaGuard.observation.source).toBe("unknown");
  });
});

type FakeBrowserPorts = { chatgpt: { dispatchSubmit(...args: unknown[]): Promise<unknown> } };
const f = vi.hoisted(() => ({
  dispatch: vi.fn(),
  interrupt: vi.fn(),
  run: vi.fn(),
  ports: undefined as FakeBrowserPorts | undefined,
  config: undefined as BridgeConfig | undefined,
}));
vi.mock("../../src/cli/adapters.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/cli/adapters.js")>()),
  buildPorts: (c: BridgeConfig) => {
    f.config = c;
    return { chatgpt: { dispatchSubmit: f.dispatch } };
  },
}));
vi.mock("../../src/state/controller.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/state/controller.js")>()),
  RunController: class {
    constructor(p: FakeBrowserPorts) {
      f.ports = p;
    }
    run() {
      return f.run();
    }
    interrupt(c: string) {
      return f.interrupt(c);
    }
  },
}));
const config = loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: "/tmp/review-only-not-opened" });
describe("independent production browser cancellation/deadline wrapper, mocked ports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    f.dispatch.mockResolvedValue({ kind: "dispatched", url: "https://chatgpt.com/c/fixture" });
    f.interrupt.mockResolvedValue(undefined);
    f.run.mockImplementation(async () => {
      await f.ports?.chatgpt.dispatchSubmit({}, { newChat: false });
      return { result: null };
    });
  });
  it("does not dispatch an already-aborted operation", async () => {
    const c = new AbortController();
    c.abort();
    await productionBrowserRun(config)("/tmp/not-a-real-request", {
      signal: c.signal,
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
      shouldCancel: () => false,
    });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.interrupt).toHaveBeenCalledOnce();
  });
  it("does not dispatch after durable cancel", async () => {
    await productionBrowserRun(config)("/tmp/not-a-real-request", {
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
      shouldCancel: () => true,
    });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.interrupt).toHaveBeenCalledOnce();
  });
  it("does not dispatch after absolute deadline", async () => {
    await productionBrowserRun(config)("/tmp/not-a-real-request", {
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() - 1).toISOString(),
      shouldCancel: () => false,
    });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.interrupt).toHaveBeenCalledOnce();
  });
  it("pins production browser config before caller can mutate the profile", async () => {
    const original = { ...config, profileDir: "/trusted/first" };
    const run = productionBrowserRun(original);
    original.profileDir = "/other/profile";
    await run("/tmp/not-a-real-request", {
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
      shouldCancel: () => false,
    });
    expect(f.config?.profileDir).toBe("/trusted/first");
  });
  it("polls durable cancellation while operation remains running", async () => {
    let cancel = false;
    f.run.mockImplementation(async () => {
      cancel = true;
      await new Promise((r) => setTimeout(r, 160));
      return { result: null };
    });
    await productionBrowserRun(config)("/tmp/not-a-real-request", {
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
      shouldCancel: () => cancel,
    });
    expect(f.interrupt).toHaveBeenCalledOnce();
  });
});
