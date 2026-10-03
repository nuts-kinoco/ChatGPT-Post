import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPERATIONS_VERSION,
  type OperationSource,
  validateOperationsMutation,
} from "../../src/contracts/operations.js";
import {
  type ProjectRegistrationReference,
  type ProjectRegistrySnapshot,
  projectRegistryHash,
} from "../../src/contracts/project-registry.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import type { TaskSpec } from "../../src/contracts/task-types.js";
import type { BridgeResult } from "../../src/contracts/types.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";
import { demoTask } from "../../src/ui/demo.js";
import {
  type HostedOperationsRecord,
  type OperationDeliveryIdentity,
  type OperationsFanoutCollection,
  UiOperationsService,
  type UiOperationsSources,
} from "../../src/ui/operations.js";
import { openUiService, type TaskUiService } from "../../src/ui/service.js";

const HASH = "a".repeat(64);
const NOW = "2026-10-03T08:00:00.000Z";
const PROJECT = "6dc03153-221e-4a58-8d02-e5ac50ce3a18";
const GROUP = "73fc32c1-7bd0-4cd5-b6b4-800a1e3fd3d2";
const EVENT = "84cd32c1-7bd0-4cd5-b6b4-800a1e3fd3d2";
function value<T>(source: OperationSource<T>): T {
  expect(source.state).toBe("available");
  if (source.state !== "available") throw new Error(source.reason);
  return source.value;
}
function snapshot(revision = 1, displayName = "Original project"): ProjectRegistrySnapshot {
  return {
    schema: "bridge-project-registry-1",
    revision,
    defaultOutputRoot: "/private/output",
    projects: [
      {
        projectId: PROJECT,
        repoId: "synthetic-demo",
        storageSlug: "original-project",
        displayName,
        githubDestination: null,
        outputRootOverride: null,
      },
    ],
  };
}
function reference(): ProjectRegistrationReference {
  return {
    projectId: PROJECT,
    registryRevision: 1,
    snapshotSha256: projectRegistryHash(snapshot()),
  };
}
function hostFixture(): HostedOperationsRecord {
  const input = demoTask({ title: "Hosted design" });
  const task = JSON.parse(input.rawSpec) as TaskSpec;
  return {
    revision: 7,
    issued: {
      requestId: task.request_id,
      taskSpecHash: sha256Bytes(Buffer.from(input.rawSpec)),
      taskFileHash: task.task_file_hash,
      requesterId: "requester",
      recipientId: "browser",
      repoId: task.repo,
      route: "ordinary_chat_browser",
      projectRegistration: reference(),
    },
    raw: input.rawSpec,
    taskBytesBase64: Buffer.from(input.taskMarkdown).toString("base64"),
    state: "approved",
    attempted: false,
    attemptId: null,
    attemptedAt: null,
    cancelRequestedAt: null,
    deadlineAt: null,
    acknowledged: false,
    response: null,
    source: null,
    event: null,
  };
}
function resultFixture(): BridgeResult {
  return {
    schemaVersion: "1.3",
    bridgeVersion: "fixture",
    requestId: randomUUID(),
    status: "completed",
    requestedPreset: null,
    observedPreset: null,
    requestedModel: null,
    observedModel: null,
    observedModelSlug: null,
    submitted: "yes",
    conversationUrl: "https://chatgpt.com/c/fixture",
    responseFile: "/private/response.md",
    extractionMethod: "dom",
    extractionQuality: "full",
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 1,
    artifacts: ["/private/artifact"],
    images: [],
    warnings: [],
    error: null,
  };
}
function complete(job: HostedOperationsRecord) {
  job.state = "completed";
  job.attempted = true;
  job.attemptId = randomUUID();
  job.attemptedAt = NOW;
  const identity = {
    requestId: job.issued.requestId,
    taskSpecHash: job.issued.taskSpecHash,
    attemptId: job.attemptId,
  };
  const framing = { identity, rawSha256: HASH, bodySha256: HASH };
  job.response = {
    version: "hosted-response-1",
    ...identity,
    localExecution: false,
    result: resultFixture(),
    framing,
  };
  job.source = {
    state: "available",
    provenance: {
      identity: { conversationId: "fixture", userTurnId: "user-1", assistantTurnId: "assistant-1" },
      frame: framing,
    },
  };
  job.event = {
    requestId: job.issued.requestId,
    taskSpecHash: job.issued.taskSpecHash,
    eventId: EVENT,
    payloadSha256: HASH,
  };
}
function hosted(job: HostedOperationsRecord): NonNullable<UiOperationsSources["hosted"]> {
  return {
    get: () => structuredClone(job),
    list: (_after, _limit) => ({ requestIds: [job.issued.requestId], next: null }),
    policyHash: HASH,
    conversationId: "fixture",
    destinationId: "browser-destination",
    capabilities: () => ({
      approve: { enabled: true, reason: "trusted_approval" },
      start: { enabled: true, reason: "trusted_scheduler" },
      cancel: { enabled: true, reason: "trusted_cancel" },
      reconcile: { enabled: true, reason: "trusted_reconcile" },
      ack: { enabled: true, reason: "trusted_ack" },
    }),
  };
}

