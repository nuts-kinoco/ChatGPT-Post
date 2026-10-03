import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeSdkProbeObservation } from "../../src/adapters/claude-sdk-profile.js";
import { fakeSdkTextAdapter, type SdkQueryPort } from "../../src/adapters/claude-sdk-text.js";
import {
  type GitObjectStore,
  type GitSnapshot,
  gitBlobSha,
} from "../../src/adapters/github-client.js";
import { GitHubTaskBus, SignedBusCodec } from "../../src/adapters/github-transport.js";
import { GitHubSdkTextBus } from "../../src/adapters/sdk-text-bus.js";
import type { SdkTextDeployment } from "../../src/adapters/sdk-text-deployment.js";
import { runSdkTextRoundtrip } from "../../src/adapters/sdk-text-roundtrip.js";
import {
  fakeSdkTextService,
  type SdkTextServiceOptions,
} from "../../src/adapters/sdk-text-service.js";
import {
  type ProjectRegistryPort,
  type ProjectRegistrySnapshot,
  projectRegistryHash,
} from "../../src/contracts/project-registry.js";
import { encodeResponseFrame } from "../../src/contracts/response-frame.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { SdkTextLedger } from "../../src/state/sdk-text-ledger.js";
import { SdkTextRequesterJournal } from "../../src/state/sdk-text-requester-journal.js";
import { json, sdkFixture } from "../helpers/sdk-text-fixture.js";

