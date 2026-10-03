import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/ui/public/app.js";
import { startUiServer, type UiServerHandle } from "../../src/ui/server.js";

const opened: { path: string; server: UiServerHandle }[] = [];
afterEach(async () => {
  for (const item of opened.splice(0)) {
    await item.server.close();
    await rm(item.path, { recursive: true, force: true });
  }
});
async function open() {
  const path = await mkdtemp(join(tmpdir(), "bridge-ops-http-"));
  const factory = vi.fn(() => ({}));
  const server = await startUiServer({
    stateDir: path,
    profile: "demo",
    operationsSources: factory,
  });
  opened.push({ path, server });
  return { server, factory };
}
function call(server: UiServerHandle, path: string, input?: unknown) {
  return fetch(server.origin + path, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${server.token}`,
      ...(input === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
describe("route-neutral authenticated HTTP wiring", () => {
  it("uses the real local ledger, keeps missing hosted/fanout explicit, and instantiates trusted ports once", async () => {
    const { server, factory } = await open();
    const task = server.service.createDemo({
      title: "Synthetic CLI fixture",
      taskMarkdown: "No external execution",
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(server.service);
    const page = await (await call(server, "/api/operations")).json();
    expect(page.operations.local.value.items[0].value.binding.requestId).toBe(
      task.task.summary.requestId,
    );
    expect(page.operations.hosted.state).toBe("unavailable");
    expect(page.operations.fanout.state).toBe("unavailable");
    const detail = await (
      await call(server, `/api/operations/local_execution/${task.task.summary.requestId}`)
    ).json();
    expect(detail.operation.value.task.result).toEqual(task.task.result);
    expect(detail.operation.value.delivery.fullDeliverySufficient).toBe(false);
    const setup = await (await call(server, "/api/setup")).json();
    expect(setup.setup.registry.state).toBe("unavailable");
  });
  it("rejects unauthenticated, extra query authority and malformed union actions", async () => {
    const { server } = await open();
    expect((await fetch(`${server.origin}/api/operations`)).status).toBe(401);
    for (const body of [
      { limit: 65 },
      { localAfter: 0 },
      { localAfter: null },
      { limit: 1, secret: "never-accepted" },
    ])
      expect((await call(server, "/api/operations/query", body)).status).toBe(400);
    expect(
      (
        await call(server, "/api/operations/actions", {
          version: "bridge-operations-1",
          action: "start",
          binding: { kind: "hosted_delivery" },
          authenticated: true,
        })
      ).status,
    ).toBe(400);
    expect((await call(server, "/api/operations?secret=x")).status).toBe(404);
  });
  it("the actual browser API client reaches underscore route kinds and still rejects external paths", async () => {
    const { server } = await open(),
      task = server.service.createDemo({});
    const client = createApiClient(server.token, (path: string, init: RequestInit) =>
      fetch(server.origin + path, init),
    );
    const response = await client(`/api/operations/local_execution/${task.task.summary.requestId}`);
    expect(response.operation.state).toBe("available");
    const hosted = await client(`/api/operations/hosted_delivery/${task.task.summary.requestId}`);
    expect(hosted.operation.state).toBe("unavailable");
    await expect(client("https://example.invalid/api/operations")).rejects.toMatchObject({
      code: "invalid_path",
    });
  });
});
