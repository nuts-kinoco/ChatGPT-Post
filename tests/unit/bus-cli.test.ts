import { describe, expect, it } from "vitest";
import { runBusCli } from "../../src/cli/bus.js";

describe("bus deployment entry point", () => {
  it("describes concrete capabilities without loading a deployment or launching a model", async () => {
    expect(await runBusCli(["capabilities"])).toMatchObject({
      github: "implemented_unconfigured",
      liveActivated: false,
      cli: "broker_implemented_os_supervisor_required",
    });
  });
  it("provides exact runnable commands", async () => {
    expect(await runBusCli(["help"])).toMatchObject({
      help: expect.stringContaining("expected-payload-sha256"),
    });
  });
  it.each(
    [[], ["tick"], ["--deployment", "relative.mjs", "tick"], ["--deployment"]].map((args) => ({
      args,
    })),
  )("fails closed without explicit trusted host deployment: %s", async ({ args }) => {
    await expect(runBusCli(args)).rejects.toThrow("deployment_path_required");
  });
});
