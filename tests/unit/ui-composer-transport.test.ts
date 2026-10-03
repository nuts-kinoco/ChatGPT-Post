import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GitObjectStore,
  type GitSnapshot,
  gitBlobSha,
} from "../../src/adapters/github-client.js";
import { GitHubTaskBus, SignedBusCodec } from "../../src/adapters/github-transport.js";
import type { ProjectRegistryPort } from "../../src/contracts/project-registry.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import type { TaskSpec } from "../../src/contracts/task-types.js";
import type { ComposerChild, UiComposerPort } from "../../src/ui/composer.js";
import { composerTransportPort } from "../../src/ui/composer-transport.js";
import { adapterTask, adapterTaskBytes } from "../helpers/adapter-fixture.js";
import {
  fixtureGitDestination,
  fixtureHostedOutputPolicy,
  fixtureProjectRegistry,
} from "../helpers/output-contract-fixture.js";

/** Same immutable in-memory Git-object fixture used by the transport tests; no HTTP or executor. */
class MemoryGit implements GitObjectStore {
  blobs = new Map<string, Uint8Array>();
  files = new Map<string, string>();
  appends = 0;
  failAppend = false;
  async snapshot(): Promise<GitSnapshot> {
    return {
      commit: String(this.appends).padStart(40, "0"),
      tree: "a".repeat(40),
      files: new Map(this.files),
    };
  }
  async read(snapshot: GitSnapshot, path: string) {
    const digest = snapshot.files.get(path);
    return digest ? (this.blobs.get(digest) ?? null) : null;
  }
  async append(files: ReadonlyMap<string, Uint8Array>) {
    if (this.failAppend) throw new Error("fixture_storage_unavailable");
    for (const [path, bytes] of files)
      if (this.files.has(path) && this.files.get(path) !== gitBlobSha(bytes))
        throw new Error("github_immutable_conflict");
    for (const [path, bytes] of files) {
      const digest = gitBlobSha(bytes);
      this.files.set(path, digest);
      this.blobs.set(digest, Uint8Array.from(bytes));
    }
    return String(++this.appends).padStart(40, "0");
  }
}
const keys = {
  requester: generateKeyPairSync("ed25519"),
  recipient: generateKeyPairSync("ed25519"),
};
function fixture(registry: ProjectRegistryPort | undefined = fixtureProjectRegistry) {
  const git = fixtureGitDestination(new MemoryGit());
  const codec = new SignedBusCodec(
    Object.entries(keys).map(([actorId, pair]) => ({
      actorId,
      roles: [actorId as "requester" | "recipient"],
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    })),
    { actorId: "requester", sign: async (raw) => sign(null, raw, keys.requester.privateKey) },
  );
  const bus = new GitHubTaskBus(git, codec, "bridge-v2", {}, registry);
  const prepare = vi.fn(() => {
    throw new Error("issue_must_not_regenerate_recipe");
  });
  const port = composerTransportPort(bus, prepare);
  return { git, codec, bus, prepare, port };
}
function child(route: ComposerChild["route"]): ComposerChild {
  const task = adapterTask();
  const rawSpec = `${JSON.stringify(task, null, 2)}\n`;
  return {
    destinationId: route === "cli" ? "registered-cli" : "registered-browser",
    recipientActorId: "recipient",
    route,
    requestId: task.request_id,
    taskSpecHash: sha256Bytes(Buffer.from(rawSpec)),
    taskFileHash: sha256Bytes(adapterTaskBytes),
    rawSpec,
    taskMarkdown: adapterTaskBytes.toString(),
    ...(route === "ordinary_chat_browser" ? { outputPolicy: fixtureHostedOutputPolicy() } : {}),
  };
}
function preview(
  children: ComposerChild[],
  fanoutId: string | null = children.length > 1 ? randomUUID() : null,
): Parameters<UiComposerPort["issue"]>[0] {
  return {
    fanoutId,
    registryRevision: 1,
    registrySha256: fixtureProjectRegistry.snapshotHash(1),
    projectId: fixtureProjectRegistry.resolve(1, "fixture-repo").projectId,
    children,
  };
}
async function issued(f: ReturnType<typeof fixture>, requestId: string) {
  return f.bus.readIssued(await f.git.snapshot(), f.bus.path("inbox", requestId, "issued.json"));
}

