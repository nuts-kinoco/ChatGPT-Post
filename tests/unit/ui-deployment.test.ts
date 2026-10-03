import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../src/adapters/deployment-loader.js", () => ({ openTrustedDeployment: fixture.load }));

import { startUiServer } from "../../src/ui/server.js";

describe("configured UI runtime ownership", () => {
  it("closes a supplied ledger if constructor rejects and no deployment close exists", async () => {
    const store = { close: vi.fn() };
    fixture.load.mockResolvedValueOnce({
      uiRuntime: { store, controller: { store, executor: { synthetic: true } } },
    });
    await expect(
      startUiServer({
        stateDir: "/unused",
        profile: "production",
        deploymentModule: "/trusted/fixture.mjs",
      }),
    ).rejects.toThrow("Synthetic runtime");
    expect(store.close).toHaveBeenCalledTimes(1);
  });
  it("delegates failed-startup cleanup exactly once to explicit deployment owner", async () => {
    const store = { close: vi.fn() };
    const close = vi.fn();
    fixture.load.mockResolvedValueOnce({
      close,
      uiRuntime: { store, controller: { store, executor: { synthetic: true } } },
    });
    await expect(
      startUiServer({
        stateDir: "/unused",
        profile: "production",
        deploymentModule: "/trusted/fixture.mjs",
      }),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect(store.close).not.toHaveBeenCalled();
  });
});
