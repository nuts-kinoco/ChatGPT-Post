import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { StdioGitHubConnectorHost } from "../../src/adapters/github-connector-stdio.js";

const operation = {
  tool: "github_fetch" as const,
  arguments: { url: "https://api.github.com/repos/owner/bus/git/ref/heads/main" },
};
function fixture() {
  const input = new PassThrough(),
    output = new PassThrough(),
    ops: { id: string; operation: unknown }[] = [];
  output.on("data", (b) => ops.push(JSON.parse(String(b))));
  return { input, output, ops, host: new StdioGitHubConnectorHost(input, output) };
}
describe("already-authorized connector host mediation, fake streams only", () => {
  it("passes Bridge-generated operations and correlates reversed responses", async () => {
    const f = fixture(),
      a = f.host.call(operation, new AbortController().signal),
      b = f.host.call(operation, new AbortController().signal);
    expect(f.ops).toHaveLength(2);
    f.input.write(
      `${JSON.stringify({ schema: "bridge-github-response-1", id: f.ops[1]?.id, result: { structuredContent: { sha: "b" } } })}\n`,
    );
    f.input.write(
      `${JSON.stringify({ schema: "bridge-github-response-1", id: f.ops[0]?.id, result: { structuredContent: { sha: "a" } } })}\n`,
    );
    expect(await a).toEqual({ structuredContent: { sha: "a" } });
    expect(await b).toEqual({ structuredContent: { sha: "b" } });
    expect(f.ops[0]?.operation).toEqual(operation);
    f.host.close();
  });
  it("drops late timeout response without resolving another request", async () => {
    const f = fixture(),
      abort = new AbortController(),
      a = f.host.call(operation, abort.signal);
    abort.abort();
    await expect(a).rejects.toThrow("timeout");
    const b = f.host.call(operation, new AbortController().signal);
    f.input.write(
      `${JSON.stringify({ schema: "bridge-github-response-1", id: f.ops[0]?.id, result: { bad: true } })}\n`,
    );
    f.input.write(
      `${JSON.stringify({ schema: "bridge-github-response-1", id: f.ops[1]?.id, result: { good: true } })}\n`,
    );
    expect(await b).toEqual({ good: true });
    f.host.close();
  });
  it("rejects malformed/extra control fields and all pending operations", async () => {
    const f = fixture(),
      a = f.host.call(operation, new AbortController().signal);
    f.input.write('{"schema":"bridge-github-response-1","id":"bad","result":{},"extra":1}\n');
    await expect(a).rejects.toThrow("response_invalid");
    await expect(f.host.call(operation, new AbortController().signal)).rejects.toThrow("closed");
  });
  it("does not invoke any fallback on EOF and caps pending operations", async () => {
    const f = fixture(),
      items = Array.from({ length: 16 }, () =>
        f.host.call(operation, new AbortController().signal),
      );
    const checks = items.map((p) => expect(p).rejects.toThrow("closed"));
    await expect(f.host.call(operation, new AbortController().signal)).rejects.toThrow("capacity");
    f.input.end();
    await Promise.all(checks);
  });
});
