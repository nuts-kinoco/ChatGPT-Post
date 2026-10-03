/** Fake browser and Git only: production composition, Ed25519 signatures, SQLite and fsync storage. */
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserDeliveryService, type BrowserRun } from "../../src/adapters/browser-delivery.js";
import {
  type GitObjectStore,
  type GitSnapshot,
  gitBlobSha,
} from "../../src/adapters/github-client.js";
import { GitHubTaskBus, SignedBusCodec } from "../../src/adapters/github-transport.js";
import { ConfiguredGitDeliveryContentStoreV1 } from "../../src/archive/content-store.js";
import {
  createHostedPayloadContext,
  createRequesterMaterialization,
  publishVerifiedDelivery,
} from "../../src/archive/delivery-composition.js";
import { ArchiveDeliveryPersistence } from "../../src/archive/materialization-store.js";
import { HostedDeliveryPayloadVerifier } from "../../src/archive/payload-verifiers.js";
import { RouteArtifactArchive } from "../../src/archive/route-store.js";
import { buildRecoveredResult } from "../../src/cli/collect.js";
import { loadConfig } from "../../src/cli/config.js";
import { checkResultInvariants } from "../../src/contracts/invariants.js";
import {
  type DeliveryArtifactDescriptorV1,
  type DeliveryBindingV1,
  parseMaterializationReceiptV1,
  serializeDeliveryManifestV1,
  serializeMaterializationReceiptV1,
} from "../../src/contracts/materialization.js";
import type {
  HostedExpectedOutputPolicy,
  OutputContractBindingV1,
  OutputContractV1,
} from "../../src/contracts/output-contract.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";
import { adapterTask, adapterTaskBytes } from "../helpers/adapter-fixture.js";