class Git implements GitObjectStore {
  destination = { repositoryFullName: "owner/bus", branch: "main" };
  files = new Map<string, string>();
  blobs = new Map<string, Uint8Array>();
  count = 0;
  failResult = false;
  loseReply = false;
  async snapshot(): Promise<GitSnapshot> {
    return {
      commit: String(this.count).padStart(40, "0"),
      tree: "a".repeat(40),
      files: new Map(this.files),
    };
  }
  async read(s: GitSnapshot, p: string) {
    const h = s.files.get(p);
    return h ? (this.blobs.get(h) ?? null) : null;
  }
  async append(files: ReadonlyMap<string, Uint8Array>) {
    if (this.failResult && [...files.keys()].some((p) => p.endsWith("text-result.json")))
      throw new Error("test_disk_network");
    for (const [p, b] of files) {
      const h = gitBlobSha(b);
      if (this.files.has(p) && this.files.get(p) !== h)
        throw new Error("github_immutable_conflict");
    }
    for (const [p, b] of files) {
      const h = gitBlobSha(b);
      this.files.set(p, h);
      this.blobs.set(h, Buffer.from(b));
    }
    this.count++;
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error("test_lost_reply");
    }
    return String(this.count).padStart(40, "0");
  }
}
function required<T>(v: T | null | undefined): T {
  if (v == null) throw new Error("fixture_missing");
  return v;
}
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function world(custom?: SdkQueryPort) {
  const f = sdkFixture(),
    root = await mkdtemp(join(tmpdir(), "bridge-sdk-service-"));
  roots.push(root);
  const output = join(root, "output"),
    privateRoot = join(root, "private");
  await mkdir(output, { mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700 });
  const snapshot: ProjectRegistrySnapshot = {
    schema: "bridge-project-registry-1",
    revision: 1,
    defaultOutputRoot: output,
    projects: [
      {
        projectId: f.request.projectRegistration.projectId,
        repoId: f.request.repoId,
        storageSlug: "product-a",
        displayName: "Synthetic",
        githubDestination: f.request.destination,
        outputRootOverride: null,
      },
    ],
  };
  const registry: ProjectRegistryPort = {
    currentRevision: () => 1,
    snapshot: () => structuredClone(snapshot),
    snapshotHash: () => projectRegistryHash(snapshot),
    resolve: () => structuredClone(required(snapshot.projects[0])),
    defaultOutputRoot: () => output,
  };
  f.request.projectRegistration.snapshotSha256 = registry.snapshotHash(1);
  const raw = json(f.request),
    requestHash = sha256Bytes(raw);
  const key = {
    requester: generateKeyPairSync("ed25519"),
    recipient: generateKeyPairSync("ed25519"),
  };
  const codec = (actorId: keyof typeof key) =>
    new SignedBusCodec(
      Object.entries(key).map(([id, k]) => ({
        actorId: id,
        roles: [id as "requester" | "recipient"],
        publicKeyPem: k.publicKey.export({ type: "spki", format: "pem" }).toString(),
      })),
      { actorId, sign: async (b) => sign(null, b, key[actorId].privateKey) },
    );
  const git = new Git(),
    requester = new GitHubSdkTextBus(
      new GitHubTaskBus(git, codec("requester"), "bridge-v2", {}, registry),
    ),
    recipient = new GitHubSdkTextBus(
      new GitHubTaskBus(git, codec("recipient"), "bridge-v2", {}, registry),
    );
  const db = new DatabaseSync(":memory:"),
    claimant = randomUUID(),
    ledger = new SdkTextLedger(db, claimant),
    journal = new SdkTextRequesterJournal(db, registry, "requester");
  const query = vi.fn(({ prompt }: { prompt: string }) => {
    const attempt = prompt.match(/attempt-id=([a-f0-9-]{36})/)?.[1];
    if (!attempt) throw new Error("fixture");
    const frame = encodeResponseFrame(
      JSON.stringify({
        requestId: f.request.requestId,
        requestSha256: requestHash,
        attemptId: attempt,
        message: "bridge-handshake-ok",
      }),
      { requestId: f.request.requestId, taskSpecHash: requestHash, attemptId: attempt },
    );
    const events = structuredClone(f.events);
    (required(events[1]).message as { content: { type: string; text: string }[] }).content = [
      { type: "text", text: frame },
    ];
    required(events[2]).result = frame;
    return {
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    };
  });
  const adapter = fakeSdkTextAdapter(custom ?? { query });
  const probe = vi.fn(
    async (): Promise<ClaudeSdkProbeObservation> => ({
      schema: "claude-text-probe-observation-1",
      cliVersion: "2.1.288",
      binarySha256: f.profile.binarySha256,
      supportedFlagsSha256: "1".repeat(64),
      authStatusSha256: "2".repeat(64),
      localManagedMetadataSha256: "3".repeat(64),
      auth: {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        configDirectoryMatches: true,
      },
      profileRevision: 1,
      approvedAuthContextId: f.profile.approvedAuthContextId,
      providerRouteId: f.profile.providerRouteId,
      observedAt: new Date().toISOString(),
    }),
  );
  const options: SdkTextServiceOptions = {
    bus: recipient,
    ledger,
    profile: () => f.profile,
    privateRoot,
    authority: {
      approve: async (i) => ({
        requestId: i.requestId,
        requestSha256: i.requestSha256,
        approverId: i.approverId,
        expiresAt: i.expiresAt,
      }),
    },
  };
  const service = fakeSdkTextService(options, adapter, probe);
  const admit = async () => {
    await journal.issue(requester, raw, f.md, new Date());
    await service.receive(f.request.requestId);
    await service.approve(f.request.requestId);
  };
  return {
    ...f,
    root,
    raw,
    requestHash,
    git,
    db,
    ledger,
    journal,
    requester,
    recipient,
    registry,
    query,
    probe,
    service,
    options,
    adapter,
    admit,
    claimant,
  };
}
describe("actual signed bus/service/archive classes with fake SDK and fake Git", () => {
  it("completes request→claim→approval→one query→result→durable requester→signed ACK", async () => {
    const f = await world();
    try {
      await f.admit();
      const job = await f.service.start(f.request.requestId);
      expect(job.state).toBe("response_received");
      expect(f.query).toHaveBeenCalledOnce();
      const result = await f.requester.readStage(f.request.requestId, "result");
      expect(result).not.toBeNull();
      const r = JSON.parse(Buffer.from(required(result).packet.bodyBase64, "base64").toString());
      expect(r.liveProviderCallObserved).toBe(false);
      expect(r.observation.osProcessExit).toBe("unobserved");
      expect(r.observation).not.toHaveProperty("exitCode");
      const receipt = await f.journal.collect(f.requester, f.request.requestId, new Date());
      expect(receipt.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await f.requester.readStage(f.request.requestId, "acceptance")).not.toBeNull();
      await f.service.start(f.request.requestId);
      await f.service.reconcile(f.request.requestId);
      expect(f.query).toHaveBeenCalledOnce();
      expect([...f.git.files.keys()].some((p) => p.includes("messages.ndjson"))).toBe(false);
      await f.service.close();
    } finally {
      f.db.close();
    }
  });
  it("two independent hosts with same actor cannot steal the first claim", async () => {
    const f = await world(),
      db = new DatabaseSync(":memory:");
    try {
      await f.admit();
      const other = fakeSdkTextService(
        { ...f.options, ledger: new SdkTextLedger(db, randomUUID()) },
        f.adapter,
        f.probe,
      );
      await expect(other.receive(f.request.requestId)).rejects.toThrow("immutable_conflict");
      await expect(other.approve(f.request.requestId)).rejects.toThrow("claim_owned_elsewhere");
      expect(f.query).not.toHaveBeenCalled();
      await other.close();
      await f.service.close();
    } finally {
      db.close();
      f.db.close();
    }
  });
  it("concurrent starts consume only one durable attempt and query", async () => {
    const f = await world();
    try {
      await f.admit();
      await Promise.all([
        f.service.start(f.request.requestId),
        f.service.start(f.request.requestId),
      ]);
      expect(f.query).toHaveBeenCalledOnce();
      await f.service.close();
    } finally {
      f.db.close();
    }
  });
  it("publication failure retries the immutable result, never the query", async () => {
    const f = await world();
    try {
      await f.admit();
      f.git.failResult = true;
      await expect(f.service.start(f.request.requestId)).rejects.toThrow("test_disk_network");
      expect(f.ledger.get(f.request.requestId)?.state).toBe("response_received");
      f.git.failResult = false;
      await f.service.reconcile(f.request.requestId);
      await f.journal.collect(f.requester, f.request.requestId, new Date());
      expect(f.query).toHaveBeenCalledOnce();
      await f.service.close();
    } finally {
      f.db.close();
    }
  });
  it("a preexisting unknown intent is reconciled without even probing or querying", async () => {
    const f = await world();
    try {
      await f.admit();
      f.ledger.reserveStart(
        f.request.requestId,
        { probeEvidenceSha256: "e".repeat(64), sdkOptionsSha256: "f".repeat(64) },
        new Date(),
      );
      expect((await f.service.start(f.request.requestId)).state).toBe("unknown");
      expect(f.probe).not.toHaveBeenCalled();
      expect(f.query).not.toHaveBeenCalled();
      await f.service.close();
    } finally {
      f.db.close();
    }
  });
  it("auth failure or changed registered profile denies before reservation/query", async () => {
    const f = await world();
    try {
      await f.admit();
      f.probe.mockRejectedValueOnce(new Error("text_host_auth_unavailable"));
      await expect(f.service.start(f.request.requestId)).rejects.toThrow("auth_unavailable");
      expect(f.ledger.get(f.request.requestId)?.intentBase64).toBeNull();
      f.profile.revision = 2;
      await expect(f.service.start(f.request.requestId)).rejects.toThrow("host_scope_denied");
      expect(f.query).not.toHaveBeenCalled();
      await f.service.close();
    } finally {
      f.db.close();
    }
  });
  it("a directory-fsync crash is recovered from exact complete private bytes without query replay", async () => {
    const f = await world();
    let fail = true;
    const service = fakeSdkTextService(
      {
        ...f.options,
        pathPolicy: {
          beforeSyncDirectory: (p) => {
            if (fail && /sdk-text-evidence\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(p))
              throw new Error("test_fsync_crash");
          },
        },
      },
      f.adapter,
      f.probe,
    );
    try {
      await f.admit();
      await expect(service.start(f.request.requestId)).rejects.toThrow("test_fsync_crash");
      expect(f.ledger.get(f.request.requestId)?.state).toBe("unknown");
      fail = false;
      expect((await service.reconcile(f.request.requestId)).state).toBe("response_received");
      expect(f.query).toHaveBeenCalledOnce();
      await service.close();
      await f.service.close();
    } finally {
      f.db.close();
    }
  });
  it("cancel before start persists a tombstone and zero query", async () => {
    const f = await world();
    try {
      await f.admit();
      f.service.cancel(f.request.requestId);
      await expect(f.service.start(f.request.requestId)).rejects.toThrow();
      expect(f.query).not.toHaveBeenCalled();
      await f.service.close();
    } finally {
      f.db.close();
    }
  });
  it("shutdown while preflight is pending prevents a late first query", async () => {
    const f = await world();
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r)),
      original = required(f.probe.getMockImplementation());
    f.probe.mockImplementation(async () => {
      await wait;
      return original();
    });
    try {
      await f.admit();
      const start = f.service.start(f.request.requestId);
      await new Promise((r) => setImmediate(r));
      const close = f.service.close();
      release();
      await expect(start).rejects.toThrow("stale_or_changed");
      await close;
      expect(f.query).not.toHaveBeenCalled();
      expect(f.ledger.get(f.request.requestId)?.intentBase64).toBeNull();
    } finally {
      f.db.close();
    }
  });
  it("one-shot CLI orchestration reuses the same request after retry and never creates a second query", async () => {
    const f = await world();
    try {
      const runtime: SdkTextDeployment = {
        requesterBus: f.requester,
        requester: f.journal,
        recipient: f.service,
        preflight: f.probe,
        generate: () => {
          throw new Error("must_use_exact_files");
        },
        close: () => f.service.close(),
      };
      const first = await runSdkTextRoundtrip(runtime, f.raw, f.md);
      expect(first.status).toBe("synthetic_roundtrip_complete");
      f.probe.mockRejectedValue(new Error("auth_not_needed_after_completion"));
      const second = await runSdkTextRoundtrip(runtime, f.raw, f.md);
      expect(second.status).toBe("synthetic_roundtrip_complete");
      expect(f.query).toHaveBeenCalledOnce();
      await runtime.close();
    } finally {
      f.db.close();
    }
  });
  it("a hung authority expires locally and a late answer cannot mint a grant", async () => {
    vi.useFakeTimers();
    const f = await world();
    let release!: (v: unknown) => void;
    const authority = {
      approve: vi.fn(
        (input: unknown) =>
          new Promise((resolve) => {
            release = () => resolve(input);
          }),
      ),
    } as unknown as NonNullable<SdkTextServiceOptions["authority"]>;
    const service = fakeSdkTextService({ ...f.options, authority }, f.adapter, f.probe);
    try {
      await f.journal.issue(f.requester, f.raw, f.md, new Date());
      await service.receive(f.request.requestId);
      const approving = service.approve(f.request.requestId);
      const rejected = expect(approving).rejects.toThrow("authority_timeout");
      await vi.advanceTimersByTimeAsync(5001);
      await rejected;
      release({});
      await Promise.resolve();
      expect(f.ledger.get(f.request.requestId)?.grantBase64).toBeNull();
      expect(f.query).not.toHaveBeenCalled();
      await service.close();
      await f.service.close();
    } finally {
      f.db.close();
    }
  });
  it("a dispatched request retains its bound private profile when settings change for later jobs", async () => {
    const f = await world();
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r)),
      original = required(f.query.getMockImplementation());
    f.query.mockImplementation((input) => {
      const q = original(input);
      return {
        ...q,
        async *[Symbol.asyncIterator]() {
          await wait;
          yield* q;
        },
      };
    });
    try {
      await f.admit();
      const starting = f.service.start(f.request.requestId);
      while (!f.query.mock.calls.length) await new Promise((r) => setImmediate(r));
      f.profile.revision = 2;
      release();
      expect((await starting).state).toBe("response_received");
      expect(f.query).toHaveBeenCalledOnce();
      await f.service.close();
    } finally {
      f.db.close();
    }
  });
  it("a separate CLI cancellation is observed by the original query owner", async () => {
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r)),
      close = vi.fn();
    let receivedSignal: AbortSignal | undefined;
    const f = await world({
      query: ({ options }) => {
        receivedSignal = options.abortController?.signal;
        return {
          close,
          async *[Symbol.asyncIterator]() {
            await wait;
            yield null;
          },
        };
      },
    });
    const second = fakeSdkTextService(f.options, f.adapter, f.probe);
    try {
      await f.admit();
      const running = f.service.start(f.request.requestId);
      while (!receivedSignal) await new Promise((r) => setImmediate(r));
      second.cancel(f.request.requestId);
      await new Promise((r) => setTimeout(r, 250));
      expect(receivedSignal.aborted).toBe(true);
      expect(close).toHaveBeenCalledOnce();
      release();
      expect((await running).state).toBe("unknown");
      await f.service.close();
      await second.close();
    } finally {
      release();
      f.db.close();
    }
  });
});
