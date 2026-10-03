import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserDeliveryService, type BrowserRun } from "../../src/adapters/browser-delivery.js";
import {
  type GitObjectStore,
  type GitSnapshot,
  gitBlobSha,
} from "../../src/adapters/github-client.js";
import { GitHubTaskBus, SignedBusCodec } from "../../src/adapters/github-transport.js";
import { buildRecoveredResult } from "../../src/cli/collect.js";
import { loadConfig } from "../../src/cli/config.js";
import { encodeResponseFrame } from "../../src/contracts/response-frame.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { adapterTask, adapterTaskBytes } from "../helpers/adapter-fixture.js";
import { fixtureAccept } from "../helpers/materialization-fixture.js";
import {
  fixtureGitDestination,
  fixtureHostedOutputPolicy,
  fixtureOutputContract,
  fixtureProjectRegistry,
} from "../helpers/output-contract-fixture.js";

class MemoryGit implements GitObjectStore {
  files = new Map<string, string>();
  blobs = new Map<string, Uint8Array>();
  async snapshot(): Promise<GitSnapshot> {
    return { commit: "a".repeat(40), tree: "b".repeat(40), files: new Map(this.files) };
  }
  async read(snapshot: GitSnapshot, path: string) {
    return this.blobs.get(snapshot.files.get(path) ?? "") ?? null;
  }
  async append(files: ReadonlyMap<string, Uint8Array>) {
    for (const [path, bytes] of files) {
      const hash = gitBlobSha(bytes);
      if (this.files.has(path) && this.files.get(path) !== hash) throw new Error("conflict");
      this.files.set(path, hash);
      this.blobs.set(hash, bytes);
    }
    return "a".repeat(40);
  }
}
const keys = {
  requester: generateKeyPairSync("ed25519"),
  recipient: generateKeyPairSync("ed25519"),
};
function bus(git: GitObjectStore, actorId: keyof typeof keys) {
  return new GitHubTaskBus(
    fixtureGitDestination(git),
    new SignedBusCodec(
      Object.entries(keys).map(([id, key]) => ({
        actorId: id,
        publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
        roles: [id as "requester" | "recipient"],
      })),
      { actorId, sign: async (raw) => sign(null, raw, keys[actorId].privateKey) },
    ),
    "bridge-v2",
    {},
    fixtureProjectRegistry,
  );
}
describe("ordinary Chat hosted-response extension (fake browser only)", () => {
  let dir: string;
  let service: BrowserDeliveryService;
  let requester: GitHubTaskBus;
  let recipient: GitHubTaskBus;
  let starts: number;
  let afterWrite: (() => Promise<void>) | null;
  let behavior: "complete" | "crash" | "auth";
  const now = new Date("2026-10-03T05:00:00Z");
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "browser-delivery-"));
    const git = new MemoryGit();
    requester = bus(git, "requester");
    recipient = bus(git, "recipient");
    starts = 0;
    afterWrite = null;
    behavior = "complete";
    const run: BrowserRun = async (path) => {
      starts++;
      if (behavior === "crash") throw new Error("browser_crashed");
      const request = JSON.parse(await readFile(path, "utf8"));
      expect(request.target).toBe("chat");
      expect(request.timeoutMs).toBe(10000);
      expect(request.newChat).toBe(false);
      expect(request.conversationUrl).toBe("https://chatgpt.com/c/fixture");
      expect(await readFile(join(dirname(path), "prompt.md"), "utf8")).toContain(
        adapterTaskBytes.toString(),
      );
      const result = buildRecoveredResult(
        {
          requestId: request.requestId,
          conversationUrl: request.conversationUrl,
          submittedAt: now.toISOString(),
        },
        { markdown: "fixture response", method: "dom", quality: "full", modelSlug: null },
        join(dirname(path), "response.md"),
        "test",
        now,
      );
      if (behavior === "auth") {
        result.status = "manual_intervention_required";
        result.submitted = "no";
        result.responseFile = null;
        result.extractionMethod = null;
        result.extractionQuality = null;
        result.error = {
          code: "AUTH_REQUIRED",
          message: "Manual sign-in required",
          retryable: false,
          phase: "AUTH_CHECKED",
          cause: "not signed in",
        };
        delete result.recoveredBy;
        delete result.recoveredFromSubmittedAt;
      } else
        await writeFile(
          join(dirname(path), "response.md"),
          encodeResponseFrame(
            "fixture response",
            JSON.parse(await readFile(join(dirname(path), "framing.json"), "utf8")),
          ),
        );
      await writeFile(join(dirname(path), "result.json"), JSON.stringify(result));
      if (afterWrite) await afterWrite();
      return result;
    };
    service = new BrowserDeliveryService(
      recipient,
      loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: dir }),
      {
        recipientId: "recipient",
        requesterIds: ["requester"],
        expectedOutputPolicy: fixtureHostedOutputPolicy(),
        conversationUrl: "https://chatgpt.com/c/fixture",
        model: "current",
        preset: "current",
        maxStarts: 2,
        deadlineAt: "2026-10-03T06:00:00Z",
        maxResponseBytes: 10000,
      },
      run,
      () => now,
    );
  });
  afterEach(async () => {
    service.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function issue() {
    const task = adapterTask();
    task.policy_snapshot_sha256 = service.policyHash;
    task.agent = "chatgpt-browser";
    task.requested_model = "current";
    const raw = Buffer.from(JSON.stringify(task));
    await requester.issue(
      raw,
      adapterTaskBytes,
      "recipient",
      "ordinary_chat_browser",
      fixtureOutputContract(raw),
    );
    await service.poll();
    service.approve(task.request_id, {
      actorId: "operator",
      taskSpecHash: sha256Bytes(raw),
      expiresAt: "2026-10-03T05:05:00Z",
      authenticated: true,
    });
    return task;
  }
  it("preserves normal Chat and completes signed GitHub result and explicit requester ACK", async () => {
    const task = await issue();
    await service.start(task.request_id);
    await service.reconcile(task.request_id);
    await fixtureAccept(recipient, requester, task.request_id, true, async (bytes) => {
      const result = JSON.parse(Buffer.from(bytes).toString());
      expect(result.markdown).toBe("fixture response");
      expect(result.evidence).toBe("ordinary-chat-browser-dom");
      expect(result.localExecution).toBe(false);
      expect(result.process_identity).toBeUndefined();
    });
    expect((await service.reconcile(task.request_id)).acknowledged).toBe(true);
    expect(starts).toBe(1);
  });
  it("does not retry a crashed or unknown browser send", async () => {
    const task = await issue();
    behavior = "crash";
    await expect(service.start(task.request_id)).rejects.toThrow("crashed");
    await expect(service.start(task.request_id)).rejects.toThrow("denied");
    await service.poll();
    await service.reconcile(task.request_id);
    expect(service.get(task.request_id)?.state).toBe("unknown");
    expect(starts).toBe(1);
  });
  it("concurrent start and reconciliation preserve the original immutable hosted event", async () => {
    const task = await issue();
    let firstEvent: string | undefined;
    afterWrite = async () => {
      await service.reconcile(task.request_id);
      firstEvent = service.get(task.request_id)?.event?.eventId;
    };
    await service.start(task.request_id);
    expect(service.get(task.request_id)?.event?.eventId).toBe(firstEvent);
    await service.reconcile(task.request_id);
    expect(starts).toBe(1);
  });
  it("caps approval age and refuses configuration changes across restart", async () => {
    const task = await issue();
    expect(service.get(task.request_id)?.approval?.expiresAt).toBe("2026-10-03T05:01:00.000Z");
    expect(
      () =>
        new BrowserDeliveryService(
          recipient,
          service.config,
          { ...service.policy, conversationUrl: "https://chatgpt.com/c/another" },
          async () => null,
          () => now,
        ),
    ).toThrow("configuration_changed");
  });
  it("rejects design fixtures and a different requested model before any browser send", async () => {
    for (const kind of ["fixture", "model"]) {
      const task = adapterTask();
      task.policy_snapshot_sha256 = service.policyHash;
      task.agent = "chatgpt-browser";
      task.requested_model = kind === "model" ? "other-model" : "current";
      if (kind === "fixture") {
        task.mode = "design_fixture";
        task.allowed_paths = [];
      }
      await requester.issue(
        Buffer.from(JSON.stringify(task)),
        adapterTaskBytes,
        "recipient",
        "ordinary_chat_browser",
        fixtureOutputContract(Buffer.from(JSON.stringify(task))),
      );
    }
    const result = await service.poll();
    expect(result.blocked).toHaveLength(2);
    expect(starts).toBe(0);
  });
  it("rejects requester-signed output scope beyond the trusted recipient policy before claim", async () => {
    const task = adapterTask();
    task.policy_snapshot_sha256 = service.policyHash;
    task.agent = "chatgpt-browser";
    task.requested_model = "current";
    const raw = Buffer.from(JSON.stringify(task));
    const contract = JSON.parse(Buffer.from(fixtureOutputContract(raw)).toString());
    contract.mode = "declared_artifacts";
    contract.requiredOutputs = [{ logicalName: "extra", mediaType: "text/plain", maxBytes: 16 }];
    contract.maxArtifacts = 1;
    contract.maxTotalBytes = 16;
    await requester.issue(
      raw,
      adapterTaskBytes,
      "recipient",
      "ordinary_chat_browser",
      Buffer.from(JSON.stringify(contract)),
    );
    const observed = await service.poll();
    expect(observed.received).toEqual([]);
    expect(observed.blocked[0]?.reason).toBe("output_policy_out_of_scope");
    expect(
      await recipient.git.read(
        await recipient.git.snapshot(),
        recipient.path("claims", task.request_id, "claim.json"),
      ),
    ).toBeNull();
    expect(starts).toBe(0);
  });
  it("does not consume a prior approval after persisted raw output contract substitution", async () => {
    const task = await issue();
    const row = service.get(task.request_id);
    expect(row?.outputContractRaw).toBeTruthy();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(service.config.runtimeDir, "hosted-delivery.db"));
    try {
      if (!row) throw new Error("fixture");
      row.outputContractRaw = Buffer.from("{}").toString("base64");
      db.prepare("UPDATE hosted_jobs SET snapshot=? WHERE id=?").run(
        JSON.stringify(row),
        task.request_id,
      );
    } finally {
      db.close();
    }
    await expect(service.start(task.request_id)).rejects.toThrow();
    expect(starts).toBe(0);
    expect(service.get(task.request_id)?.attempted).toBe(false);
  });
  it("rejects stale or changed approval", async () => {
    const task = adapterTask();
    task.policy_snapshot_sha256 = service.policyHash;
    task.agent = "chatgpt-browser";
    task.requested_model = "current";
    await requester.issue(
      Buffer.from(JSON.stringify(task)),
      adapterTaskBytes,
      "recipient",
      "ordinary_chat_browser",
      fixtureOutputContract(Buffer.from(JSON.stringify(task))),
    );
    await service.poll();
    expect(() =>
      service.approve(task.request_id, {
        actorId: "operator",
        taskSpecHash: "0".repeat(64),
        expiresAt: "2026-10-03T05:05:00Z",
        authenticated: true,
      }),
    ).toThrow();
    await expect(service.start(task.request_id)).rejects.toThrow();
    expect(starts).toBe(0);
  });
  it("blocked login is preserved without paid-route fallback", async () => {
    const task = await issue();
    behavior = "auth";
    await service.start(task.request_id);
    expect(service.get(task.request_id)?.state).toBe("blocked_auth");
    await expect(service.start(task.request_id)).rejects.toThrow();
    expect(starts).toBe(1);
  });
});
