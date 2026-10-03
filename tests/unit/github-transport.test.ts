import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeHost } from "../../src/adapters/bridge-host.js";
import { GitHubFanout } from "../../src/adapters/fanout.js";
import {
  GitHubGitStore,
  type GitObjectStore,
  type GitSnapshot,
  gitBlobSha,
} from "../../src/adapters/github-client.js";
import {
  GitHubRecipientPump,
  GitHubTaskBus,
  SignedBusCodec,
  TransportJournal,
} from "../../src/adapters/github-transport.js";
import { LocalTaskAuthority } from "../../src/adapters/local-authority.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";
import { TaskController } from "../../src/state/task-controller.js";
import { openTaskStore, type TaskStore } from "../../src/state/task-store.js";
import { adapterPolicy, adapterTask, adapterTaskBytes } from "../helpers/adapter-fixture.js";
import { FakeTaskExecutor } from "../helpers/fake-task-executor.js";
import {
  fixtureAccept,
  fixtureManifest,
  fixtureReceipt,
} from "../helpers/materialization-fixture.js";
import {
  fixtureGitDestination,
  fixtureOutputContract,
  fixtureProjectRegistry,
} from "../helpers/output-contract-fixture.js";

class MemoryGit implements GitObjectStore {
  blobs = new Map<string, Uint8Array>();
  files = new Map<string, string>();
  count = 0;
  failure = false;
  async snapshot(): Promise<GitSnapshot> {
    return {
      commit: String(this.count).padStart(40, "0"),
      tree: "a".repeat(40),
      files: new Map(this.files),
    };
  }
  async read(snapshot: GitSnapshot, path: string) {
    const hash = snapshot.files.get(path);
    return hash ? (this.blobs.get(hash) ?? null) : null;
  }
  async append(files: ReadonlyMap<string, Uint8Array>) {
    if (this.failure) throw new Error("github_http_403");
    for (const [path, bytes] of files)
      if (this.files.has(path) && this.files.get(path) !== gitBlobSha(bytes))
        throw new Error("github_immutable_conflict");
    for (const [path, bytes] of files) {
      const hash = gitBlobSha(bytes);
      this.blobs.set(hash, bytes);
      this.files.set(path, hash);
    }
    this.count++;
    return String(this.count).padStart(40, "0");
  }
}
const keys = {
  requester: generateKeyPairSync("ed25519"),
  recipient: generateKeyPairSync("ed25519"),
};
function codec(actorId: keyof typeof keys) {
  return new SignedBusCodec(
    Object.entries(keys).map(([id, key]) => ({
      actorId: id,
      publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
      roles: [id as "requester" | "recipient"],
    })),
    { actorId, sign: async (raw) => sign(null, raw, keys[actorId].privateKey) },
  );
}
describe("signed GitHub roundtrip (fake network and executor)", () => {
  let dir: string;
  let store: TaskStore;
  let journal: TransportJournal;
  let git: MemoryGit;
  let recipient: GitHubTaskBus;
  let requester: GitHubTaskBus;
  let controller: TaskController;
  let executor: FakeTaskExecutor;
  let pump: GitHubRecipientPump;
  let authority: LocalTaskAuthority;
  let clock: number;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-bus-"));
    await mkdir(join(dir, "src"));
    clock = Date.parse("2026-10-03T05:00:00Z");
    store = await openTaskStore(join(dir, "jobs.db"));
    journal = new TransportJournal(join(dir, "transport.db"));
    git = fixtureGitDestination(new MemoryGit());
    recipient = new GitHubTaskBus(git, codec("recipient"), "bridge-v2", {}, fixtureProjectRegistry);
    requester = new GitHubTaskBus(git, codec("requester"), "bridge-v2", {}, fixtureProjectRegistry);
    executor = new FakeTaskExecutor(() => new Date(clock));
    const policy = adapterPolicy(dir, new Date(clock));
    controller = new TaskController(store, executor, policy, () => new Date(clock));
    authority = new LocalTaskAuthority(
      controller,
      () => ({
        actorId: "operator",
        bridgeId: policy.bridgeId,
        sessionId: policy.sessionId,
        expiresAt: policy.expiresAt,
        capabilities: ["approve_task", "approve_workflow"],
        authenticated: true,
      }),
      () => new Date(clock),
    );
    pump = new GitHubRecipientPump(recipient, controller, journal, () => clock);
  });
  afterEach(async () => {
    journal.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function issue() {
    const task = adapterTask();
    await requester.issue(Buffer.from(JSON.stringify(task)), adapterTaskBytes, "recipient");
    return task;
  }
  async function start() {
    const task = await issue();
    await pump.tick();
    const grant = await authority.approve(task.request_id);
    controller.approve(task.request_id, grant);
    await controller.start(task.request_id, grant.approval_id);
    return task;
  }
  it("stores product/request folders with a global signed request index", async () => {
    const task = await issue();
    const paths = [...git.files.keys()];
    expect(paths).toContain(`bridge-v2/projects/PixivVault/requests/${task.request_id}/task.json`);
    expect(paths).toContain(`bridge-v2/projects/PixivVault/requests/${task.request_id}/task.md`);
    expect(paths).toContain(`bridge-v2/request-index/${task.request_id}.json`);
    await pump.tick();
    expect([...git.files.keys()]).toContain(
      `bridge-v2/projects/PixivVault/requests/${task.request_id}/claim.json`,
    );
  });
  it("registered project mapping cannot be chosen by task text or alias casing", async () => {
    const task = adapterTask();
    task.repo = "unregistered";
    await expect(
      requester.issue(Buffer.from(JSON.stringify(task)), adapterTaskBytes, "recipient"),
    ).rejects.toThrow("project_not_registered");
    expect(
      () =>
        new GitHubTaskBus(git, codec("recipient"), "bridge-v2", {
          first: "PixivVault",
          second: "pixivvault",
        }),
    ).toThrow("registry_invalid");
  });
  it("global UUID index rejects reuse under a different registered product", async () => {
    const a = new GitHubTaskBus(git, codec("requester"), "bridge-v2", {
      "fixture-repo": "PixivVault",
      other: "EMAKINOCO-Windows",
    });
    const task = adapterTask();
    await a.issue(Buffer.from(JSON.stringify(task)), adapterTaskBytes, "recipient");
    task.repo = "other";
    const b = new GitHubTaskBus(git, codec("requester"), "bridge-v2", {
      "fixture-repo": "PixivVault",
      other: "EMAKINOCO-Windows",
    });
    await expect(
      b.issue(Buffer.from(JSON.stringify(task)), adapterTaskBytes, "recipient"),
    ).rejects.toThrow("immutable_conflict");
  });
  it.each([
    "chat-first",
    "cli-first",
    "simultaneous",
    "chat-auth-blocked",
    "cli-timeout",
    "save-failure",
  ])("fanout collects two routes independently: %s", async (scenario) => {
    const cli = adapterTask();
    const chat = adapterTask();
    chat.agent = "chatgpt-browser";
    chat.requested_model = "current";
    const fanoutId = randomUUID();
    const fanout = new GitHubFanout(requester);
    const inputs = [
      {
        raw: Buffer.from(JSON.stringify(cli)),
        taskBytes: adapterTaskBytes,
        recipientId: "recipient",
        route: "cli" as const,
      },
      {
        raw: Buffer.from(JSON.stringify(chat)),
        taskBytes: adapterTaskBytes,
        recipientId: "recipient",
        route: "ordinary_chat_browser" as const,
        outputContractRaw: fixtureOutputContract(Buffer.from(JSON.stringify(chat))),
      },
    ];
    await fanout.issue(fanoutId, inputs);
    await fanout.issue(fanoutId, inputs);
    expect(await fanout.collect(fanoutId)).toMatchObject({ total: 2, available: 0, pending: 2 });
    await pump.tick();
    const grant = await authority.approve(cli.request_id);
    controller.approve(cli.request_id, grant);
    await controller.start(cli.request_id, grant.approval_id);
    const hostedBytes = Buffer.from(
      JSON.stringify({
        version: "hosted-response-1",
        attemptId: randomUUID(),
        localExecution: false,
        synthetic: true,
        result: {
          status: scenario === "chat-auth-blocked" ? "manual_intervention_required" : "completed",
        },
        markdown: "synthetic browser response",
      }),
    );
    const hostedEvent = {
      version: "hosted-response-1" as const,
      requestId: chat.request_id,
      taskSpecHash: sha256Bytes(inputs[1]?.raw ?? Buffer.alloc(0)),
      eventId: randomUUID(),
      actorId: "recipient",
      payloadSha256: sha256Bytes(hostedBytes),
      stage: "hosted_result" as const,
    };
    const finishChat = () => recipient.publishHosted(hostedEvent, hostedBytes);
    const finishCli = async () => {
      if (scenario === "cli-timeout") {
        clock += 11000;
        await controller.status(cli.request_id);
      } else {
        executor.finish(store.get(cli.request_id)?.intent?.runId ?? "", "succeeded");
        await controller.collect(cli.request_id);
      }
      await pump.tick();
    };
    if (scenario === "cli-first") {
      await finishCli();
      expect((await fanout.collect(fanoutId)).available).toBe(1);
      await finishChat();
    } else if (scenario === "simultaneous") await Promise.all([finishChat(), finishCli()]);
    else {
      await finishChat();
      expect((await fanout.collect(fanoutId)).available).toBe(1);
      await finishCli();
    }
    if (scenario === "save-failure") {
      git.failure = true;
      await expect(fixtureAccept(recipient, requester, chat.request_id, true)).rejects.toThrow();
      git.failure = false;
    }
    let collected = await fanout.collect(fanoutId);
    expect(collected).toMatchObject({ available: 2, acknowledged: 0, pending: 0 });
    if (scenario === "chat-auth-blocked")
      expect(collected.children.find((child) => child.requestId === chat.request_id)?.outcome).toBe(
        "manual_intervention_required",
      );
    if (scenario === "cli-timeout")
      expect(collected.children.find((child) => child.requestId === cli.request_id)?.outcome).toBe(
        "failed",
      );
    await fixtureAccept(recipient, requester, chat.request_id, true);
    collected = await fanout.collect(fanoutId);
    expect(collected.acknowledged).toBe(1);
    await fixtureAccept(recipient, requester, cli.request_id);
    await pump.tick();
    expect((await fanout.collect(fanoutId)).acknowledged).toBe(2);
    expect(executor.starts).toBe(1);
  });
  it("fanout unknown CLI result does not block an available normal Chat response", async () => {
    const cli = adapterTask();
    const chat = adapterTask();
    const fanout = new GitHubFanout(requester);
    const fanoutId = randomUUID();
    await fanout.issue(fanoutId, [
      {
        raw: Buffer.from(JSON.stringify(cli)),
        taskBytes: adapterTaskBytes,
        recipientId: "recipient",
        route: "cli",
      },
      {
        raw: Buffer.from(JSON.stringify(chat)),
        taskBytes: adapterTaskBytes,
        recipientId: "recipient",
        route: "ordinary_chat_browser",
        outputContractRaw: fixtureOutputContract(Buffer.from(JSON.stringify(chat))),
      },
    ]);
    await pump.tick();
    const grant = await authority.approve(cli.request_id);
    controller.approve(cli.request_id, grant);
    executor.disconnected = true;
    await controller.start(cli.request_id, grant.approval_id);
    const bytes = Buffer.from('{"synthetic":true,"result":{"status":"completed"}}');
    await recipient.publishHosted(
      {
        version: "hosted-response-1",
        requestId: chat.request_id,
        taskSpecHash: sha256Bytes(Buffer.from(JSON.stringify(chat))),
        eventId: randomUUID(),
        actorId: "recipient",
        payloadSha256: sha256Bytes(bytes),
        stage: "hosted_result",
      },
      bytes,
    );
    expect(await fanout.collect(fanoutId)).toMatchObject({ total: 2, available: 1, pending: 1 });
    expect(executor.starts).toBe(1);
  });
  it("host coordinator advances only approved jobs and safely reconciles subsequent ticks", async () => {
    const task = await issue();
    const host = new BridgeHost(pump, authority, {
      autoDispatch: true,
      evaluateBoundedPolicy: false,
      maxPerTick: 32,
    });
    await host.tick();
    expect(executor.starts).toBe(0);
    const grant = await authority.approve(task.request_id);
    controller.approve(task.request_id, grant);
    await host.tick();
    expect(executor.starts).toBe(1);
    executor.finish(store.get(task.request_id)?.intent?.runId ?? "", "succeeded");
    await host.tick();
    await host.tick();
    expect(executor.starts).toBe(1);
    await fixtureAccept(recipient, requester, task.request_id);
    await host.tick();
    expect(store.pendingDeliveries()).toHaveLength(0);
  });
  it("atomic request -> claim -> approval -> start -> result -> explicit ACK; duplicate events never execute twice", async () => {
    const task = await start();
    await pump.tick();
    const run = store.get(task.request_id)?.intent?.runId;
    expect(run).toBeTruthy();
    executor.finish(run ?? "", "succeeded");
    await controller.collect(task.request_id);
    await pump.tick();
    expect(store.pendingDeliveries()).toHaveLength(1);
    let accepted = 0;
    await fixtureAccept(recipient, requester, task.request_id, false, async (raw, event) => {
      expect(sha256Bytes(raw)).toBe(event.payloadSha256);
      accepted++;
    });
    const tick = await pump.tick();
    expect(tick.acknowledged).toEqual([task.request_id]);
    expect(store.pendingDeliveries()).toHaveLength(0);
    await pump.tick();
    expect(executor.starts).toBe(1);
    expect(accepted).toBe(1);
    expect(tick.blocked).toEqual([]);
  });
  it.each(["failed", "cancelled"] as const)(
    "returns %s evidence without retrying the job",
    async (status) => {
      const task = await start();
      if (status === "cancelled") await controller.cancel(task.request_id);
      else {
        executor.finish(store.get(task.request_id)?.intent?.runId ?? "", status);
        await controller.collect(task.request_id);
      }
      await pump.tick();
      await fixtureAccept(recipient, requester, task.request_id, false, async (raw) => {
        expect(JSON.parse(Buffer.from(raw).toString()).status).toBe(status);
      });
      await pump.tick();
      expect(executor.starts).toBe(1);
    },
  );
  it("timeout waits for termination and publishes failure", async () => {
    const task = await start();
    clock += 11000;
    await controller.status(task.request_id);
    await pump.tick();
    expect(store.get(task.request_id)?.result.status).toBe("failed");
    expect(executor.starts).toBe(1);
  });
  it("unknown dispatch survives journal reopen without second start", async () => {
    const task = await issue();
    await pump.tick();
    const grant = await authority.approve(task.request_id);
    controller.approve(task.request_id, grant);
    executor.disconnected = true;
    await controller.start(task.request_id, grant.approval_id);
    journal.close();
    journal = new TransportJournal(join(dir, "transport.db"));
    pump = new GitHubRecipientPump(recipient, controller, journal, () => clock);
    await pump.tick();
    expect(executor.starts).toBe(1);
    expect(store.get(task.request_id)?.result.status).toBe("unknown");
  });
  it("permission denied retains delivery and retry preserves terminal bytes", async () => {
    const task = await start();
    executor.finish(store.get(task.request_id)?.intent?.runId ?? "", "succeeded");
    await controller.collect(task.request_id);
    const before = store.deliveryPayload(task.request_id);
    git.failure = true;
    expect((await pump.tick()).blocked[0]?.reason).toBe("github_http_403");
    git.failure = false;
    clock += 3000;
    await pump.tick();
    expect(store.deliveryPayload(task.request_id)).toEqual(before);
    expect(executor.starts).toBe(1);
  });
  it("two independent ledgers cannot both own one recipient claim", async () => {
    const task = await issue();
    await pump.tick();
    const other = new TransportJournal(join(dir, "other-transport.db"));
    try {
      const competitor = new GitHubRecipientPump(recipient, controller, other, () => clock);
      expect(other.claimantId).not.toBe(journal.claimantId);
      expect((await competitor.tick()).blocked).toContainEqual({
        requestId: task.request_id,
        reason: "github_immutable_conflict",
      });
    } finally {
      other.close();
    }
  });
  it("rejects modified exact request bytes before local admission", async () => {
    const task = await issue();
    const path = requester.path("inbox", task.request_id, "task.md");
    const raw = Buffer.from("malicious replacement");
    git.files.set(path, gitBlobSha(raw));
    git.blobs.set(gitBlobSha(raw), raw);
    expect((await pump.tick()).blocked[0]?.reason).toBe("transport_payload_hash_mismatch");
    expect(store.get(task.request_id)).toBeNull();
  });
  it("bounds a stalled signer and never publishes a late signature", async () => {
    let release: ((value: Uint8Array) => void) | undefined;
    let signedRaw: Uint8Array | undefined;
    const signer = {
      actorId: "requester",
      sign: (raw: Uint8Array) => {
        signedRaw = raw;
        return new Promise<Uint8Array>((resolve) => {
          release = resolve;
        });
      },
    };
    const identities = Object.entries(keys).map(([actorId, key]) => ({
      actorId,
      publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
      roles: [actorId as "requester" | "recipient"],
    }));
    const stalled = new SignedBusCodec(identities, signer, 5);
    const bus = new GitHubTaskBus(git, stalled, "bridge-v2", {}, fixtureProjectRegistry);
    await expect(
      bus.issue(Buffer.from(JSON.stringify(adapterTask())), adapterTaskBytes, "recipient"),
    ).rejects.toThrow("transport_signer_timeout");
    expect(git.files.size).toBe(0);
    if (!signedRaw) throw new Error("fixture_signer_not_called");
    release?.(sign(null, signedRaw, keys.requester.privateKey));
    await new Promise((resolve) => setImmediate(resolve));
    expect(git.files.size).toBe(0);
    expect(executor.starts).toBe(0);
  });
  it.each([0, NaN, Infinity, 1.1, 30001])("rejects invalid signer timeout %s", (timeout) => {
    const key = keys.requester;
    const identity = {
      actorId: "requester",
      publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
      roles: ["requester" as const],
    };
    expect(
      () =>
        new SignedBusCodec(
          [identity],
          { actorId: "requester", sign: async (bytes) => sign(null, bytes, key.privateKey) },
          timeout,
        ),
    ).toThrow("timeout_invalid");
  });
  it("rejects stale preview and registry changes during async signing before publication", async () => {
    const registry = new ProjectRegistry(join(dir, "preview-registry.db"));
    const project = fixtureProjectRegistry.snapshot().projects[0];
    if (!project) throw new Error("fixture");
    try {
      registry.configure(
        {
          schema: "bridge-project-registry-1",
          revision: 1,
          defaultOutputRoot: null,
          projects: [project],
        },
        0,
      );
      const expected = {
        projectId: project.projectId,
        registryRevision: 1,
        snapshotSha256: registry.snapshotHash(1),
      };
      const raw = Buffer.from(JSON.stringify(adapterTask()));
      const changing = codec("requester");
      const signer = changing.signer.sign;
      changing.signer.sign = async (bytes) => {
        registry.configure(
          {
            schema: "bridge-project-registry-1",
            revision: 2,
            defaultOutputRoot: "/later",
            projects: [project],
          },
          1,
        );
        return signer(bytes);
      };
      const bus = new GitHubTaskBus(git, changing, "bridge-v2", {}, registry);
      await expect(
        bus.issue(raw, adapterTaskBytes, "recipient", "cli", undefined, expected),
      ).rejects.toThrow("preview_stale");
      expect(git.files.size).toBe(0);
      await expect(
        new GitHubTaskBus(git, codec("requester"), "bridge-v2", {}, registry).issue(
          raw,
          adapterTaskBytes,
          "recipient",
          "cli",
          undefined,
          expected,
        ),
      ).rejects.toThrow("preview_stale");
      expect(git.files.size).toBe(0);
    } finally {
      registry.close();
    }
  });
  it("versioned hosted issuance atomically binds exact contract body and registered destination", async () => {
    const task = adapterTask(),
      raw = Buffer.from(JSON.stringify(task)),
      contract = fixtureOutputContract(raw);
    await requester.issue(raw, adapterTaskBytes, "recipient", "ordinary_chat_browser", contract);
    const received = await recipient.readIssued(
      await git.snapshot(),
      recipient.path("inbox", task.request_id, "issued.json"),
    );
    expect(received.issued.version).toBe("bridge-issued-2");
    expect(received.issued.outputContractSha256).toBe(sha256Bytes(contract));
    expect(Buffer.from(received.outputContractRaw ?? []).equals(Buffer.from(contract))).toBe(true);
    expect(git.files.size).toBe(5);
    const alternate = Buffer.from(
      JSON.stringify(JSON.parse(Buffer.from(contract).toString()), null, 2),
    );
    await expect(
      requester.issue(raw, adapterTaskBytes, "recipient", "ordinary_chat_browser", alternate),
    ).rejects.toThrow("immutable_conflict");
  });
  it.each(["missing", "task", "md", "actor", "policy", "revision", "destination"])(
    "rejects hosted contract %s without partial issuance",
    async (kind) => {
      const task = adapterTask(),
        raw = Buffer.from(JSON.stringify(task));
      const c = JSON.parse(Buffer.from(fixtureOutputContract(raw)).toString());
      if (kind === "task") c.taskSpecHash = "f".repeat(64);
      if (kind === "md") c.taskFileHash = "f".repeat(64);
      if (kind === "actor") c.recipientActorId = "other";
      if (kind === "policy") c.policySnapshotSha256 = "f".repeat(64);
      if (kind === "revision") c.registryRevision = 2;
      if (kind === "destination") c.destination.repositoryFullName = "owner/other";
      await expect(
        requester.issue(
          raw,
          adapterTaskBytes,
          "recipient",
          "ordinary_chat_browser",
          kind === "missing" ? undefined : Buffer.from(JSON.stringify(c)),
        ),
      ).rejects.toThrow();
      expect(git.files.size).toBe(0);
    },
  );
  it("legacy unversioned issuance remains readable but cannot claim or gain a contract retrofit", async () => {
    const task = adapterTask(),
      raw = Buffer.from(JSON.stringify(task));
    const prepared = await requester.prepareIssue(raw, adapterTaskBytes, "recipient");
    const legacy = { ...prepared.issued };
    delete legacy.version;
    delete legacy.outputContractSha256;
    const signed = await requester.codec.encode(legacy);
    prepared.files.set(requester.path("inbox", task.request_id, "issued.json"), signed);
    prepared.files.set(requester.path("outbox", task.request_id, "issued.json"), signed);
    await git.append(prepared.files);
    const observed = await recipient.readIssued(
      await git.snapshot(),
      recipient.path("inbox", task.request_id, "issued.json"),
    );
    expect(observed.issued.version).toBeUndefined();
    await expect(recipient.claim(observed.issued, randomUUID())).rejects.toThrow(
      "legacy_issuance_not_executable",
    );
    await expect(requester.issue(raw, adapterTaskBytes, "recipient")).rejects.toThrow(
      "immutable_conflict",
    );
  });
  it("fanout listing advances past corrupt signed groups instead of starving later groups", async () => {
    const fanout = new GitHubFanout(requester);
    const invalid = "00000000-0000-0000-0000-000000000001";
    const valid = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    await git.append(new Map([[fanout.path(invalid), Buffer.from("{}")]]));
    await fanout.issue(
      valid,
      [adapterTask(), adapterTask()].map((t) => ({
        raw: Buffer.from(JSON.stringify(t)),
        taskBytes: adapterTaskBytes,
        recipientId: "recipient",
        route: "cli" as const,
      })),
    );
    const page = await fanout.list("", 1);
    expect(page.fanoutIds).toEqual([]);
    expect(page.next).toBe(invalid);
    expect(page.blocked).toHaveLength(1);
    expect((await fanout.list(page.next ?? "", 1)).fanoutIds).toEqual([valid]);
    expect((await new GitHubFanout(recipient).list("", 32)).fanoutIds).toEqual([]);
    await expect(fanout.list("", 257)).rejects.toThrow("limit_invalid");
  });
  it("signed issuance resolves its historical registry revision after current configuration changes", async () => {
    const registry = new ProjectRegistry(join(dir, "registry.db"));
    const destination = { repositoryFullName: "owner/bus", branch: "main", namespace: "bridge-v2" };
    Object.assign(git, { destination: { repositoryFullName: "owner/bus", branch: "main" } });
    const project = {
      projectId: randomUUID(),
      repoId: "fixture-repo",
      storageSlug: "PixivVault",
      displayName: "Vault",
      githubDestination: destination,
      outputRootOverride: null,
    };
    try {
      registry.configure(
        {
          schema: "bridge-project-registry-1",
          revision: 1,
          defaultOutputRoot: "/first",
          projects: [project],
        },
        0,
      );
      const registered = new GitHubTaskBus(git, codec("requester"), "bridge-v2", {}, registry);
      const task = adapterTask();
      await registered.issue(Buffer.from(JSON.stringify(task)), adapterTaskBytes, "recipient");
      registry.configure(
        {
          schema: "bridge-project-registry-1",
          revision: 2,
          defaultOutputRoot: "/second",
          projects: [
            {
              ...project,
              githubDestination: { ...destination, repositoryFullName: "owner/other" },
            },
          ],
        },
        1,
      );
      const reopened = new GitHubTaskBus(git, codec("recipient"), "bridge-v2", {}, registry);
      const { issued } = await reopened.readIssued(
        await git.snapshot(),
        `${reopened.prefix}/request-index/${task.request_id}.json`,
      );
      expect(issued.projectRegistration).toEqual({
        projectId: project.projectId,
        registryRevision: 1,
        snapshotSha256: registry.snapshotHash(1),
      });
      expect(issued.projectSlug).toBe("PixivVault");
      await expect(
        registered.issue(Buffer.from(JSON.stringify(adapterTask())), adapterTaskBytes, "recipient"),
      ).rejects.toThrow("destination");
    } finally {
      registry.close();
    }
  });
  it("requires a manifest and explicit durable materialization proof before any ACK", async () => {
    const task = await start();
    executor.finish(store.get(task.request_id)?.intent?.runId ?? "", "succeeded");
    await controller.collect(task.request_id);
    await pump.tick();
    await expect(requester.acceptResult(task.request_id, async () => undefined)).rejects.toThrow(
      "delivery_manifest_required",
    );
    await fixtureManifest(recipient, task.request_id);
    await expect(requester.acceptResult(task.request_id, async () => undefined)).rejects.toThrow(
      "delivery_materialization_required",
    );
    expect(
      await requester.readEvent(await git.snapshot(), task.request_id, "result_ack"),
    ).toBeNull();
  });
  it.each(["actor", "event", "run", "hash", "manifest", "artifacts", "synthetic"])(
    "rejects mismatched materialization %s without ACK",
    async (field) => {
      const task = await start();
      executor.finish(store.get(task.request_id)?.intent?.runId ?? "", "succeeded");
      await controller.collect(task.request_id);
      await pump.tick();
      await fixtureManifest(recipient, task.request_id);
      await expect(
        requester.acceptResult(task.request_id, async (_bytes, _event, context) => {
          const proof = fixtureReceipt(context);
          if (field === "actor") proof.requesterActorId = "other";
          if (field === "event") proof.terminalEventId = randomUUID();
          if (field === "run") proof.execution = { kind: "local_execution", runId: randomUUID() };
          if (field === "hash") proof.payloadSha256 = "a".repeat(64);
          if (field === "manifest") proof.deliveryManifestSha256 = "a".repeat(64);
          if (field === "artifacts") proof.verifiedArtifacts = [];
          if (field === "synthetic") proof.synthetic = false;
          return proof;
        }),
      ).rejects.toThrow();
      expect(
        await requester.readEvent(await git.snapshot(), task.request_id, "result_ack"),
      ).toBeNull();
      expect(executor.starts).toBe(1);
    },
  );
  it("retries only proof publication after save failure and retains identical ACK identity", async () => {
    const task = await start();
    executor.finish(store.get(task.request_id)?.intent?.runId ?? "", "succeeded");
    await controller.collect(task.request_id);
    await pump.tick();
    await fixtureManifest(recipient, task.request_id);
    const accept = async (
      _bytes: Uint8Array,
      _event: unknown,
      context: import("../../src/adapters/github-transport.js").DeliveryAcceptanceContext,
    ) => fixtureReceipt(context);
    git.failure = true;
    await expect(requester.acceptResult(task.request_id, accept)).rejects.toThrow(
      "github_http_403",
    );
    git.failure = false;
    expect(
      await requester.readEvent(await git.snapshot(), task.request_id, "result_ack"),
    ).toBeNull();
    await requester.acceptResult(task.request_id, accept);
    const before = await requester.readMaterialization(await git.snapshot(), task.request_id);
    await requester.acceptResult(task.request_id, accept);
    expect(await requester.readMaterialization(await git.snapshot(), task.request_id)).toEqual(
      before,
    );
    await pump.tick();
    expect(store.deliveryVerified(task.request_id)).toBe(true);
    expect(executor.starts).toBe(1);
  });
  it("rejects historical payload-only ACK as complete even if the signature is valid", async () => {
    const task = await start();
    executor.finish(store.get(task.request_id)?.intent?.runId ?? "", "succeeded");
    await controller.collect(task.request_id);
    await pump.tick();
    const event = store.handshake(task.request_id, "terminal_result");
    if (!event) throw new Error("fixture");
    await git.append(
      new Map([
        [
          requester.path("outbox", task.request_id, "result_ack.json"),
          await requester.codec.encode({
            kind: "handshake",
            event: { ...event, stage: "result_ack", actorId: "requester" },
          }),
        ],
      ]),
    );
    await expect(
      requester.readEvent(await git.snapshot(), task.request_id, "result_ack"),
    ).rejects.toThrow("delivery_manifest_required");
    expect((await pump.tick()).acknowledged).toEqual([]);
  });
  it("rejects spoofed actor, wrong signature and unsigned notifications", async () => {
    expect(() => codec("recipient").decode(Buffer.from('{"actorId":"requester"}'))).toThrow();
    const task = await issue();
    const path = requester.path("inbox", task.request_id, "issued.json");
    const raw = await git.read(await git.snapshot(), path);
    const forged = JSON.parse(Buffer.from(raw ?? []).toString());
    forged.actorId = "recipient";
    expect(() => codec("recipient").decode(Buffer.from(JSON.stringify(forged)))).toThrow(
      "signature",
    );
  });
  it("rejects mutation under existing request ID", async () => {
    const task = await issue();
    task.timeout.run_seconds++;
    await expect(
      requester.issue(Buffer.from(JSON.stringify(task)), adapterTaskBytes, "recipient"),
    ).rejects.toThrow("immutable");
  });
  it("does not ACK when requester rejects result", async () => {
    const task = await start();
    executor.finish(store.get(task.request_id)?.intent?.runId ?? "", "succeeded");
    await controller.collect(task.request_id);
    await pump.tick();
    await expect(
      fixtureAccept(recipient, requester, task.request_id, false, async () => {
        throw new Error("not_accepted");
      }),
    ).rejects.toThrow();
    expect(
      await requester.readEvent(await git.snapshot(), task.request_id, "result_ack"),
    ).toBeNull();
  });
  it("newest out-of-order terminal ACK cannot match another terminal event", async () => {
    const task = await start();
    const early = store.handshake(task.request_id, "start_receipt");
    if (!early) throw new Error("missing");
    await git.append(
      new Map([
        [
          requester.path("outbox", task.request_id, "result_ack.json"),
          await requester.codec.encode({
            kind: "handshake",
            event: { ...early, stage: "result_ack", actorId: "requester" },
          }),
        ],
      ]),
    );
    expect((await pump.tick()).blocked[0]?.reason).toBe("transport_result_unverified");
    expect(store.handshake(task.request_id, "result_ack")).toBeNull();
  });
  it("preserves browser route and refuses to reinterpret it as local execution", async () => {
    const task = adapterTask();
    await requester.issue(
      Buffer.from(JSON.stringify(task)),
      adapterTaskBytes,
      "recipient",
      "ordinary_chat_browser",
      fixtureOutputContract(Buffer.from(JSON.stringify(task))),
    );
    expect((await pump.tick()).blocked[0]?.reason).toBe(
      "ordinary_chat_requires_browser_delivery_adapter",
    );
    expect(executor.starts).toBe(0);
  });
  it("rotates bounded inbox scans rather than starving later requests", async () => {
    for (let i = 0; i < 5; i++) await issue();
    pump = new GitHubRecipientPump(recipient, controller, journal, () => clock, 2);
    await pump.tick();
    await pump.tick();
    await pump.tick();
    expect(store.listSession(controller.policy.sessionId)).toHaveLength(5);
  });
});

