/** Fake DOM/Git only: real installed renderer, signed transport, SQLite and durable materialization. */
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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
import {
  HostedPromptPolicyRegistry,
  parseHostedPromptReceipt,
  registerHostedPromptPolicy,
} from "../../src/adapters/hosted-prompt-policy.js";
import { ConfiguredGitDeliveryContentStoreV1 } from "../../src/archive/content-store.js";
import {
  createHostedPayloadContext,
  createRequesterMaterialization,
  publishVerifiedDelivery,
} from "../../src/archive/delivery-composition.js";
import { ExactHostedSourceResolver } from "../../src/archive/hosted-source.js";
import { ArchiveDeliveryPersistence } from "../../src/archive/materialization-store.js";
import { buildHostedSourceProofV2 } from "../../src/archive/output-evidence.js";
import {
  expectedHostedPrompt,
  HostedDeliveryPayloadVerifier,
} from "../../src/archive/payload-verifiers.js";
import { RouteArtifactArchive } from "../../src/archive/route-store.js";
import { buildRecoveredResult } from "../../src/cli/collect.js";
import { loadConfig } from "../../src/cli/config.js";
import { checkResultInvariants } from "../../src/contracts/invariants.js";
import {
  type DeliveryBindingV1,
  type MaterializationReceiptV1,
  parseMaterializationReceiptV1,
  serializeMaterializationReceiptV1,
} from "../../src/contracts/materialization.js";
import {
  type OutputContractBindingV1,
  outputContractDigest,
  parseOutputContractV1,
} from "../../src/contracts/output-contract.js";
import {
  encodeResponseFrame,
  parseResponseFrame,
  type ResponseFrameIdentity,
} from "../../src/contracts/response-frame.js";
import { sha256Bytes, validateTaskResultStructure } from "../../src/contracts/task.js";
import type { ChatRequest } from "../../src/contracts/types.js";
import { verifyInstalledHostedRenderer } from "../../src/prompt-rendering/hosted-registry.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";
import { hostedPromptFixture } from "../helpers/hosted-prompt-fixture.js";
import { fixtureProjectRegistry } from "../helpers/output-contract-fixture.js";

