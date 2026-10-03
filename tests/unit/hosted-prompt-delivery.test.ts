import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserDeliveryService, type BrowserRun } from "../../src/adapters/browser-delivery.js";
import {
  type GitObjectStore,
  type GitSnapshot,
  gitBlobSha,
} from "../../src/adapters/github-client.js";
import { GitHubTaskBus, SignedBusCodec } from "../../src/adapters/github-transport.js";
import { parseHostedPromptReceipt } from "../../src/adapters/hosted-prompt-policy.js";
import { loadConfig } from "../../src/cli/config.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { encodeTaskBrief } from "../../src/prompt-rendering/brief.js";
import { revokeHostedRenderer } from "../../src/prompt-rendering/hosted-registry.js";
import { hostedPromptFixture } from "../helpers/hosted-prompt-fixture.js";
import {
  fixtureGitDestination,
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
    fixtureOutputContract,
  );
}

describe("V2 hosted receipt and one-attempt integration; fake browser only", () => {
  let root: string;
  let service: BrowserDeliveryService;
  let fixture: ReturnType<typeof hostedPromptFixture>;
  let requester: GitHubTaskBus;
  let recipient: GitHubTaskBus;
  let starts: number;
  let driver: BrowserRun;
  let now: Date;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hosted-prompt-wire-"));
    fixture = hostedPromptFixture();
    const git = new MemoryGit();
    requester = bus(git, "requester");
    recipient = bus(git, "recipient");
    starts = 0;
    now = new Date("2026-10-03T05:00:00Z");
    driver = async (path, control) => {
      starts++;
      const saved = service.promptReceipt(fixture.task.request_id);
      expect(saved).not.toBeNull();
      const request = JSON.parse(await readFile(path, "utf8")),
        prompt = await readFile(join(dirname(path), "prompt.md"), "utf8");
      expect(control.assertPromptBinding).toBeTypeOf("function");
      control.assertPromptBinding?.(request, prompt);
      const receipt = parseHostedPromptReceipt(saved?.raw ?? new Uint8Array());
      expect(receipt.promptSha256).toBe(sha256Bytes(Buffer.from(prompt)));
      expect(service.get(fixture.task.request_id)?.attempted).toBe(true);
      return null;
    };
    service = new BrowserDeliveryService(
      recipient,
      loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: root }),
      fixture.registration,
      (p, c) => driver(p, c),
      () => now,
    );
  });
  afterEach(async () => {
    service?.close();
    await rm(root, { recursive: true, force: true });
  });
  async function issue() {
    await requester.issue(
      fixture.rawTaskSpec,
      fixture.taskFileBytes,
      "recipient",
      "ordinary_chat_browser",
      fixture.outputContractRaw,
    );
    await service.poll();
    service.approve(fixture.task.request_id, {
      actorId: "operator",
      taskSpecHash: sha256Bytes(fixture.rawTaskSpec),
      expiresAt: "2026-10-03T05:05:00Z",
      authenticated: true,
    });
  }
  it("commits the exact receipt atomically before the first browser handoff", async () => {
    await issue();
    expect(service.promptReceipt(fixture.task.request_id)).toBeNull();
    await service.start(fixture.task.request_id);
    expect(starts).toBe(1);
    const saved = service.promptReceipt(fixture.task.request_id);
    expect(saved?.sha256).toBe(service.get(fixture.task.request_id)?.promptReceiptSha256);
    await expect(service.start(fixture.task.request_id)).rejects.toThrow("start_denied");
    expect(starts).toBe(1);
  });
  it("does not retry unknown dispatch after a runner failure", async () => {
    await issue();
    driver = async () => {
      starts++;
      throw new Error("synthetic_driver_failure");
    };
    await expect(service.start(fixture.task.request_id)).rejects.toThrow(
      "synthetic_driver_failure",
    );
    expect(service.promptReceipt(fixture.task.request_id)).not.toBeNull();
    await service.reconcile(fixture.task.request_id);
    await expect(service.start(fixture.task.request_id)).rejects.toThrow("start_denied");
    expect(starts).toBe(1);
  });
  it("retains committed receipt and never retries exclusive prompt-write failure", async () => {
    await issue();
    const dir = join(root, "hosted-requests", fixture.task.request_id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "prompt.md"), "untrusted replacement");
    await expect(service.start(fixture.task.request_id)).rejects.toThrow();
    expect(starts).toBe(0);
    expect(service.get(fixture.task.request_id)?.attempted).toBe(true);
    expect(service.promptReceipt(fixture.task.request_id)).not.toBeNull();
    await expect(service.start(fixture.task.request_id)).rejects.toThrow("start_denied");
  });
  it("serializes two start callers into one durable attempt", async () => {
    await issue();
    let release: () => void = () => {};
    driver = async () => {
      starts++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return null;
    };
    const first = service.start(fixture.task.request_id);
    await expect(service.start(fixture.task.request_id)).rejects.toThrow("start_denied");
    for (let i = 0; i < 20 && starts === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(starts).toBe(1);
    release();
    await first;
  });
  it("denies cancellation and deadline expiry before receipt allocation", async () => {
    await issue();
    await service.cancel(fixture.task.request_id);
    await expect(service.start(fixture.task.request_id)).rejects.toThrow("start_denied");
    expect(service.promptReceipt(fixture.task.request_id)).toBeNull();
    expect(starts).toBe(0);
  });
  it("denies an expired approval before receipt allocation", async () => {
    await issue();
    now = new Date("2026-10-03T05:06:00Z");
    await expect(service.start(fixture.task.request_id)).rejects.toThrow("start_denied");
    expect(service.promptReceipt(fixture.task.request_id)).toBeNull();
    expect(starts).toBe(0);
  });
  it.each(["prompt", "model", "conversation"] as const)(
    "blocks changed in-memory %s at the runner boundary",
    async (field) => {
      await issue();
      driver = async (path, control) => {
        const request = JSON.parse(await readFile(path, "utf8"));
        let prompt = await readFile(join(dirname(path), "prompt.md"), "utf8");
        if (field === "prompt") prompt += " altered";
        if (field === "model") request.model = "latest";
        if (field === "conversation") request.conversationUrl = "https://chatgpt.com/c/other";
        control.assertPromptBinding?.(request, prompt);
        starts++;
        return null;
      };
      await expect(service.start(fixture.task.request_id)).rejects.toThrow("send_bytes_mismatch");
      expect(starts).toBe(0);
    },
  );
  it("rejects a renderer revoked after preparation at the final guard without restoring the start", async () => {
    await issue();
    driver = async (path, control) => {
      const request = JSON.parse(await readFile(path, "utf8")),
        prompt = await readFile(join(dirname(path), "prompt.md"), "utf8");
      revokeHostedRenderer(fixture.renderer);
      control.assertPromptBinding?.(request, prompt);
      starts++;
      return null;
    };
    await expect(service.start(fixture.task.request_id)).rejects.toThrow(
      "hosted_renderer_unavailable",
    );
    expect(starts).toBe(0);
    expect(service.get(fixture.task.request_id)?.attempted).toBe(true);
    expect(service.get(fixture.task.request_id)?.state).toBe("unknown");
    const db = new DatabaseSync(join(root, "hosted-delivery.db"));
    expect(db.prepare("SELECT starts FROM hosted_budget WHERE id=1").get()?.starts).toBe(1);
    db.close();
    await expect(service.start(fixture.task.request_id)).rejects.toThrow("start_denied");
  });
  it("restarts under the same policy without another send or receipt allocation", async () => {
    await issue();
    await service.start(fixture.task.request_id);
    const receipt = service.promptReceipt(fixture.task.request_id);
    service.close();
    service = new BrowserDeliveryService(
      recipient,
      loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: root }),
      fixture.registration,
      (p, c) => driver(p, c),
      () => now,
    );
    expect(service.promptReceipt(fixture.task.request_id)).toEqual(receipt);
    await service.reconcile(fixture.task.request_id);
    await expect(service.start(fixture.task.request_id)).rejects.toThrow("start_denied");
    expect(starts).toBe(1);
  });
  it("rolls back over-limit rendering with zero attempt and budget consumption", async () => {
    fixture.taskFileBytes = encodeTaskBrief({
      taskKind: "answer",
      objective: "x".repeat(21000),
      constraints: [],
      deliverables: [],
      acceptance: [],
      context: [],
    });
    fixture.task.task_file_hash = sha256Bytes(fixture.taskFileBytes);
    fixture.rawTaskSpec = Buffer.from(JSON.stringify(fixture.task));
    fixture.outputContractRaw = fixtureOutputContract(fixture.rawTaskSpec);
    await issue();
    await expect(service.start(fixture.task.request_id)).rejects.toThrow(
      "hosted_prompt_composer_limit",
    );
    expect(service.get(fixture.task.request_id)?.attempted).toBe(false);
    expect(service.get(fixture.task.request_id)?.attemptId).toBeNull();
    expect(service.promptReceipt(fixture.task.request_id)).toBeNull();
    expect(starts).toBe(0);
    const db = new DatabaseSync(join(root, "hosted-delivery.db"));
    expect(db.prepare("SELECT starts FROM hosted_budget WHERE id=1").get()?.starts).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS total FROM hosted_prompt_receipts").get()?.total).toBe(0);
    db.close();
  });
  it("detects a missing or corrupted receipt rather than treating V2 as legacy", async () => {
    await issue();
    await service.start(fixture.task.request_id);
    const db = new DatabaseSync(join(root, "hosted-delivery.db"));
    db.prepare("UPDATE hosted_prompt_receipts SET body=?").run("{}");
    db.close();
    expect(() => service.promptReceipt(fixture.task.request_id)).toThrow();
    await expect(service.start(fixture.task.request_id)).rejects.toThrow("start_denied");
    expect(starts).toBe(1);
  });
});
