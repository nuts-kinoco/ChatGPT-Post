import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { NotificationControlsView } from "../../src/ui/notification-runtime.js";
import { mountNotificationPreferences as mountWithRecovery } from "../../src/ui/public/notification-view.js";

// Older preference/action fixtures supply an empty durable receipt list; recovery behavior is tested separately below.
const mountNotificationPreferences = (options) =>
  mountWithRecovery({
    ...options,
    api: (path, ...args) =>
      path.endsWith("/credentials/actions")
        ? Promise.resolve({ actions: [] })
        : options.api(path, ...args),
  });

const html = readFileSync(
  new URL("../../src/ui/public/notification-panel.html", import.meta.url),
  "utf8",
);
const source = readFileSync(
  new URL("../../src/ui/public/notification-view.js", import.meta.url),
  "utf8",
);
function response(revision = 0, enabled = false, destinationIds: string[] = []) {
  return {
    profile: "production",
    notifications: {
      version: "bridge-notification-settings-1",
      state: "available",
      profile: "production",
      sendingImplemented: false,
      controls: null as NotificationControlsView | null,
      configurable: true,
      canEnable: true,
      unavailableReason: null as string | null,
      preferences: {
        version: "bridge-notification-preferences-1",
        actorId: "trusted-user",
        profile: "production",
        revision,
        updatedAt: null,
        authBlocked: { enabled, destinationIds },
      },
      destinations: {
        state: "available",
        value: [
          {
            destinationId: "work-email",
            channel: "email",
            label: "Work email",
            transportAvailable: true,
            unavailableReason: null,
          },
          {
            destinationId: "private-discord",
            channel: "discord",
            label: "Private Discord",
            transportAvailable: false,
            unavailableReason: "discord_transport_unconfigured",
          },
        ],
      },
    },
  };
}
type Listener = (event: { preventDefault(): void }) => unknown;
class Element {
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  textContent = "";
  className = "";
  type = "";
  children: Element[] = [];
  listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== fn),
    );
  }
  append(...elements: Element[]) {
    this.children.push(...elements);
  }
  replaceChildren(...elements: Element[]) {
    this.children = elements;
  }
  async emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) await fn({ preventDefault() {} });
  }
}
function dom() {
  const nodes = new Map<string, Element>();
  for (const match of html.matchAll(/id="([^"]+)"/g))
    if (match[1]) nodes.set(match[1], new Element());
  const node = (name: string) => {
    const element = nodes.get(`notification-${name}`);
    if (!element) throw new Error("missing element");
    return element;
  };
  const choice = (index: number) => {
    const element = node("destinations").children[index]?.children[0];
    if (!element) throw new Error("missing choice");
    return element;
  };
  return {
    node,
    choice,
    document: { getElementById: (id: string) => nodes.get(id), createElement: () => new Element() },
  };
}
function deferred<T>() {
  let resolve = (_value: T) => {
    throw new Error("not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function enable(
  node: ReturnType<typeof dom>["node"],
  choice: ReturnType<typeof dom>["choice"],
) {
  choice(0).checked = true;
  await choice(0).emit("change");
  node("enabled").checked = true;
  await node("enabled").emit("change");
}
describe("same-frame auth-block notification preferences", () => {
  it("starts OFF, displays registered channels and has no sender/secret input surface", async () => {
    const { document, node, choice } = dom();
    const api = vi.fn(async () => response());
    const panel = mountNotificationPreferences({ document, api });
    await panel.open();
    expect(node("enabled").checked).toBe(false);
    expect(node("save").disabled).toBe(true);
    expect(node("actions").hidden).toBe(true);
    expect(node("test").disabled).toBe(true);
    expect(node("credentials").disabled).toBe(true);
    expect(choice(0).value).toBe("work-email");
    expect(choice(1).disabled).toBe(true);
    expect(node("destinations").children[1]?.children[1]?.textContent).toContain(
      "discord_transport_unconfigured",
    );
    expect(html).not.toContain('type="text"');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("<dialog");
    expect(source).not.toMatch(/window\.open|localStorage\.|innerHTML|fetch\(/);
    expect(api).toHaveBeenCalledWith("/api/settings/notifications");
  });
  it("posts only exact registered IDs and settings revision, without actor or raw recipient", async () => {
    const { document, node, choice } = dom();
    const api = vi.fn(async (_path: string, body?: unknown) =>
      body ? response(1, true, ["work-email"]) : response(),
    );
    const panel = mountNotificationPreferences({ document, api });
    await panel.open();
    await enable(node, choice);
    await node("form").emit("submit");
    expect(api.mock.calls[1]?.[1]).toEqual({
      expectedRevision: 0,
      settings: { enabled: true, destinationIds: ["work-email"] },
    });
    expect(node("message").textContent).toContain("送信・テスト送信は行っていません");
  });
  it("preserves selected draft and enable toggle across Close and reopen", async () => {
    const { document, node, choice } = dom();
    const onClose = vi.fn();
    const panel = mountNotificationPreferences({ document, onClose, api: async () => response() });
    await panel.open();
    await enable(node, choice);
    await node("close").emit("click");
    expect(node("panel").hidden).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    await panel.open();
    expect(node("enabled").checked).toBe(true);
    expect(choice(0).checked).toBe(true);
    expect(node("save").disabled).toBe(false);
    panel.close();
    await panel.open();
    expect(choice(0).checked).toBe(true);
  });
  it("retains stale drafts and requires explicit reset before using updated server settings", async () => {
    const { document, node, choice } = dom();
    let data = response();
    const panel = mountNotificationPreferences({ document, api: async () => data });
    await panel.open();
    await enable(node, choice);
    data = response(1, false, []);
    await panel.refresh();
    expect(node("enabled").checked).toBe(true);
    expect(node("save").disabled).toBe(true);
    await node("reset-draft").emit("click");
    expect(node("enabled").checked).toBe(false);
    expect(choice(0).checked).toBe(false);
  });
  it("allows removing unavailable saved recipients but never selecting a new unavailable recipient", async () => {
    const { document, node, choice } = dom();
    const panel = mountNotificationPreferences({
      document,
      api: async () => response(1, true, ["work-email", "private-discord"]),
    });
    await panel.open();
    expect(choice(1).disabled).toBe(false);
    expect(node("save").disabled).toBe(true);
    choice(1).checked = false;
    await choice(1).emit("change");
    expect(choice(1).disabled).toBe(true);
    expect(node("save").disabled).toBe(false);
  });
  it("keeps OFF possible when transports become unavailable and disables new enablement", async () => {
    const { document, node } = dom();
    const data = response(1, true, ["work-email"]);
    data.notifications.canEnable = false;
    data.notifications.unavailableReason = "email_transport_unconfigured";
    for (const value of data.notifications.destinations.value) value.transportAvailable = false;
    const panel = mountNotificationPreferences({ document, api: async () => data });
    await panel.open();
    expect(node("enabled").disabled).toBe(false);
    expect(node("availability").textContent).toContain("email_transport_unconfigured");
    node("enabled").checked = false;
    await node("enabled").emit("change");
    expect(node("enabled").disabled).toBe(true);
    expect(node("save").disabled).toBe(false);
  });
  it("sends only one pending mutation and never replays an uncertain save", async () => {
    const { document, node, choice } = dom();
    const saved = deferred<ReturnType<typeof response>>();
    const api = vi.fn(async (_path: string, body?: unknown) => (body ? saved.promise : response()));
    const panel = mountNotificationPreferences({ document, api });
    await panel.open();
    await enable(node, choice);
    const first = node("form").emit("submit");
    await node("form").emit("submit");
    expect(api).toHaveBeenCalledTimes(2);
    saved.resolve(response(0, false, []));
    await first; // no revision increment, save unconfirmed
    expect(node("save").disabled).toBe(true);
    expect(node("reset-draft").disabled).toBe(true);
    expect(node("message").textContent).toContain("自動再送しません");
    await node("form").emit("submit");
    expect(api).toHaveBeenCalledTimes(2);
    await panel.refresh();
    expect(node("reset-draft").disabled).toBe(false);
    await node("reset-draft").emit("click");
    expect(node("enabled").checked).toBe(false);
  });
  it("ignores outdated in-flight reads and destroys listeners without opening another surface", async () => {
    const { document, node } = dom();
    const old = deferred<ReturnType<typeof response>>();
    let calls = 0;
    const panel = mountNotificationPreferences({
      document,
      api: async () => (++calls === 1 ? old.promise : response(2, true, ["work-email"])),
    });
    const first = panel.open();
    await panel.refresh();
    old.resolve(response());
    await first;
    expect(node("state").textContent).toContain("revision 2");
    expect(node("enabled").checked).toBe(true);
    panel.destroy();
    await node("refresh").emit("click");
    expect(calls).toBe(2);
    expect(node("destinations").children).toEqual([]);
  });
});

function activeResponse(revision = 0, enabled = false, destinationIds: string[] = []) {
  const data = response(revision, enabled, destinationIds);
  data.notifications.sendingImplemented = true;
  data.notifications.controls = {
    version: "bridge-notification-controls-1",
    credentialInteractionAvailable: true,
    destinations: [
      { destinationId: "work-email", credentialState: "configured", masked: "••••••••" },
      { destinationId: "private-discord", credentialState: "missing", masked: null },
    ],
    recent: [{ destinationId: "work-email", kind: "human_check", state: "uncertain", attempts: 1 }],
  };
  return data;
}
function required<T>(value: T | undefined): T {
  if (!value) throw new Error("expected captured action");
  return value;
}
type ActionInput = { actionId: string; destinationId: string; expectedRevision: number };
const actionResponse = (input: ActionInput, state = "delivered", kind = "test") => ({
  action: { actionId: input.actionId, destinationId: input.destinationId, state, kind },
});
describe("separate one-shot notification action UI", () => {
  it("permits an explicit default-OFF test with an opaque UUID and never sends during Save", async () => {
    const { document, node, choice } = dom();
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (path.endsWith("/test")) return actionResponse(body as ActionInput);
      return body ? activeResponse(1, true, ["work-email"]) : activeResponse();
    });
    const panel = mountNotificationPreferences({ document, api });
    await panel.open();
    expect(node("enabled").checked).toBe(false);
    expect(node("test").disabled).toBe(false);
    expect(node("credential-state").textContent).toBe("認証情報：設定済み ••••••••");
    expect(node("recent").children[0]?.textContent).toContain("結果不明");
    await node("test").emit("click");
    const sent = api.mock.calls[1]?.[1] as ActionInput;
    expect(sent).toEqual({
      actionId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      destinationId: "work-email",
      expectedRevision: 0,
    });
    expect(node("enabled").checked).toBe(false);
    await enable(node, choice);
    expect(node("test").disabled).toBe(true);
    await node("form").emit("submit");
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      "/api/settings/notifications",
      "/api/settings/notifications/test",
      "/api/settings/notifications",
    ]);
    expect(node("message").textContent).toContain("送信・テスト送信は行っていません");
  });
  it("keeps native setup separate, supports missing credentials, and never accepts browser secrets", async () => {
    const { document, node } = dom();
    const data = activeResponse();
    // Display only the fixed mask, even if a malformed provider response attempted a suffix.
    const firstDestination = data.notifications.controls?.destinations[0];
    if (firstDestination) firstDestination.masked = "TOKEN" as "••••••••";
    const api = vi.fn(async (path: string, body?: unknown) =>
      path.endsWith("/credentials")
        ? actionResponse(body as ActionInput, "saved", "credential")
        : data,
    );
    const panel = mountNotificationPreferences({ document, api });
    await panel.open();
    expect(node("credential-state").textContent).not.toContain("TOKEN");
    node("action-destination").value = "private-discord";
    await node("action-destination").emit("change");
    expect(node("credential-state").textContent).toContain("未設定");
    expect(node("test").disabled).toBe(true);
    expect(node("credentials").disabled).toBe(false);
    await node("credentials").emit("click");
    expect(api.mock.calls[1]?.[1]).toEqual({
      actionId: expect.any(String),
      destinationId: "private-discord",
      expectedRevision: 0,
    });
    expect(node("action-state").textContent).toContain("保存済み");
    expect(node("enabled").checked).toBe(false);
    expect(html).not.toMatch(/type="(?:text|password|email|url)"|textarea/);
    expect(source).not.toMatch(/localStorage|sessionStorage|window\.open|\.focus\(/);
    expect(api.mock.calls.some(([path]) => path.endsWith("/test"))).toBe(false);
  });
  it("dedupes clicks while pending or queued, then needs a new explicit click after terminal status", async () => {
    const { document, node } = dom();
    const sent = deferred<ReturnType<typeof actionResponse>>();
    let input: ActionInput | undefined;
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (path.endsWith("/test")) {
        input = body as ActionInput;
        return sent.promise;
      }
      if (path.includes("/actions/")) return actionResponse(required(input));
      return activeResponse();
    });
    const panel = mountNotificationPreferences({ document, api });
    await panel.open();
    const first = node("test").emit("click");
    await node("test").emit("click");
    await node("credentials").emit("click");
    expect(api).toHaveBeenCalledTimes(2);
    sent.resolve(actionResponse(required(input), "queued"));
    await first;
    await node("test").emit("click");
    expect(api).toHaveBeenCalledTimes(2);
    await node("action-refresh").emit("click");
    expect(api.mock.calls[2]?.[0]).toBe(`/api/settings/notifications/actions/${input?.actionId}`);
    const originalId = input?.actionId;
    expect(node("test").disabled).toBe(false);
    expect(api).toHaveBeenCalledTimes(3);
    await node("test").emit("click");
    expect(input?.actionId).not.toBe(originalId);
    expect(api).toHaveBeenCalledTimes(4);
  });
  it("retains an uncertain action across close/refresh and reconciles only with status GET", async () => {
    const { document, node } = dom();
    let input: ActionInput | undefined,
      found = false;
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (path.endsWith("/test")) {
        input = body as ActionInput;
        throw new Error("lost response");
      }
      if (path.includes("/actions/"))
        return found ? actionResponse(required(input), "uncertain") : { action: null };
      return activeResponse();
    });
    const panel = mountNotificationPreferences({ document, api });
    await panel.open();
    await node("test").emit("click");
    expect(node("action-state").textContent).toContain("自動再送しません");
    await node("close").emit("click");
    await panel.open();
    await node("test").emit("click");
    await node("action-refresh").emit("click");
    expect(node("test").disabled).toBe(true);
    expect(api.mock.calls.filter(([path]) => path.endsWith("/test"))).toHaveLength(1);
    found = true;
    await node("action-refresh").emit("click");
    expect(node("action-state").textContent).toContain("結果不明");
    expect(node("test").disabled).toBe(false);
    expect(api.mock.calls.filter(([path]) => path.endsWith("/test"))).toHaveLength(1);
  });
  it("holds dirty/stale preferences and preserves draft and selected action destination through dismissal", async () => {
    const { document, node, choice } = dom();
    let data = activeResponse();
    const api = vi.fn(async () => data);
    const panel = mountNotificationPreferences({ document, api });
    await panel.open();
    node("action-destination").value = "private-discord";
    await node("action-destination").emit("change");
    await enable(node, choice);
    await node("credentials").emit("click");
    expect(api).toHaveBeenCalledTimes(1);
    data = activeResponse(1);
    await panel.refresh();
    expect(node("test").disabled).toBe(true);
    expect(node("credentials").disabled).toBe(true);
    await node("close").emit("click");
    await panel.open();
    expect(node("enabled").checked).toBe(true);
    expect(choice(0).checked).toBe(true);
    expect(node("action-destination").value).toBe("private-discord");
    await node("reset-draft").emit("click");
    expect(node("credentials").disabled).toBe(false);
  });
  it("ignores an older settings read after an action starts and fences a destroyed action response", async () => {
    const { document, node } = dom();
    const old = deferred<ReturnType<typeof activeResponse>>(),
      sent = deferred<ReturnType<typeof actionResponse>>();
    let reads = 0,
      input: ActionInput | undefined;
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (path.endsWith("/test")) {
        input = body as ActionInput;
        return sent.promise;
      }
      return ++reads === 1 ? activeResponse(2) : old.promise;
    });
    const panel = mountNotificationPreferences({ document, api });
    await panel.open();
    const reading = panel.refresh();
    const sending = node("test").emit("click");
    old.resolve(activeResponse(3));
    await reading;
    expect(node("state").textContent).toContain("revision 2");
    panel.close();
    panel.destroy();
    sent.resolve(actionResponse(required(input)));
    await sending;
    expect(node("panel").hidden).toBe(true);
    expect(node("action-state").textContent).toContain("処理中");
    await node("action-refresh").emit("click");
    expect(api).toHaveBeenCalledTimes(3);
  });
  it("rejects mismatched action results and does not let an absent runtime activate controls", async () => {
    const { document, node } = dom();
    const api = vi.fn(async (path: string, body?: unknown) =>
      path.endsWith("/test")
        ? actionResponse({ ...(body as ActionInput), destinationId: "another-destination" })
        : activeResponse(),
    );
    const panel = mountNotificationPreferences({ document, api });
    await panel.open();
    await node("test").emit("click");
    expect(node("test").disabled).toBe(true);
    expect(node("action-state").textContent).toContain("結果を確認できません");
    const missing = dom(),
      absent = mountNotificationPreferences({
        document: missing.document,
        api: async () => response(),
      });
    await absent.open();
    expect(missing.node("actions").hidden).toBe(true);
    expect(missing.node("test").disabled).toBe(true);
  });
  it("requires revision refresh after a proven stale pre-admission rejection, without retrying", async () => {
    const { document, node } = dom();
    let revision = 0;
    const api = vi.fn(async (path: string) => {
      if (path.endsWith("/test")) {
        revision = 1;
        throw { code: "stale_notification_preferences", status: 409, uncertain: false };
      }
      return activeResponse(revision);
    });
    const panel = mountNotificationPreferences({ document, api });
    await panel.open();
    await node("test").emit("click");
    expect(node("test").disabled).toBe(true);
    expect(node("reset-draft").disabled).toBe(true);
    expect(node("message").textContent).toContain("操作は受け付けられませんでした");
    await panel.refresh();
    await node("reset-draft").emit("click");
    expect(node("test").disabled).toBe(false);
    expect(api.mock.calls.filter(([path]) => path.endsWith("/test"))).toHaveLength(1);
    expect(node("state").textContent).toContain("revision 1");
  });
  it("holds the last valid masked view when a malformed controls response arrives", async () => {
    const { document, node } = dom();
    let data: unknown = activeResponse();
    const panel = mountNotificationPreferences({ document, api: async () => data });
    await panel.open();
    const malformed = activeResponse();
    data = {
      notifications: {
        ...malformed.notifications,
        controls: {
          version: "bridge-notification-controls-1",
          credentialInteractionAvailable: true,
        },
      },
    };
    await panel.refresh();
    expect(node("credential-state").textContent).toBe("認証情報：設定済み ••••••••");
    expect(node("test").disabled).toBe(true);
    expect(node("message").textContent).toContain("設定を読み込めません");
  });
  it("keeps standalone and embedded action controls in sync with distinct non-submit buttons", () => {
    const embedded = readFileSync(
      new URL("../../src/ui/public/index.html", import.meta.url),
      "utf8",
    );
    for (const id of [
      "actions",
      "action-destination",
      "credential-state",
      "test",
      "credentials",
      "action-refresh",
      "action-state",
      "recent",
    ]) {
      expect(embedded.match(new RegExp(`id="notification-${id}"`, "g"))).toHaveLength(1);
      expect(html).toContain(`id="notification-${id}"`);
    }
    for (const id of ["test", "credentials", "action-refresh"])
      expect(html).toMatch(new RegExp(`id="notification-${id}" type="button"`));
  });
});

