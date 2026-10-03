/** Synthetic, in-process credential protocol. No Electron, cipher, network or real credentials. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationPreferencesStore } from "../../src/ui/notification-preferences.js";
import {
  type NotificationBinding,
  type NotificationCredentialSessionV2,
  NotificationRuntime,
  type SecureNotificationRegistry,
} from "../../src/ui/notification-runtime.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
describe("v2 durable credential admission and completion", () => {
  let dir: string;
  let now: number;
  let monotonic: number;
  let store: NotificationPreferencesStore;
  let runtime: NotificationRuntime;
  let registry: SecureNotificationRegistry;
  let binding: NotificationBinding;
  let session: NotificationCredentialSessionV2 | undefined;
  let candidate: object;
  let begin: ReturnType<typeof vi.fn>;
  let install: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "credential-v2-"));
    now = Date.parse("2026-10-03T08:00:00.000Z");
    monotonic = 0;
    store = new NotificationPreferencesStore(
      join(dir, "prefs.db"),
      "production",
      () => new Date(now),
    );
    candidate = Object.freeze({});
    binding = {
      destinationId: "discord",
      channel: "discord",
      label: "Private Discord",
      generation: "generation-1",
      revision: 1,
      activatedAt: new Date(now).toISOString(),
      credentialState: "missing",
      prepare: async () => null,
    };
    begin = vi.fn((value: NotificationCredentialSessionV2) => {
      session = value;
    });
    install = vi.fn();
    registry = {
      credentialProtocol: "bridge-notification-credentials-2",
      list: async () => [binding],
      isCurrent: (_actor, id, generation, revision) =>
        id === binding.destinationId &&
        generation === binding.generation &&
        revision === binding.revision,
      admitCredentialInteraction: vi.fn(),
      beginCredentialInteractionV2: begin,
      installCredentialCandidate: install,
      cancelCredentialInteraction: vi.fn(),
      commitCredentialCandidate: vi.fn((value, db) => {
        if (value !== candidate) throw new Error("opaque_candidate_invalid");
        db.exec("CREATE TABLE IF NOT EXISTS fake_ciphertext(value TEXT)");
        db.prepare("INSERT INTO fake_ciphertext VALUES(?)").run("FAKE_OPAQUE_BYTES");
        return {
          generation: "generation-2",
          revision: 2,
          activatedAt: new Date(now).toISOString(),
        };
      }),
    };
    runtime = new NotificationRuntime(store, {
      registry,
      authorizeSend: () => true,
      timeoutMs: 10,
      now: () => new Date(now),
      monotonicNow: () => monotonic,
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await runtime.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const input = (destinationId = "discord") => ({
    actionId: randomUUID(),
    destinationId,
    expectedRevision: 0,
  });
  async function admit() {
    const value = input();
    expect((await runtime.credentials("alice", value)).state).toBe("sending");
    runtime.activateCredentialInteraction("alice", value.actionId);
    await turn();
    expect(session).toBeDefined();
    return value;
  }

  it("admits promptly with zero dialogs, exact dedupe and one later activation", async () => {
    const value = input();
    const [first, replay] = await Promise.all([
      runtime.credentials("alice", value),
      runtime.credentials("alice", value),
    ]);
    expect(first).toEqual(replay);
    expect(first.state).toBe("sending");
    expect(begin).not.toHaveBeenCalled();
    expect(registry.admitCredentialInteraction).toHaveBeenCalledOnce();
    const activate = runtime.takeCredentialActivation("alice", value.actionId);
    expect(activate).toBeTypeOf("function");
    expect(runtime.takeCredentialActivation("alice", value.actionId)).toBeNull();
    activate?.();
    expect(begin).not.toHaveBeenCalled();
    await turn();
    expect(begin).toHaveBeenCalledOnce();
    runtime.activateCredentialInteraction("alice", value.actionId);
    await turn();
    expect(begin).toHaveBeenCalledOnce();
    await expect(
      runtime.credentials("alice", { ...value, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "notification_action_conflict" });
  });
  it.each([undefined, "bridge-notification-credentials-1", "bridge-notification-credentials-3"])(
    "never invokes legacy or unsupported protocol %s",
    async (protocol) => {
      Object.assign(registry, {
        credentialProtocol: protocol,
        beginCredentialInteraction: vi.fn(async () => "saved"),
      });
      expect((await runtime.view("alice")).credentialInteractionAvailable).toBe(false);
      await expect(runtime.credentials("alice", input())).rejects.toMatchObject({
        code: "notification_secure_provider_unavailable",
      });
      expect(begin).not.toHaveBeenCalled();
      expect(registry.beginCredentialInteraction).not.toHaveBeenCalled();
      expect(
        store.withRuntimeRead(
          (db) => db.prepare("SELECT COUNT(*) n FROM notification_actions").get()?.n,
        ),
      ).toBe(0);
    },
  );
  it.each([undefined, "bridge-notification-credentials-1", "bridge-notification-credentials-3"])(
    "unsupported credential protocol %s preserves unrelated prebound sends",
    async (protocol) => {
      const legacy = vi.fn(async () => "saved" as const);
      Object.assign(registry, { credentialProtocol: protocol, beginCredentialInteraction: legacy });
      const send = vi.fn(async () => "delivered" as const);
      binding = {
        ...binding,
        credentialState: "configured",
        prepare: async () => ({
          generation: binding.generation,
          revision: binding.revision,
          transport: { send },
        }),
      };
      await runtime.close();
      runtime = new NotificationRuntime(store, {
        registry,
        authorizeSend: () => true,
        timeoutMs: 1000,
        now: () => new Date(now),
      });
      await expect(runtime.credentials("alice", input())).rejects.toMatchObject({
        code: "notification_secure_provider_unavailable",
      });
      expect((await runtime.test("alice", input())).state).toBe("delivered");
      expect(send).toHaveBeenCalledOnce();
      expect(legacy).not.toHaveBeenCalled();
      expect(begin).not.toHaveBeenCalled();
    },
  );
  it("requires the v2 method as well as the discriminator", async () => {
    delete registry.beginCredentialInteractionV2;
    await expect(runtime.credentials("alice", input())).rejects.toMatchObject({
      code: "notification_secure_provider_unavailable",
    });
    expect((await runtime.view("alice")).credentialInteractionAvailable).toBe(false);
  });
  it("persists provider data, action, binding and receipt in one transaction before install", async () => {
    const value = await admit();
    install.mockImplementation(() => {
      expect(runtime.status("alice", value.actionId)?.state).toBe("saved");
      expect(
        store.withRuntimeRead((db) =>
          db.prepare("SELECT generation,revision,state FROM notification_bindings").get(),
        ),
      ).toMatchObject({ generation: "generation-2", revision: 2, state: "ready" });
    });
    expect(session?.complete("saved", candidate).state).toBe("saved");
    expect(install).toHaveBeenCalledOnce();
    expect(store.snapshot("alice").authBlocked.enabled).toBe(false);
    expect(runtime.credentialActions("alice")).toEqual([runtime.status("alice", value.actionId)]);
    expect(session?.complete("saved", candidate).state).toBe("saved");
    expect(registry.commitCredentialCandidate).toHaveBeenCalledOnce();
  });
  it("rolls provider writes back when candidate validation fails and never retries commit", async () => {
    await admit();
    registry.commitCredentialCandidate = vi.fn((_value, db) => {
      db.exec("CREATE TABLE temporary_partial(value TEXT)");
      throw new Error("INJECTED_FAULT_WITH_SYNTHETIC_SECRET");
    });
    const outcome = session?.complete("saved", candidate);
    expect(outcome?.state).toBe("uncertain");
    expect(JSON.stringify(outcome)).not.toContain("SYNTHETIC_SECRET");
    expect(
      store.withRuntimeRead((db) =>
        db.prepare("SELECT name FROM sqlite_master WHERE name='temporary_partial'").get(),
      ),
    ).toBeUndefined();
    expect(install).not.toHaveBeenCalled();
    expect(registry.commitCredentialCandidate).toHaveBeenCalledOnce();
  });
  it("bounds one native session across actors and slots and keeps cancellation actor-scoped", async () => {
    const value = await admit();
    await expect(runtime.credentials("bob", input())).rejects.toMatchObject({
      code: "notification_credential_interaction_pending",
    });
    expect(runtime.cancelCredentials("bob", { actionId: value.actionId })).toBeNull();
    expect(runtime.cancelCredentials("alice", { actionId: value.actionId })?.state).toBe(
      "cancelled",
    );
    expect(session?.signal.aborted).toBe(true);
    expect(session?.complete("saved", candidate).state).toBe("cancelled");
    expect(install).not.toHaveBeenCalled();
    expect(registry.commitCredentialCandidate).not.toHaveBeenCalled();
  });
  it("survives 5- and 15-second client budgets and expires at the independent ten-minute fence", async () => {
    const value = await admit();
    now += 16_000;
    monotonic += 16_000;
    expect(session?.isActive()).toBe(true);
    expect(runtime.status("alice", value.actionId)?.state).toBe("sending");
    now += 584_000;
    monotonic += 584_000;
    expect(session?.isActive()).toBe(false);
    expect(session?.complete("saved", candidate).state).toBe("cancelled");
    expect(registry.commitCredentialCandidate).not.toHaveBeenCalled();
  });
  it("has a real independent expiry timer even when the native adapter never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const value = await admit();
    await vi.advanceTimersByTimeAsync(599_999);
    expect(runtime.status("alice", value.actionId)?.state).toBe("sending");
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.status("alice", value.actionId)?.state).toBe("cancelled");
    expect(session?.signal.aborted).toBe(true);
  });
  it("locks a session before native activation and makes late completion inert", async () => {
    const value = input();
    await runtime.credentials("alice", value);
    runtime.activateCredentialInteraction("alice", value.actionId);
    runtime.lockCredentials();
    await turn();
    expect(begin).not.toHaveBeenCalled();
    expect(runtime.status("alice", value.actionId)?.state).toBe("cancelled");
  });
  it("fences preference changes and both wall and monotonic regressions", async () => {
    await admit();
    store.update("alice", 0, { enabled: false, destinationIds: [] });
    expect(session?.isActive()).toBe(false);
    expect(session?.complete("saved", candidate).state).toBe("cancelled");
    expect(registry.commitCredentialCandidate).not.toHaveBeenCalled();
  });
  it("restart settles pending legacy and current sessions uncertain without opening a dialog", async () => {
    const value = await admit();
    // A second runtime models a new owner. Its constructor never calls a native port.
    const restarted = new NotificationRuntime(store, {
      registry,
      authorizeSend: () => false,
      now: () => new Date(now),
    });
    expect(restarted.status("alice", value.actionId)?.state).toBe("uncertain");
    expect((await restarted.credentials("alice", value)).state).toBe("uncertain");
    expect(begin).toHaveBeenCalledOnce();
    expect(session?.complete("saved", candidate).state).toBe("uncertain");
    expect(install).not.toHaveBeenCalled();
    await restarted.close();
  });
  it("rejects malformed saved receipts and returns at most sixteen terminals plus one pending", async () => {
    const first = await admit();
    session?.complete("saved", candidate);
    store.withRuntimeTransaction((db) =>
      db
        .prepare("UPDATE notification_credential_sessions SET new_revision=0 WHERE action_id=?")
        .run(first.actionId),
    );
    expect(runtime.status("alice", first.actionId)?.state).toBe("uncertain");
    expect((await runtime.credentials("alice", first)).state).toBe("uncertain");
    // Additional receipts need no native or secret operation.
    binding = { ...binding, generation: "generation-2", revision: 2 };
    for (let i = 0; i < 18; i++) {
      const value = input();
      await runtime.credentials("alice", value);
      runtime.cancelCredentials("alice", { actionId: value.actionId });
    }
    await runtime.credentials("alice", input());
    const views = runtime.credentialActions("alice");
    expect(views).toHaveLength(17);
    expect(views[0]?.state).toBe("sending");
    expect(runtime.credentialActions("bob")).toEqual([]);
  });
  it.each([
    "owner",
    "attempt",
    "content",
    "content_hash",
    "actor",
    "destination",
    "generation",
    "binding_revision",
    "preference_revision",
    "preference_digest",
    "action_id",
    "state",
    "preference",
    "registration",
    "registry",
    "authorization",
    "deadline",
  ])("checks %s after the last asynchronous inner preparation", async (mutation) => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let guardReady = false;
    const effect = vi.fn();
    binding = {
      ...binding,
      credentialState: "configured",
      prepare: async () => ({
        generation: binding.generation,
        revision: binding.revision,
        transport: {
          send: async (_text, _signal, guard) => {
            guardReady = true;
            await wait;
            if (guard?.()) {
              effect();
              return "delivered";
            }
            return "not_sent";
          },
        },
      }),
    };
    await runtime.close();
    let authorized = true;
    runtime = new NotificationRuntime(store, {
      registry,
      authorizeSend: () => authorized,
      timeoutMs: 1000,
      now: () => new Date(now),
    });
    const sending = runtime.test("alice", input());
    await vi.waitFor(() => expect(guardReady).toBe(true), { interval: 1 });
    expect(
      store.withRuntimeRead(
        (db) => db.prepare("SELECT state FROM notification_outbox").get()?.state,
      ),
    ).toBe("sending");
    const updates: Record<string, string> = {
      owner: "owner='foreign-owner'",
      attempt: "attempts=attempts+1",
      content: "content='{}'",
      content_hash: "content_hash='bad'",
      actor: "actor='bob'",
      destination: "destination='other'",
      generation: "generation='other'",
      binding_revision: "binding_revision=binding_revision+1",
      preference_revision: "preference_revision=preference_revision+1",
      preference_digest: "preference_digest='bad'",
      action_id: "action_id=NULL",
      state: "state='cancelled'",
    };
    if (updates[mutation])
      store.withRuntimeTransaction((db) =>
        db.exec(`UPDATE notification_outbox SET ${updates[mutation]}`),
      );
    else if (mutation === "preference")
      store.update("alice", 0, { enabled: false, destinationIds: [] });
    else if (mutation === "registration")
      store.withRuntimeTransaction((db) =>
        db.exec("UPDATE notification_bindings SET state='unavailable'"),
      );
    else if (mutation === "registry") registry.isCurrent = () => false;
    else if (mutation === "authorization") authorized = false;
    else if (mutation === "deadline") await new Promise((resolve) => setTimeout(resolve, 1005));
    release();
    await sending;
    expect(effect).not.toHaveBeenCalled();
  });
  it.each([
    "owner='foreign-owner'",
    "binding_revision='invalid'",
    "preference_revision=-1",
    "preference_digest='invalid'",
    "deadline_at=deadline_at+1",
    "admitted_at='invalid'",
  ])("rejects a malformed saved receipt tuple %s", async (mutation) => {
    const value = await admit();
    session?.complete("saved", candidate);
    store.withRuntimeTransaction((db) =>
      db.exec(`UPDATE notification_credential_sessions SET ${mutation}`),
    );
    expect(runtime.status("alice", value.actionId)?.state).toBe("uncertain");
    expect((await runtime.credentials("alice", value)).state).toBe("uncertain");
  });
  it("Lock observed after commit fences the pending installer without undoing a saved receipt", async () => {
    const value = await admit();
    const original = store.withRuntimeTransaction.bind(store);
    let locked = false;
    vi.spyOn(store, "withRuntimeTransaction").mockImplementation((operation) => {
      const result = original(operation);
      if (!locked) {
        locked = true;
        runtime.lockCredentials();
      }
      return result;
    });
    expect(session?.complete("saved", candidate).state).toBe("saved");
    expect(runtime.status("alice", value.actionId)?.state).toBe("saved");
    expect(install).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
