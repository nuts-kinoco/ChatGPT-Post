/** Configured catalogue/template reads with fake host ports; no signer, model, network or DB. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  catalogue: vi.fn(),
  template: vi.fn(),
  issue: vi.fn(),
}));
vi.mock("../../src/adapters/deployment-loader.js", () => ({ openTrustedDeployment: host.open }));

import { runBusCli } from "../../src/cli/bus.js";

const prefix = ["--deployment", "/trusted/fixture.mjs"];
const project = "e4541d37-c43c-4c7e-924a-3a6602b71d68";
beforeEach(() => {
  vi.clearAllMocks();
  host.catalogue.mockResolvedValue({
    version: "bridge-operations-1",
    destinations: { state: "unavailable" },
  });
  host.template.mockResolvedValue({
    version: "bridge-issuer-template-1",
    templateOnly: true,
    executable: false,
    missingInputs: ["request_id", "task_markdown", "task_file_hash"],
  });
  host.open.mockResolvedValue({
    bus: { issue: host.issue },
    issuerReadPort: { catalogue: host.catalogue, template: host.template },
    close: host.close,
  });
});
describe("LLM configured read-only issuer commands", () => {
  it("reads the same configured catalogue without issuing or starting a task", async () => {
    expect(await runBusCli([...prefix, "catalogue"])).toMatchObject({
      destinations: { state: "unavailable" },
    });
    expect(host.catalogue).toHaveBeenCalledOnce();
    expect(host.issue).not.toHaveBeenCalled();
    expect(host.close).toHaveBeenCalledOnce();
  });
  it("forwards exact registered IDs/model and returns an explicitly non-executable template", async () => {
    expect(
      await runBusCli([...prefix, "template", project, "normal-chat", "model-a"]),
    ).toMatchObject({ templateOnly: true, executable: false });
    expect(host.template).toHaveBeenCalledWith(project, "normal-chat", "model-a");
    expect(host.issue).not.toHaveBeenCalled();
  });
  it("leaves single-model choice to the trusted registry and preserves multiple-model denial", async () => {
    host.template.mockRejectedValue(new Error("issuer_model_required"));
    await expect(runBusCli([...prefix, "template", project, "codex-cli"])).rejects.toThrow(
      "issuer_model_required",
    );
    expect(host.template).toHaveBeenCalledWith(project, "codex-cli", undefined);
    expect(host.close).toHaveBeenCalledOnce();
  });
  it.each(
    [
      ["catalogue", "extra"],
      ["template"],
      ["template", "../project", "route"],
      ["template", project, "../route"],
      ["template", project, "route", "bad\nmodel"],
      ["template", project, "route", "model", "extra"],
    ].map((args) => ({ args })),
  )("rejects malformed reads without calling recipe: %j", async ({ args }) => {
    await expect(runBusCli([...prefix, ...args])).rejects.toThrow("bus_arguments_invalid");
    expect(host.catalogue).not.toHaveBeenCalled();
    expect(host.template).not.toHaveBeenCalled();
    expect(host.issue).not.toHaveBeenCalled();
  });
  it("fails closed if the shared issuer port is absent", async () => {
    host.open.mockResolvedValue({ bus: { issue: host.issue }, close: host.close });
    await expect(runBusCli([...prefix, "catalogue"])).rejects.toThrow(
      "issuer_catalogue_unconfigured",
    );
    expect(host.close).toHaveBeenCalledOnce();
  });
  it("does not close host resources until an asynchronous read completes", async () => {
    let release: ((value: unknown) => void) | undefined;
    host.catalogue.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = runBusCli([...prefix, "catalogue"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(host.close).not.toHaveBeenCalled();
    release?.({ templateOnly: true });
    expect(await pending).toEqual({ templateOnly: true });
    expect(host.close).toHaveBeenCalledOnce();
  });
  it("keeps offline help/capabilities free of deployment reads and documents exact commands", async () => {
    expect(await runBusCli(["help"])).toMatchObject({
      help: expect.stringContaining("template PROJECT_UUID DESTINATION_ID [MODEL_ID]"),
    });
    await runBusCli(["capabilities"]);
    expect(host.open).not.toHaveBeenCalled();
  });
});