describe("bridge-operations-1 route-neutral projection", () => {
  let directory: string;
  const close: (() => void)[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bridge-operations-"));
  });
  afterEach(async () => {
    for (const fn of close.splice(0)) fn();
    await rm(directory, { recursive: true, force: true });
  });
  function registry() {
    const store = new ProjectRegistry(join(directory, `${randomUUID()}.db`));
    store.configure(snapshot(), 0);
    close.push(() => store.close());
    return store;
  }
  async function local() {
    const service = await openUiService({ profile: "demo", stateDir: directory });
    close.push(() => service.close());
    const task = service.createDemo({ title: "Local inspection" }).task;
    const source: NonNullable<UiOperationsSources["local"]> = {
      service,
      list: (after, limit) => service.runtime.store.listPage(after, limit),
      context: (requestId) => {
        const record = service.runtime.store.get(requestId);
        return record
          ? {
              requesterId: record.requesterId,
              recipientActorId: "local-executor",
              destinationId: "cli-destination",
              projectRegistration: reference(),
              sessionId: record.sessionId,
              dependencies: service.runtime.store.dependencies(requestId)?.dependencies ?? [],
            }
          : null;
      },
    };
    return { service, task, source };
  }
  async function finish(service: TaskUiService, requestId: string) {
    let task = service.task(requestId).task;
    const bind = () => ({
      taskSpecHash: task.result.task_spec_hash,
      taskFileHash: task.result.task_file_hash,
      sequence: task.result.observation_seq,
    });
    task = (await service.approve(requestId, bind())).task;
    task = (await service.start(requestId, bind())).task;
    return (await service.demoObservation(requestId, "succeeded")).task;
  }

  it("strictly validates version and route bindings without accepting authentication or authority fields", () => {
    const request = {
      version: OPERATIONS_VERSION,
      action: "start",
      binding: {
        kind: "hosted_delivery",
        requestId: GROUP,
        taskSpecHash: HASH,
        attemptId: null,
        revision: 0,
      },
    };
    expect(() => validateOperationsMutation(request)).not.toThrow();
    for (const wrong of [
      { ...request, version: "2.0" },
      { ...request, authenticated: true },
      { ...request, actorId: "admin" },
      { ...request, binding: { ...request.binding, sequence: 1 } },
      { ...request, binding: { ...request.binding, revision: -1 } },
      { ...request, binding: { ...request.binding, requestId: `${GROUP}\n` } },
      { ...request, action: "fanout_start" },
      { ...request, action: "ack" },
    ])
      expect(() => validateOperationsMutation(wrong)).toThrow("bridge-operations-1");
    expect(() =>
      validateOperationsMutation({
        version: OPERATIONS_VERSION,
        action: "ack",
        binding: {
          kind: "local_execution",
          requestId: GROUP,
          taskSpecHash: HASH,
          taskFileHash: HASH,
          sequence: 1,
        },
        terminal: { eventId: EVENT, payloadSha256: HASH },
      }),
    ).not.toThrow();
  });
  it("wraps the exact local detail and never manufactures a destination registration", async () => {
    const { service, task, source } = await local();
    const operations = new UiOperationsService({ local: source, registry: registry() });
    const projected = value(await operations.detail("local_execution", task.summary.requestId));
    expect(projected.kind).toBe("local_execution");
    if (projected.kind !== "local_execution") return;
    expect(projected.task.rawSpec).toBe(service.task(task.summary.requestId).task.rawSpec);
    expect(projected.task.result).toEqual(task.result);
    expect(projected.context.project.state).toBe("pinned");
    expect(projected.presentation.actualModel).toBeNull();
    expect((await operations.setup()).destinations).toEqual({
      state: "unavailable",
      reason: "destination_catalogue_unconfigured",
    });
    const overview = await operations.overview({ limit: 1 });
    expect(overview.version).toBe(OPERATIONS_VERSION);
    expect(value(overview.local).items).toHaveLength(1);
    expect(overview.hosted.state).toBe("unavailable");
  });
  it("resolves pinned historical project identity after current settings change, without exposing roots", async () => {
    const { task, source } = await local();
    const history = registry();
    history.configure(
      { ...snapshot(2, "Future label"), defaultOutputRoot: "/different/private/root" },
      1,
    );
    const operations = new UiOperationsService({ local: source, registry: history });
    const view = value(await operations.detail("local_execution", task.summary.requestId));
    if (view.kind !== "local_execution") throw new Error("wrong kind");
    expect(view.context.project).toMatchObject({
      state: "pinned",
      displayName: "Original project",
    });
    const setup = await operations.setup();
    expect(value(setup.registry).projects[0]?.displayName).toBe("Future label");
    expect(JSON.stringify(setup)).not.toContain("/private");
    expect(JSON.stringify(setup)).not.toContain("/different");
  });
  it("leaves legacy unpinned rows unbound and disables production authority", async () => {
    const job = hostFixture();
    job.issued.projectRegistration = null;
    const start = vi.fn(() => ({ accepted: true as const }));
    const operations = new UiOperationsService({
      hosted: { ...hosted(job), scheduleStart: start },
      registry: registry(),
    });
    const view = value(await operations.detail("hosted_delivery", job.issued.requestId));
    if (view.kind !== "hosted_delivery") throw new Error("wrong kind");
    expect(view.context.project).toMatchObject({ state: "legacy_unpinned", displayName: null });
    expect(view.capabilities.start.enabled).toBe(false);
    await expect(
      operations.mutate({ version: OPERATIONS_VERSION, action: "start", binding: view.binding }),
    ).rejects.toMatchObject({ code: "hosted_delivery_start_unavailable" });
    expect(start).not.toHaveBeenCalled();
  });
  it("refuses missing historical revisions or changed snapshot hashes instead of using latest", async () => {
    const job = hostFixture();
    job.issued.projectRegistration = { ...reference(), snapshotSha256: "f".repeat(64) };
    const sources = { hosted: hosted(job), registry: registry() };
    const operations = new UiOperationsService(sources);
    const view = value(await operations.detail("hosted_delivery", job.issued.requestId));
    if (view.kind !== "hosted_delivery") throw new Error("wrong kind");
    expect(view.context.project.state).toBe("mismatch");
    job.issued.projectRegistration.registryRevision = 999;
    expect(value(await operations.detail("hosted_delivery", job.issued.requestId))).toMatchObject({
      context: { project: { state: "unavailable", displayName: null } },
    });
  });
  it("keeps hosted completion, observed identity and provenance distinct from local success", async () => {
    const job = hostFixture();
    complete(job);
    const operations = new UiOperationsService({ hosted: hosted(job), registry: registry() });
    const view = value(await operations.detail("hosted_delivery", job.issued.requestId));
    expect(view).toMatchObject({
      kind: "hosted_delivery",
      state: "completed",
      outcome: "completed",
      binding: { revision: 7, attemptId: job.attemptId },
      presentation: { actualProvider: null, actualModel: null },
      source: { state: "available", value: { assistantTurnId: "assistant-1" } },
    });
    const raw = JSON.stringify(view);
    expect(raw).not.toContain("succeeded");
    expect(raw).not.toContain("process_identity");
    expect(raw).not.toContain("pid");
    expect(raw).not.toContain("/private/");
    if (view.kind !== "hosted_delivery") throw new Error("wrong kind");
    expect(view.capabilities.ack.enabled).toBe(false);
  });
  it("never upgrades payload ACKs to full delivery without matching materialization proof", async () => {
    const job = hostFixture();
    complete(job);
    job.acknowledged = true;
    let matching = false;
    const acknowledge = vi.fn();
    const operations = new UiOperationsService({
      hosted: hosted(job),
      registry: registry(),
      materialization: {
        verified: (binding) => ({
          binding: matching ? binding : { ...binding, payloadSha256: "f".repeat(64) },
          receiptSha256: HASH,
          deliveryManifestSha256: HASH,
          requiredArtifactsVerified: true,
          payloadVerified: true,
          synthetic: false,
        }),
        acknowledge,
      },
    });
    let view = value(await operations.detail("hosted_delivery", job.issued.requestId));
    if (view.kind !== "hosted_delivery") throw new Error("wrong kind");
    expect(view.delivery).toMatchObject({
      payloadAckObserved: true,
      materialization: "pending",
      fullDeliverySufficient: false,
    });
    expect(view.capabilities.ack.enabled).toBe(false);
    matching = true;
    view = value(await operations.detail("hosted_delivery", job.issued.requestId));
    if (view.kind !== "hosted_delivery" || !view.terminal) throw new Error("wrong kind");
    expect(view.delivery).toMatchObject({
      materialization: "verified",
      fullDeliverySufficient: true,
    });
    await operations.mutate({
      version: OPERATIONS_VERSION,
      action: "ack",
      binding: view.binding,
      terminal: view.terminal,
    });
    expect(acknowledge).toHaveBeenCalledWith(view.binding, view.terminal);
  });
  it("rejects stale local and hosted bindings before any action and injects only the trusted actor", async () => {
    const { source, task, service } = await local();
    const job = hostFixture();
    job.state = "awaiting_approval";
    const approve = vi.fn();
    const operations = new UiOperationsService({
      local: source,
      hosted: { ...hosted(job), approve },
      registry: registry(),
      authenticatedActorId: "trusted-host-user",
    });
    const localView = value(await operations.detail("local_execution", task.summary.requestId));
    if (localView.kind !== "local_execution") throw new Error("wrong kind");
    await service.approve(task.summary.requestId, localView.binding);
    await expect(
      operations.mutate({
        version: OPERATIONS_VERSION,
        action: "start",
        binding: localView.binding,
      }),
    ).rejects.toMatchObject({ code: "stale_operation_snapshot" });
    const view = value(await operations.detail("hosted_delivery", job.issued.requestId));
    if (view.kind !== "hosted_delivery") throw new Error("wrong kind");
    await expect(
      operations.mutate({
        version: OPERATIONS_VERSION,
        action: "approve",
        binding: { ...view.binding, revision: 6 },
      }),
    ).rejects.toMatchObject({ code: "stale_operation_snapshot" });
    await expect(
      operations.mutate({
        version: OPERATIONS_VERSION,
        action: "approve",
        binding: { ...view.binding, attemptId: EVENT },
      }),
    ).rejects.toMatchObject({ code: "stale_operation_snapshot" });
    expect(approve).not.toHaveBeenCalled();
    await operations.mutate({
      version: OPERATIONS_VERSION,
      action: "approve",
      binding: view.binding,
    });
    expect(approve).toHaveBeenCalledWith(view.binding, "trusted-host-user");
  });
  it("keeps hosted start disabled without a scheduler or trusted approval identity", async () => {
    const job = hostFixture();
    const operations = new UiOperationsService({
      hosted: { ...hosted(job), approve: vi.fn() },
      registry: registry(),
    });
    const view = value(await operations.detail("hosted_delivery", job.issued.requestId));
    if (view.kind !== "hosted_delivery") throw new Error("wrong kind");
    expect(view.capabilities.start).toEqual({
      enabled: false,
      reason: "hosted_start_adapter_unconfigured",
    });
    expect(view.capabilities.approve).toEqual({
      enabled: false,
      reason: "trusted_approval_actor_unconfigured",
    });
  });
  it("dispatches only a bound scheduler hook without waiting for hosted generation", async () => {
    const job = hostFixture();
    const pendingGeneration = new Promise<void>(() => {});
    const scheduleStart = vi.fn(() => {
      void pendingGeneration;
      job.attempted = true;
      job.attemptId = EVENT;
      job.revision++;
      job.state = "unknown";
      return { accepted: true as const };
    });
    const operations = new UiOperationsService(
      { hosted: { ...hosted(job), scheduleStart }, registry: registry() },
      { readTimeoutMs: 20 },
    );
    const view = value(await operations.detail("hosted_delivery", job.issued.requestId));
    if (view.kind !== "hosted_delivery") throw new Error("wrong kind");
    const next = value(
      await operations.mutate({
        version: OPERATIONS_VERSION,
        action: "start",
        binding: view.binding,
      }),
    );
    expect(next).toMatchObject({
      kind: "hosted_delivery",
      state: "unknown",
      binding: { revision: 8, attemptId: EVENT },
    });
    expect(scheduleStart).toHaveBeenCalledOnce();
  });
  it("preserves healthy lanes when another source fails or stalls, without leaking exception paths", async () => {
    const { source } = await local();
    const job = hostFixture();
    const operations = new UiOperationsService(
      {
        local: source,
        hosted: { ...hosted(job), list: () => new Promise(() => {}) },
        fanout: {
          list: () => {
            throw new Error("secret /private/user/token");
          },
          collect: vi.fn(),
        },
      },
      { readTimeoutMs: 15 },
    );
    const overview = await operations.overview();
    expect(overview.local.state).toBe("available");
    expect(overview.hosted).toEqual({ state: "timeout", reason: "source_read_timeout" });
    expect(overview.fanout).toEqual({ state: "error", reason: "source_read_failed" });
    expect(JSON.stringify(overview)).not.toContain("/private");
  });
  it("keeps a local result when optional context, archive or materialization readers stall", async () => {
    const { source, task } = await local();
    const operations = new UiOperationsService(
      {
        local: { ...source, context: () => new Promise(() => {}) },
        archive: { read: () => new Promise(() => {}) },
      },
      { readTimeoutMs: 15 },
    );
    const view = value(await operations.detail("local_execution", task.summary.requestId));
    if (view.kind !== "local_execution") throw new Error("wrong kind");
    expect(view.context.dependencies).toMatchObject({
      state: "unavailable",
      reason: "source_read_timeout",
    });
    expect(view.archive).toEqual({ state: "timeout", reason: "source_read_timeout" });
  });
  it("isolates a corrupt row and enforces bounded cursor pages", async () => {
    const { source, task } = await local();
    const bad = randomUUID();
    const listing = vi.fn((_after: string, _limit: number) => ({
      requestIds: [task.summary.requestId, bad].sort(),
      next: null,
    }));
    const operations = new UiOperationsService({ local: { ...source, list: listing } });
    const overview = await operations.overview({ limit: 2 });
    expect(
      value(overview.local)
        .items.map((item) => item.state)
        .sort(),
    ).toEqual(["available", "error"]);
    expect(listing).toHaveBeenCalledWith("", 2);
    await expect(operations.overview({ limit: 65 })).rejects.toMatchObject({
      code: "invalid_operations_limit",
    });
    expect((await operations.overview({ limit: 1 })).local).toMatchObject({
      state: "error",
      reason: "source_page_invalid",
    });
  });
  it("shows partial fanout child results without merged success or payload-only delivery sufficiency", async () => {
    const { source, task, service } = await local();
    const terminal = await finish(service, task.summary.requestId);
    const job = hostFixture();
    complete(job);
    const group: OperationsFanoutCollection = {
      fanoutId: GROUP,
      commit: "c".repeat(40),
      total: 999,
      available: 999,
      acknowledged: 999,
      pending: 0,
      children: [
        {
          requestId: task.summary.requestId,
          taskSpecHash: task.result.task_spec_hash,
          route: "cli",
          state: "acknowledged",
          payloadSha256: HASH,
          outcome: "succeeded",
          result: terminal.result,
          error: null,
        },
        {
          requestId: job.issued.requestId,
          taskSpecHash: job.issued.taskSpecHash,
          route: "ordinary_chat_browser",
          state: "result_available",
          payloadSha256: HASH,
          outcome: "completed",
          result: { ...job.response, markdown: "Independent hosted answer" },
          error: null,
        },
        {
          requestId: randomUUID(),
          taskSpecHash: HASH,
          route: "cli",
          state: "blocked",
          payloadSha256: null,
          outcome: "unknown",
          result: null,
          error: "/private/failure",
        },
      ],
    };
    const operations = new UiOperationsService({
      local: source,
      fanout: { list: () => ({ fanoutIds: [GROUP], next: null }), collect: () => group },
    });
    const view = value(await operations.detail("fanout", GROUP));
    if (view.kind !== "fanout") throw new Error("wrong kind");
    expect(view).toMatchObject({
      total: 3,
      available: 2,
      pending: 1,
      payloadAcknowledged: 1,
      fullDeliverySufficient: 0,
    });
    expect(view).not.toHaveProperty("status");
    expect(view.children[0]?.result).toMatchObject({
      state: "available",
      value: { kind: "local_execution", result: { status: "succeeded" } },
    });
    expect(view.children[1]?.result).toMatchObject({
      state: "available",
      value: {
        kind: "hosted_delivery",
        outcome: "completed",
        markdown: "Independent hosted answer",
      },
    });
    expect(view.children[2]).toMatchObject({
      state: "blocked",
      outcome: "unknown",
      error: "fanout_child_unavailable",
    });
    expect(view.capabilities.start.enabled).toBe(false);
  });
  it("counts fanout materialization only for matching authenticated child identity and proof", async () => {
    const requestId = randomUUID();
    const identity: OperationDeliveryIdentity = {
      requesterActorId: "requester",
      recipientActorId: "cli",
      requestId,
      taskSpecHash: HASH,
      execution: { kind: "local_execution", runId: null },
      terminalEventId: EVENT,
      payloadSha256: HASH,
    };
    const group: OperationsFanoutCollection = {
      fanoutId: GROUP,
      commit: "c".repeat(40),
      total: 2,
      available: 1,
      pending: 1,
      acknowledged: 1,
      children: [
        {
          requestId,
          route: "cli",
          taskSpecHash: HASH,
          state: "acknowledged",
          payloadSha256: HASH,
          outcome: "failed",
          result: null,
          error: null,
        },
        {
          requestId: randomUUID(),
          route: "ordinary_chat_browser",
          taskSpecHash: HASH,
          state: "pending",
          payloadSha256: null,
          outcome: null,
          result: null,
          error: null,
        },
      ],
    };
    const operations = new UiOperationsService({
      fanout: {
        list: () => ({ fanoutIds: [GROUP], next: null }),
        collect: () => group,
        deliveryIdentity: (_fanoutId, id) => (id === requestId ? identity : null),
      },
      materialization: {
        verified: (binding) => ({
          binding,
          receiptSha256: HASH,
          deliveryManifestSha256: HASH,
          requiredArtifactsVerified: true,
          payloadVerified: true,
          synthetic: false,
        }),
      },
    });
    const view = value(await operations.detail("fanout", GROUP));
    expect(view).toMatchObject({ available: 1, fullDeliverySufficient: 1 });
  });
  it("keeps quota provenance and stale/unknown windows without inventing a cost or verifying manual values", async () => {
    const operations = new UiOperationsService(
      {
        quota: {
          read: () => [
            {
              providerId: "codex",
              source: "user",
              observedAt: NOW,
              windowEndsAt: "2026-10-03T09:00:00Z",
              remainingPercent: 50,
              maxAgeSeconds: 60,
            },
            {
              providerId: "codex",
              source: "provider",
              observedAt: "2026-10-01T00:00:00Z",
              windowEndsAt: "2026-10-04T00:00:00Z",
              remainingPercent: 90,
              maxAgeSeconds: 60,
            },
            {
              providerId: "unknown",
              source: "unknown",
              observedAt: null,
              windowEndsAt: null,
              remainingPercent: null,
              maxAgeSeconds: 60,
            },
          ],
        },
      },
      { now: () => new Date(NOW) },
    );
    const quotas = value((await operations.setup()).quotas);
    expect(quotas[0]).toMatchObject({
      source: "user",
      freshness: "fresh",
      verification: "manual_unverified",
      billingEstimate: null,
    });
    expect(quotas[1]).toMatchObject({
      freshness: "stale",
      source: "provider",
      observedAt: "2026-10-01T00:00:00Z",
    });
    expect(quotas[2]).toMatchObject({
      freshness: "unknown",
      verification: "unknown",
      remainingPercent: null,
    });
  });
  it("hashes exclusive lock identities and preserves durable paused session counters", async () => {
    const { task, source, service } = await local();
    const sessionId = service.runtime.controller.policy.sessionId;
    const operations = new UiOperationsService({
      local: source,
      resources: {
        read: () => ({
          session: {
            sessionId,
            stopped: false,
            paused: true,
            starts: 8,
            reserved: 12,
            reservedSeconds: 3600,
          },
          limits: { maxStarts: 10, deadlineAt: NOW, maxReservedSeconds: 7200 },
          locks: [
            { resourceKey: "worktree:/private/source/repo", requestId: task.summary.requestId },
          ],
        }),
      },
    });
    const view = value(await operations.detail("local_execution", task.summary.requestId));
    if (view.kind !== "local_execution") throw new Error("wrong kind");
    const resources = value(view.resources);
    expect(resources).toMatchObject({
      session: { paused: true, starts: 8, reservedSeconds: 3600 },
      scope: "host_local",
      locks: [{ mode: "exclusive" }],
    });
    expect(resources.locks[0]?.resourceId).toMatch(/^resource:[a-f0-9]{64}$/);
    expect(JSON.stringify(resources)).not.toContain("/private");
  });
  it("retains strict terminal ACK binding and preserves demo-only synthetic compatibility", async () => {
    const { task, source, service } = await local();
    await finish(service, task.summary.requestId);
    const operations = new UiOperationsService({ local: source });
    const view = value(await operations.detail("local_execution", task.summary.requestId));
    if (view.kind !== "local_execution") throw new Error("wrong kind");
    const event = view.task.handshakes.terminal_result;
    if (!event) throw new Error("missing terminal");
    await expect(
      operations.mutate({
        version: OPERATIONS_VERSION,
        action: "ack",
        binding: view.binding,
        terminal: { eventId: event.eventId, payloadSha256: HASH },
      }),
    ).rejects.toMatchObject({ code: "delivery_identity_mismatch" });
    await operations.mutate({
      version: OPERATIONS_VERSION,
      action: "ack",
      binding: view.binding,
      terminal: { eventId: event.eventId, payloadSha256: event.payloadSha256 },
    });
    expect(service.task(task.summary.requestId).task.delivery.acknowledged).toBe(true);
  });
  it("preserves a historical local payload ACK while refusing full-delivery or production ACK without proof", async () => {
    const { source, task, service } = await local();
    const terminal = await finish(service, task.summary.requestId);
    const event = terminal.handshakes.terminal_result;
    if (!event) throw new Error("missing terminal");
    const record = service.task(task.summary.requestId);
    const inspect = vi.fn(() => ({
      ...record,
      task: {
        ...record.task,
        result: { ...record.task.result, synthetic: false },
        handshakes: {
          ...record.task.handshakes,
          result_ack: { ...event, stage: "result_ack" as const },
        },
        delivery: {
          acknowledged: false,
          payloadSha256: event.payloadSha256,
          payloadAckObserved: true,
        },
      },
    }));
    const acknowledge = vi.fn();
    const operations = new UiOperationsService({
      registry: registry(),
      local: {
        ...source,
        service: {
          task: inspect,
          validate: source.service.validate.bind(source.service),
          import: source.service.import.bind(source.service),
          approve: source.service.approve.bind(source.service),
          start: source.service.start.bind(source.service),
          cancel: source.service.cancel.bind(source.service),
          reconcile: source.service.reconcile.bind(source.service),
          acknowledge,
        },
      },
    });
    const view = value(await operations.detail("local_execution", task.summary.requestId));
    if (view.kind !== "local_execution") throw new Error("wrong kind");
    expect(view.delivery).toMatchObject({
      payloadAckObserved: true,
      materialization: "unavailable",
      fullDeliverySufficient: false,
    });
    expect(view.capabilities.ack.enabled).toBe(false);
    await expect(
      operations.mutate({
        version: OPERATIONS_VERSION,
        action: "ack",
        binding: view.binding,
        terminal: { eventId: event.eventId, payloadSha256: event.payloadSha256 },
      }),
    ).rejects.toMatchObject({ code: "local_execution_ack_unavailable" });
    expect(acknowledge).not.toHaveBeenCalled();
  });
  it("refuses a mismatched hosted response frame and marks exact source disagreement unavailable", async () => {
    const job = hostFixture();
    complete(job);
    const operations = new UiOperationsService({ hosted: hosted(job), registry: registry() });
    if (!job.response?.framing || job.source?.state !== "available")
      throw new Error("fixture missing");
    job.source.provenance.frame = structuredClone(job.source.provenance.frame);
    job.source.provenance.frame.rawSha256 = "f".repeat(64);
    const view = value(await operations.detail("hosted_delivery", job.issued.requestId));
    expect(view).toMatchObject({
      source: { state: "unavailable", reason: "hosted_source_identity_mismatch" },
    });
    job.response.framing.identity.attemptId = EVENT;
    expect(await operations.detail("hosted_delivery", job.issued.requestId)).toMatchObject({
      state: "error",
      reason: "source_read_failed",
    });
  });
  it("rejects null, numeric, boolean and unsupported public overview inputs before calling adapters", async () => {
    const operations = new UiOperationsService({});
    for (const input of [
      null,
      false,
      { localAfter: null },
      { hostedAfter: 0 },
      { fanoutAfter: false },
      { localAfter: [] },
      { limit: null },
      { unknown: true },
    ]) {
      await expect(
        operations.overview(input as Parameters<UiOperationsService["overview"]>[0]),
      ).rejects.toBeInstanceOf(Error);
    }
    expect((await operations.overview({ localAfter: "" })).version).toBe(OPERATIONS_VERSION);
  });
  it("validates exact registered destination route, models, policy and capability fields", async () => {
    const registered = {
      destinationId: "trusted-cli",
      route: "cli" as const,
      recipientActorId: "recipient",
      providerId: "codex",
      modelIds: ["model-exact"],
      policyHash: HASH,
      capabilities: { start: { enabled: true, reason: "configured" } },
      unavailableReason: "native_adapter_unverified",
    };
    const operations = new UiOperationsService({ destinations: () => [registered] });
    expect(value((await operations.setup()).destinations)[0]?.capabilities.start).toEqual({
      enabled: false,
      reason: "native_adapter_unverified",
    });
    for (const invalid of [
      { ...registered, route: "browser" },
      { ...registered, modelIds: ["latest\n"] },
      { ...registered, policyHash: "unknown" },
      { ...registered, modelIds: ["same", "same"] },
      { ...registered, capabilities: { start: { enabled: "yes", reason: "configured" } } },
      { ...registered, absolutePath: "/private/secret" },
    ]) {
      const bad = new UiOperationsService({ destinations: () => [invalid] } as UiOperationsSources);
      expect((await bad.setup()).destinations).toEqual({
        state: "error",
        reason: "source_read_failed",
      });
    }
  });
  it("uses raw hosted payloadAcknowledged separately and exposes terminal evidence explicitly in summaries", async () => {
    const job = hostFixture();
    complete(job);
    job.acknowledged = false;
    job.payloadAcknowledged = true;
    const operations = new UiOperationsService({ hosted: hosted(job), registry: registry() });
    const projected = value(await operations.detail("hosted_delivery", job.issued.requestId));
    expect(projected).toMatchObject({
      delivery: { payloadAckObserved: true, fullDeliverySufficient: false },
    });
    let summary = value(
      value((await operations.overview()).hosted).items[0] ?? {
        state: "unavailable",
        reason: "fixture_missing",
      },
    );
    expect(summary).toMatchObject({ kind: "hosted_delivery", terminalAvailable: true });
    job.event = null;
    summary = value(
      value((await operations.overview()).hosted).items[0] ?? {
        state: "unavailable",
        reason: "fixture_missing",
      },
    );
    expect(summary).toMatchObject({ kind: "hosted_delivery", terminalAvailable: false });
  });
  it("never labels unbound provider percentages as Claude, Antigravity or Chat quota", async () => {
    const operations = new UiOperationsService(
      {
        quota: {
          read: () =>
            ["claude", "antigravity", "chatgpt", "unknown"].map((providerId) => ({
              providerId,
              source: "provider" as const,
              observedAt: NOW,
              windowEndsAt: "2026-10-03T09:00:00Z",
              remainingPercent: 99,
              maxAgeSeconds: 60,
            })),
        },
      },
      { now: () => new Date(NOW) },
    );
    for (const row of value((await operations.setup()).quotas))
      expect(row).toMatchObject({
        source: "unknown",
        observedAt: null,
        windowEndsAt: null,
        remainingPercent: null,
        verification: "unknown",
        freshness: "unknown",
      });
  });
});
