import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { mountNotificationPreferences } from "../../src/ui/public/notification-view.js";

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
