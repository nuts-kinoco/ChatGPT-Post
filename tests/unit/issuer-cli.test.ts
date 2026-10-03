import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { IssuerFacade } from "../../src/adapters/issuer-session.js";
import { readIssuerInput, runIssuerCommand } from "../../src/cli/issuer.js";

const input = (v: unknown) => Buffer.from(JSON.stringify(v));
function port() {
  return {
    catalogue: vi.fn(async () => ({ available: true })),
    prepare: vi.fn(async () => ({})),
    issue: vi.fn(async () => ({})),
    result: vi.fn(async () => ({})),
    acknowledge: vi.fn(async () => ({})),
  } as unknown as IssuerFacade;
}
describe("finite issuer CLI input boundary", () => {
  it("catalogue requires neither stdin nor task input", async () => {
    const p = port();
    expect(await runIssuerCommand(p, "issuer-catalogue")).toEqual({ available: true });
    expect(p.prepare).not.toHaveBeenCalled();
    await expect(
      runIssuerCommand(p, "issuer-catalogue", input({ path: "/private" })),
    ).rejects.toThrow("issuer_arguments_invalid");
  });
  it.each(["approve", "start", "shell", "login", "issuer-configure"])(
    "never exposes %s",
    async (command) => {
      const p = port();
      await expect(runIssuerCommand(p, command, input({}))).rejects.toThrow(
        "issuer_command_invalid",
      );
      expect(p.issue).not.toHaveBeenCalled();
    },
  );
  it.each([
    { signedPreparationBase64: "e30=", path: "/private/secret" },
    { signedPreparationBase64: "e30=", deployment: "/private/config.mjs" },
    { signedPreparationBase64: "e30=", url: "https://invalid.local" },
    { signedPreparationBase64: "?" },
  ])("rejects path/deployment/url or malformed byte input", async (body) => {
    const p = port();
    await expect(runIssuerCommand(p, "issuer-issue", input(body))).rejects.toThrow();
    expect(p.issue).not.toHaveBeenCalled();
  });
  it("uses strict JSON and bounded bytes before dispatch", async () => {
    const p = port();
    await expect(runIssuerCommand(p, "issuer-issue", Buffer.from('{"x":1,"x":2}'))).rejects.toThrow(
      "issuer_input_invalid",
    );
    await expect(
      runIssuerCommand(p, "issuer-issue", Buffer.alloc(1024 * 1024 + 1)),
    ).rejects.toThrow("issuer_input_too_large");
    expect(p.issue).not.toHaveBeenCalled();
  });
  it("does not surface untrusted host exceptions as machine codes", async () => {
    const p = port();
    vi.mocked(p.catalogue).mockRejectedValueOnce(new Error("github_token_secret_123"));
    await expect(runIssuerCommand(p, "issuer-catalogue")).rejects.toThrow(
      "issuer_operation_failed",
    );
  });
  it("reads one bounded stream and removes listeners", async () => {
    const stream = new PassThrough();
    const read = readIssuerInput(stream, 1000, 32);
    stream.end(input({ ok: true }));
    expect(Buffer.from(await read).toString()).toBe('{"ok":true}');
    expect(stream.listenerCount("data")).toBe(0);
  });
  it("rejects oversize continuing input and stops retaining chunks", async () => {
    const stream = new PassThrough();
    const read = readIssuerInput(stream, 1000, 4);
    const error = expect(read).rejects.toThrow("issuer_input_too_large");
    stream.write(Buffer.alloc(5));
    await error;
    stream.write(Buffer.alloc(100));
    expect(stream.listenerCount("data")).toBe(0);
    stream.destroy();
  });
  it("times out an incomplete stream without executing any port", async () => {
    vi.useFakeTimers();
    try {
      const stream = new PassThrough();
      const read = readIssuerInput(stream, 10);
      const denied = expect(read).rejects.toThrow("issuer_input_timeout");
      await vi.advanceTimersByTimeAsync(11);
      await denied;
      expect(stream.listenerCount("data")).toBe(0);
      stream.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not read when the configured issuer port is absent", async () => {
    await expect(runIssuerCommand(undefined, "issuer-issue", input({}))).rejects.toThrow(
      "issuer_unconfigured",
    );
  });
});
