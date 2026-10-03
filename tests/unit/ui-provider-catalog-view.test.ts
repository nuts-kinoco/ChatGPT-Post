import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { metadataCopy, mountProviderCatalog } from "../../src/ui/public/provider-catalog-view.js";

const source = readFileSync(
  new URL("../../src/ui/public/provider-catalog-view.js", import.meta.url),
  "utf8",
);
class Element {
  textContent = "";
  disabled = false;
  open = false;
  listeners = new Map<string, () => unknown>();
  addEventListener(t: string, f: () => unknown) {
    this.listeners.set(t, f);
  }
  removeEventListener(t: string) {
    this.listeners.delete(t);
  }
}
function dom() {
  const nodes = new Map(
    ["panel", "context", "status", "observation", "schedule", "models", "read", "refresh"].map(
      (n) => [n, new Element()],
    ),
  );
  return {
    nodes,
    document: { getElementById: (id: string) => nodes.get(id.replace("provider-catalog-", "")) },
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (v: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const ready = {
  refreshAllowed: true,
  reason: null,
  context: "private_empty_home",
  accountAvailability: "unknown",
  catalog: {
    fetchedAt: "2026-10-03T00:00:00Z",
    state: "unknown",
    stale: true,
    catalog: {
      source: { kind: "cli_metadata" },
      options: [{ label: "<img src=x onerror=alert(1)>", providerModelId: null }],
    },
  },
};
describe("read-only metadata panel", () => {
  it("labels isolated auth honestly and renders model labels as text", async () => {
    expect(metadataCopy({ reason: "auth_required" }).status).toContain(
      "通常のAntigravityアカウントのログイン状態は不明",
    );
    const d = dom();
    const api = vi.fn(async () => ({ metadata: ready }));
    const panel = mountProviderCatalog({ api, document: d.document });
    expect(api).not.toHaveBeenCalled();
    await panel.read();
    expect(d.nodes.get("models")?.textContent).toContain("<img src=x");
    expect(d.nodes.get("context")?.textContent).toContain("空のHOME");
    expect(source).not.toMatch(/innerHTML|window\.open|localStorage|fetch\(/);
  });
  it("coalesces clicks, uses the existing API body contract, and never retries uncertain POST", async () => {
    const d = dom(),
      pending = deferred<unknown>();
    const api = vi.fn((path: string) =>
      path.endsWith("refresh") ? pending.promise : Promise.resolve({ metadata: ready }),
    );
    const panel = mountProviderCatalog({ api, document: d.document });
    await panel.read();
    const first = panel.refresh();
    await panel.refresh();
    expect(api.mock.calls).toHaveLength(2);
    expect(api.mock.calls[1]).toEqual([
      "/api/provider-catalog/refresh",
      { version: "bridge-antigravity-metadata-host-1" },
    ]);
    pending.reject(new Error("lost response"));
    await first;
    await panel.refresh();
    expect(api.mock.calls).toHaveLength(2);
    expect(d.nodes.get("status")?.textContent).toContain("自動で再送しません");
    await panel.read();
    expect(api.mock.calls).toHaveLength(3);
  });
  it("ignores late observations after close/destroy and never starts refresh when unavailable", async () => {
    const d = dom(),
      pending = deferred<unknown>();
    const api = vi.fn(() => pending.promise);
    const panel = mountProviderCatalog({ api, document: d.document });
    await panel.refresh();
    expect(api).not.toHaveBeenCalled();
    const read = panel.read();
    panel.destroy();
    pending.resolve({ metadata: ready });
    await read;
    expect(d.nodes.get("models")?.textContent).not.toContain("<img");
  });
  it("rerenders the newest GET controls after an older POST finishes", async () => {
    const d = dom(),
      pending = deferred<unknown>();
    const api = vi.fn((path: string) =>
      path.endsWith("refresh") ? pending.promise : Promise.resolve({ metadata: ready }),
    );
    const panel = mountProviderCatalog({ api, document: d.document });
    await panel.read();
    const posting = panel.refresh();
    await panel.read();
    expect(d.nodes.get("refresh")?.disabled).toBe(true);
    pending.resolve({ metadata: { ...ready, refreshAllowed: false } });
    await posting;
    expect(d.nodes.get("refresh")?.disabled).toBe(false);
  });
});