/** Atomic append, with a read-only observation immediately before proof/ACK publication. */
class MemoryGit implements GitObjectStore {
  readonly destination = { repositoryFullName: "owner/bus", branch: "main" };
  readonly files = new Map<string, string>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly batches: string[][] = [];
  beforeAppend: ((files: ReadonlyMap<string, Uint8Array>) => void) | null = null;
  async snapshot(): Promise<GitSnapshot> {
    return { commit: "a".repeat(40), tree: "b".repeat(40), files: new Map(this.files) };
  }
  async read(snapshot: GitSnapshot, path: string) {
    const bytes = this.blobs.get(snapshot.files.get(path) ?? "");
    return bytes ? Uint8Array.from(bytes) : null;
  }
  async append(files: ReadonlyMap<string, Uint8Array>) {
    for (const [path, bytes] of files)
      if (this.files.has(path) && this.files.get(path) !== gitBlobSha(bytes))
        throw new Error("fixture_git_conflict");
    this.beforeAppend?.(files);
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
  const path = mkdtempSync(join(tmpdir(), "hosted-prompt-roundtrip-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function setup(modelId: "gpt-5.6-sol" | "gpt-5.5" = "gpt-5.6-sol") {
  const fixture = hostedPromptFixture(modelId);
  const senderState = temporaryDirectory(),
    requesterState = temporaryDirectory(),
    output = temporaryDirectory();
  const registry = new ProjectRegistry(join(senderState, "registry.db"));
  closers.push(() => registry.close());
  registry.configure({ ...fixtureProjectRegistry.snapshot(1), defaultOutputRoot: output }, 0);
  const contractRaw = Buffer.from(
    JSON.stringify({
      ...parseOutputContractV1(fixture.outputContractRaw),
      registrySnapshotSha256: registry.snapshotHash(1),
    }),
  );
  const contract = parseOutputContractV1(contractRaw);
  const outputContractBinding: OutputContractBindingV1 = {
    requestId: contract.requestId,
    taskSpecHash: contract.taskSpecHash,
    taskFileHash: contract.taskFileHash,
    route: contract.route,
    requesterActorId: contract.requesterActorId,
    recipientActorId: contract.recipientActorId,
    policySnapshotSha256: contract.policySnapshotSha256,
    registryRevision: contract.registryRevision,
    registrySnapshotSha256: contract.registrySnapshotSha256,
    projectId: contract.projectId,
    repoId: contract.repoId,
    storageSlug: contract.storageSlug,
    destination: contract.destination,
  };
  const senderArchive = new RouteArtifactArchive({ stateDirectory: senderState, registry });
  const requesterArchive = new RouteArtifactArchive({ stateDirectory: requesterState, registry });
  closers.push(
    () => senderArchive.close(),
    () => requesterArchive.close(),
  );
  const git = new MemoryGit();
  // Ephemeral signing keys only; no credential reads or external Git operations.
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
  const requester = bus("requester"),
    recipient = bus("recipient");
  const now = new Date("2026-10-03T05:00:00.000Z");
  let starts = 0,
    snapshotReads = 0,
    promptText = "",
    framedText = "";
  let receiptObservedBeforeHandoff = false;
  const sourceResolver = new ExactHostedSourceResolver({
    read: async () => {
      snapshotReads++;
      return {
        state: "available",
        conversationId: "fixture",
        turns: [
          {
            messageId: "user-fixture",
            role: "user",
            text: promptText,
            markdown: promptText,
            artifacts: [],
          },
          {
            messageId: "assistant-fixture",
            role: "assistant",
            text: framedText,
            markdown: framedText,
            artifacts: [],
            artifactEnumerationKnown: false,
            artifactObservationChecked: true,
            artifactReaderVersion: "trusted-snapshot-1",
          },
        ],
      };
    },
  });
  const run: BrowserRun = async (path, control) => {
    starts++;
    const dir = dirname(path);
    const request = JSON.parse(await readFile(path, "utf8")) as ChatRequest;
    const frame = JSON.parse(
      await readFile(join(dir, "framing.json"), "utf8"),
    ) as ResponseFrameIdentity;
    promptText = await readFile(join(dir, "prompt.md"), "utf8");
    expect(request).toMatchObject({
      target: "chat",
      model: modelId,
      newChat: false,
      attachments: [],
    });
    expect(control.assertPromptBinding).toBeTypeOf("function");
    // A separate connection can observe the committed intent, receipt and budget before handoff.
    const db = new DatabaseSync(join(senderState, "hosted-delivery.db"), { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT body,digest FROM hosted_prompt_receipts WHERE request_id=? AND attempt_id=?",
        )
        .get(request.requestId, frame.attemptId);
      if (!row) throw new Error("fixture_receipt_not_committed");
      const receiptRaw = Buffer.from(String(row.body)),
        receipt = parseHostedPromptReceipt(receiptRaw);
      const saved = db
        .prepare("SELECT snapshot FROM hosted_jobs WHERE id=?")
        .get(request.requestId);
      expect(JSON.parse(String(saved?.snapshot))).toMatchObject({
        state: "unknown",
        attempted: true,
        attemptId: frame.attemptId,
        promptReceiptSha256: row.digest,
      });
      expect(db.prepare("SELECT starts FROM hosted_budget WHERE id=1").get()?.starts).toBe(1);
      expect(row.digest).toBe(sha256Bytes(receiptRaw));
      expect(receipt).toMatchObject({
        requestId: fixture.task.request_id,
        attemptId: frame.attemptId,
        policySnapshotSha256: fixture.policySnapshotSha256,
        profileSha256: fixture.profileSha256,
        rendererArtifactSha256: fixture.rendererArtifactSha256,
        modelId,
        promptSha256: sha256Bytes(Buffer.from(promptText)),
        promptSizeBytes: Buffer.byteLength(promptText),
        outputContractSha256: sha256Bytes(contractRaw),
        session: null,
        bootstrap: null,
      });
      receiptObservedBeforeHandoff = true;
    } finally {
      db.close();
    }
    control.assertPromptBinding?.(request, promptText);
    expect(snapshotReads).toBe(0);
    framedText = encodeResponseFrame(
      `BRIDGE ARTIFACT DECLARATION ${JSON.stringify({
        schema: "artifact-declaration-1",
        ...frame,
        outputContractSha256: outputContractDigest(contractRaw),
        outputs: [],
      })}\nSynthetic answer: no model was called.`,
      frame,
    );
    const parsed = parseResponseFrame(framedText, frame);
    const source = await sourceResolver.pin({
      conversationId: "fixture",
      promptText,
      promptSha256: sha256Bytes(Buffer.from(promptText)),
      frame: { identity: frame, rawSha256: parsed.rawSha256, bodySha256: parsed.bodySha256 },
    });
    expect(source.state).toBe("available");
    await writeFile(join(dir, "response.md"), framedText);
    const result = buildRecoveredResult(
      {
        requestId: request.requestId,
        conversationUrl: request.conversationUrl ?? "",
        submittedAt: now.toISOString(),
        baselineAssistantCount: 0,
        request,
      },
      { markdown: parsed.markdown, method: "dom", quality: "full", modelSlug: null },
      "response.md",
      "fixture",
      now,
    );
    expect(checkResultInvariants(result)).toEqual([]);
    return { result, source };
  };
  const config = loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: senderState });
  const makeService = () =>
    new BrowserDeliveryService(recipient, config, fixture.registration, run, () => now, {
      archive: senderArchive,
      sourceResolver,
    });
  let service = makeService();
  closers.push(() => service.close());
  await requester.issue(
    fixture.rawTaskSpec,
    fixture.taskFileBytes,
    "recipient",
    "ordinary_chat_browser",
    contractRaw,
  );
  const received = await recipient.readIssued(
    await git.snapshot(),
    `bridge-v2/request-index/${fixture.task.request_id}.json`,
  );
  service.receive(received.issued, received.raw, received.taskBytes, received.outputContractRaw);
  requesterArchive.reserve(senderArchive.admission(fixture.task.request_id));
  service.approve(fixture.task.request_id, {
    actorId: "owner",
    taskSpecHash: sha256Bytes(fixture.rawTaskSpec),
    expiresAt: "2026-10-03T05:01:00.000Z",
    authenticated: true,
  });
  const job = await service.start(fixture.task.request_id);
  return {
    fixture,
    registry,
    senderState,
    requesterState,
    senderArchive,
    requesterArchive,
    git,
    requester,
    recipient,
    contractRaw,
    outputContractBinding,
    job,
    get service() {
      return service;
    },
    restart: () => {
      service.close();
      service = makeService();
    },
    starts: () => starts,
    promptText: () => promptText,
    framedText: () => framedText,
    receiptObservedBeforeHandoff: () => receiptObservedBeforeHandoff,
  };
}

async function publish(x: Awaited<ReturnType<typeof setup>>) {
  const { event, response, attemptId, source } = x.job;
  if (!event || !response || !attemptId || source?.state !== "available")
    throw new Error("fixture_terminal_missing");
  await x.service.reconcile(x.fixture.task.request_id);
  const archived = x.senderArchive.inspect(x.fixture.task.request_id);
  if (archived.state !== "complete" || !archived.manifestSha256)
    throw new Error("fixture_archive_incomplete");
  const proof = buildHostedSourceProofV2(response, source, x.contractRaw);
  const artifacts = proof.artifacts.map((descriptor) => ({
    descriptor,
    bytes: x.senderArchive.readItem(
      x.fixture.task.request_id,
      archived.manifestSha256 as string,
      descriptor.artifactId,
    ),
  }));
  const binding: DeliveryBindingV1 = {
    requesterActorId: "requester",
    recipientActorId: "recipient",
    requestId: x.fixture.task.request_id,
    taskSpecHash: event.taskSpecHash,
    execution: { kind: "hosted_delivery", attemptId },
    terminalEventId: event.eventId,
    payloadSha256: event.payloadSha256,
  };
  const payload = Buffer.from(`${JSON.stringify(response)}\n`);
  const verifier = new HostedDeliveryPayloadVerifier(async () => ({
    rawTaskSpec: x.fixture.rawTaskSpec,
    taskFileBytes: x.fixture.taskFileBytes,
    terminalEvent: event,
    claimedArtifacts: proof.artifacts,
    promptRendering: { mode: "bound-hosted-v1", policy: x.fixture.registration },
    expectedConversationId: "fixture",
    outputContractRaw: x.contractRaw,
    expectedOutputPolicy: x.fixture.policy.delivery.expectedOutputPolicy,
    outputContractBinding: x.outputContractBinding,
  }));
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
    authorizations: artifacts.flatMap(({ descriptor }) =>
      (["publish", "read"] as const).map((operation) => ({
        operation,
        destinationId: "artifacts",
        binding,
        purpose: "artifact" as const,
        artifactId: descriptor.artifactId,
        contentSha256: descriptor.contentSha256,
      })),
    ),
  });
  const manifest = await publishVerifiedDelivery({
    bus: x.recipient,
    destinationId: "artifacts",
    payloadAlreadyPublishedOnBusDestinationId: "bus",
    publisher: cas,
    binding,
    payloadBytes: payload,
    artifacts,
    payloadVerifier: verifier,
  });
  const lookups: string[] = [],
    history = new HostedPromptPolicyRegistry();
  const hostedContext = createHostedPayloadContext(x.registry, (hash) => {
    lookups.push(hash);
    return history.get(hash);
  });
  const materialize = createRequesterMaterialization({
    bus: x.requester,
    busDestinationId: "bus",
    approvedContentDestinationIds: ["artifacts"],
    contentReader: cas,
    persistence: new ArchiveDeliveryPersistence(x.requesterArchive),
    hostedContext,
  });
  return {
    binding,
    payload,
    artifacts,
    manifest,
    proof,
    history,
    lookups,
    hostedContext,
    materialize,
  };
}

