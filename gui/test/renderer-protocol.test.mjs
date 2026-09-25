import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { PRODUCTION_RENDERER_URL, rendererFilePath, resolveRendererUrl } from "../dist/main/renderer-protocol.js";

test("production uses the privileged renderer scheme while development keeps its HTTP override", () => {
  assert.equal(PRODUCTION_RENDERER_URL, "bridge-gui://app/index.html");
  assert.equal(resolveRendererUrl(false, "http://127.0.0.1:5173"), "http://127.0.0.1:5173");
  assert.equal(resolveRendererUrl(true, "http://127.0.0.1:5173"), PRODUCTION_RENDERER_URL);
  assert.equal(resolveRendererUrl(false, undefined), PRODUCTION_RENDERER_URL);
});

test("renderer protocol maps same-origin paths into the renderer directory", () => {
  const rendererDirectory = path.resolve("gui", "dist", "renderer");
  assert.equal(rendererFilePath("bridge-gui://app/", rendererDirectory), path.join(rendererDirectory, "index.html"));
  assert.equal(rendererFilePath("bridge-gui://app/index.html", rendererDirectory), path.join(rendererDirectory, "index.html"));
  assert.equal(rendererFilePath("bridge-gui://app/assets/index.js", rendererDirectory), path.join(rendererDirectory, "assets", "index.js"));
});

test("renderer protocol rejects foreign hosts, schemes, and paths outside the renderer directory", () => {
  const rendererDirectory = path.resolve("gui", "dist", "renderer");
  assert.equal(rendererFilePath("bridge-gui://other/index.html", rendererDirectory), null);
  assert.equal(rendererFilePath("https://app/index.html", rendererDirectory), null);
  assert.equal(rendererFilePath("bridge-gui://app/%2e%2e%2fmain/main.js", rendererDirectory), null);
  assert.equal(rendererFilePath("not a URL", rendererDirectory), null);
});
