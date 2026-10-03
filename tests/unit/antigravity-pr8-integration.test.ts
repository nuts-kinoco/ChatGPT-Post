/** Cross-stack fake/pure integration only; no browser, metadata process, model or authentication. */
import { describe, expect, it } from "vitest";
import { ProviderCatalogCache } from "../../src/adapters/provider-catalog-cache.js";
import { buildModelCatalog, legacyCatalogSelection } from "../../src/chatgpt/model-catalog.js";
import { runBusCli } from "../../src/cli/bus.js";
import { parseStrictJsonBytes, parseStrictProviderJsonBytes } from "../../src/contracts/task.js";
import { agentLabel } from "../../src/ui/public/app.js";

const iso = "2026-10-03T00:00:00.000Z";
for (const observedAt of [iso, "2026-10-03T00:00:00Z"]) {
  describe(`PR8 discovery into common cache (${observedAt})`, () => {
    it.each([false, true])(
      "keeps exact multiline browser observations, duplicate=%s",
      async (duplicate) => {
        const row = {
          label: "GPT-5.5\nLeaving on October 14",
          checked: true,
          enabled: true,
          providerModelId: null,
        };
        const catalog = buildModelCatalog(duplicate ? [row, { ...row, checked: false }] : [row], {
          contextId: "integration-fixture",
          observedAt,
        });
        const cache = new ProviderCatalogCache({
          scope: catalog.scope,
          now: () => new Date(iso),
          source: {
            start: () => ({
              result: Promise.resolve({ kind: "snapshot", snapshot: catalog }),
              exited: Promise.resolve(),
              cancel() {},
            }),
          },
        });
        await cache.refreshIfDue();
        expect(cache.view()).toMatchObject({
          state: "fresh",
          catalog: {
            complete: true,
            executionAuthorized: false,
            reason: duplicate ? "ambiguous" : "none",
          },
        });
        expect(cache.view().catalog?.options[0]?.label).toBe(row.label);
        expect(cache.view().catalog?.options[0]?.providerModelId).toBeNull();
        if (duplicate) expect(legacyCatalogSelection(catalog, "current").ok).toBe(false);
      },
    );
  });
}
describe("catalog timestamp compatibility remains strict", () => {
  it.each(["2026-02-30T00:00:00Z", "2026-10-03", "2026-10-03T00:00:00.0000Z", "invalid"])(
    "rejects invalid or unsupported spelling %s",
    (observedAt) => {
      const catalog = buildModelCatalog(
        [{ label: "Latest", checked: true, enabled: true, providerModelId: null }],
        { contextId: "timestamp-fixture", observedAt },
      );
      expect(
        () =>
          new ProviderCatalogCache({
            scope: catalog.scope,
            now: () => new Date(iso),
            source: {
              start() {
                throw new Error("must not start");
              },
            },
            initialSnapshot: catalog,
          }),
      ).toThrow();
    },
  );
});
describe("PR5/PR9 integration preserves later operations controls", () => {
  it("adds AGY diagnostics without removing catalogue/template commands or enabling inference", async () => {
    const capabilities = await runBusCli(["capabilities"]);
    expect(capabilities).toMatchObject({
      liveActivated: false,
      antigravity: { agent: "antigravity", productionExecution: false, resume: false },
    });
    const result = (await runBusCli(["help"])) as { help: string };
    expect(result.help).toContain("catalogue");
    expect(result.help).toContain("template");
    expect(result.help).toContain("fanout");
  });
  it("retains operations AGY labels and frozen Bridge integer parsing", () => {
    expect(agentLabel("antigravity")).toBe("Antigravity");
    expect(agentLabel("constructor")).toBe("constructor");
    expect(parseStrictProviderJsonBytes(Buffer.from('{"duration":0.5}'))).toEqual({
      duration: 0.5,
    });
    expect(() => parseStrictJsonBytes(Buffer.from('{"duration":0.5}'))).toThrow("safe integer");
  });
});
