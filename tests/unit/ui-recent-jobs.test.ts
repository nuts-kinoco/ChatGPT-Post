import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildUiOperationsSources } from "../../src/ui/deployment-operations.js";
import { UiOperationsService } from "../../src/ui/operations.js";
import { openUiService, type TaskUiService } from "../../src/ui/service.js";

const resources: { path: string; service: TaskUiService }[] = [];
afterEach(async () => {
  for (const r of resources.splice(0)) {
    r.service.close();
    await rm(r.path, { recursive: true, force: true });
  }
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "bridge-recent-ui-")),
    service = await openUiService({ stateDir: path, profile: "demo" });
  resources.push({ path, service });
  return service;
}
it("new CLI-ledger records appear first without displacing an explicitly selected old UUID", async () => {
  const service = await fixture(),
    ids = [];
  for (let i = 0; i < 68; i++)
    ids.push(service.createDemo({ title: `Synthetic monitor ${i}` }).task.summary.requestId);
  const old = ids[0];
  if (!old) throw new Error("Expected old synthetic record");
  const page = service.runtime.store.recentPage("", 2);
  expect(page.requestIds).toEqual(ids.slice(-2).reverse());
  expect(page.next).toBe(ids.at(-2));
  expect(service.runtime.store.recentPage(page.next ?? "", 2).requestIds).toEqual(
    ids.slice(-4, -2).reverse(),
  );
  const bootstrap = service.bootstrapPage(old);
  expect(bootstrap.tasks).toHaveLength(65);
  expect(bootstrap.tasks[0]?.requestId).toBe(ids.at(-1));
  expect(bootstrap.tasks.at(-1)?.requestId).toBe(old);
  const operations = new UiOperationsService(buildUiOperationsSources(service));
  const overview = await operations.overview({ limit: 2 });
  expect(overview.local.state).toBe("available");
  if (overview.local.state === "available") expect(overview.local.value.items).toHaveLength(2);
  expect(() => service.runtime.store.recentPage(randomUUID(), 2)).toThrow("cursor_missing");
  expect(() => service.runtime.store.recentPage("", 257)).toThrow("page_invalid");
});
