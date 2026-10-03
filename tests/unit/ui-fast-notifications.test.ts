/** DOM-state tests only: no rendered/browser/native notification claim. */
import { describe, expect, it } from "vitest";
import { mountPresentation } from "../../src/ui/public/presentation.js";

class Element {
  hidden = true;
  disabled = false;
  open = false;
  textContent = "";
  title = "";
  className = "";
  listeners = new Map<string, () => unknown>();
  classes = new Set<string>();
  classList = {
    toggle: (key: string, on: boolean) => (on ? this.classes.add(key) : this.classes.delete(key)),
  };
  setAttribute() {}
  focus() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  addEventListener(event: string, listener: () => unknown) {
    this.listeners.set(event, listener);
  }
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
async function fixture() {
  const nodes = new Map<string, Element>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id) as Element;
  };
  const document = {
    body: new Element(),
    documentElement: new Element(),
    getElementById: node,
    querySelectorAll: () => [],
  };
  const window = { location: { search: "" }, localStorage: { setItem() {} } };
  let settings = {
    version: "bridge-presentation-1",
    revision: 1,
    values: {
      theme: "light",
      alwaysOnTop: false,
      hideWhenInactive: false,
      minimizeToTray: false,
      completionNotifications: true,
    },
  };
  const api = async (_path: string, input?: { patch: object }) => {
    if (input)
      settings = {
        ...settings,
        revision: settings.revision + 1,
        values: { ...settings.values, ...input.patch },
      };
    return { presentation: structuredClone(settings), nativeControls: { available: false } };
  };
  const presenter = mountPresentation({ api, document, window, statusLabel: (s: string) => s });
  await settle();
  return {
    presenter,
    node,
    document,
    click: async (id: string) => {
      await node(id).listeners.get("click")?.();
      await settle();
    },
  };
}
const at = (n: number) => `2026-10-03T09:00:${String(n).padStart(2, "0")}.000Z`;
const hosted = (
  id: string,
  revision: number,
  state: string,
  attemptId: string | null = null,
  observedAt = at(2),
) => ({
  binding: { requestId: id, revision, attemptId },
  state,
  terminalAvailable: state === "completed" || state === "failed",
  presentation: { title: id, observedAt },
});
describe("quiet completion of LLM-created fast jobs", () => {
  it("notifies a hosted attempt created and completed between polls, once, with no expansion", async () => {
    const x = await fixture();
    const g = x.presenter.observationGeneration();
    x.presenter.observeHosted([hosted("a", 1, "approved")], g, at(1));
    x.presenter.observeHosted([hosted("a", 3, "completed", "attempt")], g, at(3));
    expect(x.node("resident-notice").textContent).toBe("結果 1");
    x.presenter.observeHosted([hosted("a", 1, "approved")], g, at(3));
    x.presenter.observeHosted([hosted("a", 3, "completed", "attempt")], g, at(3));
    expect(x.node("resident-notice").textContent).toBe("結果 1");
    expect(x.document.body.classes.has("resident-view")).toBe(true);
  });
  it("notifies new terminal local and hosted jobs only if observed after the fresh baseline", async () => {
    const x = await fixture();
    const g = x.presenter.observationGeneration();
    x.presenter.observeTasks([], true, g, at(1));
    x.presenter.observeHosted([], g, at(1));
    x.presenter.observeTasks(
      [{ requestId: "local", status: "succeeded", title: "Local", updatedAt: at(2) }],
      true,
      g,
      at(3),
    );
    x.presenter.observeHosted([hosted("hosted", 3, "completed", "attempt")], g, at(3));
    expect(x.node("resident-notice").textContent).toBe("結果 2");
    x.presenter.observeTasks(
      [{ requestId: "old", status: "succeeded", title: "Old", updatedAt: at(0) }],
      true,
      g,
      at(3),
    );
    x.presenter.observeHosted([hosted("old-hosted", 3, "completed", "attempt", at(0))], g, at(3));
    expect(x.node("resident-notice").textContent).toBe("結果 2");
  });
  it("re-enable ignores pre-enable reads and old unseen terminal jobs", async () => {
    const x = await fixture();
    const old = x.presenter.observationGeneration();
    x.presenter.observeTasks([], true, old, at(1));
    x.presenter.observeHosted([], old, at(1));
    await x.click("pref-completionNotifications");
    await x.click("pref-completionNotifications");
    x.presenter.observeTasks([], true, old, at(1));
    x.presenter.observeHosted([], old, at(1));
    const g = x.presenter.observationGeneration();
    x.presenter.observeTasks([], true, g, at(5));
    x.presenter.observeHosted([], g, at(5));
    x.presenter.observeTasks(
      [{ requestId: "local", status: "succeeded", updatedAt: at(2) }],
      true,
      g,
      at(6),
    );
    x.presenter.observeHosted([hosted("hosted", 3, "completed", "attempt", at(2))], g, at(6));
    expect(x.node("resident-notice").hidden).toBe(true);
  });
});

describe("independent notification re-enable omission", () => {
  it("does not replay an old known hosted completion omitted from the new baseline page", async () => {
    const x = await fixture(),
      g = x.presenter.observationGeneration();
    x.presenter.observeHosted([hosted("older", 1, "approved", null, at(1))], g, at(1));
    await x.click("pref-completionNotifications");
    await x.click("pref-completionNotifications");
    const current = x.presenter.observationGeneration();
    x.presenter.observeHosted([], current, at(5));
    x.presenter.observeHosted([hosted("older", 3, "completed", "attempt", at(2))], current, at(6));
    expect(x.node("resident-notice").hidden).toBe(true);
  });
  it("does not replay an old known local completion omitted from the new baseline page", async () => {
    const x = await fixture(),
      g = x.presenter.observationGeneration();
    x.presenter.observeTasks(
      [{ requestId: "older", status: "running", updatedAt: at(1) }],
      true,
      g,
      at(1),
    );
    await x.click("pref-completionNotifications");
    await x.click("pref-completionNotifications");
    const current = x.presenter.observationGeneration();
    x.presenter.observeTasks([], true, current, at(5));
    x.presenter.observeTasks(
      [{ requestId: "older", status: "succeeded", updatedAt: at(2) }],
      true,
      current,
      at(6),
    );
    expect(x.node("resident-notice").hidden).toBe(true);
  });
});
