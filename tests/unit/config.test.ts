import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, MAX_CONCURRENCY } from "../../src/cli/config.js";

describe("loadConfig max concurrency", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns and falls back to 1 for an unparseable value", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(loadConfig({ CHATGPT_BRIDGE_MAX_CONCURRENCY: "2x" }).maxConcurrency).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("not a positive integer"));
  });

  it("warns and clamps a value above the safety limit", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(loadConfig({ CHATGPT_BRIDGE_MAX_CONCURRENCY: "9" }).maxConcurrency).toBe(
      MAX_CONCURRENCY,
    );
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("exceeds the maximum"));
  });

  it("uses an in-range value without a warning", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(loadConfig({ CHATGPT_BRIDGE_MAX_CONCURRENCY: "3" }).maxConcurrency).toBe(3);
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe("loadConfig experimental stealth mode", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is off unless explicitly selected", () => {
    expect(loadConfig({}).experimentalStealth).toBe("off");
    expect(loadConfig({ CHATGPT_BRIDGE_EXPERIMENTAL_STEALTH: "0" }).experimentalStealth).toBe(
      "off",
    );
  });

  it("selects each mechanism independently", () => {
    expect(loadConfig({ CHATGPT_BRIDGE_EXPERIMENTAL_STEALTH: "1" }).experimentalStealth).toBe(
      "initscript",
    );
    expect(
      loadConfig({ CHATGPT_BRIDGE_EXPERIMENTAL_STEALTH: "extension" }).experimentalStealth,
    ).toBe("extension");
  });

  it("warns and fails closed for an unknown value", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(loadConfig({ CHATGPT_BRIDGE_EXPERIMENTAL_STEALTH: "yes" }).experimentalStealth).toBe(
      "off",
    );
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("not one of"));
  });
});
