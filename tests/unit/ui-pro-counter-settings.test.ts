import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Bytes } from "../../src/contracts/task.js";
import type { TaskSpec } from "../../src/contracts/task-types.js";
import type { BridgeResult } from "../../src/contracts/types.js";
import { demoTask } from "../../src/ui/demo.js";
import type { HostedOperationsRecord } from "../../src/ui/operations.js";
import { ProObservationStore } from "../../src/ui/pro-counter.js";
import {
  createHostedProObserver,
  observeHostedStartIntent,
  UiProCounterSettings,
} from "../../src/ui/pro-counter-settings.js";

const NOW = "2026-10-03T08:00:00.000Z";
const START = "2026-10-03T08:00:01.000Z";
const END = "2026-10-03T08:00:02.000Z";
const SETTINGS = {
  limit: 10,
  warnRemaining: 2,
  startsAt: NOW,
  endsAt: "2026-10-03T09:00:00.000Z",
  timeZone: "Etc/UTC",
  otherUsage: null,
};
function fixture(): { job: HostedOperationsRecord; result: BridgeResult } {
  const input = demoTask({ title: "Hosted counter fixture" });
  const task = JSON.parse(input.rawSpec) as TaskSpec;
  const job: HostedOperationsRecord = {
    revision: 7,
    issued: {
      requestId: task.request_id,
      taskSpecHash: sha256Bytes(Buffer.from(input.rawSpec)),
      taskFileHash: task.task_file_hash,
      requesterId: "requester",
      recipientId: "browser",
      repoId: task.repo,
      route: "ordinary_chat_browser",
      projectRegistration: null,
    },
    raw: input.rawSpec,
    taskBytesBase64: Buffer.from(input.taskMarkdown).toString("base64"),
    state: "unknown",
    attempted: true,
    attemptId: randomUUID(),
    attemptedAt: START,
    cancelRequestedAt: null,
    deadlineAt: null,
    acknowledged: false,
    response: null,
    source: null,
    event: null,
  };
  const result: BridgeResult = {
    schemaVersion: "1.2",
    bridgeVersion: "fixture",
    requestId: task.request_id,
    status: "completed",
    requestedPreset: "pro",
    observedPreset: "pro",
    requestedModel: "gpt-5.5",
    observedModel: "gpt-5.5",
    observedModelSlug: "gpt-5.5",
    submitted: "yes",
    conversationUrl: "https://chatgpt.com/c/fixture",
    responseFile: "response.md",
    extractionMethod: "dom",
    extractionQuality: "full",
    startedAt: START,
    completedAt: END,
    durationMs: 1000,
    artifacts: [],
    images: [],
    warnings: [],
    error: null,
  };
  return { job, result };
}
describe("bounded Pro counter settings and trusted observation binding", () => {
  let directory: string;
  let store: ProObservationStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pro-counter-settings-"));
    store = new ProObservationStore(join(directory, "counter.db"), false, () => new Date(NOW));
  });
  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  it("uses only an injected store and explicitly reports absence", () => {
    expect(new UiProCounterSettings().view()).toEqual({
      version: "bridge-pro-counter-settings-1",
      state: "unavailable",
      configurable: false,
      reason: "pro_counter_unconfigured",
    });
    expect(() =>
      new UiProCounterSettings().update({ expectedRevision: 0, settings: SETTINGS }),
    ).toThrow("not configured");
    expect(createHostedProObserver(undefined, { synthetic: false })(null)).toMatchObject({
      state: "unavailable",
    });
  });
  it("strictly updates complete settings on the same store with stale-revision protection", () => {
    const service = new UiProCounterSettings(store);
    expect(service.update({ expectedRevision: 0, settings: SETTINGS })).toMatchObject({
      state: "available",
      configurable: true,
      view: { configuration: { revision: 1 } },
    });
    expect(store.configuration()?.settings).toEqual(SETTINGS);
    expect(() => service.update({ expectedRevision: 0, settings: SETTINGS })).toThrow("changed");
    for (const input of [
      { expectedRevision: 1, settings: SETTINGS, observation: {} },
      { expectedRevision: null, settings: SETTINGS },
      { expectedRevision: "1", settings: SETTINGS },
      { expectedRevision: 1, settings: { ...SETTINGS, source: "provider" } },
      { expectedRevision: -1, settings: SETTINGS },
    ])
      expect(() => service.update(input)).toThrow();
  });
  it("returns unavailable without leaking storage failures or fabricated counts", () => {
    store.configure(SETTINGS, 0);
    const db = new DatabaseSync(join(directory, "counter.db"));
    db.exec("UPDATE pro_counter_settings SET digest=NULL");
    db.close();
    const result = new UiProCounterSettings(store).view();
    expect(result).toEqual({
      version: "bridge-pro-counter-settings-1",
      state: "unavailable",
      configurable: false,
      reason: "counter_integrity_unavailable",
    });
    expect(result).not.toHaveProperty("view");
  });
  it("binds trusted persisted observations to exact request/attempt and deduplicates them", () => {
    store.configure(SETTINGS, 0);
    const { job, result } = fixture();
    const observe = createHostedProObserver(store, { synthetic: false });
    expect(observe(job, { revision: 6, result })).toMatchObject({
      state: "available",
      value: { requestId: job.issued.requestId, attemptId: job.attemptId, revision: 6 },
    });
    observe(job, { revision: 6, result });
    expect(store.view()).toMatchObject({
      confirmed: 1,
      possible: 0,
      providerQuotaKnown: false,
      wholeAccountKnown: false,
    });
  });
  it("never infers actual Pro usage from requested preset or model", () => {
    store.configure(SETTINGS, 0);
    const { job, result } = fixture();
    result.observedPreset = null;
    result.status = "failed";
    result.submitted = "unknown";
    result.error = {
      code: "INTERNAL_ERROR",
      message: "Observation unavailable",
      retryable: false,
      phase: "WAITING_FOR_RESPONSE",
      cause: null,
    };
    result.responseFile = null;
    result.extractionMethod = null;
    result.extractionQuality = null;
    expect(
      createHostedProObserver(store, { synthetic: false })(job, { revision: 6, result }).state,
    ).toBe("available");
    expect(store.view()).toMatchObject({ confirmed: 0, possible: 1 });
    result.observedPreset = "high";
    createHostedProObserver(store, { synthetic: false })(job, { revision: 7, result });
    expect(store.view()).toMatchObject({ confirmed: 0, possible: 0 });
  });
  it("keeps missing observation, wrong request/route/revision and mismatched profile unavailable", () => {
    store.configure(SETTINGS, 0);
    const { job, result } = fixture();
    const observe = createHostedProObserver(store, { synthetic: false });
    expect(observe(job)).toMatchObject({
      state: "unavailable",
      reason: "hosted_submission_observation_unavailable",
    });
    expect(observe(job, { revision: 8, result }).state).toBe("unavailable");
    expect(
      observe(job, { revision: 6, result: { ...result, requestId: randomUUID() } }).state,
    ).toBe("unavailable");
    expect(observe({ ...job, attempted: false }, { revision: 6, result }).state).toBe(
      "unavailable",
    );
    expect(
      observe({ ...job, issued: { ...job.issued, route: "cli" } }, { revision: 6, result }).state,
    ).toBe("unavailable");
    expect(
      createHostedProObserver(store, { synthetic: true })(job, { revision: 6, result }).state,
    ).toBe("unavailable");
    expect(store.view().confirmed).toBe(0);
  });
  it("accepts a correctly bound durable response but rejects attempts to retarget it", () => {
    store.configure(SETTINGS, 0);
    const { job, result } = fixture();
    if (!job.attemptId) throw new Error("fixture missing");
    job.response = {
      version: "hosted-response-1",
      requestId: job.issued.requestId,
      taskSpecHash: job.issued.taskSpecHash,
      attemptId: job.attemptId,
      localExecution: false,
      result,
      framing: null,
    };
    const observe = createHostedProObserver(store, { synthetic: false });
    expect(observe(job).state).toBe("available");
    expect(observe({ ...job, attemptId: randomUUID() }).state).toBe("unavailable");
    expect(store.view().confirmed).toBe(1);
  });
  it("records newly durable start as possible and promotes only the same attempt's real higher revision", () => {
    store.configure(SETTINGS, 0);
    const { job, result } = fixture();
    job.revision = 3;
    expect(observeHostedStartIntent(store, job).state).toBe("available");
    expect(store.view()).toMatchObject({ confirmed: 0, possible: 1 });
    // Repeated read-like calls may not advance the provisional counter revision.
    expect(observeHostedStartIntent(store, { ...job, revision: 100 }).state).toBe("available");
    expect(
      createHostedProObserver(store, { synthetic: false })(
        { ...job, revision: 4 },
        { revision: 4, result },
      ).state,
    ).toBe("available");
    expect(store.view()).toMatchObject({ confirmed: 1, possible: 0 });
    expect(observeHostedStartIntent(store, { ...job, revision: 101 }).state).toBe("available");
    expect(store.view()).toMatchObject({ confirmed: 1, possible: 0 });
  });
  it("does not create provisional observations from cancelled/unattempted jobs or regular missing-observation reads", () => {
    store.configure(SETTINGS, 0);
    const { job } = fixture();
    expect(observeHostedStartIntent(store, { ...job, cancelRequestedAt: END }).state).toBe(
      "unavailable",
    );
    expect(observeHostedStartIntent(store, { ...job, attempted: false }).state).toBe("unavailable");
    expect(createHostedProObserver(store, { synthetic: false })(job).state).toBe("unavailable");
    expect(store.view()).toMatchObject({ confirmed: 0, possible: 0 });
  });
  it("resolves a provisional start to non-Pro from a real later observation without another count", () => {
    store.configure(SETTINGS, 0);
    const { job, result } = fixture();
    job.revision = 3;
    observeHostedStartIntent(store, job);
    result.observedPreset = "high";
    expect(
      createHostedProObserver(store, { synthetic: false })(
        { ...job, revision: 4 },
        { revision: 4, result },
      ).state,
    ).toBe("available");
    expect(store.view()).toMatchObject({ confirmed: 0, possible: 0 });
  });
});
