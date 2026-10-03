import { describe, expect, it, vi } from "vitest";
import type { SdkTextDeployment } from "../../src/adapters/sdk-text-deployment.js";
import { runSdkTextCli } from "../../src/cli/sdk-text.js";

const id = "00000000-0000-4000-8000-000000000001",
  hash = "a".repeat(64);
describe("explicit SDK CLI, no actual SDK/deployment invocation", () => {
  it("help and capabilities do not load config or probe/dispatch", async () => {
    const loader = vi.fn();
    expect(await runSdkTextCli(["capabilities"], loader)).toMatchObject({
      liveActivated: false,
      osProcessExit: "unobserved",
    });
    expect(await runSdkTextCli(["help"], loader)).toMatchObject({
      help: expect.stringContaining("EXPECTED_REQUEST_SHA256"),
    });
    expect(loader).not.toHaveBeenCalled();
  });
  it.each([
    [],
    ["start", id],
    ["--deployment", "relative.mjs", "start", id, hash],
    ["--deployment", "/trusted/a.mjs", "start", id],
    ["--deployment", "/trusted/a.mjs", "start", "bad", hash],
  ])("rejects malformed inputs before loading %j", async (args) => {
    const loader = vi.fn();
    await expect(runSdkTextCli(args, loader)).rejects.toThrow();
    expect(loader).not.toHaveBeenCalled();
  });
  it("awaits actual command completion before runtime shutdown", async () => {
    let finish!: (v: unknown) => void;
    const work = new Promise((r) => (finish = r)),
      close = vi.fn();
    const runtime = {
      recipient: { get: () => ({ requestSha256: hash }), start: vi.fn(() => work) },
      close,
    } as unknown as SdkTextDeployment;
    const running = runSdkTextCli(
      ["--deployment", "/trusted/a.mjs", "start", id, hash],
      async () => runtime,
    );
    await new Promise((r) => setImmediate(r));
    expect(close).not.toHaveBeenCalled();
    finish({ state: "unknown" });
    expect(await running).toEqual({ state: "unknown" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("expected request hash mismatch never invokes an action", async () => {
    const approve = vi.fn(),
      close = vi.fn();
    const runtime = {
      recipient: { get: () => ({ requestSha256: "b".repeat(64) }), approve },
      close,
    } as unknown as SdkTextDeployment;
    await expect(
      runSdkTextCli(["--deployment", "/trusted/a.mjs", "approve", id, hash], async () => runtime),
    ).rejects.toThrow("hash_mismatch");
    expect(approve).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it("collect passes the expected hash into the atomic materialization path", async () => {
    const collect = vi.fn(async () => ({ commit: "c" })),
      close = vi.fn();
    const runtime = {
      requesterBus: { readStage: async () => ({ packet: { bodySha256: hash } }) },
      requester: { collect },
      close,
    } as unknown as SdkTextDeployment;
    expect(
      await runSdkTextCli(
        ["--deployment", "/trusted/a.mjs", "collect", id, hash],
        async () => runtime,
      ),
    ).toEqual({ commit: "c" });
    expect(collect.mock.calls[0]?.at(-1)).toBe(hash);
    expect(close).toHaveBeenCalledOnce();
  });
  it("retains the same runtime across a pending drain and retries only close", async () => {
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error("sdk_text_drain_pending"))
      .mockResolvedValue(undefined);
    const runtime = {
      recipient: {
        get: () => ({ requestSha256: hash }),
        start: async () => ({ state: "unknown" }),
      },
      close,
    } as unknown as SdkTextDeployment;
    const load = vi.fn(async () => runtime),
      stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(
        await runSdkTextCli(["--deployment", "/trusted/a.mjs", "start", id, hash], load),
      ).toEqual({ state: "unknown" });
      expect(load).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledTimes(2);
      expect(stderr).toHaveBeenCalledOnce();
    } finally {
      stderr.mockRestore();
    }
  });
});
