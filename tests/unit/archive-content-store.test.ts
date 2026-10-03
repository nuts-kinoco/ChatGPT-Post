import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type GitObjectStore,
  type GitSnapshot,
  gitBlobSha,
} from "../../src/adapters/github-client.js";
import {
  ConfiguredGitDeliveryContentStoreV1,
  type ConfiguredGitDeliveryDestinationV1,
  type DeliveryContentAuthorizationV1,
  type DeliveryContentPublicationV1,
  type DeliveryContentScopeV1,
} from "../../src/archive/content-store.js";
import {
  type DeliveryBindingV1,
  MAX_DELIVERY_MANIFEST_BYTES,
} from "../../src/contracts/materialization.js";
import { sha256Bytes } from "../../src/contracts/task.js";

/** Synthetic memory-only Git database. No test obtains credentials or calls GitHub/user files. */
class SyntheticMemoryGit implements GitObjectStore {
  files = new Map<string, string>();
  blobs = new Map<string, Uint8Array>();
  snapshots = 0;
  reads = 0;
  appends = 0;
  async snapshot(): Promise<GitSnapshot> {
    this.snapshots++;
    return { commit: "a".repeat(40), tree: "b".repeat(40), files: new Map(this.files) };
  }
  async read(snapshot: GitSnapshot, path: string): Promise<Uint8Array | null> {
    this.reads++;
    const sha = snapshot.files.get(path);
    return sha ? (this.blobs.get(sha) ?? null) : null;
  }
  async append(files: ReadonlyMap<string, Uint8Array>): Promise<string> {
    this.appends++;
    for (const [path, bytes] of files) {
      const previous = this.files.get(path);
      if (previous && previous !== gitBlobSha(bytes))
        throw new Error("synthetic immutable conflict");
    }
    for (const [path, bytes] of files) this.seed(path, bytes);
    return "c".repeat(40);
  }
  seed(path: string, bytes: Uint8Array) {
    this.files.set(path, gitBlobSha(bytes));
    this.blobs.set(gitBlobSha(bytes), Uint8Array.from(bytes));
  }
}

const payload = Buffer.from("synthetic terminal payload");
const artifact = Buffer.from("synthetic private artifact bytes");
const binding: DeliveryBindingV1 = {
  requesterActorId: "requester",
  recipientActorId: "recipient",
  requestId: "11111111-1111-1111-1111-111111111111",
  taskSpecHash: "a".repeat(64),
  execution: { kind: "local_execution", runId: "22222222-2222-2222-2222-222222222222" },
  terminalEventId: "33333333-3333-3333-3333-333333333333",
  payloadSha256: sha256Bytes(payload),
};
const artifactScope: DeliveryContentScopeV1 = {
  binding,
  purpose: "artifact",
  artifactId: "output.zip",
};
const address = { destinationId: "private_bus", contentSha256: sha256Bytes(artifact) };
const pathFor = (bytes: Uint8Array, namespace = "approved/delivery") => {
  const hash = sha256Bytes(bytes);
  return `${namespace}/cas/sha256/${hash.slice(0, 2)}/${hash}`;
};
function grant(
  operation: "read" | "publish",
  bytes = artifact,
  requestScope = artifactScope,
): DeliveryContentAuthorizationV1 {
  return {
    operation,
    ...address,
    contentSha256: sha256Bytes(bytes),
    ...structuredClone(requestScope),
  };
}
function fixture(
  options: {
    authorizations?: DeliveryContentAuthorizationV1[];
    limits?: Partial<
      Pick<ConfiguredGitDeliveryDestinationV1, "maxBytes" | "timeoutMs" | "maxFiles">
    >;
    bytes?: Buffer;
    requestScope?: DeliveryContentScopeV1;
  } = {},
) {
  const git = new SyntheticMemoryGit();
  const bytes = options.bytes ?? artifact;
  const requestScope = options.requestScope ?? artifactScope;
  const destination: ConfiguredGitDeliveryDestinationV1 = {
    destinationId: "private_bus",
    store: git,
    namespace: "approved/delivery",
    maxBytes: 1024,
    timeoutMs: 1000,
    maxFiles: 100,
    ...options.limits,
  };
  const authorizations = options.authorizations ?? [
    grant("read", bytes, requestScope),
    grant("publish", bytes, requestScope),
  ];
  const store = new ConfiguredGitDeliveryContentStoreV1({
    destinations: [destination],
    authorizations,
  });
  const publication: DeliveryContentPublicationV1 = {
    destinationId: destination.destinationId,
    bytes,
    ...structuredClone(requestScope),
  };
  const readContext = { ...structuredClone(requestScope), maxBytes: 1024 };
  return { git, store, destination, authorizations, publication, readContext };
}
afterEach(() => vi.useRealTimers());

