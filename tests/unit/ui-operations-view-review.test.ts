/** Source/DOM regression tests only: no browser, native window, network, or task execution. */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/ui/public/app.js";
import { mountArchive } from "../../src/ui/public/archive-view.js";
import { mountComposer } from "../../src/ui/public/composer-view.js";
import { mountOperations } from "../../src/ui/public/operations-view.js";

const html = readFileSync(new URL("../../src/ui/public/index.html", import.meta.url), "utf8");
type Listener = (event: { target: Element; preventDefault(): void }) => unknown;
type Reply = Record<string, unknown>;
type Api = (path: string, body?: Record<string, unknown>) => Promise<Reply>;
class Element {
  id = "";
  value = "";
  textContent = "";
  className = "";
  disabled = false;
  hidden = false;
  open = false;
  readOnly = false;
  title = "";
  type = "";
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Element[] = [];
  parent: Element | null = null;
  listeners = new Map<string, Listener[]>();
  classList = {
    toggle: (name: string, on: boolean) => {
      const values = new Set(this.className.split(/\s+/).filter(Boolean));
      if (on) values.add(name);
      else values.delete(name);
      this.className = [...values].join(" ");
    },
  };
  constructor(public tagName = "div") {}
  append(...elements: Element[]) {
    for (const element of elements) element.parent = this;
    this.children.push(...elements);
  }
  replaceChildren(...elements: Element[]) {
    for (const element of this.children) element.parent = null;
    this.children = [];
    this.append(...elements);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((value) => value !== this);
    this.parent = null;
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  focus() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  // Raw dispatch intentionally permits disabled elements to exercise handlers' own repeat guards.
  async emit(type: string) {
    for (const listener of this.listeners.get(type) ?? [])
      await listener({ target: this, preventDefault() {} });
  }
}
function dom() {
  const nodes = new Map<string, Element>();
  for (const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*>/gi)) {
    const id = /\bid="([^"]+)"/.exec(match[0])?.[1];
    if (!id) continue;
    if (nodes.has(id)) throw new Error(`Duplicate HTML id: ${id}`);
    const element = new Element(match[1]);
    element.id = id;
    element.disabled = /\sdisabled(?:[\s=>])/.test(match[0]);
    element.hidden = /\shidden(?:[\s=>])/.test(match[0]);
    nodes.set(id, element);
  }
  const node = (id: string) => {
    const element = nodes.get(id);
    if (!element) throw new Error(`Missing HTML id: ${id}`);
    return element;
  };
  const document = {
    body: new Element("body"),
    hidden: false,
    getElementById: node,
    createElement: (tag: string) => new Element(tag),
  };
  return {
    node,
    document,
    presentation: { closeDialog: (id: string) => node(id).close() },
    click: async (id: string) => {
      await node(id).emit("click");
      await settle();
    },
  };
}
async function settle() {
  for (let index = 0; index < 8; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred is not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const available = <T>(value: T) => ({ state: "available", value });
const page = <T>(items: T[]) => available({ items: items.map(available), next: null });
const emptyOverview = () => ({ local: page([]), hosted: page([]), fanout: page([]) });
const emptySetup = () => ({
  registry: available({ revision: 1, projects: [] }),
  destinations: available([]),
  quotas: available([]),
});
function registry(revision: number, displayName: string) {
  return {
    settings: {
      configurable: true,
      state: "available",
      revision,
      snapshot: {
        schema: "bridge-project-registry-1",
        revision,
        defaultOutputRoot: "/configured/output",
        projects: [
          {
            projectId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
            displayName,
            repoId: "repo",
            storageSlug: "repo",
          },
        ],
      },
    },
  };
}
function operationsMount(view: ReturnType<typeof dom>, api: Api) {
  return mountOperations({
    document: view.document,
    api,
    isDemo: () => false,
    onLocal: async () => {},
    onImport: () => {},
    onDemo: () => {},
  });
}
function setupApi(extra: Api): Api {
  return async (path, body) => {
    if (path === "/api/operations") return { operations: emptyOverview() };
    if (path === "/api/setup") return { setup: emptySetup() };
    return extra(path, body);
  };
}
function hosted(revision = 2) {
  return {
    kind: "hosted_delivery",
    binding: {
      kind: "hosted_delivery",
      requestId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      taskSpecHash: "a".repeat(64),
      attemptId: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
      revision,
    },
    presentation: { title: "Hosted request", requestedModel: "requested", actualModel: null },
    state: "approved",
    context: { project: { repoId: "repo" } },
    delivery: { fullDeliverySufficient: false, reason: "materialization_pending" },
    rawSpec: '{"immutable":"JSON"}\r\n',
    taskMarkdown: "# Exact task\r\nBody\r\n",
    responseMarkdown: null,
    capabilities: {
      start: { enabled: true, reason: "explicit_start_available" },
      cancel: { enabled: true, reason: "explicit_cancel_available" },
      reconcile: { enabled: true, reason: "observation_only" },
    },
  };
}
function archiveView(binding: Reply, state = "pending") {
  return { binding, state, items: [], requiredSetKnown: true, complete: state === "complete" };
}
function descendants(element: Element): Element[] {
  return [element, ...element.children.flatMap(descendants)];
}
function action(view: ReturnType<typeof dom>, text: string) {
  const button = descendants(view.node("operations-detail-content")).find(
    (element) => element.tagName === "button" && element.textContent === text,
  );
  if (!button) throw new Error(`Missing action: ${text}`);
  return button;
}
async function selectLane(view: ReturnType<typeof dom>, lane: number) {
  const button = view
    .node("operations-list")
    .children[lane]?.children.find((element) => element.tagName === "button");
  if (!button) throw new Error(`Missing operation in lane ${lane}`);
  await button.emit("click");
  await settle();
}
beforeEach(() => {
  vi.spyOn(globalThis, "setInterval").mockImplementation(
    () => 0 as unknown as ReturnType<typeof setInterval>,
  );
});
afterEach(() => vi.restoreAllMocks());

describe("operations view interrupted-flow regressions", () => {
  it("has unique HTML IDs and accepts each operation route in the real API client", async () => {
    expect(() => dom()).not.toThrow();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ profile: "production" })));
    const api = createApiClient("synthetic-test-token", fetcher);
    for (const kind of ["local_execution", "hosted_delivery", "fanout"])
      await api(`/api/operations/${kind}/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa`);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(api("/api/../outside")).rejects.toMatchObject({ code: "invalid_path" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("preserves registry edits when a refresh finishes hidden and the dialog reopens", async () => {
    const view = dom(),
      late = deferred<Reply>();
    let reads = 0;
    const api = vi.fn(
      setupApi(async (path) => {
        if (path !== "/api/settings/projects") throw new Error(path);
        reads++;
        return reads === 2 ? late.promise : registry(1, "Saved name");
      }),
    );
    operationsMount(view, api);
    await view.click("operations-project-settings");
    expect(view.node("project-display-name").disabled).toBe(false);
    view.node("project-display-name").value = "Unsent project edit";
    await view.node("project-display-name").emit("input");
    await view.click("project-settings-reload");
    await view.click("close-project-settings");
    late.resolve(registry(1, "Saved name"));
    await settle();
    expect(view.node("project-settings-dialog").open).toBe(false);
    expect(view.node("project-display-name").value).toBe("Unsent project edit");
    await view.click("operations-project-settings");
    expect(view.node("project-display-name").value).toBe("Unsent project edit");
    expect(api.mock.calls.filter(([, body]) => body !== undefined)).toHaveLength(0);
  });

  it("ignores reordered registry reads, preserves dirty input, and resets to the newest revision", async () => {
    const view = dom(),
      older = deferred<Reply>(),
      newer = deferred<Reply>();
    let reads = 0;
    operationsMount(
      view,
      setupApi(async (path) => {
        if (path !== "/api/settings/projects") throw new Error(path);
        reads++;
        return reads === 1 ? registry(1, "Initial") : reads === 2 ? older.promise : newer.promise;
      }),
    );
    await view.click("operations-project-settings");
    view.node("project-display-name").value = "Keep my draft";
    await view.node("project-display-name").emit("input");
    await view.click("project-settings-reload");
    await view.click("project-settings-reload");
    newer.resolve(registry(3, "Newest saved name"));
    await settle();
    older.resolve(registry(2, "Obsolete saved name"));
    await settle();
    expect(view.node("project-display-name").value).toBe("Keep my draft");
    expect(view.node("project-settings-status").textContent).toContain("revision 3");
    await view.click("project-settings-reset");
    expect(view.node("project-display-name").value).toBe("Newest saved name");
    expect(view.node("project-settings-save").disabled).toBe(true);
  });

  it("does not duplicate composer initialization or targets after rapid close/reopen", async () => {
    const view = dom(),
      pendingSetup = deferred<Reply>();
    const api = vi.fn(async (path: string) => {
      if (path === "/api/setup") return pendingSetup.promise;
      if (path === "/api/composer") return { capability: { enabled: true } };
      throw new Error(`Unexpected mutation or route: ${path}`);
    });
    mountComposer({ api, document: view.document, presentation: view.presentation });
    const initial = view.node("open-composer").emit("click");
    await settle();
    view.node("composer-instruction").value = "Keep this unsent instruction";
    await view.node("composer-instruction").emit("input");
    await view.click("close-composer");
    const reopened = view.node("open-composer").emit("click");
    await settle();
    pendingSetup.resolve({
      setup: {
        registry: available({
          revision: 1,
          projects: [{ projectId: "project", displayName: "Project", repoId: "repo" }],
        }),
        destinations: available([
          { destinationId: "destination", route: "cli", modelIds: ["model"] },
        ]),
      },
    });
    await Promise.all([initial, reopened]);
    expect(api.mock.calls.filter(([path]) => path === "/api/setup")).toHaveLength(1);
    expect(api.mock.calls.filter(([path]) => path === "/api/composer")).toHaveLength(1);
    expect(view.node("composer-targets").children).toHaveLength(1);
    expect(view.node("composer-instruction").value).toBe("Keep this unsent instruction");
    expect(view.node("composer-issue").disabled).toBe(true);
    expect(api.mock.calls.some(([path]) => path === "/api/composer/issue")).toBe(false);
  });

  it("offers common kinds only for registered formats and reuses one exact preview until edited", async () => {
    const view = dom();
    for (const value of ["legacy-verbatim", "answer", "review", "change"]) {
      const option = new Element("option");
      option.value = value;
      view.node("composer-mode").append(option);
    }
    const child = {
      destinationId: "hosted",
      requestId: "fixed-request",
      taskSpecHash: "spec",
      taskFileHash: "file",
      rawSpec: "exact raw spec",
      taskMarkdown: "exact original brief bytes",
      promptFormat: { readiness: "registered-pre-approval", codec: "bridge-task-brief-1" },
      promptPreview: { preview: { text: "Display only: unresolved attempt and output contract" } },
    };
    const api = vi.fn(async (path: string, body?: Record<string, unknown>) => {
      if (path === "/api/setup")
        return {
          setup: {
            registry: available({
              revision: 1,
              projects: [{ projectId: "project", displayName: "Project", repoId: "repo" }],
            }),
            destinations: available([
              {
                destinationId: "hosted",
                route: "ordinary_chat_browser",
                modelIds: ["gpt-5.6-sol"],
              },
            ]),
          },
        };
      if (path === "/api/composer")
        return {
          capability: { enabled: true },
          promptFormats: {
            version: "bridge-composer-prompt-formats-1",
            formats: [
              { destinationId: "hosted", modelId: "gpt-5.6-sol", promptFormat: child.promptFormat },
            ],
          },
        };
      if (path === "/api/composer/preview")
        return {
          preview: { previewId: "exact-preview", children: [child] },
          previewSha256: "preview-hash",
        };
      throw new Error(`Unexpected execution or issue: ${path} ${JSON.stringify(body)}`);
    });
    mountComposer({ api, document: view.document, presentation: view.presentation });
    await view.click("open-composer");
    const [destination, model] = view.node("composer-targets").children[0]?.children ?? [];
    if (!destination || !model) throw new Error("Expected composer destination and model");
    destination.value = "hosted";
    await destination.emit("change");
    model.value = "gpt-5.6-sol";
    await model.emit("change");
    expect(view.node("composer-mode").children[0]?.disabled).toBe(true);
    expect(
      view
        .node("composer-mode")
        .children.slice(1)
        .every((option) => !option.disabled),
    ).toBe(true);
    expect(view.node("composer-preview").disabled).toBe(true);
    view.node("composer-mode").value = "review";
    await view.node("composer-mode").emit("change");
    view.node("composer-title").value = "Synthetic review";
    view.node("composer-instruction").value = "Do not call a model";
    view.node("composer-constraints").value = "Keep scope\n\n Preserve evidence ";
    view.node("composer-deliverables").value = "Findings";
    view.node("composer-acceptance").value = "Allow no findings";
    await view.click("composer-preview");
    await view.click("composer-preview");
    expect(api.mock.calls.filter(([path]) => path === "/api/composer/preview")).toHaveLength(1);
    expect(api.mock.calls.find(([path]) => path === "/api/composer/preview")?.[1]).toMatchObject({
      mode: "bridge-task-brief-1",
      taskKind: "review",
      constraints: ["Keep scope", " Preserve evidence "],
      deliverables: ["Findings"],
      acceptance: ["Allow no findings"],
      destinations: [{ destinationId: "hosted", modelId: "gpt-5.6-sol" }],
    });
    expect(
      view
        .node("composer-preview-bytes")
        .children[0]?.children.some((node) => node.textContent.includes("non-dispatch-preview")),
    ).toBe(true);
    expect(api.mock.calls.some(([path]) => /issue|start|approve/.test(path))).toBe(false);
    await view.node("composer-instruction").emit("input");
    expect(view.node("composer-issue").disabled).toBe(true);
    expect(view.node("composer-preview").disabled).toBe(false);
    model.value = "unregistered-model";
    await model.emit("change");
    expect(view.node("composer-mode").value).toBe("legacy-verbatim");
    expect(
      view
        .node("composer-mode")
        .children.slice(1)
        .every((option) => option.disabled),
    ).toBe(true);
  });

  it.each([false, true])(
    "handles stale issue with uncertain=%s without automatic retries",
    async (uncertain) => {
      const view = dom();
      const api = vi.fn(async (path: string) => {
        if (path === "/api/setup")
          return {
            setup: {
              registry: available({
                revision: 1,
                projects: [{ projectId: "project", displayName: "Project", repoId: "repo" }],
              }),
              destinations: available([
                { destinationId: "legacy", route: "cli", modelIds: ["model"] },
              ]),
            },
          };
        if (path === "/api/composer") return { capability: { enabled: true } };
        if (path === "/api/composer/preview")
          return {
            preview: {
              previewId: "fixed",
              children: [
                {
                  destinationId: "legacy",
                  requestId: "original-request",
                  taskSpecHash: "spec",
                  taskFileHash: "file",
                  rawSpec: "original spec",
                  taskMarkdown: "original task",
                },
              ],
            },
            previewSha256: "hash",
          };
        if (path === "/api/composer/issue")
          throw { code: uncertain ? "disconnected" : "composer_prompt_format_stale", uncertain };
        throw new Error(`Unexpected route ${path}`);
      });
      mountComposer({ api, document: view.document, presentation: view.presentation });
      await view.click("open-composer");
      view.node("composer-title").value = "Keep title";
      view.node("composer-instruction").value = "Keep objective";
      await view.click("composer-preview");
      await view.click("composer-issue");
      await view.click("composer-issue");
      expect(api.mock.calls.filter(([path]) => path === "/api/composer/issue")).toHaveLength(1);
      expect(api.mock.calls.filter(([path]) => path === "/api/composer/preview")).toHaveLength(1);
      expect(api.mock.calls.filter(([path]) => path === "/api/setup")).toHaveLength(1);
      expect(view.node("composer-issue").disabled).toBe(true);
      expect(view.node("composer-title").value).toBe("Keep title");
      expect(view.node("composer-instruction").value).toBe("Keep objective");
      if (uncertain) {
        expect(view.node("composer-message").textContent).toContain("original-request");
        expect(view.node("composer-preview").disabled).toBe(true);
      } else {
        expect(view.node("composer-message").textContent).toContain("発行しませんでした");
        await view.click("close-composer");
        await view.click("open-composer");
        expect(api.mock.calls.filter(([path]) => path === "/api/setup")).toHaveLength(2);
        expect(api.mock.calls.filter(([path]) => path === "/api/composer/preview")).toHaveLength(1);
        expect(view.node("composer-preview").disabled).toBe(false);
      }
    },
  );

  it("does not let an old archive collection re-enable an unavailable capability", async () => {
    const view = dom(),
      late = deferred<Reply>();
    const binding = { kind: "local_execution", requestId: "local-request", sequence: 1 };
    let capabilityReads = 0;
    const api = vi.fn(async (path: string) => {
      if (path === "/api/archive")
        return {
          capability:
            ++capabilityReads === 1
              ? { enabled: true, collectEnabled: true }
              : { enabled: false, collectEnabled: false },
        };
      if (path === "/api/archive/inspect") return { archive: archiveView(binding) };
      if (path === "/api/archive/collect") return late.promise;
      throw new Error(path);
    });
    mountArchive({
      api,
      document: view.document,
      presentation: view.presentation,
      currentBinding: () => binding,
    });
    await view.click("open-archive");
    expect(view.node("archive-collect").disabled).toBe(false);
    const collect = view.node("archive-collect").emit("click");
    await settle();
    await view.click("close-archive");
    await view.click("open-archive");
    expect(view.node("archive-collect").disabled).toBe(true);
    late.resolve({ archive: archiveView(binding, "complete") });
    await collect;
    expect(view.node("archive-collect").disabled).toBe(true);
    expect(view.node("archive-export").disabled).toBe(true);
    expect(view.node("archive-state").textContent).toBe("");
    await view.node("archive-collect").emit("click");
    expect(api.mock.calls.filter(([path]) => path === "/api/archive/collect")).toHaveLength(1);
  });

  it("invalidates a pending archive inspection when the new selection has no child binding", async () => {
    const view = dom(),
      inspection = deferred<Reply>();
    const original = { kind: "hosted_delivery", requestId: "hosted-request", revision: 2 };
    let selected: Reply | null = original;
    const api = vi.fn(async (path: string) => {
      if (path === "/api/archive") return { capability: { enabled: true, collectEnabled: true } };
      if (path === "/api/archive/inspect") return inspection.promise;
      throw new Error(path);
    });
    mountArchive({
      api,
      document: view.document,
      presentation: view.presentation,
      currentBinding: () => selected,
    });
    await view.click("open-archive");
    await view.click("close-archive");
    selected = null;
    await view.click("open-archive");
    inspection.resolve({ archive: archiveView(original, "complete") });
    await settle();
    expect(view.node("archive-message").textContent).toContain("依頼を1件");
    expect(view.node("archive-state").textContent).toBe("");
    expect(view.node("archive-collect").disabled).toBe(true);
    expect(view.node("archive-export").disabled).toBe(true);
    await view.node("archive-collect").emit("click");
    expect(api.mock.calls.filter(([path]) => path === "/api/archive/inspect")).toHaveLength(1);
    expect(api.mock.calls.some(([path]) => path === "/api/archive/collect")).toBe(false);
  });

  it("binds hosted archives exactly and gives fanout no aggregate or unrelated local binding", async () => {
    const view = dom(),
      task = hosted();
    const group = {
      kind: "fanout",
      fanoutId: "fanout",
      total: 1,
      available: 0,
      pending: 1,
      fullDeliverySufficient: 0,
      children: [],
    };
    const api = vi.fn(async (path: string, body?: Reply) => {
      if (path === "/api/operations")
        return { operations: { local: page([]), hosted: page([task]), fanout: page([group]) } };
      if (path === "/api/setup") return { setup: emptySetup() };
      if (path.startsWith("/api/operations/hosted_delivery/"))
        return { operation: available(task) };
      if (path.startsWith("/api/operations/fanout/")) return { operation: available(group) };
      if (path === "/api/archive") return { capability: { enabled: true, collectEnabled: true } };
      if (path === "/api/archive/inspect") return { archive: archiveView(body?.binding as Reply) };
      throw new Error(path);
    });
    const operations = operationsMount(view, api);
    mountArchive({
      api,
      document: view.document,
      presentation: view.presentation,
      currentBinding: () => operations.currentBinding(),
    });
    await settle();
    await selectLane(view, 1);
    expect(operations.currentBinding()).toEqual(task.binding);
    const evidence = descendants(view.node("operations-detail-content")).map(
      (element) => element.textContent,
    );
    expect(evidence).toContain(task.rawSpec);
    expect(evidence).toContain(task.taskMarkdown);
    await view.click("open-archive");
    expect(api.mock.calls.find(([path]) => path === "/api/archive/inspect")?.[1]).toEqual({
      version: "bridge-operations-1",
      binding: task.binding,
    });
    await view.click("close-archive");
    await selectLane(view, 2);
    expect(operations.currentBinding()).toBeNull();
    await view.click("open-archive");
    expect(view.node("archive-message").textContent).toContain("依頼を1件");
    expect(api.mock.calls.filter(([path]) => path === "/api/archive/inspect")).toHaveLength(1);
  });

  it("allows cancel during start, ignores duplicate starts and rejects a late older start reply", async () => {
    const view = dom(),
      task = hosted(),
      start = deferred<Reply>(),
      cancel = deferred<Reply>();
    const api = vi.fn(async (path: string, body?: Reply) => {
      if (path === "/api/operations")
        return { operations: { ...emptyOverview(), hosted: page([task]) } };
      if (path === "/api/setup") return { setup: emptySetup() };
      if (path.startsWith("/api/operations/hosted_delivery/"))
        return { operation: available(task) };
      if (path === "/api/operations/actions") {
        if (body?.action === "start") return start.promise;
        if (body?.action === "cancel") return cancel.promise;
      }
      throw new Error(path);
    });
    const operations = operationsMount(view, api);
    await settle();
    await selectLane(view, 1);
    await action(view, "開始").emit("click");
    await settle();
    expect(action(view, "開始").disabled).toBe(true);
    expect(action(view, "停止を要求").disabled).toBe(false);
    await action(view, "開始").emit("click");
    await action(view, "停止を要求").emit("click");
    await settle();
    const mutations = () => api.mock.calls.filter(([path]) => path === "/api/operations/actions");
    expect(mutations()).toHaveLength(2);
    expect(mutations().map(([, body]) => body?.action)).toEqual(["start", "cancel"]);
    expect(mutations().map(([, body]) => body?.binding)).toEqual([task.binding, task.binding]);
    cancel.resolve({
      operation: available({
        ...task,
        binding: { ...task.binding, revision: 4 },
        state: "unknown",
        cancelRequestedAt: "2026-10-03T09:00:00.000Z",
        capabilities: {
          start: { enabled: false },
          cancel: { enabled: false },
          reconcile: { enabled: true },
        },
      }),
    });
    await settle();
    start.resolve({
      operation: available({
        ...task,
        binding: { ...task.binding, revision: 3 },
        state: "unknown",
      }),
    });
    await settle();
    expect(operations.currentBinding()?.revision).toBe(4);
    expect(action(view, "開始").disabled).toBe(true);
    expect(
      descendants(view.node("operations-detail-content")).some((element) =>
        element.textContent.includes("停止要求 2026-10-03"),
      ),
    ).toBe(true);
    await action(view, "開始").emit("click");
    await operations.refresh();
    expect(operations.currentBinding()?.revision).toBe(4);
    expect(mutations()).toHaveLength(2);
  });
});

describe("independent operation selection isolation", () => {
  it("does not disable task B after task A action rejects late", async () => {
    const view = dom(),
      a = hosted(),
      b = {
        ...hosted(),
        binding: { ...hosted().binding, requestId: "dddddddd-dddd-4ddd-dddd-dddddddddddd" },
        presentation: { ...hosted().presentation, title: "Other task" },
      };
    let fail!: () => void;
    const late = new Promise<Reply>((_resolve, reject) => {
      fail = () => reject(new Error("fixture late failure"));
    });
    const api: Api = async (path, body) => {
      if (path === "/api/operations")
        return { operations: { ...emptyOverview(), hosted: page([a, b]) } };
      if (path === "/api/setup") return { setup: emptySetup() };
      if (path.endsWith(a.binding.requestId)) return { operation: available(a) };
      if (path.endsWith(b.binding.requestId)) return { operation: available(b) };
      if (path === "/api/operations/actions" && body?.action === "start") return late;
      throw new Error(path);
    };
    operationsMount(view, api);
    await settle();
    await selectLane(view, 1);
    await action(view, "開始").emit("click");
    await settle();
    const group = view.node("operations-list").children[1];
    if (!group) throw new Error("fixture operation group missing");
    const choice = group.children.filter((e) => e.tagName === "button")[1];
    if (!choice) throw new Error("fixture second operation missing");
    await choice.emit("click");
    await settle();
    fail();
    await settle();
    expect(action(view, "開始").disabled).toBe(false);
    expect(action(view, "停止を要求").disabled).toBe(false);
  });
});