describe("GitHub real REST adapter with fake fetch", () => {
  it("times out a stalled credential and ignores its late resolution without fetching", async () => {
    let release: ((value: string) => void) | undefined;
    let fetches = 0;
    const auth = new Promise<string>((resolve) => {
      release = resolve;
    });
    const api: typeof fetch = async () => {
      fetches++;
      return new Response("{}");
    };
    const store = new GitHubGitStore(
      { owner: "fixture", repository: "bus", branch: "main" },
      { authorization: () => auth },
      api,
      { timeoutMs: 5, maxBytes: 1024, maxFiles: 10, conflicts: 1 },
    );
    await expect(store.snapshot()).rejects.toThrow("github_timeout");
    release?.("Bearer fixture");
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetches).toBe(0);
  });
  it.each(["fetch", "stream"])(
    "bounds stalled %s even if injected fetch ignores AbortSignal",
    async (mode) => {
      const api: typeof fetch = async () =>
        mode === "fetch" ? new Promise<Response>(() => {}) : new Response(new ReadableStream());
      const store = new GitHubGitStore(
        { owner: "fixture", repository: "bus", branch: "main" },
        { authorization: async () => "Bearer fixture" },
        api,
        { timeoutMs: 5, maxBytes: 1024, maxFiles: 10, conflicts: 1 },
      );
      await expect(store.snapshot()).rejects.toThrow("github_timeout");
    },
  );
  it("rejects nonfinite limits and isolates them from caller mutation", async () => {
    const limits = { timeoutMs: 5, maxBytes: 1024, maxFiles: 10, conflicts: 1 };
    const config = { owner: "fixture", repository: "bus", branch: "main" };
    const auth = { authorization: () => new Promise<string>(() => {}) };
    expect(
      () => new GitHubGitStore(config, auth, fetch, { ...limits, conflicts: Infinity }),
    ).toThrow("limits_invalid");
    const store = new GitHubGitStore(config, auth, fetch, limits);
    limits.timeoutMs = 60000;
    await expect(store.snapshot()).rejects.toThrow("github_timeout");
  });
  it("uses fixed official origin, injected authorization and verified immutable blobs", async () => {
    const body = Buffer.from("fixture\n");
    const blob = gitBlobSha(body);
    const commit = "a".repeat(40);
    const tree = "b".repeat(40);
    const calls: string[] = [];
    const api: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      expect(init?.redirect).toBe("error");
      expect(((init?.headers ?? {}) as Record<string, string>).Authorization).toBe(
        "Bearer already-authorized-fixture",
      );
      const data = url.includes("/git/ref/")
        ? { object: { sha: commit } }
        : url.includes("/git/commits/")
          ? { sha: commit, tree: { sha: tree } }
          : url.includes("/git/trees/")
            ? {
                truncated: false,
                tree: [{ type: "blob", mode: "100644", path: "fixture.txt", sha: blob }],
              }
            : {
                sha: blob,
                encoding: "base64",
                size: body.length,
                content: body.toString("base64"),
              };
      return new Response(JSON.stringify(data));
    };
    const git = new GitHubGitStore(
      { owner: "fixture", repository: "bus", branch: "inbox" },
      { authorization: async () => "Bearer already-authorized-fixture" },
      api,
    );
    const snapshot = await git.snapshot();
    expect(await git.read(snapshot, "fixture.txt")).toEqual(body);
    expect(calls.every((url) => url.startsWith("https://api.github.com/repos/fixture/bus/"))).toBe(
      true,
    );
  });
  it("denies incomplete trees, traversal and credential-less calls", async () => {
    const config = { owner: "fixture", repository: "bus", branch: "inbox" };
    const git = new GitHubGitStore(config, { authorization: async () => "" });
    await expect(git.snapshot()).rejects.toThrow("credential");
    await expect(git.append(new Map([["../outside", Buffer.from("x")]]), "test")).rejects.toThrow(
      "path",
    );
  });
  it("writes blob/tree/commit then non-force ref exactly once and idempotently returns same content", async () => {
    let head = "a".repeat(40);
    const tree = "b".repeat(40);
    const desired = Buffer.from("exact\n");
    const hash = gitBlobSha(desired);
    let stored = false;
    const methods: string[] = [];
    const api: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      methods.push(method);
      const data = init?.body ? JSON.parse(String(init.body)) : {};
      let response: unknown;
      if (method === "PATCH") {
        expect(data.force).toBe(false);
        head = data.sha;
        stored = true;
        response = { object: { sha: head } };
      } else if (method === "POST" && url.endsWith("/blobs")) {
        expect(data.encoding).toBe("base64");
        response = { sha: hash };
      } else if (method === "POST" && url.endsWith("/trees")) response = { sha: "c".repeat(40) };
      else if (method === "POST") {
        expect(data.parents).toEqual([head]);
        response = { sha: "d".repeat(40) };
      } else if (url.includes("/git/ref/")) response = { object: { sha: head } };
      else if (url.includes("/git/commits/")) response = { sha: head, tree: { sha: tree } };
      else
        response = {
          truncated: false,
          tree: stored ? [{ path: "request.json", mode: "100644", type: "blob", sha: hash }] : [],
        };
      return new Response(JSON.stringify(response));
    };
    const git = new GitHubGitStore(
      { owner: "fixture", repository: "bus", branch: "inbox" },
      { authorization: async () => "Bearer fixture" },
      api,
    );
    const files = new Map([["request.json", desired]]);
    expect(await git.append(files, "request")).toBe("d".repeat(40));
    expect(await git.append(files, "request")).toBe("d".repeat(40));
    expect(methods.filter((x) => x === "PATCH")).toHaveLength(1);
  });
});