describe("v2 metadata-only credential recovery and cancellation UI", () => {
  const receipt = (state = "sending", actionId = "11111111-2222-4333-8444-555555555555") => ({
    actionId,
    destinationId: "work-email",
    kind: "credential",
    state,
  });
  it("reload recovers a completed save whose admission response was lost without posting", async () => {
    const { document, node } = dom();
    const saved = receipt("saved");
    const api = vi.fn(async (path, _body) =>
      path.endsWith("/credentials/actions") ? { actions: [saved] } : activeResponse(),
    );
    const panel = mountWithRecovery({ document, api });
    await panel.open();
    expect(node("action-state").textContent).toContain("保存済み");
    expect(node("credentials").disabled).toBe(false);
    expect(api.mock.calls.every(([, body]) => body === undefined)).toBe(true);
    panel.destroy();
  });
  it("polls pending GETs every second only while visible and resumes with durable receipts", async () => {
    vi.useFakeTimers();
    const { document, node } = dom();
    let state = "sending";
    const pending = receipt();
    const api = vi.fn(async (path) =>
      path.endsWith("/credentials/actions")
        ? { actions: [{ ...pending, state }] }
        : path.includes("/actions/")
          ? { action: { ...pending, state } }
          : activeResponse(),
    );
    const panel = mountWithRecovery({ document, api });
    try {
      await panel.open();
      expect(node("credentials").disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.mock.calls.filter(([path]) => path.includes("/actions/")).length).toBe(1);
      panel.close();
      const count = api.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(api).toHaveBeenCalledTimes(count);
      state = "saved";
      await panel.open();
      expect(node("action-state").textContent).toContain("保存済み");
      const final = api.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(api).toHaveBeenCalledTimes(final);
    } finally {
      panel.destroy();
      vi.useRealTimers();
    }
  });
  it("keeps repeated clicks inert and cancels by exact immutable action ID", async () => {
    const { document, node } = dom();
    let sent: ActionInput | undefined;
    const api = vi.fn(async (path, body) => {
      if (path.endsWith("/credentials/actions")) return { actions: [] };
      if (path.endsWith("/credentials")) {
        sent = body;
        return actionResponse(body, "sending", "credential");
      }
      if (path.endsWith("/credentials/cancel"))
        return { action: { ...receipt("cancelled", body.actionId) } };
      return activeResponse();
    });
    const panel = mountWithRecovery({ document, api });
    await panel.open();
    await node("credentials").emit("click");
    await node("credentials").emit("click");
    expect(api.mock.calls.filter(([path]) => path.endsWith("/credentials"))).toHaveLength(1);
    await node("action-cancel").emit("click");
    expect(api.mock.calls.at(-1)).toEqual([
      "/api/settings/notifications/credentials/cancel",
      { actionId: sent.actionId },
    ]);
    expect(node("action-state").textContent).toContain("取り消し済み");
    expect(node("enabled").checked).toBe(false);
    panel.destroy();
  });
  it("fences a delayed POST behind close, reopen, recovery and explicit cancel", async () => {
    const { document, node } = dom();
    const delayed = deferred<ReturnType<typeof actionResponse>>();
    let sent: ActionInput | undefined;
    const api = vi.fn(async (path, body) => {
      if (path.endsWith("/credentials/actions"))
        return { actions: sent ? [{ ...receipt("sending", sent.actionId) }] : [] };
      if (path.endsWith("/credentials")) {
        sent = body;
        return delayed.promise;
      }
      if (path.endsWith("/credentials/cancel"))
        return { action: receipt("cancelled", body.actionId) };
      return activeResponse();
    });
    const panel = mountWithRecovery({ document, api });
    await panel.open();
    const posting = node("credentials").emit("click");
    panel.close();
    await panel.open();
    await node("action-cancel").emit("click");
    delayed.resolve(actionResponse(sent, "saved", "credential"));
    await posting;
    expect(node("action-state").textContent).toContain("取り消し済み");
    expect(api.mock.calls.filter(([path]) => path.endsWith("/credentials"))).toHaveLength(1);
    panel.destroy();
  });
  it("late pending status GET cannot replace a newer cancellation receipt", async () => {
    const { document, node } = dom();
    const pending = receipt();
    const delayed = deferred<{ action: ReturnType<typeof receipt> }>();
    const api = vi.fn(async (path, _body) =>
      path.endsWith("/credentials/actions")
        ? { actions: [pending] }
        : path.endsWith("/credentials/cancel")
          ? { action: receipt("cancelled") }
          : path.includes("/actions/")
            ? delayed.promise
            : activeResponse(),
    );
    const panel = mountWithRecovery({ document, api });
    await panel.open();
    const reading = node("action-refresh").emit("click");
    await node("action-cancel").emit("click");
    delayed.resolve({ action: pending });
    await reading;
    expect(node("action-state").textContent).toContain("取り消し済み");
    expect(node("credentials").disabled).toBe(false);
    panel.destroy();
  });
  it("fails closed on malformed recovery without displaying foreign response fields", async () => {
    const { document, node } = dom();
    const api = vi.fn(async (path) =>
      path.endsWith("/credentials/actions")
        ? { actions: [{ ...receipt(), token: "SYNTHETIC_SECRET" }] }
        : activeResponse(),
    );
    const panel = mountWithRecovery({ document, api });
    await panel.open();
    expect(node("credentials").disabled).toBe(true);
    expect(node("message").textContent).not.toContain("SYNTHETIC_SECRET");
    await node("credentials").emit("click");
    expect(api.mock.calls.every(([, body]) => body === undefined)).toBe(true);
    panel.destroy();
  });
});
