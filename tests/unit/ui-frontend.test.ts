/* biome-ignore-all lint/style/noNonNullAssertion: Test fixtures assert the required generated DOM and core records. */
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoTask } from "../../src/ui/demo.js";
import { buildUiOperationsSources } from "../../src/ui/deployment-operations.js";
import { UiOperationsService } from "../../src/ui/operations.js";
import {
  actionBinding,
  chooseSnapshot,
  chooseSummary,
  consumeToken,
  createApiClient,
  markdownHash,
} from "../../src/ui/public/app.js";
import { openUiService, type TaskUiService } from "../../src/ui/service.js";

const html = readFileSync(new URL("../../src/ui/public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../../src/ui/public/app.js", import.meta.url), "utf8");
const presentationScript = readFileSync(
  new URL("../../src/ui/public/presentation.js", import.meta.url),
  "utf8",
);
const catalogScript = readFileSync(
  new URL("../../src/ui/public/provider-catalog-view.js", import.meta.url),
  "utf8",
);
const notificationScript = readFileSync(
  new URL("../../src/ui/public/notification-view.js", import.meta.url),
  "utf8",
);
const counterScript = readFileSync(
  new URL("../../src/ui/public/pro-counter-view.js", import.meta.url),
  "utf8",
);
const archiveScript = readFileSync(
  new URL("../../src/ui/public/archive-view.js", import.meta.url),
  "utf8",
);
const composerScript = readFileSync(
  new URL("../../src/ui/public/composer-view.js", import.meta.url),
  "utf8",
);
const operationsScript = readFileSync(
  new URL("../../src/ui/public/operations-view.js", import.meta.url),
  "utf8",
);
const css = readFileSync(new URL("../../src/ui/public/styles.css", import.meta.url), "utf8");
type Listener = (event: Record<string, unknown>) => unknown;
class Element {
  files?: { size: number; arrayBuffer: () => Promise<ArrayBuffer> }[];
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  open = false;
  className = "";
  id = "";
  title = "";
  tabIndex = 0;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Element[] = [];
  listeners = new Map<string, Listener[]>();
  classList = {
    toggle: (name: string, on: boolean) => {
      const classes = new Set(this.className.split(/\s+/));
      if (on) classes.add(name);
      else classes.delete(name);
      this.className = [...classes].join(" ");
    },
  };
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  append(...elements: Element[]) {
    this.children.push(...elements);
  }
  replaceChildren(...elements: Element[]) {
    this.children = elements;
  }
  querySelector(_selector: string) {
    this.children[0] ??= new Element();
    return this.children[0];
  }
  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  focused = false;
  focus() {
    this.focused = true;
  }
  scrollIntoView() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  async emit(type: string) {
    for (const listener of this.listeners.get(type) || [])
      await listener({ target: this, preventDefault() {} });
  }
}
function dom() {
  const nodes: Element[] = [],
    byId = new Map<string, Element>();
  for (const match of html.matchAll(/<[a-z][^>]*>/gi)) {
    const element = new Element();
    for (const attr of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) {
      const key = attr[1]!,
        value = attr[2]!;
      element.attributes[key] = value;
      if (key === "id") {
        element.id = value;
        if (byId.has(value)) throw new Error(`Duplicate HTML id ${value}`);
        byId.set(value, element);
      }
      if (key === "class") element.className = value;
      if (key.startsWith("data-")) element.dataset[key.slice(5)] = value;
    }
    nodes.push(element);
  }
  const document = {
    hidden: false,
    body: new Element(),
    documentElement: new Element(),
    createElement: () => new Element(),
    getElementById: (id: string) => {
      const element = byId.get(id);
      if (!element) throw new Error(`Missing HTML element ${id}`);
      return element;
    },
    querySelectorAll: (selector: string) =>
      selector === "dialog[open]"
        ? nodes.filter(
            (node) =>
              ["draft-dialog", "presentation-dialog", "diagnostics"].includes(node.id) && node.open,
          )
        : selector.startsWith("[data-")
          ? nodes.filter((node) => node.dataset[selector.slice(6, -1)] !== undefined)
          : nodes.filter((node) => node.className.split(" ").includes(selector.slice(1))),
  };
  return { document, node: document.getElementById, nodes };
}
async function settle() {
  for (let index = 0; index < 8; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const resources: { directory: string; service: TaskUiService }[] = [];
afterEach(async () => {
  for (const { directory, service } of resources.splice(0)) {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
async function service(profile: "production" | "demo") {
  const directory = await mkdtemp(join(tmpdir(), "bridge-ui-frontend-"));
  const service = await openUiService({ profile, stateDir: directory });
  resources.push({ directory, service });
  return service;
}
async function harness(
  service: TaskUiService,
  options: {
    search?: string;
    hook?: (path: string, method: string) => Promise<void>;
    after?: (path: string, result: unknown) => Promise<void>;
    extra?: (path: string, body: Record<string, unknown>) => Promise<unknown> | unknown;
  } = {},
) {
  const view = dom(),
    calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  let preferences = {
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
  const intervals: (() => void)[] = [];
  const operations = new UiOperationsService(buildUiOperationsSources(service));
  const fetcher = async (path: string, init: RequestInit) => {
    const method = init.method || "GET",
      body = JSON.parse((init.body as string) || "{}");
    calls.push({ path, method, body });
    await options.hook?.(path, method);
    try {
      let result: unknown = await options.extra?.(path, body);
      if (result !== undefined) {
      } else if (path === "/api/setup")
        result = { ...service.metadata(), setup: await operations.setup() };
      else if (["/api/operations/query", "/api/operations"].includes(path))
        result = { ...service.metadata(), operations: await operations.overview(body) };
      else if (path === "/api/presentation") {
        if (method === "POST") {
          if (body.expectedRevision !== preferences.revision) throw new Error("stale_presentation");
          preferences = {
            ...preferences,
            revision: preferences.revision + 1,
            values: { ...preferences.values, ...body.patch },
          };
        }
        result = {
          ...service.metadata(),
          presentation: preferences,
          nativeControls: { available: false },
        };
      } else if (path.startsWith("/api/bootstrap/page"))
        result = service.bootstrapPage(path.split("/")[4] ?? "");
      else if (path === "/api/demo/tasks") result = service.createDemo(body);
      else if (path === "/api/validate") result = service.validate(body);
      else if (path === "/api/tasks") result = service.import(body);
      else {
        const [, , , id, action] = path.split("/");
        if (!action) result = service.task(id!);
        else if (action === "approve") result = await service.approve(id!, body);
        else if (action === "start") result = await service.start(id!, body);
        else if (action === "ack") result = await service.acknowledge(id!, body);
        else if (action === "cancel") result = await service.cancel(id!);
        else if (action === "reconcile") result = await service.reconcile(id!);
        else if (action === "demo-observation")
          result = await service.demoObservation(id!, body.outcome);
        else throw new Error(`Unknown route ${path}`);
      }
      await options.after?.(path, result);
      return new Response(JSON.stringify(result), { status: 200 });
    } catch (error) {
      const problem = error as Error & { code?: string; status?: number };
      return new Response(
        JSON.stringify({ error: { code: problem.code || "test_error", message: problem.message } }),
        { status: problem.status || 409 },
      );
    }
  };
  const values = new Map<string, string>();
  const themeValues = new Map<string, string>();
  const location = {
    hash: "#token=test-local-capability",
    pathname: "/",
    search: options.search || "",
    href: `http://127.0.0.1:4000/${options.search || ""}#token=test-local-capability`,
    assign: vi.fn(),
  };
  const history = {
    replaceState: vi.fn(() => {
      location.hash = "";
    }),
  };
  runInNewContext(
    `${presentationScript}\n${operationsScript}\n${composerScript}\n${archiveScript}\n${counterScript}\n${notificationScript}\n${catalogScript}\n${script.replace(/^import .*?;$/gm, "")}`.replace(
      /\bexport /g,
      "",
    ),
    {
      window: {
        location,
        history,
        sessionStorage: {
          getItem: (key: string) => values.get(key),
          setItem: (key: string, value: string) => values.set(key, value),
        },
        localStorage: {
          getItem: (key: string) => themeValues.get(key),
          setItem: (key: string, value: string) => {
            themeValues.set(key, value);
          },
        },
        confirm: () => true,
      },
      document: view.document,
      fetch: fetcher,
      crypto: webcrypto,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      AbortController,
      setTimeout,
      clearTimeout,
      setInterval: (callback: () => void) => {
        intervals.push(callback);
        return intervals.length;
      },
      console,
    },
  );
  await settle();
  return {
    ...view,
    calls,
    location,
    history,
    themeValues,
    poll: async () => {
      for (const callback of intervals) callback();
      await settle();
    },
    click: async (id: string) => {
      await view.node(id).emit("click");
      await settle();
    },
  };
}

describe("API-driven product frontend", () => {
  it("has unique IDs across every same-frame page and dialog", () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("starts collapsed and preserves unsent input through expand/collapse", async () => {
    const runtime = await service("demo"),
      app = await harness(runtime);
    expect(app.document.body.className).toContain("resident-view");
    await app.click("resident-expand");
    expect(app.document.body.className).not.toContain("resident-view");
    expect(app.node("show-presentation").focused).toBe(true);
    await app.click("new-task");
    app.node("draft-md").value = "unsent private draft";
    await app.node("draft-md").emit("input");
    await app.click("close-draft");
    await app.click("collapse-product");
    expect(app.node("resident-expand").focused).toBe(true);
    expect(app.document.body.className).toContain("resident-view");
    await app.click("resident-expand");
    await app.click("new-task");
    expect(app.node("draft-md").value).toBe("unsent private draft");
    expect(app.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
  it("persists only a theme cache in the browser and saves all preferences through the API", async () => {
    const runtime = await service("demo"),
      app = await harness(runtime);
    await app.click("resident-settings");
    await app.click("theme-dark");
    expect(app.document.documentElement.attributes["data-theme"]).toBe("dark");
    expect([...app.themeValues.entries()]).toEqual([["bridge.product.theme", "dark"]]);
    expect(
      app.calls.find((call) => call.path === "/api/presentation" && call.method === "POST")?.body,
    ).toEqual({ expectedRevision: 1, patch: { theme: "dark" } });
    expect(app.node("pref-alwaysOnTop").disabled).toBe(true);
    expect(app.node("pref-hideWhenInactive").disabled).toBe(true);
    await app.click("pref-completionNotifications");
    expect(app.node("pref-completionNotifications").attributes["aria-checked"]).toBe("false");
  });
  it("keeps option A geometry for all pages and suspends an open draft through collapse", async () => {
    const core = await service("demo"),
      app = await harness(core);
    await app.click("resident-expand");
    await app.click("new-task");
    app.node("draft-spec").value = "unsent exact draft";
    expect(app.node("draft-dialog").open).toBe(true);
    await app.click("collapse-draft-dialog");
    expect(app.document.body.className).toContain("resident-view");
    expect(app.node("draft-dialog").open).toBe(false);
    await app.click("resident-expand");
    expect(app.node("draft-dialog").open).toBe(true);
    expect(app.node("draft-spec").value).toBe("unsent exact draft");
    expect(css).toContain("--product-width: min(440px, 100vw)");
    expect(css).toContain("--product-height: min(604px, 100dvh)");
    expect(css).toMatch(/\.option-a \.shell,\s*\.option-a \.dialog/);
    expect(app.node("tab-evidence").attributes["aria-selected"]).toBe("true");
  });

  it("keeps manual composer secondary and unavailable recipes fail closed", async () => {
    const core = await service("demo"),
      app = await harness(core);
    expect(app.document.body.className).toContain("operations-home");
    expect(app.node("composer-dialog").open).toBe(false);
    await app.click("open-composer");
    expect(app.node("composer-dialog").open).toBe(true);
    expect(app.node("composer-preview").disabled).toBe(true);
    expect(app.node("composer-issue").disabled).toBe(true);
    expect(app.node("composer-message").textContent).toContain("信頼済みテンプレート");
    expect(app.calls.filter((call) => call.path === "/api/composer/issue")).toHaveLength(0);
  });
  it("manual edits invalidate exact previews and explicit issue sends only the fixed preview binding", async () => {
    const core = await service("demo");
    const task = demoTask({});
    const id = JSON.parse(task.rawSpec).request_id;
    const preview = {
      previewId: "synthetic-preview",
      children: [
        {
          destinationId: "synthetic",
          requestId: id,
          rawSpec: task.rawSpec,
          taskMarkdown: task.taskMarkdown,
          taskSpecHash: "a".repeat(64),
          taskFileHash: "b".repeat(64),
        },
      ],
    };
    const app = await harness(core, {
      extra: (path) =>
        path === "/api/setup"
          ? {
              ...core.metadata(),
              setup: {
                registry: {
                  state: "available",
                  value: {
                    revision: 1,
                    projects: [
                      { projectId: "project", repoId: "synthetic-demo", displayName: "Synthetic" },
                    ],
                  },
                },
                destinations: {
                  state: "available",
                  value: [
                    {
                      destinationId: "synthetic",
                      route: "cli",
                      modelIds: ["synthetic-model"],
                      unavailableReason: null,
                    },
                  ],
                },
                quotas: { state: "available", value: [] },
              },
            }
          : path === "/api/composer"
            ? { ...core.metadata(), capability: { enabled: true } }
            : path === "/api/composer/preview"
              ? { ...core.metadata(), preview, previewSha256: "c".repeat(64) }
              : path === "/api/composer/issue"
                ? { ...core.metadata(), issued: { commit: "d".repeat(40), requestIds: [id] } }
                : undefined,
    });
    await app.click("open-composer");
    app.node("composer-project").value = "project";
    app.node("composer-title").value = "Synthetic title";
    app.node("composer-instruction").value = "Synthetic only";
    const target = app.node("composer-targets").children[0];
    if (!target) throw new Error("Expected target controls");
    target.children[0]!.value = "synthetic";
    await target.children[0]!.emit("change");
    target.children[1]!.value = "synthetic-model";
    await app.click("composer-preview");
    expect(app.node("composer-issue").disabled).toBe(false);
    expect(app.calls.filter((call) => call.path === "/api/composer/issue")).toHaveLength(0);
    app.node("composer-instruction").value = "changed";
    await app.node("composer-instruction").emit("input");
    expect(app.node("composer-issue").disabled).toBe(true);
    await app.click("composer-preview");
    await app.click("composer-issue");
    expect(app.calls.find((call) => call.path === "/api/composer/issue")?.body).toEqual({
      previewId: "synthetic-preview",
      previewSha256: "c".repeat(64),
    });
  });

  it("does not present a historical payload-only ACK as full artifact delivery or block proof completion", async () => {
    const runtime = await service("demo");
    const app = await harness(runtime, {
      after: async (path, response) => {
        if (path.endsWith("/ack")) {
          const view = response as import("../../src/contracts/ui.js").UiTaskResponse;
          // Synthetic API-view fixture for a historical receipt; this does not alter the ledger.
          view.task.delivery = {
            ...view.task.delivery,
            acknowledged: false,
            payloadAckObserved: true,
            materialization: "pending",
          };
          view.task.summary.deliveryAcknowledged = false;
          view.task.capabilities.ack = {
            enabled: true,
            reason: "fixture requester materializer is available",
          };
        }
      },
    });
    await app.click("new-demo");
    await app.click("approve");
    await app.click("start");
    const id = runtime.bootstrap().tasks[0]!.requestId;
    await runtime.demoObservation(id, "succeeded");
    await app.click("refresh");
    await app.click("ack-result");
    expect(app.node("result-ack").textContent).toContain("本文ACKのみ");
    expect(app.node("hs-ack").className).not.toContain("confirmed");
    expect(app.node("ack-result").disabled).toBe(false);
  });

  it("never auto-expands when a task completes and allows notification OFF without changing results", async () => {
    const runtime = await service("demo"),
      app = await harness(runtime);
    await app.click("resident-expand");
    await app.click("new-demo");
    await app.click("approve");
    await app.click("start");
    const id = runtime.bootstrap().tasks[0]!.requestId;
    await app.click("collapse-product");
    await runtime.demoObservation(id, "succeeded");
    await app.poll();
    expect(app.document.body.className).toContain("resident-view");
    expect(app.node("resident-status").textContent).toBe("完了");
    await app.click("disable-completion-toast");
    expect(app.node("completion-toast").hidden).toBe(true);
    expect(runtime.task(id).task.result.status).toBe("succeeded");
  });
  it("shows a bounded resident indicator when a different task completes without expanding", async () => {
    const runtime = await service("demo");
    const first = runtime.createDemo({ title: "Selected unfinished task" });
    let other = runtime.createDemo({ title: "Other completed task" });
    const app = await harness(runtime);
    app.node("task-select").value = first.task.summary.requestId;
    await app.node("task-select").emit("change");
    await settle();
    const id = other.task.summary.requestId;
    const binding = (view: typeof other) => ({
      taskSpecHash: view.task.result.task_spec_hash,
      taskFileHash: view.task.result.task_file_hash,
      sequence: view.task.result.observation_seq,
    });
    other = await runtime.approve(id, binding(other));
    other = await runtime.start(id, binding(other));
    await runtime.demoObservation(id, "succeeded");
    await app.poll();
    expect(app.document.body.className).toContain("resident-view");
    expect(app.node("resident-title").textContent).toBe("Selected unfinished task");
    expect(app.node("resident-notice").hidden).toBe(false);
    expect(app.node("resident-notice").textContent).toBe("結果 1");
    expect(app.node("resident-notice").title).toContain("Other completed task");
    await app.poll();
    expect(app.node("resident-notice").textContent).toBe("結果 1");
  });
  it("establishes a fresh non-notifying baseline when re-enabled after a hidden OFF interval", async () => {
    const runtime = await service("demo"),
      app = await harness(runtime);
    await app.click("resident-expand");
    await app.click("new-demo");
    await app.click("approve");
    await app.click("start");
    const id = runtime.bootstrap().tasks[0]!.requestId;
    await app.click("pref-completionNotifications");
    app.document.hidden = true;
    await runtime.demoObservation(id, "succeeded");
    await app.poll();
    app.document.hidden = false;
    await app.click("pref-completionNotifications");
    await app.poll();
    expect(app.node("completion-toast").hidden).toBe(true);
    expect(app.node("resident-notice").hidden).toBe(true);
    expect(runtime.task(id).task.result.status).toBe("succeeded");
    await app.click("new-demo");
    await app.click("approve");
    await app.click("start");
    const next = runtime.bootstrap().tasks.find((task) => task.requestId !== id)!;
    await runtime.demoObservation(next.requestId, "succeeded");
    await app.poll();
    expect(app.node("resident-notice").textContent).toBe("結果 1");
    expect(app.node("resident-notice").hidden).toBe(false);
  });
  it("does not establish a notification baseline from a task read started before re-enable", async () => {
    const runtime = await service("demo"),
      initial = await harness(runtime);
    await initial.click("new-demo");
    await initial.click("approve");
    await initial.click("start");
    const id = runtime.bootstrap().tasks[0]!.requestId;
    const gate = deferred<void>();
    let hold = false,
      captured = false;
    const app = await harness(runtime, {
      after: async (path) => {
        if (hold && path.startsWith("/api/bootstrap/page")) {
          hold = false;
          captured = true;
          await gate.promise;
        }
      },
    });
    await app.click("pref-completionNotifications");
    hold = true;
    void app.click("refresh");
    await vi.waitFor(() => expect(captured).toBe(true));
    await runtime.demoObservation(id, "succeeded");
    await app.click("pref-completionNotifications");
    gate.resolve();
    await settle();
    await app.poll();
    expect(app.node("resident-notice").hidden).toBe(true);
    expect(app.node("completion-toast").hidden).toBe(true);
  });
  it("uses local external assets, inert accepted raw text, and fixed compact dock", () => {
    expect(html).not.toMatch(/<script(?![^>]*src=)[^>]*>/);
    expect(html).not.toMatch(/\sstyle=|https?:\/\/|\son\w+=/);
    expect(script).not.toMatch(/\.innerHTML\s*=|eval\(|new Function\(/);
    expect(html).toContain('<pre id="task-md"');
    expect(html).not.toContain('<textarea id="task-md"');
    expect(css).toMatch(/body\.compact\s*\{[^}]*width:\s*280px;[^}]*height:\s*380px/s);
    expect(css).toContain("-webkit-app-region: drag");
  });
  it("bounds the dock content below its fixed header, result, and footer without overlap", () => {
    const dockHeight = 380,
      border = 2,
      header = 44,
      result = 60,
      footer = 39;
    const bodyBudget = dockHeight - border - header - result - footer;
    const rows = [22, 44, 30, 60, 14],
      gap = 4,
      padding = 24;
    expect(rows.reduce((total, row) => total + row, 0) + gap * 4 + padding).toBeLessThanOrEqual(
      bodyBudget,
    );
    expect(css).toContain("grid-template-rows: 22px 44px 30px minmax(0, 60px) 14px");
    expect(css).toMatch(
      /\.dock \.meta span\s*\{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/s,
    );
    expect(css).toMatch(/\.dock \.result\s*\{[^}]*height: 60px;[^}]*min-height: 60px/s);
    expect(css).toMatch(/\.dock \.phead button\s*\{[^}]*flex: 0 0 auto;[^}]*white-space: nowrap/s);
  });
  it("removes the fragment before storage and uses only a per-tab token", () => {
    const operations: string[] = [],
      values = new Map<string, string>();
    const location = { hash: "#token=secret", pathname: "/", search: "?view=dock" };
    const history = {
      replaceState: (_state: unknown, _title: string, path: string) => operations.push(path),
    };
    const storage = {
      setItem: (key: string, value: string) => {
        operations.push("store");
        values.set(key, value);
      },
      getItem: (key: string) => values.get(key),
    };
    expect(consumeToken(location, history, storage)).toBe("secret");
    expect(operations).toEqual(["/?view=dock", "store"]);
    expect(consumeToken({ ...location, hash: "" }, history, storage)).toBe("secret");
    expect(consumeToken({ ...location, hash: "#token=fresh" }, history, undefined)).toBe("fresh");
  });
  it("sends one same-origin bearer request and does not replay ambiguous POST failures", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("connection lost"));
    const api = createApiClient("secret", fetcher);
    await expect(api("/api/tasks", { rawSpec: "{}", taskMarkdown: "" })).rejects.toMatchObject({
      uncertain: true,
      code: "disconnected",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/api/tasks");
    expect(init.headers.Authorization).toBe("Bearer secret");
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    await expect(api("https://elsewhere.invalid/api/tasks", {})).rejects.toMatchObject({
      code: "invalid_path",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("binds mutations to inspected hashes and the exact terminal event", () => {
    const task = {
      result: { task_spec_hash: "spec", task_file_hash: "md", observation_seq: 7 },
      handshakes: { terminal_result: { eventId: "event", payloadSha256: "payload", sequence: 6 } },
    };
    expect(actionBinding(task, "start")).toEqual({
      taskSpecHash: "spec",
      taskFileHash: "md",
      sequence: 7,
    });
    expect(actionBinding(task, "ack")).toEqual({
      eventId: "event",
      payloadSha256: "payload",
      sequence: 6,
    });
    expect(() => actionBinding({ ...task, handshakes: { terminal_result: null } }, "ack")).toThrow(
      "終了結果",
    );
  });
  it("rejects stale and differently selected snapshots", () => {
    const current = { summary: { requestId: "new" }, result: { observation_seq: 4 } };
    expect(
      chooseSnapshot(
        current,
        { summary: { requestId: "old" }, result: { observation_seq: 9 } },
        "new",
      ),
    ).toBe(current);
    expect(
      chooseSnapshot(
        current,
        { summary: { requestId: "new" }, result: { observation_seq: 3 } },
        "new",
      ),
    ).toBe(current);
  });
  it("renders production fail-closed and preserves the separate draft during refresh", async () => {
    const runtime = await service("production"),
      task = runtime.import(demoTask({ title: "Production inspection" }));
    const app = await harness(runtime);
    expect(app.node("task-title").textContent).toBe(task.task.summary.title);
    expect(app.node("approve").disabled).toBe(true);
    expect(app.node("start").disabled).toBe(true);
    expect(app.node("new-demo").hidden).toBe(true);
    expect(app.node("start-reason").textContent).toContain("未構成");
    expect(app.node("start").title).toContain("unconfigured");
    await app.click("copy-draft");
    const copied = JSON.parse(app.node("draft-spec").value);
    expect(copied.request_id).not.toBe(task.task.summary.requestId);
    app.node("draft-md").value = "unsaved new body";
    await app.node("draft-md").emit("input");
    await app.click("refresh");
    expect(app.node("draft-md").value).toBe("unsaved new body");
    expect(app.node("task-md").textContent).toBe(task.task.taskMarkdown);
    expect(app.node("import-draft").disabled).toBe(true);
  });
  it("runs real demo core actions, blocks double starts, and ACKs the exact delivery", async () => {
    const runtime = await service("demo"),
      app = await harness(runtime);
    await app.click("new-demo");
    expect(app.node("profile-label").textContent).toBe("デモ専用");
    expect(app.node("dock-footer").textContent).toContain("デモ専用");
    await app.click("approve");
    await Promise.all([app.node("start").emit("click"), app.node("start").emit("click")]);
    await settle();
    expect(app.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(1);
    await vi.waitFor(() =>
      expect({
        status: app.node("main-status").textContent,
        error: app.node("message").textContent,
      }).toMatchObject({ status: "実行中" }),
    );
    const outcome = app.nodes.find((node) => node.dataset.observation === "succeeded")!;
    await outcome.emit("click");
    await settle();
    await vi.waitFor(() => expect(app.node("main-status").textContent).toBe("完了"));
    expect(app.node("evidence-receipt").textContent).toBe("合成記録のため発行なし");
    await app.click("ack-result");
    expect(app.node("result-ack").textContent).toBe("受領済み");
    expect(app.node("ack-result").disabled).toBe(true);
    const id = runtime.bootstrap().tasks[0]!.requestId,
      receipt = runtime.task(id).task.handshakes.terminal_result!;
    expect(app.calls.find((call) => call.path.endsWith("/ack"))!.body).toEqual({
      eventId: receipt.eventId,
      payloadSha256: receipt.payloadSha256,
      sequence: receipt.sequence,
    });
  });
  it("does not overwrite a newer selection when an older detail request returns", async () => {
    const runtime = await service("demo"),
      first = runtime.createDemo({ title: "First" }),
      second = runtime.createDemo({ title: "Second" });
    let block = false;
    const gate = deferred<void>();
    const app = await harness(runtime, {
      search: `?task=${first.task.summary.requestId}`,
      hook: async (path) => {
        if (block && path === `/api/tasks/${first.task.summary.requestId}`) await gate.promise;
      },
    });
    block = true;
    void app.node("refresh").emit("click");
    await settle();
    app.node("task-select").value = second.task.summary.requestId;
    await app.node("task-select").emit("change");
    await settle();
    expect(app.node("task-title").textContent).toBe("Second");
    gate.resolve();
    await settle();
    expect(app.node("task-title").textContent).toBe("Second");
  });
  it("requires an explicit read refresh after a dropped mutation and never replays it", async () => {
    const runtime = await service("demo");
    let drop = true;
    const app = await harness(runtime, {
      hook: async (path) => {
        if (drop && path === "/api/demo/tasks") {
          drop = false;
          runtime.createDemo({ title: "Committed before disconnect" });
          throw new Error("lost reply");
        }
      },
    });
    await app.click("new-demo");
    expect(app.node("new-demo").disabled).toBe(true);
    expect(app.node("message").textContent).toContain("自動再送せず");
    await app.click("new-demo");
    expect(app.calls.filter((call) => call.path === "/api/demo/tasks")).toHaveLength(1);
    await app.click("refresh");
    expect(app.node("task-title").textContent).toBe("Committed before disconnect");
    expect(runtime.bootstrap().tasks).toHaveLength(1);
  });
  it("keeps unknown state during recovery and uses dock cancellation without a second start", async () => {
    const runtime = await service("demo"),
      app = await harness(runtime);
    await app.click("new-demo");
    await app.click("approve");
    await app.click("start");
    await vi.waitFor(() => expect(app.node("main-status").textContent).toBe("実行中"));
    const unknown = app.nodes.find((node) => node.dataset.observation === "unknown")!;
    await unknown.emit("click");
    await settle();
    await vi.waitFor(() => expect(app.node("main-status").textContent).toBe("状況不明"));
    await app.click("reconcile");
    expect(app.node("main-status").textContent).toBe("状況不明");
    await app.click("dock-stop");
    await vi.waitFor(() =>
      expect(
        runtime.task(runtime.bootstrap().tasks[0]!.requestId).task.intent?.cancelAt,
      ).not.toBeNull(),
    );
    expect(app.node("main-status").textContent).toBe("状況不明");
    await app.nodes.find((node) => node.dataset.observation === "succeeded")!.emit("click");
    await settle();
    await vi.waitFor(() => expect(app.node("main-status").textContent).toBe("停止確認済み"));
    expect(app.node("dock-stop").disabled).toBe(true);
    expect(app.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(1);
  });
  it("imports exact CRLF file bytes only after validation and clears validation on edit", async () => {
    const runtime = await service("production"),
      app = await harness(runtime);
    const input = demoTask({ title: "Raw bytes" });
    input.taskMarkdown = input.taskMarkdown.replaceAll("\n", "\r\n");
    const spec = JSON.parse(input.rawSpec);
    spec.task_file_hash = await markdownHash(input.taskMarkdown, webcrypto);
    input.rawSpec = `${JSON.stringify(spec, null, 2).replaceAll("\n", "\r\n")}\r\n`;
    await app.click("new-task");
    for (const [id, source] of [
      ["import-spec", input.rawSpec],
      ["import-md", input.taskMarkdown],
    ]) {
      const bytes = new TextEncoder().encode(source!);
      app.node(id!).files = [{ size: bytes.length, arrayBuffer: async () => bytes.buffer }];
      await app.node(id!).emit("change");
      await settle();
    }
    await app.click("validate-draft");
    expect(app.node("import-draft").disabled).toBe(false);
    app.node("draft-md").value = input.taskMarkdown;
    await app.node("draft-md").emit("input");
    expect(app.node("import-draft").disabled).toBe(true);
    await app.click("validate-draft");
    await app.click("import-draft");
    const saved = runtime.task(spec.request_id).task;
    expect(saved.rawSpec).toBe(input.rawSpec);
    expect(saved.taskMarkdown).toBe(input.taskMarkdown);
    expect(app.node("task-json").textContent).toBe(input.rawSpec);
    expect(app.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(0);
  });
  for (const delayedAction of ["approve", "start"])
    it(`cancels while ${delayedAction} is pending and ignores its late stale response`, async () => {
      const runtime = await service("demo");
      const gate = deferred<void>();
      let waiting = false;
      const app = await harness(runtime, {
        after: async (path) => {
          if (path.endsWith(`/${delayedAction}`)) {
            waiting = true;
            await gate.promise;
          }
        },
      });
      await app.click("new-demo");
      if (delayedAction === "start") await app.click("approve");
      void app.node(delayedAction).emit("click");
      await vi.waitFor(() => expect(waiting).toBe(true));
      expect(app.node("start").disabled).toBe(true);
      expect(app.node("dock-stop").disabled).toBe(false);
      expect(app.node("cancel").disabled).toBe(false);
      await Promise.all([app.node("dock-stop").emit("click"), app.node("cancel").emit("click")]);
      await vi.waitFor(() => expect(app.node("main-status").textContent).toBe("停止確認済み"));
      expect(app.calls.filter((call) => call.path.endsWith("/cancel"))).toHaveLength(1);
      gate.resolve();
      await settle();
      expect(app.node("main-status").textContent).toBe("停止確認済み");
      expect(app.node("dock-stop").disabled).toBe(true);
      expect(app.calls.filter((call) => call.path.endsWith(`/${delayedAction}`))).toHaveLength(1);
    });
  it("preserves an observed ACK across equal-sequence pre-ACK task and bootstrap replies", async () => {
    const runtime = await service("demo");
    let view = runtime.createDemo({});
    const id = view.task.summary.requestId;
    view = await runtime.approve(id, actionBinding(view.task, "approve"));
    view = await runtime.start(id, actionBinding(view.task, "start"));
    const preAck = await runtime.demoObservation(id, "succeeded");
    const staleBootstrap = runtime.bootstrap();
    let stale = false;
    const app = await harness(runtime, {
      after: async (path, result) => {
        if (stale && path.startsWith("/api/bootstrap/page"))
          Object.assign(result as object, structuredClone(staleBootstrap));
        if (stale && path === `/api/tasks/${id}`)
          Object.assign(result as object, structuredClone(preAck));
      },
    });
    await app.click("ack-result");
    const postAck = runtime.task(id);
    expect(postAck.task.result.observation_seq).toBe(preAck.task.result.observation_seq);
    const selected = chooseSnapshot(postAck.task, preAck.task, id);
    expect(selected.handshakes.result_ack).toEqual(postAck.task.handshakes.result_ack);
    expect(selected.delivery.acknowledged).toBe(true);
    expect(selected.summary.deliveryAcknowledged).toBe(true);
    expect(chooseSummary(postAck.task.summary, preAck.task.summary).deliveryAcknowledged).toBe(
      true,
    );
    stale = true;
    await app.click("refresh");
    expect(app.node("result-ack").textContent).toBe("受領済み");
    expect(app.node("ack-result").disabled).toBe(true);
    expect(app.node("dock-result-detail").textContent).toContain("成果物受領済み");
    expect(app.calls.filter((call) => call.path.endsWith("/ack"))).toHaveLength(1);
    const payloadOnly = structuredClone(postAck.task);
    payloadOnly.delivery.acknowledged = false;
    payloadOnly.delivery.materialization = "pending";
    payloadOnly.delivery.payloadAckObserved = true;
    payloadOnly.summary.deliveryAcknowledged = false;
    const rawAck = chooseSnapshot(payloadOnly, preAck.task, id);
    expect(rawAck.handshakes.result_ack).toEqual(payloadOnly.handshakes.result_ack);
    expect(rawAck.delivery.acknowledged).toBe(false);
    expect(rawAck.delivery.payloadAckObserved).toBe(true);
    expect(rawAck.delivery.materialization).not.toBe("verified");
    expect(chooseSnapshot(rawAck, postAck.task, id).delivery.acknowledged).toBe(true);
    const otherPayload = structuredClone(preAck.task);
    otherPayload.handshakes.terminal_result!.payloadSha256 = "different-payload";
    expect(chooseSnapshot(postAck.task, otherPayload, id).handshakes.result_ack).toBeNull();
    expect(
      chooseSummary(postAck.task.summary, { ...preAck.task.summary, runId: "different-run" })
        .deliveryAcknowledged,
    ).toBe(false);
  });
  it("keeps compact navigation token-free and names the current task", async () => {
    const runtime = await service("demo"),
      task = runtime.createDemo({});
    const app = await harness(runtime, { search: "?view=dock" });
    const details = app.nodes.find((node) => node.dataset.open === "approval")!;
    await details.emit("click");
    expect(app.location.assign).toHaveBeenCalledWith(
      `/?view=detail&tab=approval&task=${task.task.summary.requestId}`,
    );
    expect(app.history.replaceState).toHaveBeenCalled();
    expect(app.document.body.className).toContain("compact");
  });
  it("hashes raw Markdown bytes rather than newline-normalized display text", async () => {
    expect(await markdownHash("x\r\n", webcrypto)).not.toBe(await markdownHash("x\n", webcrypto));
  });
});
