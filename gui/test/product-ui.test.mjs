import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { productNavigation, productStartupError, productUiProfile, productUrl, revealExistingProductDetail, startProductUi } from "../dist/main/product-ui.js";

const server = { origin: "http://127.0.0.1:41234", token: "test-token", url: "unused", close: async () => {} };
test("default product profile is production; demo is explicit and invalid values fail closed", () => {
  assert.equal(productUiProfile(undefined), "production");
  assert.equal(productUiProfile("demo"), "demo");
  assert.throws(() => productUiProfile("fake-production"));
});

test("product server loads only the selected checkout and keeps runtime paths host-local", async () => {
  const root = path.resolve("checkout");
  let loaded;
  let options;
  const actual = await startProductUi(root, { CHATGPT_BRIDGE_UI_PROFILE: "demo" }, async (url) => {
    loaded = url;
    return { startUiServer: async (value) => { options = value; return server; } };
  });
  assert.equal(actual, server);
  assert.match(loaded, /\/dist\/ui\/server\.js$/u);
  assert.deepEqual(options, { profile: "demo", stateDir: path.join(root, "runtime"), port: 0 });
});

test("window navigation accepts only product root with known views and task identity", () => {
  const task = "12345678-1234-4234-9234-123456789abc";
  const good = `${server.origin}/?view=detail&tab=evidence&task=${task}`;
  assert.deepEqual(productNavigation(good, server.origin), { view: "detail", tab: "evidence", task });
  for (const bad of [
    "https://example.com/?view=detail", "javascript:alert(1)", `${server.origin}/api/bootstrap?view=detail`,
    `${server.origin}/?view=detail&task=../../secret`, `${server.origin}/?view=other`,
    `${server.origin}/?view=detail&tab=unknown`, `${server.origin}/?view=detail&view=dock`, `${server.origin}/?view=detail&redirect=https://example.com`,
    "http://user:pass@127.0.0.1:41234/?view=detail",
  ]) assert.equal(productNavigation(bad, server.origin), null, bad);
});

test("capability is added by main to fragment only; untrusted input cannot provide it", () => {
  const url = new URL(productUrl(server, "dock"));
  assert.equal(url.origin, server.origin);
  assert.equal(url.searchParams.get("view"), "dock");
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("token"), server.token);
});

test("default launch uses v2 isolated window while explicit legacy route is preserved", async () => {
  const source = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  assert.match(source, /void showProductDock\(\);/u);
  assert.match(source, /width: 280, height: 380/u);
  assert.match(source, /nodeIntegration: false, sandbox: true, partition: "bridge-v2-ui"/u);
  assert.match(source, /従来のブラウザチャット/u);
  assert.match(source, /productNavigation\(target, server.origin\)/u);
  assert.match(source, /if \(!legacyPollingStarted\)/u);
});

test("repeated Details and hide/reopen preserve renderer drafts without reload", () => {
  const draft = { text: "unsent draft", pending: true, selected: "original-task" };
  let loads = 0; let shows = 0; let restores = 0;
  const window = {
    isMinimized: () => true, restore: () => { restores++; },
    show: () => { shows++; }, focus: () => {},
    loadURL: () => { loads++; draft.text = ""; },
  };
  assert.equal(revealExistingProductDetail(undefined), false);
  for (let reopen = 0; reopen < 3; reopen++) assert.equal(revealExistingProductDetail(window), true);
  assert.equal(loads, 0);
  assert.equal(shows, 3);
  assert.equal(restores, 3);
  assert.deepEqual(draft, { text: "unsent draft", pending: true, selected: "original-task" });
});

test("native load failures never disclose the launch capability URL", () => {
  const error = new Error("ERR_FAILED loading http://127.0.0.1:41234/#token=PRIVATE_TEST_CAPABILITY");
  assert.doesNotMatch(productStartupError(error), /PRIVATE_TEST_CAPABILITY|#token|127\.0\.0\.1/u);
  assert.doesNotMatch(productStartupError({ code: "ERR_MODULE_NOT_FOUND", message: error.message }), /PRIVATE_TEST_CAPABILITY/u);
});

test("explicit production deployment module reaches the shared product server", async () => {
  let options;
  await startProductUi(path.resolve("checkout"), { CHATGPT_BRIDGE_DEPLOYMENT_MODULE: "/trusted/deployment.mjs" }, async () => ({ startUiServer: async value => { options = value; return server; } }));
  assert.equal(options.deploymentModule, "/trusted/deployment.mjs");
  assert.equal(options.profile, "production");
});