function registerHistoricalPolicy(
  x: Awaited<ReturnType<typeof setup>>,
  history: HostedPromptPolicyRegistry,
) {
  // Requester performs its own installed-byte verification and receives a new opaque handle.
  const renderer = verifyInstalledHostedRenderer({
    profileRaw: x.fixture.profileRaw,
    profileSha256: x.fixture.profileSha256,
    rendererArtifactSha256: x.fixture.rendererArtifactSha256,
    policySnapshotSha256: x.fixture.policySnapshotSha256,
  });
  const policy = registerHostedPromptPolicy(x.fixture.policyRaw, renderer);
  expect(policy).not.toBe(x.fixture.registration);
  history.add(policy);
  return policy;
}

function materializedRoot(x: Awaited<ReturnType<typeof setup>>, receipt: MaterializationReceiptV1) {
  const pin = x.requesterArchive.pin(x.fixture.task.request_id);
  return join(
    pin.localPinnedRoot,
    pin.relativeDirectory,
    "materialized",
    sha256Bytes(Buffer.from(serializeMaterializationReceiptV1(receipt))),
  );
}

describe("V2 hosted prompt production-component roundtrip, fake browser and Git only", () => {
  it.each(["gpt-5.6-sol", "gpt-5.5"] as const)(
    "captures, reconstructs, durably materializes and ACKs %s exactly once",
    async (modelId) => {
      const x = await setup(modelId),
        id = x.fixture.task.request_id;
      expect(x.starts()).toBe(1);
      expect(x.receiptObservedBeforeHandoff()).toBe(true);
      expect(x.job.state).toBe("completed");
      expect(x.job.response).toMatchObject({
        version: "hosted-response-1",
        evidence: "ordinary-chat-browser-dom",
        localExecution: false,
      });
      expect(validateTaskResultStructure(x.job.response).valid).toBe(false);
      expect(x.job.source).toMatchObject({
        provenance: { promptSha256: sha256Bytes(Buffer.from(x.promptText())) },
      });
      const receiptBeforeRestart = x.service.promptReceipt(id);
      const delivery = await publish(x);
      const requesterPolicy = registerHistoricalPolicy(x, delivery.history);
      // A newer unrelated registration and current registry snapshot must not replace admitted history.
      delivery.history.add(
        hostedPromptFixture(modelId === "gpt-5.5" ? "gpt-5.6-sol" : "gpt-5.5").registration,
      );
      const oldRegistryHash = x.registry.snapshotHash(1);
      x.registry.configure(
        {
          ...x.registry.snapshot(1),
          revision: 2,
          projects: x.registry
            .snapshot(1)
            .projects.map((p) => ({ ...p, displayName: "Updated current project" })),
        },
        1,
      );
      expect(x.registry.currentRevision()).toBe(2);
      expect(x.registry.snapshotHash(2)).not.toBe(oldRegistryHash);
      const context = await x.requester.deliveryContext(await x.git.snapshot(), id);
      expect(x.requester.codec.decode(context.signedManifestBytes)).toMatchObject({
        actorId: "recipient",
        message: { kind: "delivery_manifest" },
      });
      const trusted = await delivery.hostedContext(context);
      expect(trusted.promptRendering).toEqual({ mode: "bound-hosted-v1", policy: requesterPolicy });
      expect(trusted.outputContractBinding.registryRevision).toBe(1);
      expect(trusted.outputContractBinding.registrySnapshotSha256).toBe(oldRegistryHash);
      if (!x.job.response?.framing) throw new Error("fixture_frame_missing");
      const reconstructed = expectedHostedPrompt(
        {
          ...trusted,
          rawTaskSpec: context.rawTaskSpec,
          taskFileBytes: context.taskFileBytes,
          terminalEvent: x.job.event as NonNullable<typeof x.job.event>,
          claimedArtifacts: delivery.proof.artifacts,
        },
        x.job.response.framing.identity,
      );
      expect(Buffer.from(reconstructed)).toEqual(Buffer.from(x.promptText()));
      expect(sha256Bytes(reconstructed)).toBe(delivery.proof.proof.source.promptSha256);
      expect(delivery.proof.proof.source.promptMatchSha256).toBe(
        sha256Bytes(Buffer.from(x.promptText().replace(/\r\n?/g, "\n").trim())),
      );
      x.restart();
      expect(x.service.promptReceipt(id)).toEqual(receiptBeforeRestart);
      expect(x.service.get(id)?.attemptId).toBe(x.job.attemptId);
      let persistedBeforeAck = 0;
      x.git.beforeAppend = (files) => {
        if (![...files.keys()].some((path) => path.endsWith("/hosted_ack.json"))) return;
        const signed = [...files].find(([path]) => path.endsWith("/materialization.json"))?.[1];
        if (!signed) throw new Error("fixture_atomic_proof_missing");
        const decoded = x.recipient.codec.decode(signed);
        expect(decoded.actorId).toBe("requester");
        if (decoded.message.kind !== "materialization") throw new Error("fixture_proof_kind");
        const receipt = decoded.message.receipt,
          root = materializedRoot(x, receipt);
        expect(readFileSync(join(root, "results/result.json"))).toEqual(delivery.payload);
        expect(
          parseMaterializationReceiptV1(
            readFileSync(join(root, "results/materialization-receipt.json")),
          ),
        ).toEqual(receipt);
        const db = new DatabaseSync(join(x.requesterState, "route-archive.db"), { readOnly: true });
        try {
          expect(
            db
              .prepare(
                "SELECT receipt_hash FROM archive2_materializations WHERE request_id=? AND event_id=?",
              )
              .get(id, delivery.binding.terminalEventId)?.receipt_hash,
          ).toBe(sha256Bytes(Buffer.from(serializeMaterializationReceiptV1(receipt))));
        } finally {
          db.close();
        }
        persistedBeforeAck++;
      };
      await x.requester.acceptHosted(id, delivery.materialize);
      expect(persistedBeforeAck).toBe(1);
      const proof = await x.recipient.readMaterialization(await x.git.snapshot(), id);
      const ack = await x.recipient.readHosted(await x.git.snapshot(), id, "hosted_ack");
      expect(ack).toEqual({ ...x.job.event, actorId: "requester", stage: "hosted_ack" });
      expect(proof).toMatchObject({
        ...delivery.binding,
        payloadVerification: "hosted_response_source",
        requiredArtifactsVerified: true,
        verifiedArtifacts: delivery.proof.artifacts,
      });
      const root = materializedRoot(x, proof);
      expect(readFileSync(join(root, "results/delivery-manifest.signed.json"))).toEqual(
        Buffer.from(context.signedManifestBytes),
      );
      for (const artifact of delivery.artifacts)
        expect(
          readFileSync(
            join(
              root,
              "artifacts",
              `artifact-${sha256Bytes(Buffer.from(artifact.descriptor.artifactId))}.bin`,
            ),
          ),
        ).toEqual(Buffer.from(artifact.bytes));
      expect(readdirSync(join(root, "artifacts"))).toHaveLength(3);
      expect(delivery.manifest.artifacts.map((a) => a.artifactId)).toEqual([
        "hosted-output-contract",
        "hosted-response-body",
        "hosted-source-proof",
      ]);
      expect(x.senderArchive.provenance(id)[0]?.observation).toMatchObject({
        kind: "hosted_delivery",
        attemptId: x.job.attemptId,
        userTurnId: "user-fixture",
        assistantTurnId: "assistant-fixture",
      });
      const reconciled = await x.service.reconcile(id);
      expect(reconciled).toMatchObject({
        state: "completed",
        acknowledged: true,
        materialization: proof,
      });
      const ackBatches = x.git.batches.filter((batch) =>
        batch.some((path) => path.endsWith("/hosted_ack.json")),
      );
      expect(ackBatches).toHaveLength(1);
      expect(ackBatches[0]).toHaveLength(2);
      const files = new Map(x.git.files);
      await x.requester.acceptHosted(id, delivery.materialize);
      await x.service.reconcile(id);
      await x.service.reconcile(id);
      expect(x.git.files).toEqual(files);
      // Repeated acceptance may append the same immutable proof/ACK; it adds no new identity.
      for (const batch of x.git.batches.filter((batch) =>
        batch.some((path) => path.endsWith("/hosted_ack.json")),
      ))
        expect(batch).toEqual(ackBatches[0]);
      await expect(x.service.start(id)).rejects.toThrow("browser_delivery_start_denied");
      expect(x.service.get(id)?.attemptId).toBe(x.job.attemptId);
      expect(x.starts()).toBe(1);
      expect(new Set(delivery.lookups)).toEqual(new Set([x.fixture.policySnapshotSha256]));
    },
  );

  it("blocks materialization and ACK when historical V2 policy is absent, then only retries verification", async () => {
    const x = await setup(),
      id = x.fixture.task.request_id,
      delivery = await publish(x);
    // A valid different current policy is deliberately insufficient for this historical request.
    delivery.history.add(hostedPromptFixture("gpt-5.5").registration);
    await expect(x.requester.acceptHosted(id, delivery.materialize)).rejects.toThrow(
      "delivery_hosted_policy_unavailable",
    );
    expect(await x.recipient.readHosted(await x.git.snapshot(), id, "hosted_ack")).toBeNull();
    expect([...x.git.files.keys()].some((path) => path.endsWith("/materialization.json"))).toBe(
      false,
    );
    const pin = x.requesterArchive.pin(id);
    expect(existsSync(join(pin.localPinnedRoot, pin.relativeDirectory, "materialized"))).toBe(
      false,
    );
    const db = new DatabaseSync(join(x.requesterState, "route-archive.db"), { readOnly: true });
    try {
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM archive2_materializations").get()?.count,
      ).toBe(0);
    } finally {
      db.close();
    }
    const attemptId = x.job.attemptId,
      receipt = x.service.promptReceipt(id);
    x.restart();
    expect((await x.service.reconcile(id)).acknowledged).toBe(false);
    expect(x.starts()).toBe(1);
    registerHistoricalPolicy(x, delivery.history);
    await x.requester.acceptHosted(id, delivery.materialize);
    expect((await x.service.reconcile(id)).acknowledged).toBe(true);
    expect(x.service.promptReceipt(id)).toEqual(receipt);
    expect(x.service.get(id)?.attemptId).toBe(attemptId);
    await expect(x.service.start(id)).rejects.toThrow("browser_delivery_start_denied");
    expect(x.starts()).toBe(1);
    expect(new Set(delivery.lookups)).toEqual(new Set([x.fixture.policySnapshotSha256]));
  });
});