describe("concrete composer transport, immutable registered routes", () => {
  const network = vi.fn(() => {
    throw new Error("real_network_forbidden_in_fixture");
  });
  beforeEach(() => {
    network.mockClear();
    vi.stubGlobal("fetch", network);
  });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("issues exact CLI bytes and the immutable registry reference without preparing or starting anything", async () => {
    const f = fixture(),
      request = child("cli"),
      input = preview([request]);
    const receipt = await f.port.issue(input);
    expect(receipt.commit).toMatch(/^[a-f0-9]{40}$/);
    const read = await issued(f, request.requestId);
    expect(Buffer.from(read.raw).toString()).toBe(request.rawSpec);
    expect(Buffer.from(read.taskBytes).toString()).toBe(request.taskMarkdown);
    expect(read.issued).toMatchObject({
      version: "bridge-issued-2",
      route: "cli",
      fanoutId: null,
      requesterId: "requester",
      recipientId: request.recipientActorId,
      requestId: request.requestId,
      taskSpecHash: request.taskSpecHash,
      taskFileHash: request.taskFileHash,
      projectRegistration: {
        projectId: input.projectId,
        registryRevision: 1,
        snapshotSha256: input.registrySha256,
      },
    });
    expect(read.outputContract).toBeNull();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.git.appends).toBe(1);
    expect([...f.git.files.keys()]).toEqual(
      expect.arrayContaining([
        `bridge-v2/request-index/${request.requestId}.json`,
        `bridge-v2/projects/PixivVault/requests/${request.requestId}/task.json`,
        `bridge-v2/projects/PixivVault/requests/${request.requestId}/task.md`,
      ]),
    );
    expect([...f.git.files.keys()].some((path) => /approval|result|claim|receipt/.test(path))).toBe(
      false,
    );
  });

  it("issues hosted bytes with an authenticated exact output contract rather than a local execution claim", async () => {
    const f = fixture(),
      request = child("ordinary_chat_browser"),
      input = preview([request]);
    await f.port.issue(input);
    const read = await issued(f, request.requestId);
    expect(read.issued).toMatchObject({
      version: "bridge-issued-2",
      route: "ordinary_chat_browser",
      requestId: request.requestId,
      taskSpecHash: request.taskSpecHash,
    });
    expect(read.outputContract).toMatchObject({
      schema: "output-contract-1",
      requestId: request.requestId,
      taskSpecHash: request.taskSpecHash,
      taskFileHash: request.taskFileHash,
      route: "hosted_delivery",
      registryRevision: input.registryRevision,
      registrySnapshotSha256: input.registrySha256,
      projectId: input.projectId,
      requesterActorId: "requester",
      recipientActorId: "recipient",
      mode: "text_only",
      requiredOutputs: [],
      allowAdditionalArtifacts: false,
      destination: {
        repositoryFullName: "owner/bus",
        branch: "main",
        namespace: "bridge-v2",
        conversationId: "fixture",
      },
    });
    expect(read.outputContractRaw).not.toBeNull();
    expect(read.issued.outputContractSha256).toBe(
      sha256Bytes(read.outputContractRaw ?? new Uint8Array()),
    );
    expect(Buffer.from(read.raw).toString()).toBe(request.rawSpec);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(JSON.stringify(read.outputContract)).not.toContain("process_identity");
    expect([...f.git.files.keys()].some((path) => /result\.json|response\.json/.test(path))).toBe(
      false,
    );
  });

  it("commits a mixed CLI/hosted fanout atomically with exact child identity and individual route", async () => {
    const f = fixture(),
      cli = child("cli"),
      hosted = child("ordinary_chat_browser"),
      input = preview([cli, hosted]);
    await f.port.issue(input);
    expect(f.git.appends).toBe(1);
    const snapshot = await f.git.snapshot();
    const rawParent = await f.git.read(snapshot, `bridge-v2/workflows/${input.fanoutId}.json`);
    if (!rawParent) throw new Error("signed fanout missing");
    const parent = f.codec.decode(rawParent);
    expect(parent).toMatchObject({
      actorId: "requester",
      message: {
        kind: "fanout",
        fanoutId: input.fanoutId,
        requesterId: "requester",
        children: [
          {
            requestId: cli.requestId,
            route: "cli",
            taskSpecHash: cli.taskSpecHash,
            recipientId: "recipient",
          },
          {
            requestId: hosted.requestId,
            route: "ordinary_chat_browser",
            taskSpecHash: hosted.taskSpecHash,
            recipientId: "recipient",
          },
        ],
      },
    });
    expect((await issued(f, cli.requestId)).issued.fanoutId).toBe(input.fanoutId);
    expect((await issued(f, hosted.requestId)).issued.fanoutId).toBe(input.fanoutId);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("rejects payload mutation before writing and protects already issued immutable UUIDs", async () => {
    const f = fixture(),
      request = child("cli"),
      input = preview([request]);
    await expect(
      f.port.issue(preview([{ ...request, taskMarkdown: `${request.taskMarkdown}changed` }])),
    ).rejects.toThrow("composer_payload_binding_invalid");
    expect(f.git.appends).toBe(0);
    await f.port.issue(input);
    const before = new Map(f.git.files);
    const task = JSON.parse(request.rawSpec) as TaskSpec;
    const taskMarkdown = `${request.taskMarkdown}changed`;
    task.task_file_hash = sha256Bytes(Buffer.from(taskMarkdown));
    const rawSpec = JSON.stringify(task);
    await expect(
      f.port.issue(
        preview([
          {
            ...request,
            rawSpec,
            taskMarkdown,
            taskSpecHash: sha256Bytes(Buffer.from(rawSpec)),
            taskFileHash: task.task_file_hash,
          },
        ]),
      ),
    ).rejects.toThrow("github_immutable_conflict");
    expect(f.git.files).toEqual(before);
    expect(f.git.appends).toBe(1);
    expect(Buffer.from((await issued(f, request.requestId)).raw).toString()).toBe(request.rawSpec);
  });

  it("rejects missing/wrong hosted output scope or a hosted output policy on CLI before any append", async () => {
    const f = fixture(),
      hosted = child("ordinary_chat_browser");
    const { outputPolicy: _missing, ...missing } = hosted;
    await expect(f.port.issue(preview([missing]))).rejects.toThrow("output_contract_required");
    await expect(
      f.port.issue(
        preview([
          {
            ...hosted,
            outputPolicy: { ...fixtureHostedOutputPolicy(), recipientActorId: "another-recipient" },
          },
        ]),
      ),
    ).rejects.toThrow("output_policy_out_of_scope");
    await expect(
      f.port.issue(preview([{ ...child("cli"), outputPolicy: fixtureHostedOutputPolicy() }])),
    ).rejects.toThrow("output_contract_route_unsupported");
    expect(f.git.appends).toBe(0);
    expect(f.git.files.size).toBe(0);
  });

  it("rejects stale or mismatched registration and incomplete fanout before publication", async () => {
    const f = fixture(),
      request = child("cli"),
      input = preview([request]);
    for (const invalid of [
      { ...input, registryRevision: 2 },
      { ...input, registrySha256: "f".repeat(64) },
      { ...input, projectId: randomUUID() },
      { ...input, fanoutId: randomUUID() },
      preview([], null),
      preview([child("cli"), child("cli")], null),
    ])
      await expect(f.port.issue(invalid)).rejects.toThrow();
    expect(f.git.appends).toBe(0);
    expect(f.git.files.size).toBe(0);
  });

  it("does not publish a valid first child when the second child or atomic storage fails", async () => {
    const f = fixture(),
      cli = child("cli"),
      hosted = child("ordinary_chat_browser");
    const { outputPolicy: _missing, ...missing } = hosted;
    await expect(f.port.issue(preview([cli, missing]))).rejects.toThrow("output_contract_required");
    expect(f.git.files.size).toBe(0);
    f.git.failAppend = true;
    await expect(f.port.issue(preview([cli, hosted]))).rejects.toThrow(
      "fixture_storage_unavailable",
    );
    expect(f.git.files.size).toBe(0);
    expect(f.git.appends).toBe(0);
    expect(f.prepare).not.toHaveBeenCalled();
  });
});
