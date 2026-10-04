import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createUiStopSignalQueue, runUiCli } from "../../src/cli/ui.js";
import { syntheticAbsolute } from "../helpers/sdk-text-fixture.js";

const stateDir = syntheticAbsolute("tmp", "bridge-ui-cli-test");

describe("product UI CLI", () => {
  it("defaults to production, prints the private launch URL, and closes on stop", async () => {
    const output: string[] = [];
    const options: unknown[] = [];
    let closed = 0;
    const exit = await runUiCli([], {
      env: { CHATGPT_BRIDGE_RUNTIME_DIR: stateDir },
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
    expect(options).toEqual([{ profile: "production", port: 0, stateDir }]);
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
  it("passes only an explicit trusted deployment path to production startup", async () => {
    let options: unknown;
    expect(
      await runUiCli(["--deployment", "/trusted/deployment.mjs"], {
        env: {},
        stdout: () => {},
        start: async (value) => {
          options = value;
          return { url: "local", close: async () => {} };
        },
        waitForStop: async () => {},
      }),
    ).toBe(0);
    expect(options).toMatchObject({
      profile: "production",
      deploymentModule: "/trusted/deployment.mjs",
    });
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
  it("keeps the same CLI instance after pending drain and retries only after another explicit stop", async () => {
    let retry!: () => void;
    const signal = new Promise<void>((resolve) => {
      retry = resolve;
    });
    const wait = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(() => signal);
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error("metadata_shutdown_pending"))
      .mockResolvedValue(undefined);
    const start = vi.fn(async () => ({ url: "local", close }));
    const errors: string[] = [];
    const run = runUiCli([], {
      env: {},
      start,
      stdout: () => {},
      stderr: (text) => errors.push(text),
      waitForStop: wait,
    });
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(2));
    expect(close).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(errors.join("")).toContain("UI_SHUTDOWN_PENDING");
    expect(errors.join("")).not.toContain("UI_START_FAILED");
    retry();
    expect(await run).toBe(0);
    expect(close).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("retains stop listeners during drain, coalesces signals and disposes the keepalive", async () => {
    vi.useFakeTimers();
    const events = new EventEmitter(),
      queue = createUiStopSignalQueue(events);
    try {
      const first = queue.next();
      events.emit("SIGINT");
      await first;
      expect(events.listenerCount("SIGINT")).toBe(1);
      events.emit("SIGINT");
      events.emit("SIGTERM");
      await queue.next();
      let stopped = false;
      const next = queue.next().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      events.emit("SIGTERM");
      await next;
    } finally {
      queue.dispose();
    }
    expect(events.listenerCount("SIGINT")).toBe(0);
    expect(events.listenerCount("SIGTERM")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
