import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli/main.js";

const requestId = "20260925T120000Z-stop0001";
let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "bridge-stop-"));
  vi.stubEnv("CHATGPT_BRIDGE_RUNTIME_DIR", runtimeDir);
  vi.stubEnv("CHATGPT_BRIDGE_MAX_CONCURRENCY", "1");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(runtimeDir, { recursive: true, force: true });
});

function markerPath(): string {
  return join(runtimeDir, "state", requestId, "stop.request");
}

async function expectNoMarker(): Promise<void> {
  await expect(stat(markerPath())).rejects.toMatchObject({ code: "ENOENT" });
}

async function writeLock(id: string, pid = process.pid, command = "run"): Promise<void> {
  const locksDir = join(runtimeDir, "locks");
  await mkdir(locksDir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    join(locksDir, "bridge.lock"),
    JSON.stringify({
      pid,
      startedAt: now,
      token: "stop-test-token",
      command,
      requestId: id,
      hostname: hostname(),
      heartbeatAt: now,
    }),
  );
}

async function runJson(id = requestId): Promise<{ code: number; output: unknown }> {
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const code = await main(["stop", id, "--json"]);
  return { code, output: JSON.parse(writes.join("")) as unknown };
}

describe("stop <requestId>", () => {
  it("validates requestId and never writes a marker for invalid input", async () => {
    const out = await runJson("bad");
    expect(out.code).not.toBe(0);
    expect(out.output).toMatchObject({ ok: false, reason: expect.stringContaining("invalid") });
    await expectNoMarker();
  });

  it("refuses when no lock exists and writes no marker", async () => {
    const out = await runJson();
    expect(out.code).not.toBe(0);
    expect(out.output).toEqual({ ok: false, reason: "no lock exists" });
    await expectNoMarker();
  });

  it("refuses a live lock with a different requestId and writes no marker", async () => {
    await writeLock("20260925T120000Z-other001");
    const out = await runJson();
    expect(out.code).not.toBe(0);
    expect(out.output).toMatchObject({ ok: false, reason: expect.stringContaining("mismatch") });
    await expectNoMarker();
  });

  it("refuses a stale matching lock and writes no marker", async () => {
    await writeLock(requestId, 2_147_483_647);
    const out = await runJson();
    expect(out.code).not.toBe(0);
    expect(out.output).toMatchObject({ ok: false, reason: expect.stringContaining("stale") });
    await expectNoMarker();
  });

  it("refuses a live collect lock and writes no marker", async () => {
    await writeLock(requestId, process.pid, "collect");
    const out = await runJson();
    expect(out.code).not.toBe(0);
    expect(out.output).toEqual({
      ok: false,
      reason: 'cannot stop command "collect": only "run" supports cooperative stop',
    });
    await expectNoMarker();
  });

  it("atomically writes an idempotent marker only for a live matching lock", async () => {
    await writeLock(requestId);
    expect((await runJson()).code).toBe(0);
    expect((await runJson()).code).toBe(0);
    const marker = JSON.parse(await readFile(markerPath(), "utf8")) as {
      token: string;
      requestedAt: string;
      requestedBy: string;
    };
    expect(marker.token).toBe("stop-test-token");
    expect(new Date(marker.requestedAt).toISOString()).toBe(marker.requestedAt);
    expect(marker.requestedBy).toBe("cli");
  });
});
