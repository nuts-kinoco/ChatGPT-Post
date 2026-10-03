import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/cli/config.js";
import type { BridgeResult } from "../../src/contracts/types.js";
import {
  type NotificationPreferencesStore,
  openNotificationPreferencesStore,
} from "../../src/ui/notification-preferences.js";
import {
  type NotificationBinding,
  NotificationRuntime,
} from "../../src/ui/notification-runtime.js";
import { ProObservationStore } from "../../src/ui/pro-counter.js";
import {
  type BridgeProCounterRuntime,
  openBridgeProCounter,
} from "../../src/ui/pro-counter-runtime.js";
import { startUiServer, type UiServerHandle } from "../../src/ui/server.js";

describe("real loopback settings + durable direct lifecycle + fake alert sink", () => {
  let dir: string;
  let now: number;
  let server: UiServerHandle;
  let prefs: NotificationPreferencesStore;
  let counter: BridgeProCounterRuntime;
  let alerts: NotificationRuntime;
  let send: ReturnType<typeof vi.fn>;
  let binding: NotificationBinding;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-alert-http-"));
    now = Date.parse("2026-10-03T10:00:00.000Z");
    prefs = await openNotificationPreferencesStore({
      stateDir: dir,
      profile: "production",
      now: () => new Date(now),
    });
    counter = await openBridgeProCounter(
      loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: dir }),
      "production",
      () => new Date(now),
    );
    send = vi.fn(async () => "delivered" as const);
    binding = {
      destinationId: "private-mail",
      channel: "email",
      label: "Private mail",
      generation: "binding-one",
      revision: 1,
      activatedAt: new Date(now - 1000).toISOString(),
      credentialState: "configured",
      prepare: async () => ({
        generation: binding.generation,
        revision: binding.revision,
        transport: { send },
      }),
    };
    alerts = new NotificationRuntime(prefs, {
      registry: {
        isCurrent: (_actor, id, generation, revision) =>
          id === binding.destinationId &&
          generation === binding.generation &&
          revision === binding.revision,
        list: async () => [binding],
        beginCredentialInteraction: async () => {
          binding = { ...binding, generation: "binding-two", revision: 2 };
          return "saved";
        },
      },
      authorizeSend: () => true,
      now: () => new Date(now),
    });
    server = await startUiServer({
      stateDir: dir,
      profile: "production",
      proCounterRuntime: counter,
      notificationRuntime: alerts,
    });
  });
  afterEach(async () => {
    await server?.close();
    await alerts?.close();
    await counter?.close();
    prefs?.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function api(path: string, value?: unknown, method = value === undefined ? "GET" : "POST") {
    return fetch(`${server.origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${server.token}`,
        ...(value === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  }
  async function result(body: Partial<BridgeResult> = {}) {
    const id = "request-auth-0001",
      requestDir = join(dir, "requests", id),
      startedAt = new Date(now).toISOString();
    await mkdir(requestDir, { recursive: true });
    await counter.beginRun(id, join(requestDir, "request.json"), startedAt);
    now += 1000;
    const value: BridgeResult = {
      schemaVersion: "1.2",
      bridgeVersion: "test",
      requestId: id,
      status: "manual_intervention_required",
      requestedPreset: "pro",
      observedPreset: null,
      requestedModel: "gpt-5.5",
      observedModel: null,
      observedModelSlug: null,
      submitted: "no",
      conversationUrl: "https://chatgpt.com/c/example",
      responseFile: null,
      extractionMethod: null,
      extractionQuality: null,
      startedAt,
      completedAt: new Date(now).toISOString(),
      durationMs: 1000,
      artifacts: [],
      images: [],
      warnings: [],
      error: {
        code: "AUTH_REQUIRED",
        message: "not transmitted",
        retryable: false,
        phase: "AUTH_CHECKED",
        cause: null,
      },
      ...body,
    };
    await writeFile(join(requestDir, "result.json"), JSON.stringify(value));
    await counter.resultWritten(value);
    return value;
  }
  it("saves preferences without sending, then consumes a pre-submit auth event once without a Pro count", async () => {
    const initial = await (await api("/api/settings/notifications")).json();
    expect(initial.notifications.preferences.authBlocked.enabled).toBe(false);
    expect(initial.notifications.controls.destinations[0].masked).toBe("••••••••");
    expect(
      (
        await api("/api/settings/notifications", {
          expectedRevision: 0,
          settings: { enabled: true, destinationIds: ["private-mail"] },
        })
      ).status,
    ).toBe(200);
    expect(send).not.toHaveBeenCalled();
    now++;
    await result();
    await alerts.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toContain("sign-in is required");
    expect(send.mock.calls[0]?.[0]).not.toContain("not transmitted");
    await counter.refresh();
    await alerts.tick();
    expect(send).toHaveBeenCalledTimes(1);
    const usage = await (await api("/api/settings/pro-counter")).json();
    expect(usage.proCounter.view.confirmed).toBe(0);
    expect(usage.proCounter.view.possible).toBe(0);
  });
  it("exposes distinct authenticated POST actions and read-only status, never a GET effect", async () => {
    const input = { actionId: randomUUID(), destinationId: "private-mail", expectedRevision: 0 };
    for (const path of [
      "/api/settings/notifications/test",
      "/api/settings/notifications/credentials",
    ]) {
      expect((await api(path)).status).toBe(404);
      expect(
        (
          await fetch(`${server.origin}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(401);
    }
    const first = await api("/api/settings/notifications/test", input);
    expect(first.status).toBe(200);
    expect((await first.json()).action.state).toBe("delivered");
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (await (await api(`/api/settings/notifications/actions/${input.actionId}`)).json()).action
        .state,
    ).toBe("delivered");
    await api("/api/settings/notifications/test", input);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await api("/api/settings/notifications/test", {
          ...input,
          recipient: "forbidden@example.invalid",
        })
      ).status,
    ).toBe(409);
    now += 60000;
    const setup = await api("/api/settings/notifications/credentials", {
      ...input,
      actionId: randomUUID(),
    });
    expect((await setup.json()).action.state).toBe("saved");
    expect(send).toHaveBeenCalledTimes(1);
    const settings = await (await api("/api/settings/notifications")).json();
    expect(settings.notifications.preferences.authBlocked.enabled).toBe(false);
    expect(JSON.stringify(settings)).not.toMatch(/token|webhook|forbidden@/);
  });
  it("invalidates queued verified-not-sent retries through the real Save endpoint", async () => {
    send.mockResolvedValue("not_sent_retryable");
    const input = { actionId: randomUUID(), destinationId: "private-mail", expectedRevision: 0 };
    expect((await (await api("/api/settings/notifications/test", input)).json()).action.state).toBe(
      "queued",
    );
    expect(send).toHaveBeenCalledTimes(1);
    await api("/api/settings/notifications", {
      expectedRevision: 0,
      settings: { enabled: false, destinationIds: [] },
    });
    now += 120000;
    await alerts.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (await (await api(`/api/settings/notifications/actions/${input.actionId}`)).json()).action
        .state,
    ).toBe("cancelled");
  });
  it("does not display an unbound raw counter as live observation coverage", async () => {
    const raw = new ProObservationStore(join(dir, "raw-counter.db"), false, () => new Date(now));
    const separate = await startUiServer({
      stateDir: join(dir, "raw-ui"),
      profile: "production",
      proCounter: raw,
    });
    try {
      const response = await fetch(`${separate.origin}/api/settings/pro-counter`, {
        headers: { Authorization: `Bearer ${separate.token}` },
      });
      expect((await response.json()).proCounter).toMatchObject({
        state: "unavailable",
        configurable: false,
        reason: "counter_runtime_unbound",
      });
    } finally {
      await separate.close();
      raw.close();
    }
  });
});
