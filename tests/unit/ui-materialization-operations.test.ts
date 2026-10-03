/** Synthetic Git transport with real Ed25519 signatures, SQLite ledgers and fsync-backed files. */
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type GitObjectStore,
  type GitSnapshot,
  gitBlobSha,
} from "../../src/adapters/github-client.js";
import { GitHubTaskBus, SignedBusCodec } from "../../src/adapters/github-transport.js";
import { ConfiguredGitDeliveryContentStoreV1 } from "../../src/archive/content-store.js";
import {
  createRequesterMaterialization,
  publishVerifiedDelivery,
} from "../../src/archive/delivery-composition.js";
import { LocalRouteArchive } from "../../src/archive/local-route.js";
import { ArchiveDeliveryPersistence } from "../../src/archive/materialization-store.js";
import { LocalDeliveryPayloadVerifier } from "../../src/archive/payload-verifiers.js";
import { RouteArtifactArchive } from "../../src/archive/route-store.js";
import {
  type DeliveryBindingV1,
  serializeMaterializationReceiptV1,
} from "../../src/contracts/materialization.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";
import { TaskController } from "../../src/state/task-controller.js";
import { UnavailableTaskExecutor } from "../../src/state/task-executor.js";
import { openTaskStore } from "../../src/state/task-store.js";
import {
  buildUiOperationsSources,
  currentOperationBindingReader,
} from "../../src/ui/deployment-operations.js";
import { requesterMaterializationPort } from "../../src/ui/materialization-operations.js";
import { UiOperationsService } from "../../src/ui/operations.js";
import { TaskUiService } from "../../src/ui/service.js";
import { adapterPolicy, adapterTask, adapterTaskBytes } from "../helpers/adapter-fixture.js";

class MemoryGit implements GitObjectStore {
  readonly destination = { repositoryFullName: "owner/bus", branch: "main" };
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
    }
    for (const [path, bytes] of files) {
      const hash = gitBlobSha(bytes);
      this.files.set(path, hash);
      this.blobs.set(hash, Uint8Array.from(bytes));
    }
    return "a".repeat(40);
  }
}
const dirs: string[] = [],
  closers: (() => void)[] = [];
