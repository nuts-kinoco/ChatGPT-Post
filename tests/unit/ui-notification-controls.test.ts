/** Facade integration only, with local SQLite and fake host ports. Never contacts a provider. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationPreferencesStore } from "../../src/ui/notification-preferences.js";
import {
  type NotificationControlsView,
  NotificationRuntime,
} from "../../src/ui/notification-runtime.js";
import { UiNotificationSettings } from "../../src/ui/notification-settings.js";

const NOW = new Date("2026-10-03T08:00:00.000Z");
describe("explicit host notification controls facade", () => {
  let directory: string;
  const stores: NotificationPreferencesStore[] = [];
  const runtimes: NotificationRuntime[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "notification-controls-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const runtime of runtimes.splice(0)) await runtime.close();
    for (const store of stores.splice(0)) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  function fixture() {
    const store = new NotificationPreferencesStore(
      join(directory, `${stores.length}.db`),
      "production",
      () => NOW,
    );
    stores.push(store);
    let generation = "initial";
    const send = vi.fn(async () => "delivered" as const);
    const interact = vi.fn(async () => {
      generation = "rotated";
      return "saved" as const;
    });
    const list = vi.fn(async () => {
      const leaseGeneration = generation;
      const revision = leaseGeneration === "initial" ? 1 : 2;
      return [
        {
          destinationId: "work-email",
          channel: "email" as const,
          label: "Work email",
          generation: leaseGeneration,
          revision,
          activatedAt: "2026-10-03T00:00:00.000Z",
          credentialState: "configured" as const,
          prepare: async () => ({ generation: leaseGeneration, revision, transport: { send } }),
        },
      ];
    });
    const runtime = new NotificationRuntime(store, {
      registry: {
        list,
        isCurrent: (_actor, _id, value, revision) =>
          value === generation && revision === (generation === "initial" ? 1 : 2),
        beginCredentialInteraction: interact,
      },
      authorizeSend: () => true,
      now: () => NOW,
    });
    runtimes.push(runtime);
    const settings = new UiNotificationSettings({
      store,
      runtime,
      profile: "production",
      authenticatedActorId: "alice",
    });
    const input = () => ({
      actionId: randomUUID(),
      destinationId: "work-email",
      expectedRevision: store.snapshot("alice").revision,
    });
    return { store, runtime, settings, send, interact, list, input };
  }
  it("uses the runtime catalogue, masks status, and never sends on Save", async () => {
    const f = fixture();
    const invalidate = vi.spyOn(f.runtime, "invalidate");
    expect(await f.settings.view()).toMatchObject({
      sendingImplemented: true,
      preferences: { authBlocked: { enabled: false } },
      controls: {
        destinations: [
          { destinationId: "work-email", credentialState: "configured", masked: "••••••••" },
        ],
      },
    });
    expect(f.list).toHaveBeenCalledWith("alice", expect.any(AbortSignal));
    await f.settings.update({
      expectedRevision: 0,
      settings: { enabled: true, destinationIds: ["work-email"] },
    });
    expect(invalidate).toHaveBeenCalledWith("alice");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.interact).not.toHaveBeenCalled();
  });
  it("allows a distinct default-OFF test, dedupes it, and scopes status to the authenticated actor", async () => {
    const f = fixture(),
      input = f.input();
    expect(await f.settings.test(input)).toMatchObject({
      actionId: input.actionId,
      kind: "test",
      state: "delivered",
    });
    expect(await f.settings.test(input)).toMatchObject({ state: "delivered" });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.store.snapshot("alice")).toMatchObject({
      revision: 0,
      authBlocked: { enabled: false },
    });
    expect(f.settings.actionStatus(input.actionId)).toMatchObject({ state: "delivered" });
    const bob = new UiNotificationSettings({
      store: f.store,
      runtime: f.runtime,
      profile: "production",
      authenticatedActorId: "bob",
    });
    expect(bob.actionStatus(input.actionId)).toBeNull();
    expect(await f.settings.view()).toMatchObject({
      controls: { recent: [{ kind: "test", state: "delivered", attempts: 1 }] },
    });
  });
  it("runs native credential setup separately and dedupes repeated interaction", async () => {
    const f = fixture(),
      input = f.input();
    expect(await f.settings.credentials(input)).toMatchObject({
      actionId: input.actionId,
      kind: "credential",
      state: "saved",
    });
    expect(await f.settings.credentials(input)).toMatchObject({ state: "saved" });
    expect(f.interact).toHaveBeenCalledOnce();
    expect(f.interact).toHaveBeenCalledWith({
      actorId: "alice",
      destinationId: "work-email",
      actionId: input.actionId,
      signal: expect.any(AbortSignal),
    });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.store.snapshot("alice").authBlocked.enabled).toBe(false);
  });
  it("rejects raw secret/recipient/actor fields and stale revisions before effects", async () => {
    const f = fixture();
    for (const extra of [
      { token: "SECRET" },
      { actorId: "bob" },
      { webhookUrl: "https://secret.invalid" },
    ]) {
      await expect(f.settings.test({ ...f.input(), ...extra })).rejects.toMatchObject({
        code: "notification_action_invalid",
      });
      await expect(f.settings.credentials({ ...f.input(), ...extra })).rejects.toMatchObject({
        code: "notification_action_invalid",
      });
    }
    for (const destinationId of ["person@example.com", "https://secret.invalid", "unregistered"]) {
      await expect(f.settings.test({ ...f.input(), destinationId })).rejects.toBeInstanceOf(Error);
      await expect(f.settings.credentials({ ...f.input(), destinationId })).rejects.toBeInstanceOf(
        Error,
      );
    }
    await f.settings.update({
      expectedRevision: 0,
      settings: { enabled: false, destinationIds: [] },
    });
    await expect(f.settings.test({ ...f.input(), expectedRevision: 0 })).rejects.toMatchObject({
      code: "stale_notification_preferences",
    });
    await expect(
      f.settings.credentials({ ...f.input(), expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: "stale_notification_preferences" });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.interact).not.toHaveBeenCalled();
  });
  it("requires one store and catalogue identity and refuses unauthenticated actions", async () => {
    const f = fixture(),
      other = fixture();
    expect(
      () =>
        new UiNotificationSettings({
          store: other.store,
          runtime: f.runtime,
          profile: "production",
        }),
    ).toThrow("share the settings store");
    expect(
      () =>
        new UiNotificationSettings({
          store: f.store,
          runtime: f.runtime,
          catalogue: { list: () => [] },
          profile: "production",
        }),
    ).toThrow("share the registered destination catalogue");
    expect(
      () =>
        new UiNotificationSettings({
          store: f.store,
          runtime: f.runtime,
          catalogue: f.runtime,
          profile: "production",
        }),
    ).not.toThrow();
    const settings = new UiNotificationSettings({
      store: f.store,
      runtime: f.runtime,
      profile: "production",
    });
    await expect(settings.test(f.input())).rejects.toMatchObject({
      code: "notification_actor_unavailable",
    });
    await expect(settings.credentials(f.input())).rejects.toMatchObject({
      code: "notification_actor_unavailable",
    });
    expect(() => settings.actionStatus(randomUUID())).toThrow();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.interact).not.toHaveBeenCalled();
  });
  it("remains honestly unavailable without runtime even with a read-only catalogue", async () => {
    const f = fixture();
    const settings = new UiNotificationSettings({
      store: f.store,
      catalogue: f.runtime,
      profile: "production",
      authenticatedActorId: "alice",
    });
    expect(await settings.view()).toMatchObject({ sendingImplemented: false, controls: null });
    await expect(settings.test(f.input())).rejects.toMatchObject({
      code: "notification_controls_unconfigured",
    });
    await expect(settings.credentials(f.input())).rejects.toMatchObject({
      code: "notification_controls_unconfigured",
    });
    expect(() => settings.actionStatus(randomUUID())).toThrow("not configured");
  });
  it("bounds control reads and exposes only static errors or sanitized fixed data", async () => {
    const f = fixture();
    const settings = new UiNotificationSettings({
      store: f.store,
      runtime: f.runtime,
      profile: "production",
      authenticatedActorId: "alice",
      readTimeoutMs: 5,
    });
    const read = vi.spyOn(f.runtime, "view").mockImplementation(() => new Promise(() => {}));
    expect(await settings.view()).toMatchObject({
      controls: null,
      unavailableReason: "notification_controls_read_timeout",
    });
    read.mockRejectedValue(new Error("private-token https://private.invalid person@example.com"));
    const failed = await settings.view();
    expect(failed).toMatchObject({
      controls: null,
      unavailableReason: "notification_controls_read_failed",
    });
    expect(JSON.stringify(failed)).not.toMatch(/private-token|private.invalid|person@example.com/);
    read.mockResolvedValue({
      version: "bridge-notification-controls-1",
      credentialInteractionAvailable: true,
      destinations: [
        { destinationId: "work-email", credentialState: "configured", masked: "SECRET" },
      ],
      recent: [],
      secret: "SECRET",
    } as unknown as NotificationControlsView);
    const masked = await settings.view();
    expect(masked).toMatchObject({ controls: { destinations: [{ masked: "••••••••" }] } });
    expect(JSON.stringify(masked)).not.toContain("SECRET");
    read.mockResolvedValue({
      version: "bridge-notification-controls-1",
      credentialInteractionAvailable: true,
      destinations: [],
      recent: [
        { destinationId: "work-email", kind: "test", state: "provider-secret", attempts: 1 },
      ],
    } as unknown as NotificationControlsView);
    expect(await settings.view()).toMatchObject({
      controls: null,
      unavailableReason: "notification_controls_read_failed",
    });
  });
});
