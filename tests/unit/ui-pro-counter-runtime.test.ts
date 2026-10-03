import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/cli/config.js";
import type { BridgeResult } from "../../src/contracts/types.js";
import {
  markerExists,
  markerPath,
  type SubmitMarker,
  writeMarker,
} from "../../src/state/marker.js";
import { type BridgeUsageEvent, UsageLifecycleJournal } from "../../src/state/usage-lifecycle.js";
import { ProObservationStore } from "../../src/ui/pro-counter.js";
import {
  type BridgeProCounterRuntime,
  openBridgeProCounter,
  projectUsageEvent,
  qualifiedProPreset,
} from "../../src/ui/pro-counter-runtime.js";

const START = "2026-10-03T00:00:00.000Z",
  ATTEMPT = "2026-10-03T00:00:01.000Z",
  END = "2026-10-03T01:00:00.000Z";
const REQUEST = "req-counter-00001";
function result(over: Partial<BridgeResult> = {}): BridgeResult {
  return {
    schemaVersion: "1.2",
    bridgeVersion: "test",
    requestId: REQUEST,
    status: "completed",
    requestedPreset: "pro",
    observedPreset: "pro",
    requestedModel: "gpt-5.5",
    observedModel: "gpt-5.5",
    observedModelSlug: "gpt-5-5-pro",
    submitted: "yes",
    conversationUrl: "https://chatgpt.com/c/fixture",
    responseFile: "response.md",
    extractionMethod: "dom",
    extractionQuality: "full",
    startedAt: START,
    completedAt: "2026-10-03T00:00:02.000Z",
    durationMs: 2000,
    artifacts: [],
    images: [],
    warnings: [],
    error: null,
    ...over,
  };
}
describe("scoped direct/hosted usage projection, fake evidence only", () => {
  let dir: string;
  let runtime: BridgeProCounterRuntime;
  let now: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pro-runtime-"));
    now = START;
    runtime = await openBridgeProCounter(
      loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: dir }),
      "production",
      () => new Date(now),
    );
    runtime.store.configure(
      {
        limit: 8,
        warnRemaining: 2,
        startsAt: START,
        endsAt: END,
        timeZone: "Asia/Tokyo",
        otherUsage: null,
      },
      0,
    );
    now = "2026-10-03T00:00:05.000Z";
  });
  afterEach(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function marker(owner: "direct" | "hosted" = "direct") {
    const requestPath = join(dir, "request.json");
    await runtime.beginRun(REQUEST, requestPath, START);
    const value: SubmitMarker = {
      requestId: REQUEST,
      requestPath,
      writtenAt: ATTEMPT,
      urlBefore: "https://chatgpt.com/c/fixture",
      baselineAssistantCount: 0,
      presetLabelBefore: "Pro",
      submissionBinding: {
        version: 1,
        owner,
        scopeId: runtime.scopeId,
        requestId: REQUEST,
        attemptId: randomUUID(),
        attemptedAt: ATTEMPT,
      },
    };
    await writeMarker(markerPath(join(dir, "state"), REQUEST), value);
    return value;
  }
  it("repairs crash after marker and before projection, then counts a persisted real result once on replay/reopen", async () => {
    const binding = await marker();
    await runtime.refresh();
    expect(runtime.store.view()).toMatchObject({
      confirmed: 0,
      possible: 1,
      coveragePending: false,
    });
    await writeFile(join(dir, "result.json"), JSON.stringify(result()));
    await runtime.refresh();
    await runtime.refresh();
    expect(runtime.store.view()).toMatchObject({
      confirmed: 1,
      possible: 0,
      remaining: { lower: 7, upper: 7 },
    });
    const seen: BridgeUsageEvent[] = [];
    await runtime.drainLifecycle("fixture", (e) => {
      seen.push(e);
    });
    expect(seen.map((e) => e.kind)).toEqual(["start", "result"]);
    expect(new Set(seen.map((e) => e.attemptId))).toEqual(
      new Set([binding.submissionBinding?.attemptId]),
    );
    await runtime.close();
    runtime = await openBridgeProCounter(
      loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: dir }),
      "production",
      () => new Date(now),
    );
    await runtime.refresh();
    expect(runtime.store.view().confirmed).toBe(1);
    expect(
      (
        await runtime.drainLifecycle("fixture", () => {
          throw new Error("should not replay consumed event");
        })
      ).processed,
    ).toBe(0);
  });
  it("retains original event identity/timestamp after consumer failure and restart", async () => {
    await runtime.beginRun(REQUEST, join(dir, "request.json"), START);
    const auth = result({
      submitted: "no",
      status: "manual_intervention_required",
      observedPreset: null,
      observedModel: null,
      observedModelSlug: null,
      responseFile: null,
      extractionMethod: null,
      extractionQuality: null,
      error: {
        code: "AUTH_REQUIRED",
        message: "sign in",
        cause: "sign in",
        retryable: false,
        phase: "AUTH_CHECKED",
      },
    });
    await writeFile(join(dir, "result.json"), JSON.stringify(auth));
    await runtime.refresh();
    let original: BridgeUsageEvent | undefined;
    await expect(
      runtime.drainLifecycle("alerts", async (event) => {
        original = event;
        throw new Error("enqueue failed");
      }),
    ).rejects.toThrow("enqueue failed");
    await runtime.close();
    runtime = await openBridgeProCounter(
      loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: dir }),
      "production",
      () => new Date(now),
    );
    const seen: BridgeUsageEvent[] = [];
    await runtime.drainLifecycle("alerts", (event) => {
      seen.push(event);
    });
    expect(seen).toEqual([original]);
    expect(seen[0]).toMatchObject({
      attemptId: null,
      requesterActorId: null,
      observedAt: auth.completedAt,
    });
    expect(seen[0]?.runId).toMatch(/^[a-f0-9-]{36}$/);
    expect(runtime.store.view()).toMatchObject({ confirmed: 0, possible: 0 });
  });
  it("never invents identities for legacy and malformed markers and suppresses reference remaining", async () => {
    const path = markerPath(join(dir, "state"), REQUEST);
    await mkdir(join(dir, "state", REQUEST), { recursive: true });
    await writeFile(path, "{broken");
    await runtime.refresh();
    expect(runtime.store.view()).toMatchObject({
      confirmed: 0,
      possible: 0,
      coverageGaps: 1,
      remaining: null,
    });
    expect(await readFile(path, "utf8")).toBe("{broken");
  });
  it("reuses direct attempt for collect and does not let old result replay downgrade it", async () => {
    const m = await marker();
    await runtime.markerWritten(m);
    await writeFile(
      join(dir, "result.json"),
      JSON.stringify(
        result({
          submitted: "unknown",
          observedPreset: null,
          observedModel: null,
          observedModelSlug: null,
          status: "failed",
          responseFile: null,
          extractionMethod: null,
          extractionQuality: null,
          error: {
            code: "SUBMIT_STATE_UNKNOWN",
            message: "unknown",
            cause: "unknown",
            retryable: false,
            phase: "PROMPT_SUBMITTING",
          },
        }),
      ),
    );
    await runtime.refresh();
    expect(runtime.store.view().possible).toBe(1);
    const recovered = result({
      completedAt: "2026-10-03T00:00:04.000Z",
      durationMs: 4000,
      recoveredBy: "collect",
    });
    await runtime.recordCollected(REQUEST, recovered);
    await runtime.refresh();
    await runtime.refresh();
    expect(runtime.store.view()).toMatchObject({ confirmed: 1, possible: 0 });
  });
  it("does not emit direct events for hosted inner marker/auth/collect", async () => {
    const m = await marker("hosted");
    await runtime.markerWritten(m);
    await runtime.recordCollected(REQUEST, result());
    await runtime.refresh();
    const events: BridgeUsageEvent[] = [];
    await runtime.drainLifecycle("alerts", (event) => {
      events.push(event);
    });
    expect(events).toEqual([]);
    expect(runtime.store.view()).toMatchObject({ confirmed: 0, possible: 0 });
  });
  it("persistently resolves known-not-sent before caller deletes marker", async () => {
    const m = await marker();
    await runtime.markerWritten(m);
    if (!m.submissionBinding) throw new Error("test binding missing");
    await runtime.resolveNotSent(
      m.submissionBinding,
      result({
        submitted: "no",
        status: "failed",
        responseFile: null,
        extractionMethod: null,
        extractionQuality: null,
        error: {
          code: "PROMPT_SUBMIT_FAILED",
          message: "unsent",
          cause: "unsent",
          retryable: false,
          phase: "PROMPT_SUBMITTING",
        },
      }),
    );
    expect(await markerExists(markerPath(join(dir, "state"), REQUEST))).toBe(true);
    expect(runtime.store.view()).toMatchObject({ confirmed: 0, possible: 0 });
  });
  it("uses one store for direct and hosted and never counts an ACK/read revision", async () => {
    await marker();
    await writeFile(join(dir, "result.json"), JSON.stringify(result()));
    await runtime.refresh();
    const db = new DatabaseSync(join(dir, "fake-host.db"));
    const source = new UsageLifecycleJournal(db);
    db.exec("BEGIN IMMEDIATE");
    const id = randomUUID(),
      attemptId = randomUUID();
    source.append({
      origin: "hosted",
      kind: "start",
      requestId: id,
      requesterActorId: "requester",
      runId: null,
      attemptId,
      attemptedAt: ATTEMPT,
      observedAt: ATTEMPT,
    });
    source.append({
      origin: "hosted",
      kind: "result",
      requestId: id,
      requesterActorId: "requester",
      runId: null,
      attemptId,
      attemptedAt: ATTEMPT,
      observedAt: result().completedAt,
      result: result({ requestId: id }),
    });
    db.exec("COMMIT");
    runtime.attachHosted(Object.assign(source, { scopeId: runtime.scopeId }));
    await runtime.refresh();
    await runtime.refresh();
    expect(runtime.store.view()).toMatchObject({
      confirmed: 2,
      possible: 0,
      coveragePending: false,
    });
    db.close();
  });
  it("rejects a different profile and an old populated unscoped counter without adopting evidence", async () => {
    await expect(
      openBridgeProCounter(
        loadConfig({
          CHATGPT_BRIDGE_RUNTIME_DIR: dir,
          CHATGPT_BRIDGE_PROFILE_DIR: join(dir, "other"),
        }),
      ),
    ).rejects.toThrow("scope");
    const path = join(dir, "unscoped.db"),
      old = new ProObservationStore(path, false, () => new Date(START));
    old.configure(
      {
        limit: 10,
        warnRemaining: null,
        startsAt: null,
        endsAt: null,
        timeZone: null,
        otherUsage: null,
      },
      0,
    );
    old.close();
    expect(
      () => new ProObservationStore(path, false, () => new Date(START), runtime.scopeId),
    ).toThrow("scope");
  });
  it("uses observed concrete model and Pro evidence, never requested alias or conflicting slug", () => {
    expect(qualifiedProPreset(result())).toBe("pro");
    for (const model of [null, "latest"] as const)
      expect(qualifiedProPreset(result({ observedModel: model }))).toBe("unknown");
    expect(qualifiedProPreset(result({ requestedModel: "gpt-5.6-sol" }))).toBe("unknown");
    expect(qualifiedProPreset(result({ observedModelSlug: "gpt-5-5-thinking" }))).toBe("unknown");
    expect(qualifiedProPreset(result({ observedPreset: "high" }))).toBe("other");
  });
  it("replays a projection committed before cursor advancement without counting twice", async () => {
    const db = new DatabaseSync(join(dir, "cursor-crash.db"));
    const source = new UsageLifecycleJournal(db);
    const attemptId = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    source.append({
      origin: "hosted",
      kind: "start",
      requestId: REQUEST,
      requesterActorId: "requester",
      runId: null,
      attemptId,
      attemptedAt: ATTEMPT,
      observedAt: ATTEMPT,
    });
    source.append({
      origin: "hosted",
      kind: "result",
      requestId: REQUEST,
      requesterActorId: "requester",
      runId: null,
      attemptId,
      attemptedAt: ATTEMPT,
      observedAt: result().completedAt,
      result: result(),
    });
    db.exec("COMMIT");
    await expect(
      source.drainLifecycle("pro_counter", (event) => {
        projectUsageEvent(runtime.store, event);
        if (event.kind === "result") throw new Error("crash after projection");
      }),
    ).rejects.toThrow("crash after projection");
    expect(runtime.store.view().confirmed).toBe(1);
    const replay = await source.drainLifecycle("pro_counter", (event) => {
      projectUsageEvent(runtime.store, event);
    });
    expect(replay).toEqual({ processed: 1, pending: false });
    expect(runtime.store.view()).toMatchObject({ confirmed: 1, possible: 0 });
    db.close();
  });
  it("replays exact direct evidence into a replaced target without adopting its newly configured window", async () => {
    await marker();
    await writeFile(join(dir, "result.json"), JSON.stringify(result()));
    await runtime.refresh();
    expect(runtime.store.view().confirmed).toBe(1);
    const generation = runtime.store.generationId;
    await runtime.close();
    await rename(join(dir, "pro-counter", "production", "counter.db"), join(dir, "old-counter.db"));
    runtime = await openBridgeProCounter(
      loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: dir }),
      "production",
      () => new Date(now),
    );
    expect(runtime.store.generationId).not.toBe(generation);
    runtime.store.configure(
      {
        limit: 8,
        warnRemaining: 2,
        startsAt: START,
        endsAt: END,
        timeZone: "Etc/UTC",
        otherUsage: null,
      },
      0,
    );
    await runtime.refresh();
    expect(runtime.store.view()).toMatchObject({ remaining: null, unassignedInWindow: 1 });
  });
  it("replays hosted evidence for a replacement counter generation too", async () => {
    const db = new DatabaseSync(join(dir, "replacement-hosted.db"));
    const source = Object.assign(new UsageLifecycleJournal(db), { scopeId: runtime.scopeId });
    const attemptId = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    source.append({
      origin: "hosted",
      kind: "start",
      requestId: REQUEST,
      requesterActorId: "requester",
      runId: null,
      attemptId,
      attemptedAt: ATTEMPT,
      observedAt: ATTEMPT,
    });
    source.append({
      origin: "hosted",
      kind: "result",
      requestId: REQUEST,
      requesterActorId: "requester",
      runId: null,
      attemptId,
      attemptedAt: ATTEMPT,
      observedAt: result().completedAt,
      result: result(),
    });
    db.exec("COMMIT");
    try {
      runtime.attachHosted(source);
      await runtime.refresh();
      expect(runtime.store.view().confirmed).toBe(1);
      await runtime.close();
      await rename(
        join(dir, "pro-counter", "production", "counter.db"),
        join(dir, "old-counter.db"),
      );
      runtime = await openBridgeProCounter(
        loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: dir }),
        "production",
        () => new Date(now),
      );
      runtime.attachHosted(source);
      runtime.store.configure(
        {
          limit: 8,
          warnRemaining: 2,
          startsAt: START,
          endsAt: END,
          timeZone: "Etc/UTC",
          otherUsage: null,
        },
        0,
      );
      await runtime.refresh();
      expect(runtime.store.view()).toMatchObject({ remaining: null, unassignedInWindow: 1 });
    } finally {
      db.close();
    }
  });
  it("fails closed when an older same-generation target backup is restored behind source cursor", async () => {
    const generation = runtime.store.generationId;
    await runtime.close();
    const path = join(dir, "pro-counter", "production", "counter.db");
    await copyFile(path, join(dir, "counter-backup.db"));
    runtime = await openBridgeProCounter(
      loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: dir }),
      "production",
      () => new Date(now),
    );
    await marker();
    await writeFile(join(dir, "result.json"), JSON.stringify(result()));
    await runtime.refresh();
    expect(runtime.store.view().confirmed).toBe(1);
    await runtime.close();
    await copyFile(join(dir, "counter-backup.db"), path);
    runtime = await openBridgeProCounter(
      loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: dir }),
      "production",
      () => new Date(now),
    );
    expect(runtime.store.generationId).toBe(generation);
    expect(runtime.store.view()).toMatchObject({ confirmed: 0, coverageGaps: 1, remaining: null });
  });
  it("concurrent owners do not manufacture a restoration gap or duplicate a count", async () => {
    const second = await openBridgeProCounter(
      loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: dir }),
      "production",
      () => new Date(now),
    );
    try {
      expect(second.store.generationId).toBe(runtime.store.generationId);
      await marker();
      await writeFile(join(dir, "result.json"), JSON.stringify(result()));
      await Promise.allSettled([runtime.refresh(), second.refresh()]);
      await runtime.refresh();
      await second.refresh();
      expect(runtime.store.view()).toMatchObject({
        confirmed: 1,
        possible: 0,
        coverageGaps: 0,
        coveragePending: false,
      });
    } finally {
      await second.close();
    }
  });
  it("recovers a projection committed before the target receipt and source cursor", async () => {
    await marker();
    await writeFile(join(dir, "result.json"), JSON.stringify(result()));
    const record = runtime.store.recordProjectionPosition.bind(runtime.store);
    let fail = true;
    runtime.store.recordProjectionPosition = (source, sequence) => {
      if (fail) {
        fail = false;
        throw new Error("receipt crash");
      }
      record(source, sequence);
    };
    await expect(runtime.refresh()).rejects.toThrow("receipt crash");
    expect(runtime.store.view().remaining).toBe(null);
    await runtime.refresh();
    expect(runtime.store.view()).toMatchObject({
      confirmed: 1,
      possible: 0,
      coverageGaps: 0,
      coveragePending: false,
    });
  });
  it.each(["binding", "marker", "result"])(
    "bounds oversized %s evidence and leaves coverage unavailable",
    async (kind) => {
      const limits = await import("../../src/state/usage-read.js");
      await marker();
      const path =
        kind === "binding"
          ? join(dir, "state", REQUEST, "run.binding.json")
          : kind === "marker"
            ? markerPath(join(dir, "state"), REQUEST)
            : join(dir, "result.json");
      const limit =
        kind === "binding"
          ? limits.USAGE_BINDING_MAX_BYTES
          : kind === "marker"
            ? limits.USAGE_MARKER_MAX_BYTES
            : limits.USAGE_RESULT_MAX_BYTES;
      await writeFile(path, " ".repeat(limit + 1));
      await expect(runtime.refresh()).rejects.toThrow();
      expect(runtime.store.view()).toMatchObject({ remaining: null, coveragePending: true });
    },
  );
  it.each(["invalid_utf8", "duplicate_key"])(
    "rejects %s source bytes before projecting evidence",
    async (kind) => {
      await marker();
      const raw = JSON.stringify(result());
      await writeFile(
        join(dir, "result.json"),
        kind === "invalid_utf8"
          ? Buffer.concat([Buffer.from(raw), Buffer.from([0xff])])
          : raw.replace('"submitted":"yes"', '"submitted":"yes","submitted":"no"'),
      );
      await expect(runtime.refresh()).rejects.toThrow();
      expect(runtime.store.view()).toMatchObject({
        confirmed: 0,
        remaining: null,
        coveragePending: true,
      });
    },
  );
});