/** Append validates all paths before committing the batch; no partial fake ACK commits. */
class MemoryGit implements GitObjectStore {
  readonly destination = { repositoryFullName: "owner/bus", branch: "main" };
  readonly files = new Map<string, string>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly batches: string[][] = [];
  async snapshot(): Promise<GitSnapshot> {
    return { commit: "a".repeat(40), tree: "b".repeat(40), files: new Map(this.files) };
  }
  async read(snapshot: GitSnapshot, path: string) {
    const bytes = this.blobs.get(snapshot.files.get(path) ?? "");
    return bytes ? Uint8Array.from(bytes) : null;
  }
  async append(files: ReadonlyMap<string, Uint8Array>) {
    for (const [path, bytes] of files) {
      const hash = gitBlobSha(bytes);
      if (this.files.has(path) && this.files.get(path) !== hash) throw new Error("conflict");
    }
    for (const [path, bytes] of files) {
      const hash = gitBlobSha(bytes);
      this.files.set(path, hash);
      this.blobs.set(hash, Uint8Array.from(bytes));
    }
    this.batches.push([...files.keys()]);
    return "a".repeat(40);
  }
}
const directories: string[] = [];
const closers: (() => void)[] = [];
function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "hosted-no-send-roundtrip-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function setup(submitted: "no" | "unknown" = "no") {
  const senderState = temporaryDirectory();
  const requesterState = temporaryDirectory();
  const output = temporaryDirectory();
  const registry = new ProjectRegistry(join(senderState, "registry.db"));
  closers.push(() => registry.close());
  const projectId = randomUUID();
  registry.configure(
    {
      schema: "bridge-project-registry-1",
      revision: 1,
      defaultOutputRoot: output,
      projects: [
        {
          projectId,
          repoId: "fixture-repo",
          storageSlug: "fixture",
          displayName: "Fixture",
          githubDestination: {
            repositoryFullName: "owner/bus",
            branch: "main",
            namespace: "bridge-v2",
          },
          outputRootOverride: null,
        },
      ],
    },
    0,
  );
  const senderArchive = new RouteArtifactArchive({ stateDirectory: senderState, registry });
  const requesterArchive = new RouteArtifactArchive({ stateDirectory: requesterState, registry });
  closers.push(
    () => senderArchive.close(),
    () => requesterArchive.close(),
  );
  const git = new MemoryGit();
  // Ephemeral test keys. No credentials, provider invocation or external Git operations.
  const keys = {
    requester: generateKeyPairSync("ed25519"),
    recipient: generateKeyPairSync("ed25519"),
  };
  const identities = Object.entries(keys).map(([actorId, key]) => ({
    actorId,
    roles: [actorId as "requester" | "recipient"],
    publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
  }));
  const bus = (actorId: keyof typeof keys) =>
    new GitHubTaskBus(
      git,
      new SignedBusCodec(identities, {
        actorId,
        sign: async (bytes) => sign(null, bytes, keys[actorId].privateKey),
      }),
      "bridge-v2",
      {},
      registry,
    );
  const requester = bus("requester");
  const recipient = bus("recipient");
  const expectedOutputPolicy: HostedExpectedOutputPolicy = {
    route: "hosted_delivery",
    requesterActorId: "requester",
    recipientActorId: "recipient",
    projectId,
    repoId: "fixture-repo",
    storageSlug: "fixture",
    destination: {
      repositoryFullName: "owner/bus",
      branch: "main",
      namespace: "bridge-v2",
      conversationId: "fixture",
    },
    mode: "text_only",
    requiredOutputs: [],
    allowAdditionalArtifacts: false,
    maxArtifacts: 0,
    maxTotalBytes: 0,
  };
  const now = new Date("2026-10-03T05:00:00.000Z");
  let starts = 0;
  const run: BrowserRun = async (path) => {
    starts++;
    const request = JSON.parse(await readFile(path, "utf8"));
    expect(request.target).toBe("chat");
    expect(request.conversationUrl).toBe("https://chatgpt.com/c/fixture");
    const failed = buildRecoveredResult(
      {
        requestId: request.requestId,
        conversationUrl: request.conversationUrl,
        submittedAt: now.toISOString(),
        baselineAssistantCount: 0,
      },
      { markdown: "", method: "dom", quality: "degraded", modelSlug: null },
      join(dirname(path), "response.md"),
      "fixture",
      now,
    );
    failed.status = "failed";
    failed.submitted = submitted;
    failed.responseFile = null;
    failed.extractionMethod = null;
    failed.extractionQuality = null;
    failed.requestedModel = "current";
    failed.requestedPreset = "current";
    failed.warnings = [];
    delete failed.recoveredBy;
    delete failed.recoveredFromSubmittedAt;
    failed.error =
      submitted === "no"
        ? {
            code: "BROWSER_LAUNCH_FAILED",
            message: "Synthetic pre-submit failure",
            retryable: false,
            phase: "PROFILE_CHECKED",
            cause: "fixture",
          }
        : {
            code: "SUBMIT_STATE_UNKNOWN",
            message: "Synthetic submit interruption",
            retryable: false,
            phase: "PROMPT_SUBMITTING",
            cause: "fixture",
          };
    expect(checkResultInvariants(failed)).toEqual([]);
    return failed;
  };
  const service = new BrowserDeliveryService(
    recipient,
    loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: senderState }),
    {
      recipientId: "recipient",
      requesterIds: ["requester"],
      conversationUrl: "https://chatgpt.com/c/fixture",
      model: "current",
      preset: "current",
      maxStarts: 2,
      deadlineAt: "2026-10-03T06:00:00.000Z",
      maxResponseBytes: 100000,
      expectedOutputPolicy,
    },
    run,
    () => now,
    { archive: senderArchive },
  );
  closers.push(() => service.close());
  const task = Object.assign(adapterTask(), {
    agent: "chatgpt-browser",
    requested_model: "current",
    mode: "read_only",
    allowed_commands: [],
    policy_snapshot_sha256: service.policyHash,
    timeout: { run_seconds: 10, cancel_grace_seconds: 1 },
  });
  const raw = Buffer.from(JSON.stringify(task));
  const outputContractBinding: OutputContractBindingV1 = {
    requestId: task.request_id,
    taskSpecHash: sha256Bytes(raw),
    taskFileHash: task.task_file_hash,
    route: "hosted_delivery",
    requesterActorId: "requester",
    recipientActorId: "recipient",
    policySnapshotSha256: service.policyHash,
    registryRevision: 1,
    registrySnapshotSha256: registry.snapshotHash(1),
    projectId,
    repoId: task.repo,
    storageSlug: "fixture",
    destination: expectedOutputPolicy.destination,
  };
  const contract: OutputContractV1 = {
    ...expectedOutputPolicy,
    ...outputContractBinding,
    schema: "output-contract-1",
    declarationFormat: "bridge-artifact-declaration-1",
  };
  const contractRaw = Buffer.from(JSON.stringify(contract));
  await requester.issue(raw, adapterTaskBytes, "recipient", "ordinary_chat_browser", contractRaw);
  const received = await recipient.readIssued(
    await git.snapshot(),
    `bridge-v2/request-index/${task.request_id}.json`,
  );
  service.receive(
    received.issued,
    received.raw,
    received.taskBytes,
    received.outputContractRaw ?? undefined,
  );
  requesterArchive.reserve(senderArchive.admission(task.request_id));
  service.approve(task.request_id, {
    actorId: "owner",
    taskSpecHash: sha256Bytes(raw),
    expiresAt: "2026-10-03T05:10:00.000Z",
    authenticated: true,
  });
  const job = await service.start(task.request_id);
  const hostedContext = createHostedPayloadContext(registry, (hash) =>
    hash === service.policyHash ? expectedOutputPolicy : null,
  );
  return {
    requesterState,
    output,
    registry,
    senderArchive,
    requesterArchive,
    git,
    requester,
    recipient,
    service,
    task,
    raw,
    contractRaw,
    expectedOutputPolicy,
    outputContractBinding,
    hostedContext,
    job,
    starts: () => starts,
  };
}
async function publishKnownNoSend(x: Awaited<ReturnType<typeof setup>>) {
  const { response, event, attemptId } = x.job;
  if (!response || !event || !attemptId) throw new Error("fixture terminal missing");
  await x.service.archiveResult(x.task.request_id);
  await x.service.reconcile(x.task.request_id);
  const inspection = x.senderArchive.inspect(x.task.request_id);
  if (inspection.state !== "complete" || !inspection.manifestSha256)
    throw new Error("fixture archive incomplete");
  const payload = Buffer.from(`${JSON.stringify(response)}\n`);
  const binding: DeliveryBindingV1 = {
    requesterActorId: "requester",
    recipientActorId: "recipient",
    requestId: x.task.request_id,
    taskSpecHash: event.taskSpecHash,
    execution: { kind: "hosted_delivery", attemptId },
    terminalEventId: event.eventId,
    payloadSha256: event.payloadSha256,
  };
  const descriptor: DeliveryArtifactDescriptorV1 = {
    artifactId: "hosted-output-contract",
    contentSha256: sha256Bytes(x.contractRaw),
    sizeBytes: x.contractRaw.length,
    required: true,
  };
  const verifier = new HostedDeliveryPayloadVerifier(async () => ({
    rawTaskSpec: x.raw,
    taskFileBytes: adapterTaskBytes,
    terminalEvent: event,
    claimedArtifacts: [descriptor],
    promptRendering: { mode: "legacy" as const },
    expectedConversationId: "fixture",
    outputContractRaw: x.contractRaw,
    expectedOutputPolicy: x.expectedOutputPolicy,
    outputContractBinding: x.outputContractBinding,
  }));
  const validated = await verifier.validatePayload(payload, binding);
  expect(validated.artifacts).toEqual([descriptor]);
  const contractBytes = x.senderArchive.readItem(
    x.task.request_id,
    inspection.manifestSha256,
    descriptor.artifactId,
  );
  const cas = new ConfiguredGitDeliveryContentStoreV1({
    destinations: [
      {
        destinationId: "artifacts",
        store: x.git,
        namespace: "scoped-artifacts",
        maxBytes: 1024 * 1024,
        timeoutMs: 1000,
        maxFiles: 1000,
      },
    ],
    authorizations: (["publish", "read"] as const).map((operation) => ({
      operation,
      destinationId: "artifacts",
      binding,
      purpose: "artifact",
      artifactId: descriptor.artifactId,
      contentSha256: descriptor.contentSha256,
    })),
  });
  const manifest = await publishVerifiedDelivery({
    bus: x.recipient,
    destinationId: "artifacts",
    payloadAlreadyPublishedOnBusDestinationId: "bus",
    publisher: cas,
    binding,
    payloadBytes: payload,
    artifacts: [{ descriptor, bytes: contractBytes }],
    payloadVerifier: verifier,
  });
  const materialize = createRequesterMaterialization({
    bus: x.requester,
    busDestinationId: "bus",
    approvedContentDestinationIds: ["artifacts"],
    contentReader: cas,
    persistence: new ArchiveDeliveryPersistence(x.requesterArchive),
    hostedContext: x.hostedContext,
  });
  return { binding, descriptor, manifest, materialize, inspection, payload };
}