function dir() {
  const p = mkdtempSync(join(tmpdir(), "bridge-materialized-roundtrip-"));
  dirs.push(p);
  return p;
}
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});
async function setup(allowRead = true) {
  const state = dir(),
    receiverState = dir(),
    output = dir(),
    registry = new ProjectRegistry(join(state, "registry.db"));
  closers.push(() => registry.close());
  registry.configure(
    {
      schema: "bridge-project-registry-1",
      revision: 1,
      defaultOutputRoot: output,
      projects: [
        {
          projectId: randomUUID(),
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
  const senderArchive = new RouteArtifactArchive({ stateDirectory: state, registry }),
    receiverArchive = new RouteArtifactArchive({ stateDirectory: receiverState, registry });
  closers.push(
    () => senderArchive.close(),
    () => receiverArchive.close(),
  );
  const git = new MemoryGit(),
    keys = { requester: generateKeyPairSync("ed25519"), recipient: generateKeyPairSync("ed25519") };
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
      ),
    requester = bus("requester"),
    recipient = bus("recipient");
  const store = await openTaskStore(join(state, "jobs.db"));
  closers.push(() => store.close());
  const executor = new UnavailableTaskExecutor(),
    policy = adapterPolicy(state, new Date());
  policy.executorId = executor.executorId;
  const archiveAdapter = new LocalRouteArchive(senderArchive, store, {
    recipientActorId: "recipient",
    sessionId: policy.sessionId,
    executorId: executor.executorId,
  });
  const controller = new TaskController(
    store,
    executor,
    policy,
    undefined,
    undefined,
    5000,
    undefined,
    archiveAdapter,
  );
  const task = adapterTask(),
    raw = Buffer.from(JSON.stringify(task));
  await requester.issue(raw, adapterTaskBytes, "recipient", "cli");
  const issued = await recipient.readIssued(
    await git.snapshot(),
    `bridge-v2/request-index/${task.request_id}.json`,
  );
  controller.receive(raw, adapterTaskBytes, task.request_id, "requester", {
    projectRegistration: issued.issued.projectRegistration,
  });
  await controller.cancel(task.request_id);
  await controller.archiveResult(task.request_id);
  for (const stage of ["receipt_ack", "terminal_result"] as const) {
    const event = store.handshake(task.request_id, stage);
    if (!event) throw new Error("fixture missing");
    await recipient.publish(
      event,
      stage === "terminal_result" ? store.deliveryPayload(task.request_id) : undefined,
    );
  }
  const event = store.handshake(task.request_id, "terminal_result");
  if (!event) throw new Error("fixture missing");
  const payload = store.deliveryPayload(task.request_id);
  const binding: DeliveryBindingV1 = {
    requesterActorId: "requester",
    recipientActorId: "recipient",
    requestId: task.request_id,
    taskSpecHash: event.taskSpecHash,
    execution: { kind: "local_execution", runId: null },
    terminalEventId: event.eventId,
    payloadSha256: event.payloadSha256,
  };
  const verifier = new LocalDeliveryPayloadVerifier(async () => ({
    rawTaskSpec: raw,
    taskFileBytes: adapterTaskBytes,
    terminalEvent: event,
  }));
  const verified = await verifier.validatePayload(payload, binding);
  const artifacts = verified.artifacts.map((descriptor) => {
    const ref = store.get(task.request_id)?.result.receipt?.evidence_ref;
    if (!ref) throw new Error("fixture missing");
    const bytes = store.readLocalEvidence(ref);
    if (!bytes) throw new Error("fixture missing");
    return { descriptor, bytes };
  });
  const grants = artifacts.flatMap((a) => [
    {
      operation: "publish" as const,
      destinationId: "artifacts",
      binding,
      purpose: "artifact" as const,
      artifactId: a.descriptor.artifactId,
      contentSha256: a.descriptor.contentSha256,
    },
    ...(allowRead
      ? [
          {
            operation: "read" as const,
            destinationId: "artifacts",
            binding,
            purpose: "artifact" as const,
            artifactId: a.descriptor.artifactId,
            contentSha256: a.descriptor.contentSha256,
          },
        ]
      : []),
  ]);
  const cas = new ConfiguredGitDeliveryContentStoreV1({
    destinations: [
      {
        destinationId: "artifacts",
        store: git,
        namespace: "scoped-artifacts",
        maxBytes: 1024 * 1024,
        timeoutMs: 1000,
        maxFiles: 1000,
      },
    ],
    authorizations: grants,
  });
  const manifest = await publishVerifiedDelivery({
    bus: recipient,
    destinationId: "artifacts",
    payloadAlreadyPublishedOnBusDestinationId: "bus",
    publisher: cas,
    binding,
    payloadBytes: payload,
    artifacts,
    payloadVerifier: verifier,
  });
  receiverArchive.reserve(senderArchive.admission(task.request_id));
  const materialize = createRequesterMaterialization({
    bus: requester,
    busDestinationId: "bus",
    approvedContentDestinationIds: ["artifacts"],
    contentReader: cas,
    persistence: new ArchiveDeliveryPersistence(receiverArchive),
  });
  return {
    task,
    registry,
    requester,
    recipient,
    git,
    store,
    controller,
    receiverArchive,
    materialize,
    manifest,
    payload,
    output,
  };
}

function compose(x: Awaited<ReturnType<typeof setup>>) {
  const service = new TaskUiService(
    { store: x.store, controller: x.controller, authenticatedRequesterId: "requester" },
    { profile: "production" },
  );
  const currentBinding = () => {
    const result = service.task(x.task.request_id).task.result;
    return {
      kind: "local_execution" as const,
      requestId: result.request_id,
      taskSpecHash: result.task_spec_hash,
      taskFileHash: result.task_file_hash,
      sequence: result.observation_seq,
    };
  };
  const materialize = vi.fn((context) =>
    x.materialize(context.payloadBytes, context.terminalEvent, context),
  );
  const port = requesterMaterializationPort({
    bus: x.requester,
    currentBinding: currentOperationBindingReader(service),
    materialize,
  });
  const operations = new UiOperationsService(
    buildUiOperationsSources(service, { registry: x.registry, materialization: port }),
  );
  const terminal = x.store.handshake(x.task.request_id, "terminal_result");
  if (!terminal) throw new Error("missing terminal");
  return {
    port,
    materialize,
    operations,
    currentBinding,
    terminal: { eventId: terminal.eventId, payloadSha256: terminal.payloadSha256 },
  };
}
describe("UI first materialization and ACK using real signed bus/archive classes", () => {
  it("keeps reads side-effect-free, then verifies/persists before the first explicit ACK", async () => {
    const x = await setup(),
      y = compose(x);
    const read = await y.operations.detail("local_execution", x.task.request_id);
    expect(read).toMatchObject({
      state: "available",
      value: {
        delivery: { fullDeliverySufficient: false },
        capabilities: {
          ack: { enabled: true, reason: "verify_materialize_then_ack_exact_delivery" },
        },
      },
    });
    expect(y.materialize).not.toHaveBeenCalled();
    expect(
      await x.recipient.readEvent(await x.git.snapshot(), x.task.request_id, "result_ack"),
    ).toBeNull();
    await y.operations.mutate({
      version: "bridge-operations-1",
      action: "ack",
      binding: y.currentBinding(),
      terminal: y.terminal,
    });
    expect(y.materialize).toHaveBeenCalledTimes(1);
    const snapshot = await x.git.snapshot(),
      proof = await x.recipient.readMaterialization(snapshot, x.task.request_id),
      ack = await x.recipient.readEvent(snapshot, x.task.request_id, "result_ack");
    if (!ack) throw new Error("missing ACK");
    expect(proof.synthetic).toBe(false);
    expect(x.store.deliveryVerified(x.task.request_id)).toBe(false);
    expect(await y.operations.detail("local_execution", x.task.request_id)).toMatchObject({
      state: "available",
      value: {
        delivery: { fullDeliverySufficient: true },
        capabilities: { ack: { enabled: false } },
      },
    });
    const hash = sha256Bytes(Buffer.from(serializeMaterializationReceiptV1(proof)));
    expect(
      readFileSync(
        join(
          x.output,
          x.receiverArchive.pin(x.task.request_id).relativeDirectory,
          "materialized",
          hash,
          "results/result.json",
        ),
      ),
    ).toEqual(Buffer.from(x.payload));
    // Same authenticated event the recipient host tick consumes; never forged by the UI.
    await x.controller.acknowledgeResult(ack, proof);
    expect(await y.operations.detail("local_execution", x.task.request_id)).toMatchObject({
      state: "available",
      value: {
        delivery: { fullDeliverySufficient: true },
        capabilities: { ack: { enabled: false } },
      },
    });
    expect(x.store.get(x.task.request_id)?.intent).toBeNull();
  });
  it("missing artifact permission cannot publish proof/ACK or rerun", async () => {
    const x = await setup(false),
      y = compose(x);
    await expect(
      y.port.materializeAndAcknowledge?.(y.currentBinding(), y.terminal),
    ).rejects.toThrow();
    expect(
      await x.recipient.readEvent(await x.git.snapshot(), x.task.request_id, "result_ack"),
    ).toBeNull();
    expect(x.store.get(x.task.request_id)?.intent).toBeNull();
  });
  it("rejects stale revision and wrong terminal before materializing", async () => {
    const x = await setup(),
      y = compose(x);
    await expect(
      y.port.materializeAndAcknowledge?.({ ...y.currentBinding(), sequence: 999 }, y.terminal),
    ).rejects.toThrow("changed");
    await expect(
      y.port.materializeAndAcknowledge?.(y.currentBinding(), {
        ...y.terminal,
        payloadSha256: "f".repeat(64),
      }),
    ).rejects.toThrow("exact requester");
    expect(y.materialize).not.toHaveBeenCalled();
  });
  it("a changed operation during durable materialization blocks ACK without undoing the saved bytes", async () => {
    const x = await setup(),
      y = compose(x);
    let changed = false;
    const port = requesterMaterializationPort({
      bus: x.requester,
      currentBinding: () => ({
        ...y.currentBinding(),
        sequence: changed ? 999 : y.currentBinding().sequence,
      }),
      materialize: async (context) => {
        const proof = await x.materialize(context.payloadBytes, context.terminalEvent, context);
        changed = true;
        return proof;
      },
    });
    await expect(port.materializeAndAcknowledge?.(y.currentBinding(), y.terminal)).rejects.toThrow(
      "changed",
    );
    expect(
      await x.recipient.readEvent(await x.git.snapshot(), x.task.request_id, "result_ack"),
    ).toBeNull();
    expect(x.store.get(x.task.request_id)?.intent).toBeNull();
  });
});