describe("configured delivery CAS (synthetic Git; no live publication)", () => {
  it("publishes immutable SHA256 bytes with verified readback and resolves the exact address", async () => {
    const f = fixture();
    const result = await f.store.publish(f.publication);
    expect(result).toEqual(address);
    expect([...f.git.files.keys()]).toEqual([pathFor(artifact)]);
    expect(f.git.appends).toBe(1);
    expect(f.git.reads).toBe(1);
    expect(await f.store.read(result, f.readContext)).toEqual(Uint8Array.from(artifact));
    expect(f.git.reads).toBe(2);
  });

  it("has no implicit authority even when a destination and content are configured", async () => {
    const f = fixture({ authorizations: [] });
    f.git.seed(pathFor(artifact), artifact);
    await expect(f.store.read(address, f.readContext)).rejects.toThrow(
      "delivery_content_scope_denied",
    );
    await expect(f.store.publish(f.publication)).rejects.toThrow("delivery_content_scope_denied");
    const defaultDenied = new ConfiguredGitDeliveryContentStoreV1({
      destinations: [f.destination],
    });
    await expect(defaultDenied.publish(f.publication)).rejects.toThrow(
      "delivery_content_scope_denied",
    );
    expect([f.git.snapshots, f.git.reads, f.git.appends]).toEqual([0, 0, 0]);
  });

  it.each(["read", "publish"] as const)(
    "does not treat %s permission as the other operation",
    async (operation) => {
      const f = fixture({ authorizations: [grant(operation)] });
      if (operation === "read")
        await expect(f.store.publish(f.publication)).rejects.toThrow(
          "delivery_content_scope_denied",
        );
      else
        await expect(f.store.read(address, f.readContext)).rejects.toThrow(
          "delivery_content_scope_denied",
        );
      expect(f.git.snapshots).toBe(0);
    },
  );

  it.each([
    { requesterActorId: "another_requester" },
    { recipientActorId: "another_recipient" },
    { requestId: "44444444-4444-4444-4444-444444444444" },
    { taskSpecHash: "b".repeat(64) },
    { terminalEventId: "55555555-5555-5555-5555-555555555555" },
    { execution: { kind: "local_execution" as const, runId: null } },
    {
      execution: {
        kind: "hosted_delivery" as const,
        attemptId: "22222222-2222-2222-2222-222222222222",
      },
    },
  ])("denies a changed binding for reads AND publications: %j", async (changed) => {
    const f = fixture();
    const wrongBinding = { ...binding, ...changed };
    await expect(
      f.store.read(address, { ...f.readContext, binding: wrongBinding }),
    ).rejects.toThrow("delivery_content_scope_denied");
    await expect(f.store.publish({ ...f.publication, binding: wrongBinding })).rejects.toThrow(
      "delivery_content_scope_denied",
    );
    expect(f.git.snapshots).toBe(0);
  });

  it("denies a different configured destination even when it uses the same backing store", async () => {
    const f = fixture();
    const store = new ConfiguredGitDeliveryContentStoreV1({
      destinations: [f.destination, { ...f.destination, destinationId: "other_bus" }],
      authorizations: f.authorizations,
    });
    await expect(
      store.read({ ...address, destinationId: "other_bus" }, f.readContext),
    ).rejects.toThrow("delivery_content_scope_denied");
    await expect(store.publish({ ...f.publication, destinationId: "other_bus" })).rejects.toThrow(
      "delivery_content_scope_denied",
    );
    await expect(
      store.read({ ...address, destinationId: "missing" }, f.readContext),
    ).rejects.toThrow("delivery_content_destination_denied");
    expect(f.git.snapshots).toBe(0);
  });

  it.each(["../private", "/tmp/private", "https://example.test/x", "C:\\private", "private_bus\n"])(
    "refuses path-like or URL-like destination %s",
    async (destinationId) => {
      const f = fixture();
      await expect(f.store.read({ ...address, destinationId }, f.readContext)).rejects.toThrow();
      await expect(f.store.publish({ ...f.publication, destinationId })).rejects.toThrow();
      expect(f.git.snapshots).toBe(0);
    },
  );

  it("cannot reuse a grant for a different artifact, purpose, or content hash", async () => {
    const f = fixture();
    await expect(
      f.store.read(address, { ...f.readContext, artifactId: "other.zip" }),
    ).rejects.toThrow("delivery_content_scope_denied");
    await expect(f.store.publish({ ...f.publication, artifactId: "other.zip" })).rejects.toThrow(
      "delivery_content_scope_denied",
    );
    await expect(
      f.store.read(address, {
        ...f.readContext,
        purpose: "signed_delivery_manifest",
        artifactId: null,
      }),
    ).rejects.toThrow("delivery_content_scope_denied");
    await expect(
      f.store.publish({ ...f.publication, purpose: "signed_delivery_manifest", artifactId: null }),
    ).rejects.toThrow("delivery_content_scope_denied");
    await expect(
      f.store.read({ ...address, contentSha256: sha256Bytes(payload) }, f.readContext),
    ).rejects.toThrow("delivery_content_scope_denied");
    await expect(f.store.publish({ ...f.publication, bytes: payload })).rejects.toThrow(
      "delivery_content_scope_denied",
    );
    expect(f.git.snapshots).toBe(0);
  });

  it.each([
    { purpose: "unknown", artifactId: null },
    { purpose: "artifact", artifactId: null },
    { purpose: "artifact", artifactId: "../../raw" },
    { purpose: "terminal_payload", artifactId: "output.zip" },
    { purpose: "signed_delivery_manifest", artifactId: "output.zip" },
  ])("rejects malformed purpose/artifact scope: %j", async (changed) => {
    const f = fixture();
    const invalid = changed as Partial<DeliveryContentScopeV1>;
    await expect(f.store.read(address, { ...f.readContext, ...invalid })).rejects.toThrow(
      "delivery_content_scope_invalid",
    );
    await expect(f.store.publish({ ...f.publication, ...invalid })).rejects.toThrow(
      "delivery_content_scope_invalid",
    );
    expect(f.git.snapshots).toBe(0);
  });

  it("requires a terminal payload hash to match the bound payload identity", () => {
    const f = fixture();
    expect(
      () =>
        new ConfiguredGitDeliveryContentStoreV1({
          destinations: [f.destination],
          authorizations: [{ ...grant("publish"), purpose: "terminal_payload", artifactId: null }],
        }),
    ).toThrow("delivery_content_scope_invalid");
  });

  it.each(["terminal_payload", "signed_delivery_manifest"] as const)(
    "accepts an explicitly approved %s with null artifact ID",
    async (purpose) => {
      const requestScope = { binding, purpose, artifactId: null };
      const f = fixture({ bytes: payload, requestScope });
      const result = await f.store.publish(f.publication);
      expect(await f.store.read(result, f.readContext)).toEqual(Uint8Array.from(payload));
    },
  );

  it("does not overwrite or append when the hash path already contains different bytes", async () => {
    const f = fixture();
    f.git.seed(pathFor(artifact), payload);
    await expect(f.store.publish(f.publication)).rejects.toThrow("delivery_content_hash_mismatch");
    expect(f.git.appends).toBe(0);
    expect(f.git.files.get(pathFor(artifact))).toBe(gitBlobSha(payload));
  });

  it("verifies existing same bytes on each idempotent retry without another write", async () => {
    const f = fixture();
    expect(await f.store.publish(f.publication)).toEqual(address);
    expect(await f.store.publish(f.publication)).toEqual(address);
    expect(f.git.appends).toBe(1);
    expect(f.git.reads).toBe(2);
    f.git.blobs.set(gitBlobSha(artifact), payload);
    await expect(f.store.publish(f.publication)).rejects.toThrow("delivery_content_hash_mismatch");
    expect(f.git.appends).toBe(1);
  });

  it("returns unavailable for truly absent content, without publishing it", async () => {
    const f = fixture();
    expect(await f.store.read(address, f.readContext)).toBeNull();
    expect(f.git.appends).toBe(0);
  });

  it("rejects corrupt bytes and dishonest Git blob identity", async () => {
    const f = fixture();
    f.git.seed(pathFor(artifact), artifact);
    f.git.blobs.set(gitBlobSha(artifact), payload);
    await expect(f.store.read(address, f.readContext)).rejects.toThrow(
      "delivery_content_hash_mismatch",
    );
    f.git.files.set(pathFor(artifact), "f".repeat(40));
    f.git.blobs.set("f".repeat(40), artifact);
    await expect(f.store.read(address, f.readContext)).rejects.toThrow(
      "delivery_content_snapshot_mismatch",
    );
  });

  it("rejects missing declared blobs rather than treating them as absent content", async () => {
    const f = fixture();
    f.git.files.set(pathFor(artifact), gitBlobSha(artifact));
    await expect(f.store.read(address, f.readContext)).rejects.toThrow(
      "delivery_content_unavailable",
    );
    await expect(f.store.publish(f.publication)).rejects.toThrow("delivery_content_unavailable");
    expect(f.git.appends).toBe(0);
  });

  it("requires actual readback after append, not merely a claimed commit", async () => {
    const f = fixture();
    f.git.append = vi.fn(async () => "c".repeat(40));
    await expect(f.store.publish(f.publication)).rejects.toThrow(
      "delivery_content_readback_failed",
    );
    expect(f.git.append).toHaveBeenCalledTimes(1);
  });

  it("rejects corrupt publication readback without deleting or overwriting evidence", async () => {
    const f = fixture();
    f.git.append = vi.fn(async (files) => {
      for (const [path] of files) f.git.seed(path, payload);
      return "c".repeat(40);
    });
    await expect(f.store.publish(f.publication)).rejects.toThrow("delivery_content_hash_mismatch");
    expect(f.git.append).toHaveBeenCalledTimes(1);
    expect(f.git.files.get(pathFor(artifact))).toBe(gitBlobSha(payload));
  });

  it("enforces destination and caller byte caps on a custom GitObjectStore", async () => {
    const f = fixture({ limits: { maxBytes: artifact.length - 1 } });
    f.git.seed(pathFor(artifact), artifact);
    await expect(f.store.read(address, f.readContext)).rejects.toThrow(
      "delivery_content_size_limit",
    );
    await expect(f.store.publish(f.publication)).rejects.toThrow("delivery_content_size_limit");
    expect(f.git.appends).toBe(0);
    const allowed = fixture();
    allowed.git.seed(pathFor(artifact), artifact);
    await expect(
      allowed.store.read(address, { ...allowed.readContext, maxBytes: artifact.length - 1 }),
    ).rejects.toThrow("delivery_content_size_limit");
  });

  it("permits explicitly authorized empty bytes under a zero-byte caller cap", async () => {
    const f = fixture({ bytes: Buffer.alloc(0) });
    const result = await f.store.publish(f.publication);
    expect(await f.store.read(result, { ...f.readContext, maxBytes: 0 })).toEqual(new Uint8Array());
  });

  it("enforces the manifest-specific byte cap before any publication", async () => {
    const bytes = Buffer.alloc(MAX_DELIVERY_MANIFEST_BYTES + 1);
    const f = fixture({
      bytes,
      requestScope: { binding, purpose: "signed_delivery_manifest", artifactId: null },
      limits: { maxBytes: bytes.length },
    });
    await expect(f.store.publish(f.publication)).rejects.toThrow("delivery_content_size_limit");
    expect(f.git.snapshots).toBe(0);
  });

  it("rejects oversized or malformed snapshots from an exposed custom Git port", async () => {
    const f = fixture({ limits: { maxFiles: 1 } });
    f.git.seed("one", artifact);
    f.git.seed("two", artifact);
    await expect(f.store.read(address, f.readContext)).rejects.toThrow(
      "delivery_content_snapshot_invalid",
    );
    expect(f.git.reads).toBe(0);
    f.git.files = new Map([["../escape", "a".repeat(40)]]);
    await expect(f.store.read(address, f.readContext)).rejects.toThrow(
      "delivery_content_snapshot_invalid",
    );
  });

  it("does not publish a new object when the configured snapshot capacity is full", async () => {
    const f = fixture({ limits: { maxFiles: 1 } });
    f.git.seed("already/full", payload);
    await expect(f.store.publish(f.publication)).rejects.toThrow("delivery_content_snapshot_limit");
    expect(f.git.appends).toBe(0);
    f.git.files.clear();
    f.git.seed(pathFor(artifact), artifact);
    expect(await f.store.publish(f.publication)).toEqual(address);
    expect(f.git.appends).toBe(0);
  });

  it("refuses address/path overrides rather than interpreting them as a storage location", async () => {
    const f = fixture();
    const changedAddress = { ...address, path: "/private/secret" };
    await expect(f.store.read(changedAddress, f.readContext)).rejects.toThrow(
      "delivery_schema_invalid",
    );
    const changedPublication = { ...f.publication, path: "arbitrary/path" };
    await expect(f.store.publish(changedPublication)).rejects.toThrow(
      "delivery_content_configuration_invalid",
    );
    expect(f.git.snapshots).toBe(0);
  });

  it.each(["snapshot", "read"] as const)(
    "bounds a hanging publication readback %s after writing",
    async (method) => {
      vi.useFakeTimers();
      const f = fixture({ limits: { timeoutMs: 10 } });
      const realSnapshot = f.git.snapshot.bind(f.git);
      if (method === "snapshot") {
        f.git.snapshot = () => (f.git.appends > 0 ? new Promise(() => undefined) : realSnapshot());
      } else f.git.read = () => new Promise(() => undefined);
      const assertion = expect(f.store.publish(f.publication)).rejects.toThrow(
        "delivery_content_timeout",
      );
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(f.git.appends).toBe(1);
      expect(f.git.files.size).toBe(1);
    },
  );

  it.each(["snapshot", "read"] as const)(
    "bounds a hanging %s, without any publication",
    async (method) => {
      vi.useFakeTimers();
      const f = fixture({ limits: { timeoutMs: 10 } });
      if (method === "snapshot") f.git.snapshot = () => new Promise(() => undefined);
      else f.git.read = () => new Promise(() => undefined);
      const assertion = expect(f.store.read(address, f.readContext)).rejects.toThrow(
        "delivery_content_timeout",
      );
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(f.git.appends).toBe(0);
    },
  );

  it("bounds append and keeps a late committed write unknown until an explicit exact retry", async () => {
    vi.useFakeTimers();
    const f = fixture({ limits: { timeoutMs: 10 } });
    const realAppend = f.git.append.bind(f.git);
    let complete: (() => Promise<void>) | undefined;
    f.git.append = (files) =>
      new Promise((resolve) => {
        complete = async () => resolve(await realAppend(files));
      });
    const assertion = expect(f.store.publish(f.publication)).rejects.toThrow(
      "delivery_content_publication_unknown",
    );
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(f.git.files.size).toBe(0);
    expect(complete).toBeDefined();
    await complete?.();
    expect(f.git.files.size).toBe(1);
    expect(f.git.reads).toBe(0);
    expect(await f.store.publish(f.publication)).toEqual(address);
    expect(f.git.appends).toBe(1);
  });

  it("uses one total deadline rather than restarting the allowance for each await", async () => {
    vi.useFakeTimers();
    const f = fixture({ limits: { timeoutMs: 10 } });
    const realSnapshot = f.git.snapshot.bind(f.git);
    f.git.snapshot = async () => {
      await new Promise((resolve) => setTimeout(resolve, 6));
      return realSnapshot();
    };
    f.git.read = async () => {
      await new Promise((resolve) => setTimeout(resolve, 6));
      return null;
    };
    const assertion = expect(f.store.read(address, f.readContext)).rejects.toThrow(
      "delivery_content_timeout",
    );
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
    expect(f.git.appends).toBe(0);
  });

  it("copies publication bytes and configuration before the first async step", async () => {
    const f = fixture();
    const bytes = Buffer.from(artifact);
    const pending = f.store.publish({ ...f.publication, bytes });
    bytes.fill(0);
    f.destination.namespace = "unapproved";
    f.destination.maxBytes = 1;
    const originalReadGrant = f.authorizations[0];
    if (!originalReadGrant) throw new Error("synthetic fixture grant missing");
    originalReadGrant.binding.recipientActorId = "new_recipient";
    expect(await pending).toEqual(address);
    expect([...f.git.files.keys()]).toEqual([pathFor(artifact)]);
    const result = await f.store.read(address, f.readContext);
    result?.fill(0);
    expect(await f.store.read(address, f.readContext)).toEqual(Uint8Array.from(artifact));
    await expect(
      f.store.read(address, {
        ...f.readContext,
        binding: { ...binding, recipientActorId: "new_recipient" },
      }),
    ).rejects.toThrow("delivery_content_scope_denied");
  });

  it.each([
    { namespace: "../escape" },
    { namespace: "/absolute" },
    { namespace: "https://example.test/private" },
    { namespace: "approved/.git/raw" },
    { maxBytes: 0 },
    { maxBytes: Number.NaN },
    { timeoutMs: 0 },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { maxFiles: 0 },
    { maxFiles: 100_001 },
  ])("rejects invalid configured namespace or bounds: %j", (changed) => {
    const f = fixture();
    expect(
      () =>
        new ConfiguredGitDeliveryContentStoreV1({
          destinations: [{ ...f.destination, ...changed }],
        }),
    ).toThrow("delivery_content_configuration_invalid");
  });
});
