/** Reviewer-only adversarial tests. Fake in-memory Git, temporary SQLite, no browser/model/network. */
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { GitHubFanout } from "../../src/adapters/fanout.js";
import {
  GitHubGitStore,
  type GitObjectStore,
  type GitSnapshot,
  gitBlobSha,
} from "../../src/adapters/github-client.js";
import { GitHubTaskBus, SignedBusCodec } from "../../src/adapters/github-transport.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { TaskController } from "../../src/state/task-controller.js";
import { UnavailableTaskExecutor } from "../../src/state/task-executor.js";
import { openTaskStore } from "../../src/state/task-store.js";
import { demoTask } from "../../src/ui/demo.js";
import { openUiService } from "../../src/ui/service.js";
import { adapterPolicy, adapterTask, adapterTaskBytes } from "../helpers/adapter-fixture.js";
import { fixtureManifest, fixtureReceipt } from "../helpers/materialization-fixture.js";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("fixture_missing");
  return value;
}
class MemoryGit implements GitObjectStore {
  files = new Map<string, string>();
  blobs = new Map<string, Uint8Array>();
  async snapshot() {
    return { commit: "a".repeat(40), tree: "b".repeat(40), files: new Map(this.files) };
  }
  async read(s: GitSnapshot, p: string) {
    return this.blobs.get(s.files.get(p) ?? "") ?? null;
  }
  async append(fs: ReadonlyMap<string, Uint8Array>) {
    for (const [p, b] of fs)
      if (this.files.has(p) && this.files.get(p) !== gitBlobSha(b))
        throw Error("github_immutable_conflict");
    for (const [p, b] of fs) {
      const h = gitBlobSha(b);
      this.files.set(p, h);
      this.blobs.set(h, b);
    }
    return "a".repeat(40);
  }
}
function buses() {
  const g = new MemoryGit();
  const keys = {
    requester: generateKeyPairSync("ed25519"),
    recipient: generateKeyPairSync("ed25519"),
    unrelated: generateKeyPairSync("ed25519"),
  };
  const make = (id: keyof typeof keys) =>
    new GitHubTaskBus(
      g,
      new SignedBusCodec(
        Object.entries(keys).map(([actorId, k]) => ({
          actorId,
          publicKeyPem: k.publicKey.export({ type: "spki", format: "pem" }).toString(),
          roles: [actorId === "requester" ? "requester" : "recipient"],
        })),
        { actorId: id, sign: async (b) => sign(null, b, keys[id].privateKey) },
      ),
      "bridge-v2",
      { "fixture-repo": "PixivVault" },
    );
  return {
    g,
    requester: make("requester"),
    recipient: make("recipient"),
    unrelated: make("unrelated"),
  };
}
describe("independent receiver-proof checkpoint review", () => {
  it("historical payload-only ACK must not make UI summary claim verified delivery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-review-historical-"));
    const service = await openUiService({ profile: "production", stateDir: dir });
    try {
      const view = service.import(demoTask({ title: "historical acknowledgement" }));
      const id = view.task.summary.requestId;
      await service.runtime.controller.cancel(id);
      const terminal = required(service.runtime.store.handshake(id, "terminal_result"));
      const db = new DatabaseSync(join(dir, "jobs.db"));
      db.prepare("INSERT INTO task_handshakes VALUES (?,?,?)").run(
        id,
        "result_ack",
        JSON.stringify({
          ...terminal,
          stage: "result_ack",
          actorId: service.authenticatedRequesterId,
        }),
      );
      db.close();
      expect(service.runtime.store.deliveryVerified(id)).toBe(false);
      expect(service.task(id).task.delivery.acknowledged).toBe(false);
      expect(service.bootstrap().tasks.find((t) => t.requestId === id)?.deliveryAcknowledged).toBe(
        false,
      );
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each(["actor", "task_hash", "process_identity"] as const)(
    "rejects incorrectly bound start receipt: %s",
    async (field) => {
      const { g, requester, recipient, unrelated } = buses();
      const one = adapterTask(),
        two = adapterTask(),
        fanoutId = randomUUID();
      const fanout = new GitHubFanout(requester);
      await fanout.issue(
        fanoutId,
        [one, two].map((task) => ({
          raw: Buffer.from(JSON.stringify(task)),
          taskBytes: adapterTaskBytes,
          recipientId: "recipient",
          route: "cli" as const,
        })),
      );
      const signer = field === "actor" ? unrelated : recipient;
      const poisoned = {
        eventId: randomUUID(),
        stage: "start_receipt" as const,
        requestId: one.request_id,
        taskSpecHash:
          field === "task_hash" ? "f".repeat(64) : sha256Bytes(Buffer.from(JSON.stringify(one))),
        runId: randomUUID(),
        sequence: 9,
        actorId: signer.codec.signer.actorId,
        payloadSha256: "e".repeat(64),
        fencingToken: 1,
        startIntentSequence: 4,
        processIdentity:
          field === "process_identity"
            ? null
            : {
                host_id: "fake-host",
                boot_id: randomUUID(),
                pid: 42,
                creation_time: new Date().toISOString(),
                executable_sha256: "d".repeat(64),
                process_group_id: "fake-process-group",
              },
      };
      const raw = Buffer.from(JSON.stringify({ kind: "handshake", event: poisoned }));
      const bytes = Buffer.from(
        JSON.stringify({
          version: "bridge-bus-1",
          actorId: signer.codec.signer.actorId,
          payload: raw.toString("base64"),
          signature: Buffer.from(await signer.codec.signer.sign(raw)).toString("base64"),
        }),
      );
      await g.append(
        new Map([[requester.path("outbox", one.request_id, "start_receipt.json"), bytes]]),
      );
      const result = await fanout.collect(fanoutId);
      expect(result.children.find((c) => c.requestId === one.request_id)?.state).not.toBe(
        "running",
      );
    },
  );
  it("valid terminal payload stays available when a historical payload-only ACK is insufficient", async () => {
    const { g, requester, recipient } = buses();
    const one = adapterTask(),
      two = adapterTask(),
      fanoutId = randomUUID();
    const fanout = new GitHubFanout(requester);
    await fanout.issue(
      fanoutId,
      [one, two].map((task) => ({
        raw: Buffer.from(JSON.stringify(task)),
        taskBytes: adapterTaskBytes,
        recipientId: "recipient",
        route: "cli" as const,
      })),
    );
    const dir = await mkdtemp(join(tmpdir(), "bridge-review-fanin-"));
    const store = await openTaskStore(join(dir, "jobs.db"));
    try {
      const controller = new TaskController(
        store,
        new UnavailableTaskExecutor(),
        adapterPolicy(dir, new Date()),
      );
      controller.receive(Buffer.from(JSON.stringify(one)), adapterTaskBytes, null, "requester");
      await controller.cancel(one.request_id);
      const event = required(store.handshake(one.request_id, "terminal_result"));
      const payload = store.deliveryPayload(one.request_id);
      await recipient.publish(event, payload);
      await g.append(
        new Map([
          [
            requester.path("outbox", one.request_id, "result_ack.json"),
            await requester.codec.encode({
              kind: "handshake",
              event: { ...event, stage: "result_ack", actorId: "requester" },
            }),
          ],
        ]),
      );
      const result = await fanout.collect(fanoutId);
      expect(result.children.find((c) => c.requestId === one.request_id)?.result).toEqual(
        JSON.parse(Buffer.from(payload).toString()),
      );
      expect(result.available).toBe(1);
      expect(result.acknowledged).toBe(0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("configured API timeout also bounds credential acquisition", async () => {
    const git = new GitHubGitStore(
      { owner: "fixture", repository: "fixture", branch: "main" },
      { authorization: () => new Promise<string>(() => {}) },
      async () => {
        throw Error("network must not run");
      },
      { timeoutMs: 5, maxBytes: 4096, maxFiles: 100, conflicts: 1 },
    );
    const outcome = await Promise.race([
      git.snapshot().then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 40)),
    ]);
    expect(outcome).toBe("rejected");
  });

  it("lost reply after atomic proof+ACK commit safely replays identical bytes without execution", async () => {
    const { g, requester, recipient } = buses();
    const task = adapterTask();
    await requester.issue(Buffer.from(JSON.stringify(task)), adapterTaskBytes, "recipient");
    const dir = await mkdtemp(join(tmpdir(), "bridge-review-lostreply-"));
    const store = await openTaskStore(join(dir, "jobs.db"));
    try {
      const controller = new TaskController(
        store,
        new UnavailableTaskExecutor(),
        adapterPolicy(dir, new Date()),
      );
      controller.receive(Buffer.from(JSON.stringify(task)), adapterTaskBytes, null, "requester");
      await controller.cancel(task.request_id);
      await recipient.publish(
        required(store.handshake(task.request_id, "terminal_result")),
        store.deliveryPayload(task.request_id),
      );
      await fixtureManifest(recipient, task.request_id);
      const append = g.append.bind(g);
      let lost = true;
      g.append = async (files) => {
        const result = await append(files);
        if (lost && [...files.keys()].some((p) => p.endsWith("/materialization.json"))) {
          lost = false;
          throw Error("lost_reply_after_commit");
        }
        return result;
      };
      await expect(
        requester.acceptResult(task.request_id, async (_b, _e, c) => fixtureReceipt(c)),
      ).rejects.toThrow("lost_reply_after_commit");
      const before = new Map(g.files);
      expect(
        await requester.readEvent(await g.snapshot(), task.request_id, "result_ack"),
      ).not.toBeNull();
      await requester.acceptResult(task.request_id, async (_b, _e, c) => fixtureReceipt(c));
      expect(g.files).toEqual(before);
      expect(store.get(task.request_id)?.intent).toBeNull();
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("manifest and materialization signatures reject swapping recipient and requester roles", async () => {
    const { g, requester, recipient } = buses();
    const task = adapterTask();
    await requester.issue(Buffer.from(JSON.stringify(task)), adapterTaskBytes, "recipient");
    const dir = await mkdtemp(join(tmpdir(), "bridge-review-proofroles-"));
    const store = await openTaskStore(join(dir, "jobs.db"));
    try {
      const controller = new TaskController(
        store,
        new UnavailableTaskExecutor(),
        adapterPolicy(dir, new Date()),
      );
      controller.receive(Buffer.from(JSON.stringify(task)), adapterTaskBytes, null, "requester");
      await controller.cancel(task.request_id);
      await recipient.publish(
        required(store.handshake(task.request_id, "terminal_result")),
        store.deliveryPayload(task.request_id),
      );
      await fixtureManifest(recipient, task.request_id);
      const context = await requester.deliveryContext(await g.snapshot(), task.request_id);
      await expect(
        requester.codec.encode({ kind: "delivery_manifest", manifest: context.manifest }),
      ).rejects.toThrow("transport_manifest_actor_denied");
      await expect(
        recipient.codec.encode({ kind: "materialization", receipt: fixtureReceipt(context) }),
      ).rejects.toThrow("transport_materialization_actor_denied");
      await expect(
        requester.acceptResult(task.request_id, async (_b, _e, c) => ({
          ...fixtureReceipt(c),
          requestId: randomUUID(),
        })),
      ).rejects.toThrow("delivery_proof_binding_mismatch");
      expect(
        await requester.readEvent(await g.snapshot(), task.request_id, "result_ack"),
      ).toBeNull();
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
