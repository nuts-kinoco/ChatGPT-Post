import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  NotificationPreferencesStore,
  openNotificationPreferencesStore,
} from "../../src/ui/notification-preferences.js";
import { NotificationRuntime } from "../../src/ui/notification-runtime.js";
import {
  createNotificationProviderHost,
  NativeNotificationRegistry,
  type NotificationNativePorts,
  type NotificationProviderConfiguration,
} from "../../src/ui/notification-secret-provider.js";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("fixture_value_missing");
  return value;
}
const SECRET = "https://discord.com/api/webhooks/123456/SYNTHETIC_TOKEN_ONLY";
const actor = "owner",
  destination = "discord-personal";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(configuration?: NotificationProviderConfiguration) {
  const directory = await mkdtemp(join(tmpdir(), "bridge-secret-fake-"));
  const store = await openNotificationPreferencesStore({
    stateDir: directory,
    profile: "production",
  });
  const opaque = new Map<string, string>();
  let seals = 0,
    opens = 0,
    windows = 0,
    closes = 0;
  let dialog: Parameters<NotificationNativePorts["dialog"]["open"]>[0] | undefined;
  let now = Date.now(),
    mono = 100;
  const native: NotificationNativePorts = {
    cipher: {
      seal(value) {
        seals++;
        const key = `opaque-fake-${seals}`;
        opaque.set(key, value);
        return Buffer.from(key);
      },
      open(value) {
        opens++;
        const result = opaque.get(Buffer.from(value).toString());
        if (!result) throw new Error("fake_unavailable");
        return result;
      },
    },
    dialog: {
      open(value) {
        windows++;
        dialog = value;
        return {
          close() {
            closes++;
          },
        };
      },
    },
  };
  const registry = new NativeNotificationRegistry({
    preferences: store,
    actorId: actor,
    native,
    ...(configuration ? { configuration } : {}),
    now: () => new Date(now),
    monotonic: () => mono,
  });
  const runtime = new NotificationRuntime(store, {
    registry,
    authorizeSend: (a, d, k) => registry.authorizeSend(a, d, k),
    now: () => new Date(now),
    monotonicNow: () => mono,
  });
  cleanups.push(async () => {
    await runtime.close();
    registry.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const start = async () => {
    const actionId = randomUUID();
    const result = await runtime.credentials(actor, {
      actionId,
      destinationId: destination,
      expectedRevision: store.snapshot(actor).revision,
    });
    expect(result.state).toBe("sending");
    runtime.activateCredentialInteraction(actor, actionId);
    await turn();
    return actionId;
  };
  return {
    directory,
    store,
    registry,
    runtime,
    native,
    opaque,
    start,
    dialog: () => required(dialog),
    counts: () => ({ seals, opens, windows, closes }),
    advance: (ms: number) => {
      now += ms;
      mono += ms;
    },
    register: async () => {
      const id = await start();
      required(dialog).submit({ mode: "register", secret: SECRET, consent: true });
      return id;
    },
  };
}
describe("concrete fake notification credential provider", () => {
  it("verified opener only, ownership is exclusive, startup and background metadata call no native methods", async () => {
    const f = await fixture();
    expect((await f.runtime.list(actor))[0]?.transportAvailable).toBe(false);
    expect((await f.registry.list(actor, new AbortController().signal))[0]?.credentialState).toBe(
      "missing",
    );
    expect(f.counts()).toEqual({ seals: 0, opens: 0, windows: 0, closes: 0 });
    expect(
      () =>
        new NativeNotificationRegistry({ preferences: f.store, actorId: actor, native: f.native }),
    ).toThrow("notification_provider_already_owned");
    const memory = new NotificationPreferencesStore(":memory:", "production");
    expect(
      () =>
        new NativeNotificationRegistry({ preferences: memory, actorId: actor, native: f.native }),
    ).toThrow("notification_storage_verifier_unavailable");
    memory.close();
    const lock = new DatabaseSync(
      join(f.directory, "notification-preferences", "production", "notification-provider-owner.db"),
    );
    lock.exec("PRAGMA busy_timeout=0");
    expect(() => lock.exec("BEGIN EXCLUSIVE")).toThrow();
    lock.close();
  });
  it("first registration atomically stores opaque ciphertext/receipt, stays OFF and does not send", async () => {
    const f = await fixture();
    const id = await f.register();
    expect(f.runtime.status(actor, id)?.state).toBe("saved");
    expect((await f.registry.list(actor, new AbortController().signal))[0]?.credentialState).toBe(
      "configured",
    );
    expect(f.store.snapshot(actor).authBlocked).toEqual({ enabled: false, destinationIds: [] });
    expect(f.counts()).toEqual({ seals: 1, opens: 0, windows: 1, closes: 1 });
    expect(f.runtime.credentialActions(actor)[0]?.state).toBe("saved");
    const dbdir = join(f.directory, "notification-preferences", "production");
    for (const file of await readdir(dbdir))
      expect((await readFile(join(dbdir, file))).includes(Buffer.from(SECRET))).toBe(false);
    expect(JSON.stringify(await f.runtime.view(actor))).not.toContain("SYNTHETIC_TOKEN_ONLY");
    expect(await f.registry.list("other", new AbortController().signal)).toEqual([]);
  });
  it("registration consent, target matching and same-target generation CAS are enforced", async () => {
    const f = await fixture();
    let id = await f.start();
    f.dialog().submit({ mode: "register", secret: SECRET, consent: false });
    expect(f.runtime.status(actor, id)?.state).toBe("rejected");
    expect(f.counts().seals).toBe(0);
    await f.register();
    const before = required(f.registry.store.get(actor, destination));
    id = await f.start();
    f.dialog().submit({ mode: "replace", secret: SECRET.replace("123456", "999999") });
    expect(f.runtime.status(actor, id)?.state).toBe("rejected");
    expect(f.registry.store.get(actor, destination)).toEqual(before);
    id = await f.start();
    f.dialog().submit({
      mode: "replace",
      secret: SECRET.replace("SYNTHETIC_TOKEN_ONLY", "OTHER_FAKE_TOKEN"),
    });
    const after = required(f.registry.store.get(actor, destination));
    expect(f.runtime.status(actor, id)?.state).toBe("saved");
    expect(after.generation).not.toBe(before.generation);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.target).toBe(before.target);
    expect(after.consent).toBe(before.consent);
  });
  it("unlock re-seals under a fresh generation; host lifetime mutation cannot extend an existing lease", async () => {
    const config = { leaseLifetimeMs: 60000 };
    const f = await fixture(config);
    await f.register();
    const before = required(f.registry.store.get(actor, destination));
    config.leaseLifetimeMs = 24 * 3600000;
    f.advance(60001);
    expect((await f.registry.list(actor, new AbortController().signal))[0]?.credentialState).toBe(
      "locked",
    );
    const id = await f.start();
    expect(f.dialog().view.leaseLifetimeMs).toBe(60000);
    f.dialog().submit({ mode: "unlock" });
    expect(f.runtime.status(actor, id)?.state).toBe("saved");
    expect(f.counts().opens).toBe(1);
    expect(required(f.registry.store.get(actor, destination)).revision).toBe(before.revision + 1);
  });
  it("admission immediately revokes old outer handles; Lock cannot be undone by native return", async () => {
    const f = await fixture();
    await f.register();
    const binding = required((await f.registry.list(actor, new AbortController().signal))[0]);
    const prepared = await binding.prepare(new AbortController().signal);
    expect(prepared).not.toBeNull();
    const id = await f.start();
    expect(
      await required(prepared).transport.send(
        "Bridge notification test. No task content is included.",
        new AbortController().signal,
        () => true,
      ),
    ).toBe("not_sent");
    f.native.cipher.seal = () => {
      f.registry.lock();
      f.runtime.lockCredentials();
      return Buffer.from("opaque-late");
    };
    f.dialog().submit({ mode: "replace", secret: SECRET });
    expect(f.runtime.status(actor, id)?.state).toBe("cancelled");
    expect((await f.registry.list(actor, new AbortController().signal))[0]?.credentialState).toBe(
      "locked",
    );
  });
  it("cipher errors never echo synthetic secrets, accessor errors are never read", async () => {
    const f = await fixture();
    let getterReads = 0;
    f.native.cipher.seal = () => {
      throw {
        get code() {
          getterReads++;
          return SECRET;
        },
        get message() {
          getterReads++;
          return SECRET;
        },
      };
    };
    const id = await f.register();
    expect(f.runtime.status(actor, id)?.state).toBe("rejected");
    expect(getterReads).toBe(0);
    expect(
      JSON.stringify({
        view: await f.runtime.view(actor),
        status: f.runtime.status(actor, id),
        recent: f.runtime.credentialActions(actor),
      }),
    ).not.toContain(SECRET);
  });
  it.each([
    "actor",
    "profile",
    "scope",
    "store",
    "destination",
    "registration",
    "generation",
    "revision",
    "target",
    "consent",
    "consentVersion",
    "channel",
  ])(
    "substituted inner %s identity cannot unlock or replace the committed record",
    async (field) => {
      const f = await fixture();
      await f.register();
      f.registry.lock();
      f.runtime.lockCredentials();
      const key = required([...f.opaque.keys()][0]);
      const value = JSON.parse(required(f.opaque.get(key)));
      value[field] = field === "revision" ? 900 : "other";
      f.opaque.set(key, JSON.stringify(value));
      const before = f.registry.store.get(actor, destination);
      const id = await f.start();
      f.dialog().submit({ mode: "unlock" });
      expect(f.runtime.status(actor, id)?.state).toBe("rejected");
      expect(f.registry.store.get(actor, destination)).toEqual(before);
    },
  );
  it("SQLite write fault rolls back generation/ciphertext/action success as one transaction", async () => {
    const f = await fixture();
    const before = f.registry.store.get(actor, destination);
    f.store.withRuntimeTransaction((db) =>
      db.exec(
        "CREATE TRIGGER fake_write_failure BEFORE INSERT ON notification_secret_records BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END;",
      ),
    );
    const id = await f.register();
    expect(f.runtime.status(actor, id)?.state).toBe("uncertain");
    expect(f.registry.store.get(actor, destination)).toEqual(before);
    expect(
      f.store.withRuntimeRead(
        (db) => db.prepare("SELECT count(*) n FROM notification_secret_records").get()?.n,
      ),
    ).toBe(0);
  });
  it("human wait exceeds old deadlines, but late native completion after human expiry cannot commit", async () => {
    const f = await fixture();
    const id = await f.start();
    f.advance(16000);
    expect(f.runtime.status(actor, id)?.state).toBe("sending");
    f.native.cipher.seal = () => {
      f.advance(10 * 60000);
      return Buffer.from("opaque-late");
    };
    f.dialog().submit({ mode: "register", secret: SECRET, consent: true });
    expect(f.registry.store.get(actor, destination)?.target).toBeNull();
    expect(f.runtime.status(actor, id)?.state).not.toBe("saved");
  });
  it("restart keeps encrypted records/receipts but never automatically decrypts or opens a dialog", async () => {
    const f = await fixture();
    const id = await f.register();
    await f.runtime.close();
    f.registry.close();
    const next = new NativeNotificationRegistry({
      preferences: f.store,
      actorId: actor,
      native: f.native,
    });
    const runtime = new NotificationRuntime(f.store, {
      registry: next,
      authorizeSend: () => false,
    });
    expect((await next.list(actor, new AbortController().signal))[0]?.credentialState).toBe(
      "locked",
    );
    expect(runtime.status(actor, id)?.state).toBe("saved");
    expect(f.counts().opens).toBe(0);
    expect(f.counts().windows).toBe(1);
    await runtime.close();
    next.close();
  });
  it("untrusted sidecars fail closed without permission repair or native access", async () => {
    const f = await fixture();
    const path = join(
      f.directory,
      "notification-preferences",
      "production",
      "preferences.db-journal",
    );
    const target = join(f.directory, "synthetic-sidecar");
    await writeFile(target, "synthetic", { mode: 0o600 });
    await symlink(target, path);
    expect(f.registry.isCurrent(actor, destination, "unknown", 1)).toBe(false);
    await expect(f.registry.list(actor, new AbortController().signal)).rejects.toThrow(
      "notification_storage_untrusted",
    );
    expect(f.counts().seals).toBe(0);
    await rm(path);
  });
  it("unknown schema and corrupted ciphertext metadata cannot be treated as ready", async () => {
    const f = await fixture();
    await f.register();
    f.store.withRuntimeTransaction((db) =>
      db.prepare("UPDATE notification_secret_records SET cipher_kind='unsupported'").run(),
    );
    expect((await f.registry.list(actor, new AbortController().signal))[0]?.credentialState).toBe(
      "unavailable",
    );
    f.registry.close();
    f.store.withRuntimeTransaction((db) =>
      db.exec("UPDATE notification_secret_identity SET version=999"),
    );
    expect(
      () =>
        new NativeNotificationRegistry({ preferences: f.store, actorId: actor, native: f.native }),
    ).toThrow("notification_secret_store_unavailable");
  });
  it("Email without an actual configured sender is unavailable; demo host cannot initialize native provider", async () => {
    const f = await fixture({
      slots: [{ destinationId: destination, channel: "email", label: "Email" }],
    });
    expect((await f.registry.list(actor, new AbortController().signal))[0]?.credentialState).toBe(
      "unavailable",
    );
    const id = await f.start();
    expect(f.runtime.status(actor, id)?.state).toBe("rejected");
    expect(f.counts().windows).toBe(0);
    expect(() =>
      createNotificationProviderHost({
        preferences: f.store,
        actorId: actor,
        profile: "demo",
        native: f.native,
      }),
    ).toThrow("notification_profile_mismatch");
  });
});

// Deterministic atomic-completion fault injection; fake credentials and local SQLite only.
describe("atomic provider completion regressions", () => {
  it.each([
    ["notification_secret_slots", "UPDATE"],
    ["notification_secret_records", "INSERT"],
    ["notification_bindings", "UPDATE"],
    ["notification_credential_sessions", "UPDATE"],
    ["notification_actions", "UPDATE"],
  ])("rolls back the complete save if %s %s fails", async (table, operation) => {
    const f = await fixture();
    const id = await f.start();
    const before = f.registry.store.get(actor, destination);
    f.store.withRuntimeTransaction((db) =>
      db.exec(
        `CREATE TRIGGER reviewer_failure BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'reviewer_failure'); END;`,
      ),
    );
    f.dialog().submit({ mode: "register", secret: SECRET, consent: true });
    expect(f.registry.store.get(actor, destination)).toEqual(before);
    expect(
      f.store.withRuntimeRead(
        (db) => db.prepare("SELECT count(*) n FROM notification_secret_records").get()?.n,
      ),
    ).toBe(0);
    expect(f.runtime.status(actor, id)?.state).not.toBe("saved");
    expect(
      (await f.registry.list(actor, new AbortController().signal))[0]?.credentialState,
    ).not.toBe("configured");
    f.store.withRuntimeTransaction((db) => db.exec("DROP TRIGGER reviewer_failure"));
  });
  it("after durable commit with a lost completion response, reports saved but leaves lease locked", async () => {
    const f = await fixture();
    const id = await f.start();
    const original = f.store.withRuntimeTransaction.bind(f.store);
    let lost = false;
    f.store.withRuntimeTransaction = (operation) => {
      const result = original(operation);
      const state = f.store.withRuntimeRead(
        (db) =>
          db.prepare("SELECT state FROM notification_actions WHERE action_id=?").get(id)?.state,
      );
      if (!lost && state === "saved") {
        lost = true;
        throw new Error("simulated_reply_loss");
      }
      return result;
    };
    f.dialog().submit({ mode: "register", secret: SECRET, consent: true });
    expect(lost).toBe(true);
    expect(f.runtime.status(actor, id)?.state).toBe("saved");
    expect((await f.registry.list(actor, new AbortController().signal))[0]?.credentialState).toBe(
      "locked",
    );
  });
  it("actual provider cannot install a lease when Lock is observed immediately after durable commit", async () => {
    const f = await fixture();
    const id = await f.start();
    const original = f.store.withRuntimeTransaction.bind(f.store);
    let locked = false;
    f.store.withRuntimeTransaction = (operation) => {
      const result = original(operation);
      const state = f.store.withRuntimeRead(
        (db) =>
          db.prepare("SELECT state FROM notification_actions WHERE action_id=?").get(id)?.state,
      );
      if (!locked && state === "saved") {
        locked = true;
        f.registry.lock();
        f.runtime.lockCredentials();
      }
      return result;
    };
    f.dialog().submit({ mode: "register", secret: SECRET, consent: true });
    expect(locked).toBe(true);
    expect(f.runtime.status(actor, id)?.state).toBe("saved");
    expect((await f.registry.list(actor, new AbortController().signal))[0]?.credentialState).toBe(
      "locked",
    );
  });
});
