import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { hostedOperationsPort } from "../../src/ui/hosted-operations.js";
import { UiOperationsService } from "../../src/ui/operations.js";
import { adapterTask, adapterTaskBytes } from "../helpers/adapter-fixture.js";
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
  it("composes real archive2 hosted ledger with UI start ownership, cancellation and response bytes", async () => {
    const task = await issue();
    let finish: (() => void) | undefined;
    afterWrite = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const port = hostedOperationsPort(service, {
      policyHash: service.policyHash,
      conversationId: "fixture",
      destinationId: "browser-destination",
      now: () => now,
      capabilities: (job) => ({
        approve: { enabled: job.state === "awaiting_approval", reason: "fixture" },
        start: { enabled: job.state === "approved" && !job.attempted, reason: "fixture" },
        cancel: { enabled: !job.response, reason: "fixture" },
        reconcile: { enabled: job.attempted, reason: "fixture" },
      }),
    });
    const ops = new UiOperationsService({
      hosted: port.source,
      registry: fixtureProjectRegistry,
      authenticatedActorId: "operator",
    });
    const before = await ops.detail("hosted_delivery", task.request_id);
    expect(before.state).toBe("available");
    if (before.state !== "available" || before.value.kind !== "hosted_delivery")
      throw new Error("missing hosted record");
    const original = service.get(task.request_id);
    if (!original) throw new Error("Missing authoritative hosted record");
    expect(before.value.binding.revision).toBe(original.revision);
    expect(before.value.rawSpec).toBe(original.raw);
    const started = await ops.mutate({
      version: "bridge-operations-1",
      action: "start",
      binding: before.value.binding,
    });
    expect(started).toMatchObject({
      state: "available",
      value: { attempted: true, state: "unknown" },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(starts).toBe(1);
    await expect(
      ops.mutate({
        version: "bridge-operations-1",
        action: "start",
        binding: before.value.binding,
      }),
    ).rejects.toMatchObject({ code: "stale_operation_snapshot" });
    if (started.state !== "available" || started.value.kind !== "hosted_delivery")
      throw new Error("missing started record");
    const cancelled = await ops.mutate({
      version: "bridge-operations-1",
      action: "cancel",
      binding: started.value.binding,
    });
    expect(cancelled).toMatchObject({
      state: "available",
      value: { state: "unknown", cancelRequestedAt: now.toISOString() },
    });
    if (!finish) throw new Error("Expected held injected runner");
    finish();
    await vi.waitFor(() => expect(service.get(task.request_id)?.response).not.toBeNull());
    const completed = await ops.detail("hosted_delivery", task.request_id);
    expect(completed).toMatchObject({
      state: "available",
      value: {
        state: "completed",
        responseMarkdown: "fixture response",
        delivery: { fullDeliverySufficient: false },
      },
    });
    await port.close();
    expect(starts).toBe(1);
  });
});
