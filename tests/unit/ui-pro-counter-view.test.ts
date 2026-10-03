import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  counterCopy,
  mountProCounter,
  parseCounterFields,
} from "../../src/ui/public/pro-counter-view.js";

const source = readFileSync(
  new URL("../../src/ui/public/pro-counter-view.js", import.meta.url),
  "utf8",
);
const html = readFileSync(
  new URL("../../src/ui/public/pro-counter-panel.html", import.meta.url),
  "utf8",
);
const fields = {
  limit: "10",
  threshold: "2",
  start: "2026-10-03T08:00:00.000Z",
  end: "2026-10-03T09:00:00.000Z",
  timezone: "Etc/UTC",
  other: "",
};
function response(revision = 1, limit = 10) {
  return {
    profile: "production",
    proCounter: {
      version: "bridge-pro-counter-settings-1",
      state: "available",
      configurable: true,
      view: {
        version: "bridge-pro-counter-1",
        synthetic: false,
        scope: "bridge-observed-ordinary-chat-only",
        wholeAccountKnown: false,
        providerQuotaKnown: false,
        configuration: { revision, settings: { ...parseCounterFields(fields), limit } },
        observedAt: "2026-10-03T08:30:00.000Z",
        confirmed: 4,
        possible: 1,
        unassignedInWindow: 0,
        windowState: "active",
        remaining: { lower: 5, upper: 6, source: "configured-reference-only" },
        warning: { active: false, severity: "normal", text: "公式quotaは不明です" },
      },
    },
  };
}
type Listener = (event: { preventDefault(): void }) => unknown;
class Element {
  hidden = false;
  disabled = false;
  value = "";
  textContent = "";
  className = "";
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
  async emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) await fn({ preventDefault() {} });
  }
}
function dom() {
  const nodes = new Map<string, Element>();
  for (const match of html.matchAll(/id="([^"]+)"/g))
    if (match[1]) nodes.set(match[1], new Element());
  const node = (name: string) => {
    const element = nodes.get(`pro-counter-${name}`);
    if (!element) throw new Error("missing element");
    return element;
  };
  return { node, document: { getElementById: (id: string) => nodes.get(id) } };
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
describe("same-frame Pro reference counter", () => {
  it("parses manual unknowns without inferring reset times and rejects malformed input", () => {
    expect(parseCounterFields(fields)).toMatchObject({
      limit: 10,
      warnRemaining: 2,
      otherUsage: null,
      timeZone: "Etc/UTC",
    });
    expect(
      parseCounterFields({ limit: "", threshold: "", start: "", end: "", timezone: "", other: "" }),
    ).toEqual({
      limit: null,
      warnRemaining: null,
      startsAt: null,
      endsAt: null,
      timeZone: null,
      otherUsage: null,
    });
    for (const invalid of [
      { ...fields, limit: "1e3" },
      { ...fields, other: "-1" },
      { ...fields, limit: "0" },
      { ...fields, threshold: "11" },
      { ...fields, start: "2026-10-03T08:00:00Z" },
      { ...fields, timezone: "" },
      { ...fields, timezone: "Imaginary/Island" },
    ])
      expect(() => parseCounterFields(invalid)).toThrow();
  });
  it("renders confirmed/possible separately, unknown coverage and a red warning without a popup", async () => {
    const { document, node } = dom();
    const data = response();
    data.proCounter.view.warning.active = true;
    const api = vi.fn(async () => data);
    const panel = mountProCounter({ api, document });
    await panel.open();
    expect(node("counts").textContent).toContain("確認済み 4回 · 利用した可能性 1回");
    expect(node("coverage").textContent).toContain("アカウント全体の利用量は不明");
    expect(node("warning").className).toContain("danger");
    expect(source).not.toMatch(/window\.open|localStorage\.|innerHTML|fetch\(/);
    expect(html).toContain('id="pro-counter-panel" hidden');
    expect(html).not.toContain("<dialog");
  });
  it("keeps absent host store explicitly unavailable and disables saves", async () => {
    const { document, node } = dom();
    const panel = mountProCounter({
      document,
      api: async () => ({
        proCounter: {
          version: "bridge-pro-counter-settings-1",
          state: "unavailable",
          reason: "pro_counter_unconfigured",
        },
      }),
    });
    await panel.open();
    expect(node("save").disabled).toBe(true);
    expect(node("fields").disabled).toBe(true);
    expect(node("remaining").textContent).toContain("不明");
    expect(counterCopy(null).remaining).toContain("不明");
  });
  it("retains unsaved drafts across Close, reopen and refresh", async () => {
    const { document, node } = dom();
    const onClose = vi.fn();
    const panel = mountProCounter({ document, onClose, api: async () => response() });
    await panel.open();
    node("limit").value = "20";
    await node("limit").emit("input");
    await node("close").emit("click");
    expect(node("panel").hidden).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    await panel.open();
    expect(node("limit").value).toBe("20");
    expect(node("save").disabled).toBe(false);
    panel.close();
    await panel.open();
    expect(node("limit").value).toBe("20");
  });
  it("blocks stale dirty settings without overwriting the draft", async () => {
    const { document, node } = dom();
    let data = response();
    const panel = mountProCounter({ document, api: async () => data });
    await panel.open();
    node("limit").value = "20";
    await node("limit").emit("input");
    data = response(2, 30);
    await panel.refresh();
    expect(node("limit").value).toBe("20");
    expect(node("save").disabled).toBe(true);
    await node("reset-draft").emit("click");
    expect(node("limit").value).toBe("30");
  });
  it("sends one exact settings mutation and ignores repeat submissions while pending", async () => {
    const { document, node } = dom();
    const pending = deferred<ReturnType<typeof response>>();
    const api = vi.fn(async (_path: string, body?: unknown) =>
      body ? pending.promise : response(),
    );
    const panel = mountProCounter({ document, api });
    await panel.open();
    node("limit").value = "20";
    await node("limit").emit("input");
    const save = node("form").emit("submit");
    await node("form").emit("submit");
    expect(api).toHaveBeenCalledTimes(2);
    expect(node("fields").disabled).toBe(true);
    expect(api.mock.calls[1]?.[1]).toEqual({
      expectedRevision: 1,
      settings: { ...parseCounterFields(fields), limit: 20 },
    });
    pending.resolve(response(2, 20));
    await save;
    expect(node("message").textContent).toContain("保存しました");
    expect(node("save").disabled).toBe(true);
  });
  it("does not retry ambiguous saves and requires readback before discarding uncertainty", async () => {
    const { document, node } = dom();
    let saved = false;
    const api = vi.fn(async (_path: string, body?: unknown) => {
      if (body) {
        saved = true;
        throw new Error("transport failed");
      }
      return saved ? response(2, 20) : response();
    });
    const panel = mountProCounter({ document, api });
    await panel.open();
    node("limit").value = "20";
    await node("limit").emit("input");
    await node("form").emit("submit");
    expect(node("save").disabled).toBe(true);
    expect(node("reset-draft").disabled).toBe(true);
    expect(node("message").textContent).toContain("自動再送しません");
    await node("form").emit("submit");
    expect(api).toHaveBeenCalledTimes(2);
    await panel.refresh();
    expect(node("reset-draft").disabled).toBe(false);
    await node("reset-draft").emit("click");
    expect(node("limit").value).toBe("20");
    expect(node("save").disabled).toBe(true);
  });
  it("ignores older reads after a newer refresh and removes listeners on teardown", async () => {
    const { document, node } = dom();
    const old = deferred<ReturnType<typeof response>>();
    let calls = 0;
    const panel = mountProCounter({
      document,
      api: async () => (++calls === 1 ? old.promise : response(2, 20)),
    });
    const initial = panel.open();
    await panel.refresh();
    old.resolve(response(1, 10));
    await initial;
    expect(node("limit").value).toBe("20");
    panel.destroy();
    await node("refresh").emit("click");
    expect(calls).toBe(2);
  });
});
