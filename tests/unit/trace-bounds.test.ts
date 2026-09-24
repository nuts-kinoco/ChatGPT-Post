import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserSession } from "../../src/browser/launch.js";
import { TRACE_MAX_COMPRESSED_BYTES } from "../../src/browser/trace-sanitizer.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-trace-bounds-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("bounded pre-submit tracing (A-151)", () => {
  it("deletes an over-cap temporary trace instead of leaving an artifacts-drive giant", async () => {
    const session = new BrowserSession({ profileDir: dir, channel: "chromium" });
    const fake = session as unknown as {
      context: { tracing: { stop: ({ path }: { path: string }) => Promise<void> } };
      tracing: boolean;
    };
    fake.tracing = true;
    fake.context = {
      tracing: {
        stop: async ({ path }) => {
          await writeFile(path, Buffer.alloc(TRACE_MAX_COMPRESSED_BYTES + 1));
        },
      },
    };
    await expect(session.sealTrace(dir)).rejects.toThrow(/compressed cap/);
    expect((await readdir(dir)).filter((name) => name.startsWith(".trace-"))).toEqual([]);
  });
});
