/** Actual product -> HTTP server -> provider/store/runtime composition, all secret/native ports fake. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { startProductUi } from "../../gui/src/main/product-ui.js";
import type { NotificationPreferencesStore } from "../../src/ui/notification-preferences.js";
import {
  createNotificationProviderHost,
  type NotificationNativePorts,
} from "../../src/ui/notification-secret-provider.js";
import { startUiServer, type UiServerOptions } from "../../src/ui/server.js";

it("composes the real fake-backed provider through product server, saving OFF and recovering status before Lock", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "bridge-native-composition-fake-"));
  const opaque = new Map<string, string>();
  let nativeCalls = 0,
    windows = 0;
  let entry: Parameters<NotificationNativePorts["dialog"]["open"]>[0] | undefined;
  const native: NotificationNativePorts = {
    cipher: {
      seal(value) {
        nativeCalls++;
        const key = `opaque-${nativeCalls}`;
        opaque.set(key, value);
        return Buffer.from(key);
      },
      open(value) {
        nativeCalls++;
        return opaque.get(Buffer.from(value).toString()) ?? "invalid";
      },
    },
    dialog: {
      open(value) {
        windows++;
        entry = value;
        return { close() {} };
      },
    },
  };
  const server = await startProductUi(
    resolve("."),
    { CHATGPT_BRIDGE_RUNTIME_DIR: stateDir },
    async () => ({
      startUiServer: (options) =>
        startUiServer({
          ...options,
          publicDir: resolve("src/ui/public"),
        } as unknown as UiServerOptions),
    }),
    (input) =>
      createNotificationProviderHost({
        preferences: input.preferences as NotificationPreferencesStore,
        actorId: input.actorId,
        profile: input.profile,
        native,
      }),
  );
  const bodies: string[] = [];
  const request = async (path: string, body?: unknown) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded) bodies.push(encoded);
    const response = await fetch(server.origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        origin: server.origin,
        ...(encoded ? { "content-type": "application/json" } : {}),
      },
      ...(encoded ? { body: encoded } : {}),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    const first = await request("/api/settings/notifications");
    expect(first.status).toBe(200);
    expect(first.value.notifications.preferences.authBlocked.enabled).toBe(false);
    expect(nativeCalls).toBe(0);
    expect(windows).toBe(0);
    expect(first.value.notifications.controls.destinations[0].credentialState).toBe("missing");
    const actionId = randomUUID();
    const admitted = await request("/api/settings/notifications/credentials", {
      actionId,
      destinationId: "discord-personal",
      expectedRevision: 0,
    });
    expect(admitted.status).toBe(202);
    expect(admitted.value.action.state).toBe("sending");
    for (let i = 0; i < 10 && !entry; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(windows).toBe(1);
    expect(nativeCalls).toBe(0);
    entry?.submit({
      mode: "register",
      secret: "https://discord.com/api/webhooks/12345/FAKE_ONLY_COMPOSITION",
      consent: true,
    });
    expect(
      (await request(`/api/settings/notifications/actions/${actionId}`)).value.action.state,
    ).toBe("saved");
    const recent = await request("/api/settings/notifications/credentials/actions");
    expect(recent.value.actions).toEqual([expect.objectContaining({ actionId, state: "saved" })]);
    const configured = await request("/api/settings/notifications");
    expect(configured.value.notifications.controls.destinations[0].credentialState).toBe(
      "configured",
    );
    expect(configured.value.notifications.preferences.authBlocked).toEqual({
      enabled: false,
      destinationIds: [],
    });
    expect(nativeCalls).toBe(1);
    await server.lockNotificationCredentials?.();
    expect(
      (await request("/api/settings/notifications")).value.notifications.controls.destinations[0]
        .credentialState,
    ).toBe("locked");
    expect(nativeCalls).toBe(1);
    expect(JSON.stringify(bodies)).not.toContain("FAKE_ONLY_COMPOSITION");
    expect(JSON.stringify(configured.value)).not.toContain("FAKE_ONLY_COMPOSITION");
  } finally {
    await server.close();
    await server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
