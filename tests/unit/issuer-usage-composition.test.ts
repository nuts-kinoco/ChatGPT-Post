import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusDeployment } from "../../src/cli/bus.js";

const ports = vi.hoisted(() => ({ open: vi.fn(), counter: vi.fn() }));
vi.mock("../../src/adapters/deployment-loader.js", () => ({ openTrustedDeployment: ports.open }));
vi.mock("../../src/ui/pro-counter-runtime.js", () => ({ openBridgeProCounter: ports.counter }));

import { runBusCli } from "../../src/cli/bus.js";

afterEach(() => vi.restoreAllMocks());
describe("issuer CLI preserves usage projection lifecycle", () => {
  function fixture(owned: boolean, failIssuer = false) {
    const order: string[] = [];
    const counter = {
      attachHosted: vi.fn(() => order.push("attach")),
      refresh: vi.fn(async () => {
        order.push("refresh");
      }),
      close: vi.fn(async () => {
        order.push("counter-close");
      }),
    };
    const issuer = {
      catalogue: vi.fn(async () => {
        order.push("catalogue");
        if (failIssuer) throw new Error("issuer_scope_denied");
        return { safe: true };
      }),
    };
    const deployment = {
      bus: {},
      browser: { config: {} },
      issuer,
      ...(owned ? {} : { proCounterRuntime: counter }),
      close: vi.fn(async () => {
        order.push("deployment-close");
      }),
    } as unknown as BusDeployment;
    ports.open.mockResolvedValue(deployment);
    ports.counter.mockImplementation(async () => {
      order.push("counter-open");
      return counter;
    });
    return { order, counter, issuer, deployment };
  }
  it("refreshes an injected counter without claiming its ownership", async () => {
    const f = fixture(false);
    expect(await runBusCli(["--deployment", "/trusted/fixture.mjs", "issuer-catalogue"])).toEqual({
      safe: true,
    });
    expect(f.order).toEqual(["attach", "refresh", "catalogue", "refresh", "deployment-close"]);
    expect(f.counter.close).not.toHaveBeenCalled();
  });
  it("closes an owned counter before the same deployment after success", async () => {
    const f = fixture(true);
    await runBusCli(["--deployment", "/trusted/fixture.mjs", "issuer-catalogue"]);
    expect(f.order).toEqual([
      "counter-open",
      "attach",
      "refresh",
      "catalogue",
      "refresh",
      "counter-close",
      "deployment-close",
    ]);
    expect(f.counter.close).toHaveBeenCalledTimes(1);
    expect(f.deployment.close).toHaveBeenCalledTimes(1);
  });
  it("retains counter cleanup when issuer scope fails", async () => {
    const f = fixture(true, true);
    await expect(
      runBusCli(["--deployment", "/trusted/fixture.mjs", "issuer-catalogue"]),
    ).rejects.toThrow("issuer_scope_denied");
    expect(f.order.slice(-3)).toEqual(["refresh", "counter-close", "deployment-close"]);
  });
  it("does not dispatch or lose cleanup after malformed finite issuer input", async () => {
    const f = fixture(true);
    await expect(
      runBusCli(
        ["--deployment", "/trusted/fixture.mjs", "issuer-issue"],
        Buffer.from('{"deployment":"/private"}'),
      ),
    ).rejects.toThrow();
    expect(f.issuer.catalogue).not.toHaveBeenCalled();
    expect(f.deployment.close).toHaveBeenCalledTimes(1);
    expect(f.order.slice(-3)).toEqual(["refresh", "counter-close", "deployment-close"]);
  });
  it("usage projection failure stays unknown without starting another route", async () => {
    const f = fixture(true);
    f.counter.refresh.mockRejectedValue(new Error("synthetic disk failure"));
    const warnings = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runBusCli(["--deployment", "/trusted/fixture.mjs", "issuer-catalogue"])).toEqual({
      safe: true,
    });
    expect(f.counter.close).toHaveBeenCalledTimes(1);
    expect(f.deployment.close).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls.flat().join("")).not.toContain("synthetic disk failure");
  });
});

describe("issuer enclosing cleanup and redaction", () => {
  it("attempts deployment cleanup even when an owned counter close rejects", async () => {
    const close = vi.fn(async () => {}),
      counter = {
        attachHosted: () => {},
        refresh: async () => {},
        close: async () => {
          throw new Error("credential_example_value");
        },
      };
    ports.open.mockResolvedValue({
      bus: {},
      browser: { config: {} },
      issuer: { catalogue: async () => ({ safe: true }) },
      close,
    });
    ports.counter.mockResolvedValue(counter);
    await expect(
      runBusCli(["--deployment", "/trusted/fixture.mjs", "issuer-catalogue"]),
    ).rejects.toThrow("issuer_operation_failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
  it.each(["open", "close"])(
    "redacts %s failures at the full issuer command boundary",
    async (phase) => {
      const error = new Error("credential_example_value");
      if (phase === "open") ports.open.mockRejectedValueOnce(error);
      else
        ports.open.mockResolvedValue({
          bus: {},
          issuer: { catalogue: async () => ({}) },
          close: () => {
            throw error;
          },
        });
      await expect(
        runBusCli(["--deployment", "/trusted/fixture.mjs", "issuer-catalogue"]),
      ).rejects.toThrow("issuer_operation_failed");
    },
  );
});
