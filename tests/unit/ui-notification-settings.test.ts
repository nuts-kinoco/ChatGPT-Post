import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NotificationPreferencesStore,
  openNotificationPreferencesStore,
  validateNotificationPreferences,
} from "../../src/ui/notification-preferences.js";
import {
  type RegisteredNotificationDestination,
  UiNotificationSettings,
} from "../../src/ui/notification-settings.js";

const NOW = "2026-10-03T08:00:00.000Z";
const EMAIL: RegisteredNotificationDestination = {
  destinationId: "work-email",
  channel: "email",
  label: "Work email",
  transportAvailable: true,
  unavailableReason: null,
};
const DISCORD: RegisteredNotificationDestination = {
  destinationId: "private-discord",
  channel: "discord",
  label: "Private Discord",
  transportAvailable: false,
  unavailableReason: "discord_transport_unconfigured",
};
describe("bounded per-actor auth-block notification preferences", () => {
  let directory: string;
  const stores: NotificationPreferencesStore[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bridge-notification-settings-"));
  });
  afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  function open(profile: "production" | "demo" = "production", name = "preferences.db") {
    const store = new NotificationPreferencesStore(
      join(directory, name),
      profile,
      () => new Date(NOW),
    );
    stores.push(store);
    return store;
  }
  function service(
    store = open(),
    actor = "alice",
    values: readonly RegisteredNotificationDestination[] = [EMAIL, DISCORD],
  ) {
    return new UiNotificationSettings({
      store,
      authenticatedActorId: actor,
      profile: store.profile,
      catalogue: { list: () => values },
    });
  }
  it("defaults every actor OFF without creating rows or sending anything", async () => {
    const store = open();
    expect(store.snapshot("alice")).toMatchObject({
      revision: 0,
      updatedAt: null,
      authBlocked: { enabled: false, destinationIds: [] },
    });
    expect(store.snapshot("bob").authBlocked.enabled).toBe(false);
    const view = await service(store).view();
    expect(view).toMatchObject({
      state: "available",
      sendingImplemented: false,
      preferences: { actorId: "alice", revision: 0 },
      canEnable: true,
    });
    const db = new DatabaseSync(join(directory, "preferences.db"));
    expect(db.prepare("SELECT COUNT(*) AS count FROM notification_preferences").get()?.count).toBe(
      0,
    );
    db.close();
  });
  it("keys preferences by trusted actor and rejects request-body identity or raw recipients", async () => {
    const store = open(),
      alice = service(store, "alice"),
      bob = service(store, "bob");
    await alice.update({
      expectedRevision: 0,
      settings: { enabled: true, destinationIds: [EMAIL.destinationId] },
    });
    expect(await bob.view()).toMatchObject({
      preferences: { actorId: "bob", revision: 0, authBlocked: { enabled: false } },
    });
    for (const input of [
      {
        expectedRevision: 0,
        actorId: "alice",
        settings: { enabled: true, destinationIds: [EMAIL.destinationId] },
      },
      { expectedRevision: 0, settings: { enabled: true, destinationIds: ["person@example.com"] } },
      {
        expectedRevision: 0,
        settings: { enabled: true, destinationIds: ["https://discord.com/api/webhooks/secret"] },
      },
      {
        expectedRevision: 0,
        settings: { enabled: true, destinationIds: [EMAIL.destinationId], token: "secret" },
      },
    ])
      await expect(bob.update(input)).rejects.toBeInstanceOf(Error);
    expect(store.snapshot("bob").revision).toBe(0);
  });
  it("requires exact actor-authorized catalogue entries and reports missing transport specifically", async () => {
    const store = open(),
      api = service(store);
    await expect(
      api.update({
        expectedRevision: 0,
        settings: { enabled: true, destinationIds: ["unknown-email"] },
      }),
    ).rejects.toMatchObject({ code: "notification_destination_not_registered" });
    await expect(
      api.update({
        expectedRevision: 0,
        settings: { enabled: true, destinationIds: [DISCORD.destinationId] },
      }),
    ).rejects.toMatchObject({
      code: "notification_transport_unavailable",
      message: "discord_transport_unconfigured",
    });
    const list = vi.fn(() => [EMAIL]);
    await new UiNotificationSettings({
      store,
      profile: "production",
      authenticatedActorId: "bob",
      catalogue: { list },
    }).view();
    expect(list).toHaveBeenCalledWith("bob");
    expect(await service(store, "alice", [DISCORD]).view()).toMatchObject({
      canEnable: false,
      unavailableReason: "discord_transport_unconfigured",
    });
  });
  it("uses SQLite CAS and leaves another actor independent", async () => {
    const store = open(),
      api = service(store);
    const input = {
      expectedRevision: 0,
      settings: { enabled: true, destinationIds: [EMAIL.destinationId] },
    };
    const settled = await Promise.allSettled([api.update(input), api.update(input)]);
    expect(settled.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(store.snapshot("alice").revision).toBe(1);
    await service(store, "bob").update(input);
    expect(store.snapshot("bob").revision).toBe(1);
  });
  it("fails closed for missing store/actor/catalogue, while allowing OFF after catalogue loss", async () => {
    expect(await new UiNotificationSettings({ profile: "production" }).view()).toMatchObject({
      state: "unavailable",
      reason: "notification_preferences_store_unconfigured",
    });
    const store = open();
    expect(await new UiNotificationSettings({ store, profile: "production" }).view()).toMatchObject(
      { state: "unavailable", reason: "notification_actor_unavailable" },
    );
    await service(store).update({
      expectedRevision: 0,
      settings: { enabled: true, destinationIds: [EMAIL.destinationId] },
    });
    const noCatalogue = new UiNotificationSettings({
      store,
      profile: "production",
      authenticatedActorId: "alice",
    });
    expect(await noCatalogue.view()).toMatchObject({
      canEnable: false,
      unavailableReason: "notification_destination_catalogue_unconfigured",
    });
    await expect(
      noCatalogue.update({
        expectedRevision: 1,
        settings: { enabled: true, destinationIds: [EMAIL.destinationId] },
      }),
    ).rejects.toMatchObject({ code: "notification_catalogue_unavailable" });
    const saved = await noCatalogue.update({
      expectedRevision: 1,
      settings: { enabled: false, destinationIds: [EMAIL.destinationId] },
    });
    expect(saved).toMatchObject({ preferences: { revision: 2, authBlocked: { enabled: false } } });
  });
  it("bounds failed/stalled catalogues and never leaks their raw exception or secret fields", async () => {
    const store = open();
    const stalled = new UiNotificationSettings({
      store,
      profile: "production",
      authenticatedActorId: "alice",
      readTimeoutMs: 10,
      catalogue: { list: () => new Promise(() => {}) },
    });
    expect(await stalled.view()).toMatchObject({
      canEnable: false,
      destinations: { state: "timeout", reason: "notification_catalogue_read_timeout" },
    });
    const failed = new UiNotificationSettings({
      store,
      profile: "production",
      authenticatedActorId: "alice",
      catalogue: {
        list: () => {
          throw new Error("/private/webhook/secret");
        },
      },
    });
    expect(JSON.stringify(await failed.view())).not.toContain("/private");
    const extra = { ...EMAIL, webhookUrl: "https://secret.invalid" };
    expect(await service(store, "alice", [extra]).view()).toMatchObject({
      destinations: { state: "error" },
      canEnable: false,
    });
    expect(
      await service(store, "alice", [{ ...EMAIL, label: "https://secret.invalid" }]).view(),
    ).toMatchObject({ destinations: { state: "error" } });
  });
  it("does not silently reroute existing saved recipients after catalogue changes", async () => {
    const store = open();
    await service(store).update({
      expectedRevision: 0,
      settings: { enabled: true, destinationIds: [EMAIL.destinationId] },
    });
    const view = await service(store, "alice", [
      { ...EMAIL, destinationId: "another-email" },
    ]).view();
    expect(view).toMatchObject({
      preferences: { authBlocked: { enabled: true, destinationIds: [EMAIL.destinationId] } },
      unavailableReason: "notification_destination_no_longer_registered",
    });
  });
  it("limits users, selection size and revisions without evicting or resetting saved data", () => {
    const store = open();
    for (let i = 0; i < 256; i++)
      store.update(`actor-${i}`, 0, { enabled: false, destinationIds: [] });
    expect(() => store.update("overflow", 0, { enabled: false, destinationIds: [] })).toThrow(
      "capacity",
    );
    expect(store.update("actor-0", 1, { enabled: false, destinationIds: [] }).revision).toBe(2);
    for (const bad of [
      { enabled: true, destinationIds: [] },
      { enabled: false, destinationIds: Array.from({ length: 9 }, (_, i) => `id-${i}`) },
      { enabled: true, destinationIds: ["same", "same"] },
    ])
      expect(() => validateNotificationPreferences(bad)).toThrow();
    expect(() => store.update("actor-0", 10000, { enabled: false, destinationIds: [] })).toThrow(
      "revision",
    );
  });
  it("preserves profile separation and persists across explicit open/close lifecycle", async () => {
    const store = await openNotificationPreferencesStore({
      stateDir: directory,
      profile: "production",
    });
    store.update("alice", 0, { enabled: false, destinationIds: [] });
    store.close();
    store.close();
    const restarted = await openNotificationPreferencesStore({
      stateDir: directory,
      profile: "production",
    });
    stores.push(restarted);
    expect(restarted.snapshot("alice").revision).toBe(1);
    const demo = await openNotificationPreferencesStore({ stateDir: directory, profile: "demo" });
    stores.push(demo);
    expect(demo.snapshot("alice").revision).toBe(0);
    expect(
      () =>
        new UiNotificationSettings({
          store: demo,
          profile: "production",
          authenticatedActorId: "alice",
        }),
    ).toThrow("match");
    const other = open();
    expect(() => open("demo")).toThrow("separate stores");
    expect(other.snapshot("alice").revision).toBe(0);
  });
  it("fails closed on stored-row/hash corruption instead of restoring defaults", async () => {
    const store = open();
    store.update("alice", 0, { enabled: true, destinationIds: [EMAIL.destinationId] });
    const db = new DatabaseSync(join(directory, "preferences.db"));
    const row = db
      .prepare("SELECT body FROM notification_preferences WHERE actor_id='alice'")
      .get() as { body: string };
    const changed = JSON.parse(row.body);
    changed.authBlocked.destinationIds = ["redirected"];
    db.prepare("UPDATE notification_preferences SET body=? WHERE actor_id='alice'").run(
      JSON.stringify(changed),
    );
    db.close();
    expect(await service(store).view()).toMatchObject({
      state: "unavailable",
      reason: "notification_preferences_unavailable",
    });
    expect(() => store.snapshot("alice")).toThrow("cannot be verified");
    expect(() => store.update("alice", 1, { enabled: false, destinationIds: [] })).toThrow(
      "cannot be verified",
    );
  });
  it("preserves a static native storage blocker without affecting unrelated UI services", async () => {
    const settings = new UiNotificationSettings({
      profile: "production",
      storageUnavailableReason: "notification_storage_verifier_unavailable",
    });
    expect(await settings.view()).toMatchObject({
      state: "unavailable",
      reason: "notification_storage_verifier_unavailable",
      sendingImplemented: false,
      configurable: false,
    });
  });
});
