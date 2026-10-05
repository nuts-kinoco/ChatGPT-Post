import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchiveDeliveryPersistence } from "../../src/archive/materialization-store.js";
import type { VerifiedDeliveryMaterializationV1 } from "../../src/archive/materializer.js";
import { RouteArtifactArchive } from "../../src/archive/route-store.js";
import type { JobAdmissionV1 } from "../../src/archive/route-types.js";
import {
  type MaterializationReceiptV1,
  serializeDeliveryManifestV1,
  serializeMaterializationReceiptV1,
} from "../../src/contracts/materialization.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";

const writeFault = vi.hoisted(() => ({ enabled: false, calls: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeSync: (...args: unknown[]) => {
      if (writeFault.enabled) {
        // The guard bounds reproduction on the old nonprogressing write loop.
        if (++writeFault.calls > 1) throw new Error("unexpected_second_write");
        return 0;
      }
      return Reflect.apply(real.writeSync, real, args);
    },
  };
});

const dirs: string[] = [],
  closers: (() => void)[] = [];
function directory() {
  const p = mkdtempSync(join(tmpdir(), "materialization-real-store-"));
  dirs.push(p);
  return p;
}
afterEach(() => {
  writeFault.enabled = false;
  writeFault.calls = 0;
  for (const fn of closers.splice(0).reverse()) fn();
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});
function setup(
  kind: "local_execution" | "hosted_delivery" = "local_execution",
  fault?: () => void,
) {
  const state = directory(),
    root = directory(),
    registry = new ProjectRegistry(join(state, "registry.db"));
  closers.push(() => registry.close());
  const projectId = randomUUID();
  registry.configure(
    {
      schema: "bridge-project-registry-1",
      revision: 1,
      defaultOutputRoot: root,
      projects: [
        {
          projectId,
          repoId: "fixture",
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
  const archive = new RouteArtifactArchive({
    stateDirectory: state,
    registry,
    pathPolicy: fault ? { beforeSyncDirectory: fault } : {},
  });
  closers.push(() => archive.close());
  const requestId = randomUUID(),
    taskSpecHash = "a".repeat(64),
    actor = { requesterActorId: "requester", recipientActorId: "recipient" };
  const admission: JobAdmissionV1 = {
    schema: "job-admission-1",
    requestId,
    taskSpecHash,
    outputContractSha256: null,
    taskFileHash: "b".repeat(64),
    registryRevision: 1,
    registrySnapshotHash: registry.snapshotHash(1),
    projectId,
    repoId: "fixture",
    storageSlug: "fixture",
    ...actor,
    route:
      kind === "local_execution"
        ? { kind, policyHash: "c".repeat(64), sessionId: randomUUID(), executorId: "executor" }
        : {
            kind,
            policyHash: "c".repeat(64),
            conversationId: "exact-conversation",
            destinationId: "chat",
          },
  };
  const contractBytes = Buffer.from(
    JSON.stringify({
      schema: "output-contract-1",
      requestId,
      taskSpecHash,
      taskFileHash: admission.taskFileHash,
      route: "hosted_delivery",
      ...actor,
      policySnapshotSha256: admission.route.policyHash,
      registryRevision: 1,
      registrySnapshotSha256: admission.registrySnapshotHash,
      projectId,
      repoId: "fixture",
      storageSlug: "fixture",
      destination: {
        repositoryFullName: "owner/bus",
        branch: "main",
        namespace: "bridge-v2",
        conversationId: "exact-conversation",
      },
      mode: "text_only",
      requiredOutputs: [],
      allowAdditionalArtifacts: false,
      maxArtifacts: 0,
      maxTotalBytes: 0,
      declarationFormat: "bridge-artifact-declaration-1",
    }),
  );
  if (kind === "hosted_delivery") admission.outputContractSha256 = sha256Bytes(contractBytes);
  const pin = archive.reserve(admission),
    payloadBytes = Buffer.from("synthetic validated payload"),
    artifactBytes = Buffer.from("synthetic validated evidence"),
    signedDeliveryManifestBytes = Buffer.from(
      "synthetic signer bytes: cryptographic validation is upstream",
    );
  const binding = {
    ...actor,
    requestId,
    taskSpecHash,
    execution:
      kind === "local_execution"
        ? { kind, runId: randomUUID() }
        : { kind, attemptId: randomUUID() },
    terminalEventId: randomUUID(),
    payloadSha256: sha256Bytes(payloadBytes),
  };
  const descriptor = {
    artifactId: "evidence",
    contentSha256: sha256Bytes(artifactBytes),
    sizeBytes: artifactBytes.length,
    required: true,
  };
  const verifiedArtifacts = [
    { descriptor, bytes: artifactBytes },
    ...(kind === "hosted_delivery"
      ? [
          {
            descriptor: {
              artifactId: "hosted-output-contract",
              contentSha256: sha256Bytes(contractBytes),
              sizeBytes: contractBytes.length,
              required: true,
            },
            bytes: contractBytes,
          },
        ]
      : []),
  ];
  const deliveryManifestBytes = Buffer.from(
    serializeDeliveryManifestV1({
      ...binding,
      schema: "delivery-manifest-1",
      artifactSet: "complete",
      payload: {
        source: { destinationId: "fixture", contentSha256: binding.payloadSha256 },
        sizeBytes: payloadBytes.length,
      },
      artifacts: verifiedArtifacts.map(({ descriptor }) => ({
        ...descriptor,
        availability: "available",
        source: { destinationId: "fixture", contentSha256: descriptor.contentSha256 },
      })),
    }),
  );
  const receipt: MaterializationReceiptV1 = {
    ...binding,
    schema: "materialization-receipt-1",
    deliveryManifestSha256: sha256Bytes(deliveryManifestBytes),
    requiredArtifactsVerified: true,
    payloadVerification:
      kind === "local_execution" ? "local_result_and_receipt" : "hosted_response_source",
    synthetic: true,
    verifiedArtifacts: verifiedArtifacts.map((a) => a.descriptor),
  };
  const receiptBytes = Buffer.from(serializeMaterializationReceiptV1(receipt));
  const input: VerifiedDeliveryMaterializationV1 = {
    binding,
    signedDeliveryManifestBytes,
    deliveryManifestBytes,
    deliveryManifestSha256: receipt.deliveryManifestSha256,
    payloadBytes,
    verifiedArtifacts,
    receipt,
    receiptBytes,
    receiptSha256: sha256Bytes(receiptBytes),
  };
  return {
    state,
    root,
    registry,
    archive,
    pin,
    input,
    sink: new ArchiveDeliveryPersistence(archive),
  };
}
describe("real requester pinned-root durability, synthetic upstream proof only", () => {
  it.each(["local_execution", "hosted_delivery"] as const)(
    "fsyncs, saves and verifies %s exact bytes before durable receipt",
    async (kind) => {
      const x = setup(kind);
      expect(readdirSync(x.root)).toEqual([]);
      expect(await x.sink.persistVerified(x.input)).toEqual({
        state: "durable",
        receiptSha256: x.input.receiptSha256,
      });
      const base = join(x.root, x.pin.relativeDirectory, "materialized", x.input.receiptSha256);
      expect(readFileSync(join(base, "results/result.json"))).toEqual(x.input.payloadBytes);
      expect(readFileSync(join(base, "results/materialization-receipt.json"))).toEqual(
        x.input.receiptBytes,
      );
      expect(await x.sink.persistVerified(x.input)).toEqual({
        state: "durable",
        receiptSha256: x.input.receiptSha256,
      });
    },
  );
  it("missing admission never creates a new root pin", async () => {
    const x = setup();
    const input = structuredClone(x.input);
    input.binding.requestId = randomUUID();
    await expect(x.sink.persistVerified(input)).rejects.toThrow();
    expect(readdirSync(x.root)).toEqual([]);
  });
  it("fsync failure returns no durable success and retry does not rerun anything", async () => {
    let fail = true;
    const x = setup("local_execution", () => {
      if (fail) throw new Error("test fsync fault");
    });
    await expect(x.sink.persistVerified(x.input)).rejects.toThrow();
    fail = false;
    expect((await x.sink.persistVerified(x.input)).state).toBe("durable");
  });
  it.each(["local_execution", "hosted_delivery"] as const)(
    "%s zero-progress write rolls back its receipt and recovers with the same identity",
    async (kind) => {
      const x = setup(kind),
        original = structuredClone(x.input);
      const db = new DatabaseSync(join(x.state, "route-archive.db"), { readOnly: true });
      closers.push(() => db.close());
      const receipts = () => db.prepare("SELECT * FROM archive2_materializations").all();
      writeFault.enabled = true;
      await expect(x.sink.persistVerified(x.input)).rejects.toThrow(
        "archive_write_verification_failed",
      );
      expect(writeFault.calls).toBe(1);
      expect(receipts()).toEqual([]);
      const destination = join(
        x.root,
        x.pin.relativeDirectory,
        "materialized",
        x.input.receiptSha256,
      );
      expect(existsSync(destination)).toBe(false);
      writeFault.enabled = false;
      expect(await x.sink.persistVerified(x.input)).toEqual({
        state: "durable",
        receiptSha256: original.receiptSha256,
      });
      expect(structuredClone(x.input)).toEqual(original);
      expect(x.archive.pin(original.binding.requestId)).toEqual(x.pin);
      expect(receipts()).toEqual([
        {
          request_id: original.binding.requestId,
          event_id: original.binding.terminalEventId,
          receipt_hash: original.receiptSha256,
          body: Buffer.from(original.receiptBytes).toString("utf8"),
        },
      ]);
      expect(readFileSync(join(destination, "results/result.json"))).toEqual(
        Buffer.from(original.payloadBytes),
      );
    },
  );
  it("root revisions do not change the requester's existing materialization destination", async () => {
    const x = setup(),
      other = directory();
    x.registry.configure({ ...x.registry.snapshot(), revision: 2, defaultOutputRoot: other }, 1);
    await x.sink.persistVerified(x.input);
    expect(readdirSync(other)).toEqual([]);
    expect(x.archive.pin(x.input.binding.requestId).localPinnedRoot).toBe(x.root);
  });
  it("corrupt saved evidence blocks retry without overwriting it", async () => {
    const x = setup();
    await x.sink.persistVerified(x.input);
    const p = join(
      x.root,
      x.pin.relativeDirectory,
      "materialized",
      x.input.receiptSha256,
      "results/result.json",
    );
    writeFileSync(p, "changed", { mode: 0o600 });
    await expect(x.sink.persistVerified(x.input)).rejects.toThrow("archive_content_hash_mismatch");
    expect(readFileSync(p, "utf8")).toBe("changed");
  });
  it("does not trust mismatched content, receipt hashes, requester or route", async () => {
    const x = setup();
    for (const mutate of [
      (i: VerifiedDeliveryMaterializationV1) => {
        i.payloadBytes = Buffer.from("bad");
      },
      (i: VerifiedDeliveryMaterializationV1) => {
        i.receiptSha256 = "f".repeat(64);
      },
      (i: VerifiedDeliveryMaterializationV1) => {
        i.binding.requesterActorId = "stranger";
      },
    ]) {
      const input = structuredClone(x.input);
      mutate(input);
      await expect(x.sink.persistVerified(input)).rejects.toThrow();
    }
    expect(readdirSync(x.root)).toEqual([]);
  });
});
