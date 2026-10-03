import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationSendOutcome } from "../../src/adapters/notification-transports.js";
import { UsageLifecycleJournal } from "../../src/state/usage-lifecycle.js";
import { NotificationPreferencesStore } from "../../src/ui/notification-preferences.js";
import {
  type NotificationBinding,
  type NotificationCredentialSessionV2,
  type NotificationLifecycleEvent,
  NotificationRuntime,
  type SecureNotificationRegistry,
} from "../../src/ui/notification-runtime.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
describe("optional trusted notification runtime (fake transports only)", () => {
  let directory: string;
  let now: number;
  let stores: NotificationPreferencesStore[];
  let runtimes: NotificationRuntime[];
  let send: ReturnType<
    typeof vi.fn<(text: string, signal: AbortSignal) => Promise<NotificationSendOutcome>>
  >;
  let binding: NotificationBinding;
  let registry: SecureNotificationRegistry;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bridge-alert-test-"));
    now = Date.parse("2026-10-03T08:00:00.000Z");
    stores = [];
    runtimes = [];
    send = vi.fn(async () => "delivered");
    binding = {
      destinationId: "personal-email",
      channel: "email",
      label: "Private email",
      generation: "binding-v1",
      revision: 1,
      activatedAt: new Date(now - 1000).toISOString(),
      credentialState: "configured",
      prepare: async () => ({
        generation: binding.generation,
        revision: binding.revision,
        transport: { send },
      }),
    };
    registry = {
      isCurrent: (actor, id, generation, revision) =>
        actor === "alice" &&
        id === binding.destinationId &&
        generation === binding.generation &&
        revision === binding.revision,
      list: async (actor) => (actor === "alice" ? [binding] : []),
    };
  });
  afterEach(async () => {
    now += 3600000;
    for (const runtime of runtimes) await runtime.close();
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  function open(timeoutMs = 1000) {
    const store = new NotificationPreferencesStore(
      join(directory, "preferences.db"),
      "production",
      () => new Date(now),
    );
    stores.push(store);
    const runtime = new NotificationRuntime(store, {
      registry,
      authorizeSend: () => true,
      now: () => new Date(now),
      timeoutMs,
    });
    runtimes.push(runtime);
    return { store, runtime };
  }
  function enable(store: NotificationPreferencesStore, enabled = true) {
    const before = store.snapshot("alice");
    store.update("alice", before.revision, {
      enabled,
      destinationIds: enabled ? [binding.destinationId] : [],
    });
    now++;
  }
  function event(overrides: Partial<NotificationLifecycleEvent> = {}): NotificationLifecycleEvent {
    return {
      version: 1,
      sourceId: randomUUID(),
      eventId: randomUUID(),
      origin: "direct",
      kind: "result",
      requestId: randomUUID(),
      requesterActorId: null,
      runId: randomUUID(),
      attemptId: null,
      observedAt: new Date(now).toISOString(),
      result: {
        error: { code: "AUTH_REQUIRED" },
        conversationUrl: "https://chatgpt.com/c/example",
      },
      ...overrides,
    };
  }
  const testInput = (revision = 0) => ({
    actionId: randomUUID(),
    destinationId: "personal-email",
    expectedRevision: revision,
  });
  it("starts OFF, tombstones old auth events and permits only an explicit one-shot test", async () => {
    const { store, runtime } = open();
    const blocked = event();
    await runtime.enqueue("alice", blocked);
    await runtime.drain();
    expect(send).not.toHaveBeenCalled();
    enable(store);
    await runtime.enqueue("alice", blocked);
    await runtime.drain();
    expect(send).not.toHaveBeenCalled();
    enable(store, false);
    const input = testInput(2);
    expect(await runtime.test("alice", input)).toMatchObject({ kind: "test", state: "delivered" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.snapshot("alice").authBlocked.enabled).toBe(false);
    expect(await runtime.test("alice", input)).toMatchObject({ state: "delivered" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("suppresses an OFF-era event first observed after restart and enable", async () => {
    const first = open();
    const blocked = event();
    await first.runtime.close();
    now += 100;
    const next = open();
    enable(next.store);
    await next.runtime.enqueue("alice", blocked);
    await next.runtime.drain();
    expect(send).not.toHaveBeenCalled();
  });
  it("dedupes the same run/category across new event IDs, replay and reopened DB", async () => {
    const first = open();
    enable(first.store);
    const blocked = event();
    await first.runtime.enqueue("alice", blocked);
    await first.runtime.drain();
    await first.runtime.enqueue("alice", { ...blocked, eventId: randomUUID() });
    await first.runtime.drain();
    expect(send).toHaveBeenCalledTimes(1);
    await first.runtime.close();
    now += 60000;
    const next = open();
    await next.runtime.enqueue("alice", blocked);
    await next.runtime.drain();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not expose or transmit task/error text and handles legacy request IDs", async () => {
    const { store, runtime } = open();
    enable(store);
    await runtime.enqueue(
      "alice",
      event({
        requestId: "legacy-request-001",
        result: {
          error: { code: "CAPTCHA_OR_CHALLENGE" },
          conversationUrl: "https://user:secret@chatgpt.com/c/fixture?token=secret",
        },
      }),
    );
    await runtime.drain();
    const text = send.mock.calls[0]?.[0];
    expect(text).toContain("legacy-request-001");
    expect(text).not.toMatch(/secret|user:|token=/);
  });
  it("rejects unsupported or retargeted events and keeps actors isolated", async () => {
    const { store, runtime } = open();
    enable(store);
    const blocked = event();
    await expect(
      runtime.enqueue("alice", {
        ...blocked,
        origin: "hosted",
        attemptId: randomUUID(),
        requesterActorId: "bob",
      }),
    ).rejects.toMatchObject({ code: "notification_event_invalid" });
    await expect(
      runtime.enqueue("alice", {
        ...blocked,
        result: { target: "dot", error: { code: "AUTH_REQUIRED" }, conversationUrl: null },
      }),
    ).rejects.toMatchObject({ code: "notification_event_invalid" });
    await expect(
      runtime.enqueue("alice", {
        ...blocked,
        result: { error: { code: "RATE_LIMITED" }, conversationUrl: null },
      }),
    ).rejects.toMatchObject({ code: "notification_event_invalid" });
    await runtime.enqueue("bob", blocked);
    await runtime.drain();
    expect(send).not.toHaveBeenCalled();
    expect((await runtime.view("bob")).recent).toEqual([]);
  });
  it("cancels queued retries after disabling and never flushes them after re-enable", async () => {
    const { store, runtime } = open();
    enable(store);
    send.mockResolvedValue("not_sent_retryable");
    await runtime.enqueue("alice", event());
    await runtime.drain();
    expect(send).toHaveBeenCalledTimes(1);
    enable(store, false);
    runtime.invalidate("alice");
    enable(store, true);
    now += 120000;
    await runtime.drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await runtime.view("alice")).recent[0]?.state).toBe("cancelled");
  });
  it("pins exact recipient/credential generation and cancels after rotation", async () => {
    const { store, runtime } = open();
    enable(store);
    await runtime.enqueue("alice", event());
    binding = { ...binding, generation: "binding-v2", revision: 2 };
    await runtime.drain();
    expect(send).not.toHaveBeenCalled();
    expect((await runtime.view("alice")).recent[0]?.state).toBe("cancelled");
  });
  it("rechecks disable after async preparation immediately before send", async () => {
    const { store, runtime } = open();
    enable(store);
    await runtime.enqueue("alice", event());
    const waiting = deferred<{
      generation: string;
      revision: number;
      transport: { send: typeof send };
    }>();
    binding = { ...binding, prepare: () => waiting.promise };
    const drain = runtime.drain();
    await vi.waitFor(() => expect(runtime.active.size).toBe(1));
    enable(store, false);
    waiting.resolve({
      generation: binding.generation,
      revision: binding.revision,
      transport: { send },
    });
    await drain;
    expect(send).not.toHaveBeenCalled();
  });
  it("times out preparation and never invokes a late prepared closure", async () => {
    const { store, runtime } = open(15);
    enable(store);
    await runtime.enqueue("alice", event());
    const waiting = deferred<{
      generation: string;
      revision: number;
      transport: { send: typeof send };
    }>();
    binding = { ...binding, prepare: () => waiting.promise };
    await runtime.drain();
    waiting.resolve({
      generation: binding.generation,
      revision: binding.revision,
      transport: { send },
    });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });
  it("records unknown send outcomes and never retries them after restart", async () => {
    const { runtime } = open(15);
    const waiting = deferred<NotificationSendOutcome>();
    send.mockImplementation(() => waiting.promise);
    const input = testInput();
    expect(await runtime.test("alice", input)).toMatchObject({ state: "uncertain" });
    expect(send).toHaveBeenCalledTimes(1);
    await runtime.close();
    now += 120000;
    const next = open();
    await next.runtime.drain();
    expect(send).toHaveBeenCalledTimes(1);
    waiting.resolve("delivered");
    await Promise.resolve();
    expect(next.runtime.status("alice", input.actionId)?.state).toBe("uncertain");
  });
  it("allows only three total verified-not-sent attempts and charges the shared hourly rate", async () => {
    const { store, runtime } = open();
    enable(store);
    send.mockResolvedValue("not_sent_retryable");
    const blocked = event();
    await runtime.enqueue("alice", blocked);
    await runtime.drain();
    now += 60000;
    await runtime.drain();
    now += 120000;
    await runtime.drain();
    now += 240000;
    await runtime.drain();
    expect(send).toHaveBeenCalledTimes(3);
    expect((await runtime.view("alice")).recent[0]).toMatchObject({
      state: "not_sent",
      attempts: 3,
    });
    const input = testInput(1);
    expect(await runtime.test("alice", input)).toMatchObject({ state: "queued" });
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("atomically owns concurrent cross-connection claims", async () => {
    const first = open();
    enable(first.store);
    await first.runtime.enqueue("alice", event());
    const second = open();
    await Promise.all([first.runtime.drain(), second.runtime.drain()]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("keeps credential save separate, masked, action-deduped and bound to native confirmation", async () => {
    const candidate = {};
    const capture = vi.fn((session: NotificationCredentialSessionV2) => {
      session.complete("saved", candidate);
    });
    registry.credentialProtocol = "bridge-notification-credentials-2";
    registry.beginCredentialInteractionV2 = capture;
    registry.commitCredentialCandidate = (value) => {
      expect(value).toBe(candidate);
      binding = { ...binding, generation: "binding-v2", revision: 2 };
      return binding;
    };
    const { runtime, store } = open();
    const input = testInput();
    expect(await runtime.credentials("alice", input)).toMatchObject({
      kind: "credential",
      state: "sending",
    });
    expect(capture).not.toHaveBeenCalled();
    runtime.activateCredentialInteraction("alice", input.actionId);
    await vi.waitFor(() => expect(runtime.status("alice", input.actionId)?.state).toBe("saved"));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(store.snapshot("alice").authBlocked.enabled).toBe(false);
    expect(await runtime.credentials("alice", input)).toMatchObject({ state: "saved" });
    expect(capture).toHaveBeenCalledTimes(1);
    expect((await runtime.view("alice")).destinations).toEqual([
      { destinationId: "personal-email", credentialState: "configured", masked: "••••••••" },
    ]);
    await expect(runtime.test("alice", input)).rejects.toMatchObject({
      code: "notification_action_conflict",
    });
    await expect(runtime.credentials("alice", { ...input, actorId: "bob" })).rejects.toMatchObject({
      code: "notification_action_invalid",
    });
  });
  it("never reopens uncertain native save or silently reactivates old credentials", async () => {
    registry.credentialProtocol = "bridge-notification-credentials-2";
    registry.beginCredentialInteractionV2 = (session) => {
      session.complete("uncertain");
    };
    const { runtime } = open();
    const input = testInput();
    expect(await runtime.credentials("alice", input)).toMatchObject({ state: "sending" });
    runtime.activateCredentialInteraction("alice", input.actionId);
    await vi.waitFor(() =>
      expect(runtime.status("alice", input.actionId)?.state).toBe("uncertain"),
    );
    expect((await runtime.list("alice"))[0]?.transportAvailable).toBe(false);
    await runtime.close();
    const next = open();
    expect((await next.runtime.list("alice"))[0]?.transportAvailable).toBe(false);
    expect(await next.runtime.credentials("alice", input)).toMatchObject({ state: "uncertain" });
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects changed action inputs and stale revision without any effect", async () => {
    const { runtime, store } = open();
    const input = testInput();
    await runtime.test("alice", input);
    await expect(runtime.test("alice", { ...input, destinationId: "other" })).rejects.toMatchObject(
      { code: "notification_action_conflict" },
    );
    enable(store);
    await expect(runtime.test("alice", testInput())).rejects.toMatchObject({
      code: "stale_notification_preferences",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("fences shutdown during preparation and during an in-flight send", async () => {
    const first = open();
    enable(first.store);
    await first.runtime.enqueue("alice", event());
    const prepared = deferred<{
      generation: string;
      revision: number;
      transport: { send: typeof send };
    }>();
    binding = { ...binding, prepare: () => prepared.promise };
    const draining = first.runtime.drain();
    await vi.waitFor(() => expect(first.runtime.active.size).toBe(1));
    await first.runtime.close();
    first.store.close();
    prepared.resolve({
      generation: binding.generation,
      revision: binding.revision,
      transport: { send },
    });
    await draining;
    expect(send).not.toHaveBeenCalled();
    binding = {
      ...binding,
      prepare: async () => ({
        generation: binding.generation,
        revision: binding.revision,
        transport: { send },
      }),
    };
    const second = open();
    const delivered = deferred<NotificationSendOutcome>();
    send.mockImplementation(() => delivered.promise);
    const action = testInput(1);
    const testing = second.runtime.test("alice", action);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await second.runtime.close();
    second.store.close();
    delivered.resolve("delivered");
    expect(await testing).toMatchObject({ state: "uncertain" });
  });
  it("fails closed on clock regression and corrupt content without reflecting transport errors", async () => {
    const { store, runtime } = open();
    enable(store);
    await runtime.enqueue("alice", event());
    const remembered = now;
    now -= 100;
    await expect(runtime.drain()).rejects.toMatchObject({ code: "notification_clock_unavailable" });
    expect(send).not.toHaveBeenCalled();
    now = remembered;
    const db = new DatabaseSync(join(directory, "preferences.db"));
    db.exec('UPDATE notification_outbox SET content=\'{"kind":"test","token":"SECRET"}\'');
    db.close();
    await runtime.drain();
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(await runtime.view("alice"))).not.toContain("SECRET");
  });
  it("rejects a prepared lease with changed credential identity", async () => {
    const { store, runtime } = open();
    enable(store);
    await runtime.enqueue("alice", event());
    binding = {
      ...binding,
      prepare: async () => ({ generation: "replacement", revision: 2, transport: { send } }),
    };
    await runtime.drain();
    expect(send).not.toHaveBeenCalled();
  });
  it("does not roll the current recipient registration back to an older process view", async () => {
    const { runtime } = open();
    await runtime.list("alice");
    binding = { ...binding, generation: "binding-v2", revision: 2 };
    await runtime.list("alice");
    binding = { ...binding, generation: "binding-v1", revision: 1 };
    expect((await runtime.list("alice"))[0]?.transportAvailable).toBe(false);
    await expect(runtime.test("alice", testInput())).rejects.toMatchObject({
      code: "notification_destination_unavailable",
    });
    expect(send).not.toHaveBeenCalled();
  });
  it("preserves original source-event fields across a delayed registry read", async () => {
    const { store, runtime } = open();
    enable(store);
    const blocked = event();
    const lookup = deferred<NotificationBinding[]>();
    registry.list = () => lookup.promise;
    const enqueuing = runtime.enqueue("alice", blocked);
    await Promise.resolve();
    blocked.requestId = "changed-request-001";
    blocked.observedAt = "2099-01-01T00:00:00.000Z";
    lookup.resolve([binding]);
    await enqueuing;
    registry.list = async () => [binding];
    await runtime.drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).not.toContain("changed-request");
  });
  it("pins source-to-direct-actor mapping and waits for its active consumer before shutdown", async () => {
    const { store, runtime } = open();
    enable(store);
    const blocked = event();
    const source = {
      sourceId: blocked.sourceId,
      registerLifecycleSink: () => {},
      drainLifecycle: async (
        _id: string,
        consume: (value: NotificationLifecycleEvent) => Promise<void> | void,
      ) => {
        await consume(blocked);
        return { processed: 1, pending: false };
      },
    };
    runtime.attachSource(source, "alice");
    const other = open();
    expect(() => other.runtime.attachSource(source, "bob")).toThrow(
      "notification_source_actor_changed",
    );
    const lookup = deferred<NotificationBinding[]>();
    registry.list = () => lookup.promise;
    const ticking = runtime.tick();
    await Promise.resolve();
    const closing = runtime.close();
    lookup.resolve([binding]);
    await closing;
    await ticking.catch(() => undefined);
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps an in-flight original owner's claim while another process reports uncertainty", async () => {
    const { runtime } = open();
    const delivery = deferred<NotificationSendOutcome>();
    send.mockImplementation(() => delivery.promise);
    const input = testInput();
    const sending = runtime.test("alice", input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const other = open();
    expect(other.runtime.status("alice", input.actionId)?.state).toBe("uncertain");
    await other.runtime.drain();
    expect(send).toHaveBeenCalledTimes(1);
    delivery.resolve("delivered");
    expect(await sending).toMatchObject({ state: "delivered" });
    expect(other.runtime.status("alice", input.actionId)?.state).toBe("delivered");
  });
  it("regression: rejects a prepared generation retired during the preparation await", async () => {
    const { store, runtime } = open();
    enable(store);
    await runtime.enqueue("alice", event());
    const waiting = deferred<{
      generation: string;
      revision: number;
      transport: { send: typeof send };
    }>();
    const entered = deferred<void>();
    binding = {
      ...binding,
      prepare: () => {
        entered.resolve();
        return waiting.promise;
      },
    };
    const draining = runtime.drain();
    await entered.promise;
    binding = { ...binding, generation: "binding-v2", revision: 2 };
    waiting.resolve({ generation: "binding-v1", revision: 1, transport: { send } });
    await draining;
    expect(send).not.toHaveBeenCalled();
  });
  it("regression: rejects an older prepared revision once another process records a newer revision", async () => {
    const { store, runtime } = open();
    enable(store);
    await runtime.enqueue("alice", event());
    const waiting = deferred<{
      generation: string;
      revision: number;
      transport: { send: typeof send };
    }>();
    const entered = deferred<void>();
    binding = {
      ...binding,
      prepare: () => {
        entered.resolve();
        return waiting.promise;
      },
    };
    const draining = runtime.drain();
    await entered.promise;
    binding = { ...binding, revision: 2 };
    const other = open();
    await other.runtime.list("alice");
    waiting.resolve({ generation: "binding-v1", revision: 1, transport: { send } });
    await draining;
    expect(send).not.toHaveBeenCalled();
  });

  it("regression: a cancelled credential action cannot roll the registered revision backwards", async () => {
    registry.beginCredentialInteraction = async () => "cancelled";
    const { runtime } = open();
    binding = { ...binding, generation: "binding-v2", revision: 2 };
    await runtime.list("alice");
    binding = { ...binding, generation: "binding-v1", revision: 1 };
    expect((await runtime.list("alice"))[0]?.transportAvailable).toBe(false);
    try {
      await runtime.credentials("alice", testInput());
    } catch {}
    expect((await runtime.list("alice"))[0]?.transportAvailable).toBe(false);
  });

  it("regression: an enable during clock rollback cannot admit OFF-era backlog after recovery", async () => {
    const { store, runtime } = open();
    enable(store, false);
    const initial = now;
    now = initial + 100;
    const old = event();
    now = initial + 200;
    await runtime.list("alice");
    now = initial + 50;
    try {
      enable(store, true);
      runtime.invalidate("alice");
    } catch {}
    now = initial + 300;
    await runtime.enqueue("alice", old);
    await runtime.drain();
    expect(send).not.toHaveBeenCalled();
  });

  it("requires a synchronous authoritative binding gate even after a fresh read", async () => {
    const { store, runtime } = open();
    enable(store);
    await runtime.enqueue("alice", event());
    registry.isCurrent = () => false;
    await runtime.drain();
    expect(send).not.toHaveBeenCalled();
  });
  it("suppresses unseen old events after a binding's activation boundary", async () => {
    const { store, runtime } = open();
    enable(store);
    const old = event();
    now += 100;
    binding = {
      ...binding,
      generation: "binding-v2",
      revision: 2,
      activatedAt: new Date(now).toISOString(),
    };
    await runtime.enqueue("alice", old);
    await runtime.drain();
    expect(send).not.toHaveBeenCalled();
  });
  it("allows OFF during rollback while preserving the high-water eligibility boundary", async () => {
    const { store, runtime } = open();
    enable(store);
    const initial = now;
    now += 200;
    await runtime.list("alice");
    now = initial + 50;
    enable(store, false);
    runtime.invalidate("alice");
    expect(store.snapshot("alice").authBlocked.enabled).toBe(false);
    expect(() => enable(store, true)).toThrow("Notification settings clock moved backwards");
    now = initial + 300;
    await runtime.drain();
    expect(send).not.toHaveBeenCalled();
  });
  it("dedupes durable run identity even if the source journal identity is replaced", async () => {
    const { store, runtime } = open();
    enable(store);
    const blocked = event();
    await runtime.enqueue("alice", blocked);
    await runtime.drain();
    now += 60000;
    await runtime.enqueue("alice", { ...blocked, sourceId: randomUUID(), eventId: randomUUID() });
    await runtime.drain();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not revive queued work after a preference row is recreated at the same revision", async () => {
    const { store, runtime } = open();
    enable(store);
    await runtime.enqueue("alice", event());
    const db = new DatabaseSync(join(directory, "preferences.db"));
    db.prepare("DELETE FROM notification_preferences WHERE actor_id=?").run("alice");
    db.close();
    now += 100;
    enable(store);
    expect(store.snapshot("alice").revision).toBe(1);
    await runtime.drain();
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects another store before it can consume or suppress the durable source", async () => {
    const first = open();
    const otherStore = new NotificationPreferencesStore(
      join(directory, "other.db"),
      "production",
      () => new Date(now),
    );
    stores.push(otherStore);
    enable(otherStore);
    const other = new NotificationRuntime(otherStore, {
      registry,
      authorizeSend: () => true,
      now: () => new Date(now),
    });
    runtimes.push(other);
    const db = new DatabaseSync(join(directory, "source.db"));
    const source = new UsageLifecycleJournal(db);
    try {
      first.runtime.attachSource(source, "alice");
      expect(() => other.attachSource(source, "alice")).toThrow("usage_lifecycle_sink_conflict");
      expect(source.cursorPosition("notification-runtime-1")).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(() => first.runtime.attachSource(source, "bob")).toThrow(
        "notification_source_actor_changed",
      );
    } finally {
      await first.runtime.close();
      await other.close();
      db.close();
    }
  });
  it("resumes the same sealed store and rejects copied or replaced stores", async () => {
    const first = open();
    const id = first.runtime.targetId;
    const db = new DatabaseSync(join(directory, "source.db"));
    const source = new UsageLifecycleJournal(db);
    try {
      first.runtime.attachSource(source, "alice");
      await first.runtime.close();
      first.store.close();
      const same = open();
      expect(same.runtime.targetId).toBe(id);
      same.runtime.attachSource(source, "alice");
      await same.runtime.close();
      same.store.close();
      await copyFile(join(directory, "preferences.db"), join(directory, "copied.db"));
      const copiedStore = new NotificationPreferencesStore(
        join(directory, "copied.db"),
        "production",
        () => new Date(now),
      );
      stores.push(copiedStore);
      const copied = new NotificationRuntime(copiedStore, {
        registry,
        authorizeSend: () => true,
        now: () => new Date(now),
      });
      runtimes.push(copied);
      expect(copied.targetId).not.toBe(id);
      expect(() => copied.attachSource(source, "alice")).toThrow("usage_lifecycle_sink_conflict");
      await rm(join(directory, "preferences.db"));
      const replaced = open();
      expect(replaced.runtime.targetId).not.toBe(id);
      expect(() => replaced.runtime.attachSource(source, "alice")).toThrow(
        "usage_lifecycle_sink_conflict",
      );
      expect(source.cursorPosition("notification-runtime-1")).toBe(0);
      expect(send).not.toHaveBeenCalled();
    } finally {
      for (const runtime of runtimes) await runtime.close();
      db.close();
    }
  });
  it("refuses to adopt a consumed source cursor without an original sink seal", async () => {
    const { runtime } = open();
    const blocked = event();
    const db = new DatabaseSync(join(directory, "source.db"));
    const source = new UsageLifecycleJournal(db);
    try {
      db.exec("BEGIN IMMEDIATE");
      source.append({
        ...blocked,
        attemptedAt: null,
        requesterActorId: null,
        result: blocked.result as never,
      });
      db.exec("COMMIT");
      await source.drainLifecycle("notification-runtime-1", () => {});
      expect(() => runtime.attachSource(source, "alice")).toThrow(
        "usage_lifecycle_sink_binding_unavailable",
      );
      expect(source.cursorPosition("notification-runtime-1")).toBe(1);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
      db.close();
    }
  });
});
