import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { vi } from "vitest";
import {
  type GitObjectStore,
  type GitPublicationBinding,
  type GitSnapshot,
  gitBlobSha,
} from "../../src/adapters/github-client.js";
import { GitHubTaskBus, SignedBusCodec } from "../../src/adapters/github-transport.js";
import {
  createIssuerSession,
  type IssuerSessionOptions,
} from "../../src/adapters/issuer-session.js";
import type { IssuerSessionBindingV1, RecipientCapabilityV1 } from "../../src/contracts/issuer.js";
import type { RegisteredOperationDestination } from "../../src/contracts/operations.js";
import {
  type ProjectRegistryPort,
  projectRegistryHash,
} from "../../src/contracts/project-registry.js";
import { manualTaskTemplate, type UiComposerPort } from "../../src/ui/composer.js";
import { UiOperationsService } from "../../src/ui/operations.js";
import { adapterTask } from "./adapter-fixture.js";
export class IssuerMemoryGit implements GitObjectStore {
  destination = { repositoryFullName: "owner/bus", branch: "main" };
  files = new Map<string, string>();
  blobs = new Map<string, Uint8Array>();
  appends = 0;
  loseReply = false;
  async snapshot(): Promise<GitSnapshot> {
    return {
      commit: String(this.appends).padStart(40, "0"),
      tree: "a".repeat(40),
      files: new Map(this.files),
    };
  }
  async read(snapshot: GitSnapshot, path: string) {
    const sha = snapshot.files.get(path);
    return sha ? (this.blobs.get(sha) ?? null) : null;
  }
  async appendConditional(
    files: ReadonlyMap<string, Uint8Array>,
    _message: string,
    bindings: readonly GitPublicationBinding[],
  ) {
    for (const b of bindings)
      if (this.files.has(b.whenPresentPath) && this.files.get(b.bindingPath) !== b.bindingBlobSha)
        throw new Error("github_publication_binding_conflict");
    return this.append(files);
  }
  async append(files: ReadonlyMap<string, Uint8Array>) {
    for (const [p, b] of files)
      if (this.files.has(p) && this.files.get(p) !== gitBlobSha(b))
        throw new Error("github_immutable_conflict");
    for (const [p, b] of files) {
      const h = gitBlobSha(b);
      this.files.set(p, h);
      this.blobs.set(h, Buffer.from(b));
    }
    this.appends++;
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error("fixture_lost_reply");
    }
    return String(this.appends).padStart(40, "0");
  }
}
export function issuerFixture() {
  let time = Date.parse("2026-10-03T16:00:00.000Z");
  const now = () => new Date(time),
    task = adapterTask(),
    projectId = randomUUID();
  const snapshot = {
    schema: "bridge-project-registry-1" as const,
    revision: 1,
    defaultOutputRoot: null,
    projects: [
      {
        projectId,
        repoId: task.repo,
        storageSlug: "product-a",
        displayName: "Synthetic",
        githubDestination: {
          repositoryFullName: "owner/bus",
          branch: "main",
          namespace: "bridge-v2",
        },
        outputRootOverride: null,
      },
    ],
  };
  const registry: ProjectRegistryPort = {
    currentRevision: () => snapshot.revision,
    snapshot: () => structuredClone(snapshot),
    snapshotHash: () => projectRegistryHash(snapshot),
    resolve: (_revision, id) => {
      const p = snapshot.projects.find((p) => p.repoId === id);
      if (!p) throw new Error("fixture_unknown_project");
      return structuredClone(p);
    },
    defaultOutputRoot: () => null,
  };
  const keys = {
    requester: generateKeyPairSync("ed25519"),
    recipient: generateKeyPairSync("ed25519"),
    other: generateKeyPairSync("ed25519"),
  };
  const signerHooks: {
    requester: null | (() => Promise<void>);
    recipient: null | (() => Promise<void>);
  } = { requester: null, recipient: null };
  const codec = (actor: keyof typeof keys) =>
    new SignedBusCodec(
      Object.entries(keys).map(([actorId, pair]) => ({
        actorId,
        roles: [actorId === "recipient" ? ("recipient" as const) : ("requester" as const)],
        publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      })),
      {
        actorId: actor,
        sign: async (bytes) => {
          if (actor !== "other") await signerHooks[actor]?.();
          return sign(null, bytes, keys[actor].privateKey);
        },
      },
    );
  const git = new IssuerMemoryGit(),
    bus = new GitHubTaskBus(git, codec("requester"), "bridge-v2", {}, registry),
    recipient = new GitHubTaskBus(git, codec("recipient"), "bridge-v2", {}, registry);
  const destination: RegisteredOperationDestination = {
    destinationId: "destination-a",
    route: "cli",
    recipientActorId: "recipient",
    providerId: task.agent,
    modelIds: [task.requested_model],
    capabilities: {},
    unavailableReason: null,
    policyHash: task.policy_snapshot_sha256,
  };
  const destinations = [destination];
  const session: IssuerSessionBindingV1 = {
    schema: "bridge-issuer-session-1",
    sessionId: randomUUID(),
    requesterActorId: "requester",
    source: "configured_local_cli",
    providerObservation: "unverified",
    allowedProjectIds: [projectId],
    allowedDestinationIds: [destination.destinationId],
    expiresAt: new Date(time + 3600000).toISOString(),
  };
  const capability: RecipientCapabilityV1 = {
    schema: "bridge-recipient-capability-1",
    recipientActorId: "recipient",
    providerId: task.agent,
    route: "cli",
    destinationId: destination.destinationId,
    modelIds: [task.requested_model],
    policySha256: task.policy_snapshot_sha256,
    projects: [{ projectId, registryRevision: 1, snapshotSha256: registry.snapshotHash(1) }],
    observedAt: now().toISOString(),
    expiresAt: new Date(time + 30000).toISOString(),
    actions: {
      issue: { available: true, reason: null },
      start: { available: false, reason: "native_unavailable" },
    },
  };
  const capabilities = [{ codec: recipient.codec, current: () => structuredClone(capability) }];
  const operations = new UiOperationsService({ registry, destinations: () => destinations }),
    prepare = vi.fn(manualTaskTemplate(task));
  const recipe: UiComposerPort = {
    prepare,
    issue: async () => {
      throw new Error("must_use_existing_transport");
    },
  };
  const options: IssuerSessionOptions = {
    bus,
    operations,
    recipe,
    session: () => session,
    currentDestinations: () => destinations,
    capabilities,
    now,
  };
  const facade = createIssuerSession(options);
  const input = () => ({
    identities: { previewId: randomUUID(), requestIds: [randomUUID()], fanoutId: null },
    request: {
      registryRevision: 1,
      projectId,
      destinations: [{ destinationId: destination.destinationId, modelId: task.requested_model }],
      title: "Synthetic task",
      instruction: "Inspect fake data. No provider call.",
    },
  });
  return {
    task,
    registry,
    snapshot,
    projectId,
    keys,
    codec,
    git,
    bus,
    recipient,
    destination,
    destinations,
    session,
    capability,
    capabilities,
    operations,
    prepare,
    recipe,
    options,
    facade,
    input,
    now,
    advance: (ms: number) => {
      time += ms;
    },
    signerHooks,
  };
}
