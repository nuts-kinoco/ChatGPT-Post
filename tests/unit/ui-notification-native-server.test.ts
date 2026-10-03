/** Loopback composition against fake notification ports; no native calls or external delivery. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiError } from "../../src/contracts/ui.js";
import { NotificationPreferencesStore } from "../../src/ui/notification-preferences.js";
import { isVerifiedNotificationStore } from "../../src/ui/notification-private-state.js";
import {
  type NotificationCredentialSessionV2,
  NotificationRuntime,
} from "../../src/ui/notification-runtime.js";
import {
  type NotificationProviderFactory,
  startUiServer,
  type UiServerHandle,
} from "../../src/ui/server.js";
import { openUiService } from "../../src/ui/service.js";

const deployment = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../../src/adapters/deployment-loader.js", () => ({
  openTrustedDeployment: async () => deployment.value,
}));

describe("notification host selection and metadata-only HTTP", () => {
  let dir: string;
  const servers: UiServerHandle[] = [];
  const stores: NotificationPreferencesStore[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "native-server-"));
    deployment.value = null;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) await server.close();
    for (const store of stores.splice(0)) store.close();
    await rm(dir, { recursive: true, force: true });
  });
  function factory() {
    const begin = vi.fn((_session: NotificationCredentialSessionV2) => {}),
      lock = vi.fn();
    const close = vi.fn();
    const make = vi.fn<NotificationProviderFactory>(({ preferences, actorId, profile }) => {
      expect(isVerifiedNotificationStore(preferences)).toBe(true);
      expect(actorId).toBe("local-ui-requester");
      expect(profile).toBe("production");
      const runtime = new NotificationRuntime(preferences, {
        registry: {
          credentialProtocol: "bridge-notification-credentials-2",
          beginCredentialInteractionV2: begin,
          isCurrent: () => true,
          list: async () => [
            {
              destinationId: "discord",
              channel: "discord",
              label: "Private Discord",
              generation: "initial",
              revision: 1,
              activatedAt: "2026-01-01T00:00:00.000Z",
              credentialState: "missing",
              prepare: async () => null,
            },
          ],
        },
        authorizeSend: () => false,
      });
      close.mockImplementation(() => runtime.close());
      lock.mockImplementation(() => runtime.lockCredentials());
      return { runtime, close, lock };
    });
    return { make, begin, close, lock };
  }
  async function open(options = {}) {
    const server = await startUiServer({ stateDir: dir, profile: "production", ...options });
    servers.push(server);
    return server;
  }
  async function api(server: UiServerHandle, path: string, value?: unknown) {
    return fetch(`${server.origin}/api/settings/notifications${path}`, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${server.token}`,
        ...(value === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  }
  it("constructs native fallback only for standard production host using its verified exact store", async () => {
    const f = factory(),
      server = await open({ notificationProviderFactory: f.make });
    expect(f.make).toHaveBeenCalledOnce();
    expect(f.begin).not.toHaveBeenCalled();
    expect((await (await api(server, "")).json()).notifications).toMatchObject({
      sendingImplemented: true,
      preferences: { authBlocked: { enabled: false } },
      controls: { credentialInteractionAvailable: true },
    });
    expect(server.lockNotificationCredentials).toBeTypeOf("function");
    server.lockNotificationCredentials?.();
    expect(f.lock).toHaveBeenCalledOnce();
    await server.close();
    await server.close();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it.each(["demo", "disabled"])("does not invoke native fallback for %s", async (mode) => {
    const f = factory();
    const server = await open({
      notificationProviderFactory: f.make,
      ...(mode === "demo" ? { profile: "demo" } : { notificationMode: "disabled" }),
    });
    expect(f.make).not.toHaveBeenCalled();
    expect(server.lockNotificationCredentials).toBeUndefined();
  });
  it("preserves external ports and never supplements them with the fallback", async () => {
    const f = factory();
    const store = new NotificationPreferencesStore(join(dir, "external.db"), "production");
    stores.push(store);
    const server = await open({
      notificationPreferences: store,
      notificationCatalogue: { list: () => [] },
      notificationProviderFactory: f.make,
    });
    expect(f.make).not.toHaveBeenCalled();
    expect(server.lockNotificationCredentials).toBeUndefined();
    expect((await (await api(server, "")).json()).notifications.sendingImplemented).toBe(false);
  });
  it.each([
    { notificationMode: "native" },
    { notificationMode: "external" },
    { notificationMode: "bogus" },
    { notificationMode: "disabled", notificationConfiguration: { slots: [] } },
  ])("rejects invalid mode combination before provider construction %#", async (options) => {
    await expect(open(options)).rejects.toMatchObject({ code: "notification_mode_conflict" });
  });
  it("rejects explicit native plus external even with a valid fallback", async () => {
    const f = factory();
    await expect(
      open({
        notificationMode: "native",
        notificationCatalogue: { list: () => [] },
        notificationProviderFactory: f.make,
      }),
    ).rejects.toMatchObject({ code: "notification_mode_conflict" });
    expect(f.make).not.toHaveBeenCalled();
  });
  it("deployment with no notification configuration stays disabled, explicit native opts in", async () => {
    const service = await openUiService({
      stateDir: join(dir, "deployment"),
      profile: "production",
    });
    deployment.value = { uiRuntime: service.runtime, close: () => service.close() };
    const f = factory();
    const server = await open({
      deploymentModule: "/synthetic-config.mjs",
      notificationProviderFactory: f.make,
    });
    expect(f.make).not.toHaveBeenCalled();
    await server.close();
    const next = await openUiService({ stateDir: join(dir, "deployment"), profile: "production" });
    deployment.value = {
      uiRuntime: next.runtime,
      close: () => next.close(),
      notificationMode: "native",
      notificationConfiguration: { slots: [] },
    };
    await open({ deploymentModule: "/synthetic-config.mjs", notificationProviderFactory: f.make });
    expect(f.make).toHaveBeenCalledOnce();
    expect(f.make.mock.calls[0]?.[0].configuration).toEqual({ slots: [] });
  });
  it("isolates unavailable notification storage while the monitor HTTP host stays up", async () => {
    const f = factory();
    f.make.mockImplementation(() => {
      throw new UiError("notification_storage_verifier_unavailable", "fixed unavailable", 409);
    });
    const server = await open({ notificationProviderFactory: f.make });
    expect((await (await api(server, "")).json()).notifications).toMatchObject({
      state: "unavailable",
      reason: "notification_storage_verifier_unavailable",
    });
    expect(
      (
        await fetch(`${server.origin}/api/bootstrap`, {
          headers: { Authorization: `Bearer ${server.token}` },
        })
      ).status,
    ).toBe(200);
    expect(server.lockNotificationCredentials).toBeUndefined();
  });
  it("returns 202 after admission, opens once on a later turn, supports safe recovery/cancel", async () => {
    const f = factory(),
      server = await open({ notificationProviderFactory: f.make });
    const runtime = f.make.mock.results[0]?.value.runtime as NotificationRuntime;
    const activated = vi.spyOn(runtime, "activateCredentialInteraction");
    let responseFinished = false;
    server.server.prependListener("request", (_request, response) =>
      response.once("finish", () => {
        responseFinished = true;
      }),
    );
    f.begin.mockImplementation(() => {
      expect(responseFinished).toBe(true);
    });
    const input = { actionId: randomUUID(), destinationId: "discord", expectedRevision: 0 };
    const response = await api(server, "/credentials", input);
    expect(response.status).toBe(202);
    expect((await response.json()).action.state).toBe("sending");
    await vi.waitFor(() => expect(f.begin).toHaveBeenCalledOnce());
    expect(activated).toHaveBeenCalledOnce();
    await api(server, "/credentials", input);
    expect(f.begin).toHaveBeenCalledOnce();
    expect(activated).toHaveBeenCalledOnce();
    const listed = await (await api(server, "/credentials/actions")).json();
    expect(listed.actions).toEqual([
      { actionId: input.actionId, destinationId: "discord", kind: "credential", state: "sending" },
    ]);
    const cancelled = await (
      await api(server, "/credentials/cancel", { actionId: input.actionId })
    ).json();
    expect(cancelled.action.state).toBe("cancelled");
    expect((await (await api(server, `/actions/${input.actionId}`)).json()).action.state).toBe(
      "cancelled",
    );
    expect(
      (
        await api(server, "/credentials/cancel", {
          actionId: input.actionId,
          destinationId: "discord",
        })
      ).status,
    ).toBe(409);
    expect(f.begin).toHaveBeenCalledOnce();
  });
});
