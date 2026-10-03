import { describe, expect, it } from "vitest";
import { runUiCli } from "../../src/cli/ui.js";

describe("product UI CLI", () => {
  it("defaults to production, prints the private launch URL, and closes on stop", async () => {
    const output: string[] = [];
    const options: unknown[] = [];
    let closed = 0;
    const exit = await runUiCli([], {
      env: { CHATGPT_BRIDGE_RUNTIME_DIR: "/tmp/bridge-ui-cli-test" },
      stdout: (text) => output.push(text),
      start: async (value) => {
        options.push(value);
        return {
          url: "http://127.0.0.1:54321/#token=private",
          close: async () => {
            closed++;
          },
        };
      },
      waitForStop: async () => {},
    });
    expect(exit).toBe(0);
    expect(options).toEqual([
      { profile: "production", port: 0, stateDir: "/tmp/bridge-ui-cli-test" },
    ]);
    expect(output.join("")).toContain("#token=private");
    expect(closed).toBe(1);
  });
  it("requires explicit demo and accepts a fixed loopback port", async () => {
    let options: unknown;
    expect(
      await runUiCli(["--profile", "demo", "--port", "8765"], {
        stdout: () => {},
        start: async (value) => {
          options = value;
          return { url: "local", close: async () => {} };
        },
        waitForStop: async () => {},
      }),
    ).toBe(0);
    expect(options).toMatchObject({ profile: "demo", port: 8765 });
  });
  it.each([
    ["--port", "-1"],
    ["--port", "65536"],
    ["--port", "1.5"],
    ["--port", ""],
    ["--profile", "fake"],
    ["--host", "0.0.0.0"],
    ["start"],
  ])("rejects invalid option %j without starting anything", async (...args) => {
    let started = false;
    expect(
      await runUiCli(args, {
        stderr: () => {},
        start: async () => {
          started = true;
          throw new Error("must_not_start");
        },
      }),
    ).toBe(2);
    expect(started).toBe(false);
  });
  it("help does not start a server", async () => {
    let text = "";
    expect(
      await runUiCli(["--help"], {
        stdout: (value) => {
          text += value;
        },
      }),
    ).toBe(0);
    expect(text).toContain("no model/process execution");
  });
});
