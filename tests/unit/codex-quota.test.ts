import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexQuotaClient, launchCodexQuota } from "../../src/adapters/codex-quota.js";

function setup(
  respond: (message: Record<string, unknown>, output: PassThrough) => void,
  timeout = 100,
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Record<string, unknown>[] = [];
  input.on("data", (bytes) => {
    for (const line of String(bytes).trim().split("\n")) {
      const message = JSON.parse(line);
      messages.push(message);
      respond(message, output);
    }
  });
  return {
    client: new CodexQuotaClient(input, output, "fixture-1.0", "public-2026-10", timeout),
    output,
    messages,
  };
}
const limit = {
  limitId: "codex",
  primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 },
  secondary: null,
};
function reply(output: PassThrough, id: unknown, result: unknown) {
  output.write(`${JSON.stringify({ id, result })}\n`);
}
describe("public Codex quota management client", () => {
  it("initializes once, reads both windows, and never starts inference", async () => {
    const x = setup((msg, out) => {
      if (msg.method === "initialize") reply(out, msg.id, { userAgent: "fixture" });
      if (msg.method === "account/rateLimits/read")
        reply(out, msg.id, { rateLimitsByLimitId: { codex: limit } });
    });
    expect((await x.client.readRateLimits()).limits).toEqual([limit]);
    await x.client.readRateLimits();
    expect(x.messages.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "account/rateLimits/read",
      "account/rateLimits/read",
    ]);
    x.client.close();
  });
  it("supports documented single-bucket response and fragmented JSONL", async () => {
    const x = setup((msg, out) => {
      if (msg.method === "initialize") reply(out, msg.id, {});
      if (msg.method === "account/rateLimits/read") {
        const line = JSON.stringify({ id: msg.id, result: { rateLimits: limit } });
        out.write(line.slice(0, 8));
        out.write(`${line.slice(8)}\n`);
      }
    });
    expect((await x.client.readRateLimits()).source).toBe("account/rateLimits/read");
    x.client.close();
  });
  it("denies server refresh/login/attestation requests without returning secrets", async () => {
    const x = setup((msg, out) => {
      if (msg.method === "initialize") {
        out.write(
          `${JSON.stringify({ id: "refresh", method: "account/chatgptAuthTokens/refresh" })}\n`,
        );
        reply(out, msg.id, {});
      }
      if (msg.method === "account/rateLimits/read") reply(out, msg.id, { rateLimits: limit });
    });
    await x.client.readRateLimits();
    expect(x.messages.find((m) => m.id === "refresh")).toMatchObject({ error: { code: -32601 } });
    expect(JSON.stringify(x.messages)).not.toContain("accessToken");
    x.client.close();
  });
  it.each([
    { rateLimits: { ...limit, primary: { ...limit.primary, usedPercent: 101 } } },
    { rateLimitsByLimitId: { other: limit } },
    {},
    { rateLimits: { ...limit, secondary: "bad" } },
  ])("rejects invalid or missing quota rather than reporting zero", async (response) => {
    const x = setup((msg, out) => {
      if (msg.method === "initialize") reply(out, msg.id, {});
      if (msg.method === "account/rateLimits/read") reply(out, msg.id, response);
    });
    await expect(x.client.readRateLimits()).rejects.toThrow();
    x.client.close();
  });
  it("times out without a second query or turn", async () => {
    const x = setup((msg, out) => {
      if (msg.method === "initialize") reply(out, msg.id, {});
    }, 5);
    await expect(x.client.readRateLimits()).rejects.toThrow("timeout");
    expect(x.messages.filter((m) => m.method === "account/rateLimits/read")).toHaveLength(1);
    x.client.close();
  });
  it("rejects unsafe launcher path before process creation", async () => {
    await expect(
      launchCodexQuota({
        executable: "codex",
        sha256: "a".repeat(64),
        cwd: "/tmp",
        environment: {},
        cliVersion: "fixture",
        protocolVersion: "fixture",
      }),
    ).rejects.toThrow("denied");
  });
});
