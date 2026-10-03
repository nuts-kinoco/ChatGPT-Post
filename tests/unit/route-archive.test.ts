import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { rootIdentity } from "../../src/archive/durable.js";
import { LocalRouteArchive } from "../../src/archive/local-route.js";
import { RouteArtifactArchive } from "../../src/archive/route-store.js";
import type { ArchiveSnapshotV2, JobAdmissionV1 } from "../../src/archive/route-types.js";
import { admissionDigest } from "../../src/archive/route-validation.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";
import { TaskController } from "../../src/state/task-controller.js";
import { openUiService } from "../../src/ui/service.js";

const dirs: string[] = [],
  closers: (() => void)[] = [];
function dir() {
  const x = mkdtempSync(join(tmpdir(), "archive2-"));
  dirs.push(x);
  return x;
}
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(options: { beforeSyncDirectory?: (path: string) => void } = {}) {
  const state = dir(),
    root = dir(),
    registry = new ProjectRegistry(join(state, "projects.db"));
  closers.push(() => registry.close());
  registry.configure(
    {
      schema: "bridge-project-registry-1",
      revision: 1,
      defaultOutputRoot: root,
      projects: [
        {
          projectId: randomUUID(),
          repoId: "fixture",
          storageSlug: "safe-fixture",
          displayName: "../CON 日本語",
          githubDestination: null,
          outputRootOverride: null,
        },
      ],
    },
    0,
  );
  const archive = new RouteArtifactArchive({
    stateDirectory: state,
    registry,
    pathPolicy: options,
  });
  closers.push(() => archive.close());
  return { state, root, registry, archive };
}
function admission(
  x: ReturnType<typeof setup>,
  route: "local_execution" | "hosted_delivery" = "local_execution",
): JobAdmissionV1 {
  const p = x.registry.resolve(1, "fixture");
  return {
    schema: "job-admission-1",
    requestId: randomUUID(),
    taskSpecHash: sha256Bytes(Buffer.from("task")),
    outputContractSha256: null,
    taskFileHash: sha256Bytes(Buffer.from("markdown")),
    registryRevision: 1,
    registrySnapshotHash: x.registry.snapshotHash(1),
    projectId: p.projectId,
    repoId: p.repoId,
    storageSlug: p.storageSlug,
    requesterActorId: "requester",
    recipientActorId: "recipient",
    route:
      route === "local_execution"
        ? {
            kind: route,
            policyHash: "a".repeat(64),
            sessionId: randomUUID(),
            executorId: "executor",
          }
        : {
            kind: route,
            policyHash: "b".repeat(64),
            conversationId: "conversation-old",
            destinationId: "chat",
          },
  };
}
function snapshot(a: JobAdmissionV1): ArchiveSnapshotV2 {
  return {
    requestId: a.requestId,
    taskSpecBytes: Buffer.from("task"),
    taskFileBytes: Buffer.from("markdown"),
    payloadBytes: Buffer.from("payload"),
    synthetic: true,
    requiredSetKnown: true,
    items: [
      {
        artifactId: "evidence",
        logicalName: "receipt",
        required: true,
        source: { kind: "executor_artifact", artifactId: "evidence" },
        contentSha256: sha256Bytes(Buffer.from("evidence")),
        sizeBytes: 8,
      },
    ],
  };
}
const reader = { read: async () => Buffer.from("evidence") };
describe("route-neutral archive v2, immutable temp storage", () => {
  it.each(["local_execution", "hosted_delivery"] as const)(
    "pins and verifies %s without future IDs",
    async (route) => {
      const x = setup(),
        a = admission(x, route),
        pin = x.archive.reserve(a);
      expect(readdirSync(x.root)).toEqual([]);
      expect(pin.storageSlug).toBe("safe-fixture");
      expect(JSON.stringify(pin)).not.toContain("runId");
      expect(JSON.stringify(pin)).not.toContain("attemptId");
      const result = await x.archive.archive(snapshot(a), reader);
      expect(result.state).toBe("complete");
      expect(result.manifest?.schema).toBe("artifact-archive-2");
      expect(result.manifest?.admission.route.kind).toBe(route);
      expect(x.archive.inspect(a.requestId).state).toBe("complete");
    },
  );
  it("root/revision/history are pinned before acceptance and orphan retries never repin", () => {
    const x = setup(),
      a = admission(x),
      pin = x.archive.reserve(a),
      newRoot = dir();
    const s = x.registry.snapshot();
    x.registry.configure({ ...s, revision: 2, defaultOutputRoot: newRoot }, 1);
    expect(x.archive.reserve(a, true)).toEqual(pin);
    expect(x.archive.pin(a.requestId).registryRevision).toBe(1);
    expect(x.archive.pin(a.requestId).localPinnedRoot).toBe(x.root);
    expect(readdirSync(newRoot)).toEqual([]);
    expect(() => x.archive.reserve({ ...a, requestId: randomUUID() }, true)).toThrow(
      "archive_legacy_admission_unpinned",
    );
    expect(() => x.archive.reserve({ ...a, taskSpecHash: "c".repeat(64) }, true)).toThrow(
      "archive_admission_conflict",
    );
  });
  it("rejects newline-smuggled identifiers and hashes before pinning", () => {
    const x = setup(),
      a = admission(x);
    for (const field of ["requestId", "taskSpecHash", "repoId", "storageSlug"] as const)
      expect(() => x.archive.reserve({ ...a, [field]: `${a[field]}\n` })).toThrow();
  });
  it("rejects historical registry digest/slug mismatch and cannot derive path from display name", () => {
    const x = setup(),
      a = admission(x);
    expect(() => x.archive.reserve({ ...a, registrySnapshotHash: "0".repeat(64) })).toThrow(
      "archive_registry_binding_mismatch",
    );
    expect(() => x.archive.reserve({ ...a, storageSlug: "different" })).toThrow(
      "archive_registry_binding_mismatch",
    );
    expect(x.archive.reserve(a).relativeDirectory).not.toContain("CON");
  });
  it("missing/hash-mismatched artifacts stay incomplete; later exact recovery creates another immutable manifest", async () => {
    const x = setup(),
      a = admission(x);
    x.archive.reserve(a);
    const first = await x.archive.archive(snapshot(a), { read: async () => Buffer.from("BAD") });
    expect(first.state).toBe("incomplete");
    expect(first.manifest?.items[0]?.unavailableReason).toBe("archive_artifact_hash_mismatch");
    const second = await x.archive.archive(snapshot(a), reader);
    expect(second.state).toBe("complete");
    expect(second.manifestSha256).not.toBe(first.manifestSha256);
    expect(x.archive.inspect(a.requestId, first.manifestSha256 ?? "").state).toBe("incomplete");
  });
  it("an unknown required set cannot become complete even with zero supplied references", async () => {
    const x = setup(),
      a = admission(x);
    x.archive.reserve(a);
    const result = await x.archive.archive(
      { ...snapshot(a), items: [], requiredSetKnown: false },
      reader,
    );
    expect(result.state).toBe("incomplete");
  });
  it("optional unavailable sources do not hide required completeness", async () => {
    const x = setup(),
      a = admission(x);
    x.archive.reserve(a);
    const v = snapshot(a);
    v.items.push({
      artifactId: "optional",
      logicalName: "optional",
      required: false,
      source: null,
      contentSha256: null,
      sizeBytes: null,
    });
    const result = await x.archive.archive(v, reader);
    expect(result.state).toBe("complete");
    expect(result.manifest?.items[1]?.state).toBe("unavailable");
  });
  it("duplicate artifact IDs, escaped source identifiers and changed terminal payload reject", async () => {
    const x = setup(),
      a = admission(x);
    x.archive.reserve(a);
    const v = snapshot(a);
    const firstItem = v.items[0];
    if (!firstItem) throw new Error("fixture missing");
    v.items.push({ ...firstItem });
    await expect(x.archive.archive(v, reader)).rejects.toThrow("archive_manifest_invalid");
    await x.archive.archive(snapshot(a), reader);
    await expect(
      x.archive.archive({ ...snapshot(a), payloadBytes: Buffer.from("different") }, reader),
    ).rejects.toThrow("archive_terminal_payload_conflict");
  });
  it("changed underlying root identity and symlink substitution do not redirect output", async () => {
    const x = setup(),
      a = admission(x);
    x.archive.reserve(a);
    const moved = `${x.root}-moved`;
    renameSync(x.root, moved);
    try {
      symlinkSync(dir(), x.root, "dir");
      await expect(x.archive.archive(snapshot(a), reader)).rejects.toThrow();
    } finally {
      rmSync(x.root);
      renameSync(moved, x.root);
    }
    expect((await x.archive.archive(snapshot(a), reader)).state).toBe("complete");
  });
  it("directory fsync failure never commits complete; retry can safely recover published exact bytes", async () => {
    let fail = true;
    const x = setup({
        beforeSyncDirectory: () => {
          if (fail) throw Object.assign(new Error("fsync"), { code: "EIO" });
        },
      }),
      a = admission(x);
    x.archive.reserve(a);
    await expect(x.archive.archive(snapshot(a), reader)).rejects.toThrow();
    expect(x.archive.inspect(a.requestId).state).toBe("not_archived");
    fail = false;
    expect((await x.archive.archive(snapshot(a), reader)).state).toBe("complete");
  });
  it("exact older manifest bytes are inspected and corruption never overwritten", async () => {
    const x = setup(),
      a = admission(x),
      pin = x.archive.reserve(a);
    const result = await x.archive.archive(snapshot(a), reader);
    const path = join(
      x.root,
      pin.relativeDirectory,
      "archives",
      result.manifestSha256 ?? "",
      "results/result.json",
    );
    writeFileSync(path, "corrupt", { mode: 0o600 });
    expect(x.archive.inspect(a.requestId).state).toBe("corrupt");
    await expect(x.archive.archive(snapshot(a), reader)).rejects.toThrow(
      "archive_content_hash_mismatch",
    );
    expect(readFileSync(path, "utf8")).toBe("corrupt");
  });
  it("append-only observed provenance rejects stale/conflicting source revisions", () => {
    const x = setup(),
      a = admission(x);
    x.archive.reserve(a);
    const event = {
      schema: "job-provenance-1" as const,
      admissionHash: admissionDigest(a),
      source: "local_ledger" as const,
      sourceRevision: 1,
      observedAt: "2026-10-03T00:00:00.000Z",
      observation: {
        kind: "local_execution" as const,
        runId: null,
        fencingToken: 0,
        resultSha256: null,
        processIdentitySha256: null,
      },
    };
    x.archive.appendProvenance(a.requestId, event);
    x.archive.appendProvenance(a.requestId, event);
    expect(x.archive.provenance(a.requestId)).toHaveLength(1);
    expect(() =>
      x.archive.appendProvenance(a.requestId, {
        ...event,
        observation: { ...event.observation, fencingToken: 1 },
      }),
    ).toThrow("archive_provenance_stale_or_conflicting");
  });
  it("local controller blocks old unpinned replay before choosing current root", async () => {
    const state = dir(),
      source = await openUiService({ profile: "demo", stateDir: state });
    closers.push(() => source.close());
    const old = source.createDemo({});
    const x = setup();
    const s = x.registry.snapshot();
    const project = s.projects[0];
    if (!project) throw new Error("fixture missing");
    x.registry.configure(
      {
        ...s,
        revision: 2,
        projects: [
          {
            ...project,
            repoId: "synthetic-demo",
            projectId: randomUUID(),
            storageSlug: "demo",
          },
        ],
      },
      1,
    );
    const { store, executor, policy } = source.runtime.controller;
    const adapter = new LocalRouteArchive(x.archive, store, {
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
      adapter,
    );
    expect(() =>
      controller.receive(
        Buffer.from(old.task.rawSpec),
        Buffer.from(old.task.taskMarkdown),
        null,
        "local-ui-requester",
      ),
    ).toThrow("archive_legacy_admission_unpinned");
    expect(x.archive.hasPin(old.task.result.request_id)).toBe(false);
  });
});

describe("independent archive pin corruption review", () => {
  it("rejects a schema-valid pin redirected away from admitted historical root", async () => {
    const x = setup(),
      a = admission(x),
      redirected = dir();
    const pin = x.archive.reserve(a);
    const db = new DatabaseSync(join(x.state, "route-archive.db"));
    db.prepare("UPDATE archive2_admissions SET pin=? WHERE request_id=?").run(
      JSON.stringify({
        ...pin,
        localPinnedRoot: redirected,
        rootIdentity: rootIdentity(redirected),
      }),
      a.requestId,
    );
    db.close();
    await expect(x.archive.archive(snapshot(a), reader)).rejects.toThrow();
    expect(readdirSync(redirected)).toEqual([]);
  });
});

describe("independent durability recovery review", () => {
  it("retries fsync through root after publication interrupted at an ancestor barrier", async () => {
    let root = "",
      fail = true;
    const synced: string[] = [];
    const x = setup({
      beforeSyncDirectory(path) {
        synced.push(path);
        if (path === root && fail)
          throw Object.assign(new Error("root fsync failed"), { code: "EIO" });
      },
    });
    root = x.root;
    const a = admission(x);
    x.archive.reserve(a);
    await expect(x.archive.archive(snapshot(a), reader)).rejects.toThrow();
    fail = false;
    synced.length = 0;
    expect((await x.archive.archive(snapshot(a), reader)).state).toBe("complete");
    expect(synced).toContain(root);
  });
});

describe("independent archive concurrent collection review", () => {
  it("does not let a delayed incomplete collection replace a completed archive", async () => {
    const x = setup(),
      a = admission(x);
    x.archive.reserve(a);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = x.archive.archive(snapshot(a), {
      read: async () => {
        await pending;
        throw new Error("old read failed");
      },
    });
    expect((await x.archive.archive(snapshot(a), reader)).state).toBe("complete");
    release();
    await stale;
    expect(x.archive.inspect(a.requestId).state).toBe("complete");
  });
});

describe("sealed admission corruption recovery", () => {
  it("validates replay and historical root even if a corrupt pin is rehashed", () => {
    const x = setup(),
      a = admission(x),
      redirected = dir(),
      pin = x.archive.reserve(a);
    const db = new DatabaseSync(join(x.state, "route-archive.db"));
    const raw = JSON.stringify({
      ...pin,
      localPinnedRoot: redirected,
      rootIdentity: rootIdentity(redirected),
    });
    db.prepare("UPDATE archive2_admissions SET pin=?,pin_hash=? WHERE request_id=?").run(
      raw,
      sha256Bytes(Buffer.from(raw)),
      a.requestId,
    );
    db.close();
    expect(() => x.archive.reserve(a, true)).toThrow("archive_pin_root_mismatch");
    expect(readdirSync(redirected)).toEqual([]);
  });
  it("does not retrofit seals onto historical unsealed rows", () => {
    const x = setup(),
      a = admission(x);
    x.archive.reserve(a);
    const db = new DatabaseSync(join(x.state, "route-archive.db"));
    db.prepare(
      "UPDATE archive2_admissions SET pin_hash=NULL,registry_snapshot=NULL WHERE request_id=?",
    ).run(a.requestId);
    db.close();
    expect(() => x.archive.reserve(a, true)).toThrow("archive_legacy_pin_unsealed");
    expect(readdirSync(x.root)).toEqual([]);
  });
});