describe("known-no-send hosted failure, production materialization composition", () => {
  it("saves admitted contract-only evidence before signed atomic proof+ACK, without fabricated messages or resend", async () => {
    const x = await setup();
    expect(x.job.state).toBe("failed");
    expect(x.job.response).toMatchObject({
      result: { status: "failed", submitted: "no" },
      markdown: null,
      framing: null,
    });
    expect(x.job.source).toBeNull();
    const delivery = await publishKnownNoSend(x);
    expect(delivery.inspection.manifest).toMatchObject({ requiredSetKnown: true, complete: true });
    expect(delivery.inspection.manifest?.items).toHaveLength(1);
    expect(delivery.inspection.manifest?.items[0]).toMatchObject({
      artifactId: "hosted-output-contract",
      required: true,
      state: "complete",
      source: { kind: "hosted_admission_evidence", artifactId: "hosted-output-contract" },
    });
    expect(x.senderArchive.provenance(x.task.request_id)[0]?.observation).toMatchObject({
      kind: "hosted_delivery",
      attemptId: x.job.attemptId,
      userTurnId: null,
      assistantTurnId: null,
      rawSha256: null,
      bodySha256: null,
    });
    const context = await x.requester.deliveryContext(await x.git.snapshot(), x.task.request_id);
    expect(x.requester.codec.decode(context.signedManifestBytes).actorId).toBe("recipient");
    expect(x.requester.codec.decode(context.signedManifestBytes).message.kind).toBe(
      "delivery_manifest",
    );
    expect(delivery.manifest.artifacts.map((a) => a.artifactId)).toEqual([
      "hosted-output-contract",
    ]);

    await x.requester.acceptHosted(x.task.request_id, delivery.materialize);
    const snapshot = await x.git.snapshot();
    const proof = await x.recipient.readMaterialization(snapshot, x.task.request_id);
    const ack = await x.recipient.readHosted(snapshot, x.task.request_id, "hosted_ack");
    expect(ack).toMatchObject({ ...x.job.event, stage: "hosted_ack", actorId: "requester" });
    expect(proof).toMatchObject({
      ...delivery.binding,
      requiredArtifactsVerified: true,
      payloadVerification: "hosted_response_source",
      deliveryManifestSha256: sha256Bytes(
        Buffer.from(serializeDeliveryManifestV1(delivery.manifest)),
      ),
      verifiedArtifacts: [delivery.descriptor],
    });
    const ackBatch = x.git.batches.filter((batch) =>
      batch.some((path) => path.endsWith("/hosted_ack.json")),
    );
    expect(ackBatch).toHaveLength(1);
    expect(ackBatch[0]).toHaveLength(2);
    expect(ackBatch[0]?.some((path) => path.endsWith("/materialization.json"))).toBe(true);
    const proofPath = ackBatch[0]?.find((path) => path.endsWith("/materialization.json"));
    if (!proofPath) throw new Error("fixture signed proof missing");
    const signedProof = await x.git.read(snapshot, proofPath);
    if (!signedProof) throw new Error("fixture signed proof missing");
    expect(x.recipient.codec.decode(signedProof)).toMatchObject({
      actorId: "requester",
      message: { kind: "materialization", receipt: proof },
    });

    const reconciled = await x.service.reconcile(x.task.request_id);
    expect(reconciled.acknowledged).toBe(true);
    expect(reconciled.materialization).toEqual(proof);
    expect(reconciled.state).toBe("failed");
    expect(reconciled.source).toBeNull();
    const receiptHash = sha256Bytes(Buffer.from(serializeMaterializationReceiptV1(proof)));
    const pin = x.requesterArchive.pin(x.task.request_id);
    const root = join(pin.localPinnedRoot, pin.relativeDirectory, "materialized", receiptHash);
    expect(readFileSync(join(root, "results/result.json"))).toEqual(delivery.payload);
    expect(readFileSync(join(root, "results/delivery-manifest.signed.json"))).toEqual(
      Buffer.from(context.signedManifestBytes),
    );
    expect(
      parseMaterializationReceiptV1(
        readFileSync(join(root, "results/materialization-receipt.json")),
      ),
    ).toEqual(proof);
    expect(
      readFileSync(
        join(
          root,
          "artifacts",
          `artifact-${sha256Bytes(Buffer.from("hosted-output-contract"))}.bin`,
        ),
      ),
    ).toEqual(x.contractRaw);
    expect(readdirSync(join(root, "artifacts"))).toHaveLength(1);
    const db = new DatabaseSync(join(x.requesterState, "route-archive.db"), { readOnly: true });
    try {
      expect(
        db
          .prepare(
            "SELECT receipt_hash FROM archive2_materializations WHERE request_id=? AND event_id=?",
          )
          .get(x.task.request_id, delivery.binding.terminalEventId)?.receipt_hash,
      ).toBe(receiptHash);
    } finally {
      db.close();
    }

    const before = new Map(x.git.files);
    await x.requester.acceptHosted(x.task.request_id, delivery.materialize);
    await x.service.reconcile(x.task.request_id);
    expect(x.git.files).toEqual(before);
    expect(x.service.get(x.task.request_id)?.attemptId).toBe(x.job.attemptId);
    expect(x.starts()).toBe(1);
    await expect(x.service.start(x.task.request_id)).rejects.toThrow(
      "browser_delivery_start_denied",
    );
  });
  it("missing required contract bytes leave proof+ACK absent and retry only retrieval/materialization", async () => {
    const x = await setup();
    const delivery = await publishKnownNoSend(x);
    const artifactGitHash = gitBlobSha(x.contractRaw);
    expect(x.git.blobs.delete(artifactGitHash)).toBe(true);
    await expect(
      x.requester.acceptHosted(x.task.request_id, delivery.materialize),
    ).rejects.toThrow();
    expect(
      await x.recipient.readHosted(await x.git.snapshot(), x.task.request_id, "hosted_ack"),
    ).toBeNull();
    expect([...x.git.files.keys()].some((path) => path.endsWith("/materialization.json"))).toBe(
      false,
    );
    expect(
      x.git.batches.some((batch) => batch.some((path) => path.endsWith("/hosted_ack.json"))),
    ).toBe(false);
    const pin = x.requesterArchive.pin(x.task.request_id);
    expect(existsSync(join(pin.localPinnedRoot, pin.relativeDirectory, "materialized"))).toBe(
      false,
    );
    expect(x.service.get(x.task.request_id)?.acknowledged).toBe(false);
    expect(x.starts()).toBe(1);
    x.git.blobs.set(artifactGitHash, Uint8Array.from(x.contractRaw));
    await x.requester.acceptHosted(x.task.request_id, delivery.materialize);
    expect((await x.service.reconcile(x.task.request_id)).acknowledged).toBe(true);
    expect(x.starts()).toBe(1);
    expect(x.service.get(x.task.request_id)?.attemptId).toBe(x.job.attemptId);
  });
  it("unknown submission remains nonterminal and cannot produce a manifest, receipt, or ACK", async () => {
    const x = await setup("unknown");
    expect(x.job.state).toBe("unknown");
    expect(x.job.event).toBeNull();
    expect(x.job.response).toBeNull();
    expect(x.job.source).toBeNull();
    expect(x.service.observations(x.task.request_id)).toHaveLength(1);
    await expect(x.service.archiveResult(x.task.request_id)).rejects.toThrow(
      "archive_hosted_not_terminal",
    );
    expect(x.senderArchive.inspect(x.task.request_id).state).toBe("not_archived");
    expect((await x.service.reconcile(x.task.request_id)).state).toBe("unknown");
    const snapshot = await x.git.snapshot();
    expect(await x.recipient.readHosted(snapshot, x.task.request_id, "hosted_result")).toBeNull();
    expect(await x.recipient.readHosted(snapshot, x.task.request_id, "hosted_ack")).toBeNull();
    await expect(
      x.requester.acceptHosted(x.task.request_id, async () => {
        throw new Error("must not materialize unknown");
      }),
    ).rejects.toThrow("transport_result_unverified");
    expect(
      [...x.git.files.keys()].some((path) =>
        /(?:delivery_manifest|materialization|hosted_ack)\.json$/.test(path),
      ),
    ).toBe(false);
    await expect(x.service.start(x.task.request_id)).rejects.toThrow(
      "browser_delivery_start_denied",
    );
    expect(x.starts()).toBe(1);
  });
});
