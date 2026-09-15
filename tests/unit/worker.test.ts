import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { destinationFor, runWorker } from "../../src/cli/worker.js";

describe("file-queue worker (21 §5c, A-094)", () => {
  let q: string;
  beforeEach(async () => {
    q = await mkdtemp(join(tmpdir(), "bridge-queue-"));
    for (const id of [
      "20260915T000001Z-aaaaaaaa",
      "20260915T000002Z-bbbbbbbb",
      "20260915T000003Z-cccccccc",
    ]) {
      await mkdir(join(q, "pending", id), { recursive: true });
      await writeFile(join(q, "pending", id, "request.json"), "{}");
    }
    await mkdir(join(q, "pending", "not-a-request"), { recursive: true }); // no request.json -> ignored
    await mkdir(join(q, "pending", "..evil"), { recursive: true }); // malformed id -> ignored
    await writeFile(join(q, "pending", "..evil", "request.json"), "{}");
  });
  afterEach(async () => {
    await rm(q, { recursive: true, force: true });
  });

  it("maps exit codes to directories", () => {
    expect(destinationFor(0)).toBe("done");
    expect(destinationFor(1)).toBe("failed");
    expect(destinationFor(2)).toBe("failed");
    expect(destinationFor(3)).toBe("blocked");
    expect(destinationFor(4)).toBe("pending");
  });

  it("drains in submission order, moves each item, stops the queue on exit 3", async () => {
    const seen: string[] = [];
    const codes = new Map([
      ["20260915T000001Z-aaaaaaaa", 0],
      ["20260915T000002Z-bbbbbbbb", 3],
    ]);
    const r = await runWorker(
      { queueDir: q, once: false, drain: true, pollMs: 1, maxBusyRetries: 3 },
      async (p) => {
        const parts = p.split(/[\\/]/);
        expect(parts.at(-3)).toBe("running");
        const id = parts.at(-2) ?? "";
        seen.push(id);
        return codes.get(id) ?? 1;
      },
      () => undefined,
      async () => undefined,
    );
    expect(seen).toEqual(["20260915T000001Z-aaaaaaaa", "20260915T000002Z-bbbbbbbb"]);
    expect(r.stoppedBy).toBe("blocked");
    expect(await readdir(join(q, "done"))).toEqual(["20260915T000001Z-aaaaaaaa"]);
    expect(await readdir(join(q, "blocked"))).toEqual(["20260915T000002Z-bbbbbbbb"]);
    expect(await readdir(join(q, "pending"))).toContain("20260915T000003Z-cccccccc"); // untouched
    expect(await readdir(join(q, "running"))).toEqual([]);
  });

  it("busy (exit 4) bounces back to pending and fails after maxBusyRetries", async () => {
    let calls = 0;
    const r = await runWorker(
      { queueDir: q, once: false, drain: true, pollMs: 1, maxBusyRetries: 2 },
      async () => {
        calls++;
        return 4;
      },
      () => undefined,
      async () => undefined,
    );
    // each of the 3 items bounces twice then fails on the third attempt
    expect(calls).toBe(9);
    expect(r.stoppedBy).toBe("drain");
    expect((await readdir(join(q, "failed"))).length).toBe(3);
  });

  it("--once processes exactly one item", async () => {
    const r = await runWorker(
      { queueDir: q, once: true, drain: false, pollMs: 1, maxBusyRetries: 3 },
      async () => 0,
      () => undefined,
      async () => undefined,
    );
    expect(r.processed.length).toBe(1);
    expect(r.stoppedBy).toBe("once");
  });
});
