import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/adapters/deployment-loader.js", () => ({
  openTrustedDeployment: async () => {
    throw new Error("credential_example_value");
  },
}));

import { runArchiveCli } from "../../src/cli/archive.js";

describe("independent archive error secrecy", () => {
  it("does not echo arbitrary dependency text that happens to look like an error code", async () => {
    const out: string[] = [];
    await runArchiveCli(
      ["save", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "--deployment", "/synthetic/fixture.mjs"],
      (s) => out.push(s),
    );
    expect(out.join("")).not.toContain("credential_example_value");
  });
});
