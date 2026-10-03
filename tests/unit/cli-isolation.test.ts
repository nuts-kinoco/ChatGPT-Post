/** Mocked process and filesystem only: never launches an executable. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  lstat: vi.fn(),
  open: vi.fn(),
  realpath: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({
  lstat: mocks.lstat,
  open: mocks.open,
  realpath: mocks.realpath,
}));

import { InstalledCliIsolationRuntime } from "../../src/adapters/cli-isolation.js";
import { sha256Bytes } from "../../src/contracts/task.js";

const executable = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
const identity = {
  requestId: "fixture",
  runId: "run",
  taskSpecHash: "a".repeat(64),
  fencingToken: 1,
};
class FakeChild extends EventEmitter {
  pid = 424242;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
}
describe("installed isolation process driver with fake process", () => {
  let child: FakeChild;
  let fileClose: ReturnType<typeof vi.fn>;
  const runtime = (extra: object = {}) =>
    new InstalledCliIsolationRuntime({
      executable: "/opt/bridge/isolate",
      sha256: sha256Bytes(executable),
      ownerUid: 0,
      rpcTimeoutMs: 20,
      ...extra,
    });
  beforeEach(() => {
    vi.clearAllMocks();
    child = new FakeChild();
    fileClose = vi.fn(async () => {});
    mocks.lstat.mockResolvedValue({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o755,
      uid: 0,
    });
    mocks.realpath.mockResolvedValue("/opt/bridge/isolate");
    mocks.open.mockResolvedValue({
      fd: 17,
      close: fileClose,
      stat: async () => ({
        isFile: () => true,
        nlink: 1,
        uid: 0,
        mode: 0o755,
        size: executable.length,
      }),
      readFile: async () => executable,
    });
    mocks.spawn.mockImplementation(() => {
      child.stdin.on("finish", () => {
        child.stdout.end(JSON.stringify({ kind: "unknown", identity, reason: "fixture" }));
        child.emit("close", 0);
      });
      return child;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("launches only hash-bound fd with fixed argv/cwd/env, shell false, and piped JSON", async () => {
    let input = "";
    child.stdin.on("data", (chunk) => {
      input += chunk.toString();
    });
    expect((await runtime().status(identity)).kind).toBe("unknown");
    expect(mocks.spawn).toHaveBeenCalledWith(
      "/proc/self/fd/3",
      ["rpc", "--protocol", "bridge-cli-isolation/1", "status"],
      {
        cwd: "/",
        env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe", 17],
      },
    );
    expect(JSON.parse(input)).toEqual({ identity });
    expect(fileClose).toHaveBeenCalledOnce();
  });
  it("denies binary hash mismatch before process creation", async () => {
    await expect(runtime({ sha256: "f".repeat(64) }).status(identity)).rejects.toThrow(
      "isolation_binary_hash_mismatch",
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(fileClose).toHaveBeenCalledOnce();
  });
  it("denies writable install directories before process creation", async () => {
    mocks.lstat.mockResolvedValue({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o777,
      uid: 0,
    });
    await expect(runtime().status(identity)).rejects.toThrow("isolation_installation_permissions");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("denies symlink substitution before opening the binary", async () => {
    mocks.realpath.mockResolvedValue("/elsewhere/untrusted");
    await expect(runtime().status(identity)).rejects.toThrow("isolation_binary_symlink");
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("treats nonzero exit as unknown and does not relaunch", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    mocks.spawn.mockImplementation(() => {
      child.stdin.on("finish", () => child.emit("close", 1));
      return child;
    });
    await expect(runtime().status(identity)).rejects.toThrow("isolation_rpc_failed_unknown");
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  });
  it("bounds RPC deadline and kills only the RPC process group, never claims job termination", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    mocks.spawn.mockReturnValue(child);
    await expect(runtime().status(identity)).rejects.toThrow("isolation_rpc_timeout_unknown");
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(fileClose).toHaveBeenCalledOnce();
  });
  it("bounds stdout/stderr without exposing sensitive stderr", async () => {
    vi.spyOn(process, "kill").mockReturnValue(true);
    mocks.spawn.mockImplementation(() => {
      child.stdin.on("finish", () => child.stderr.write("do-not-log-this-secret"));
      return child;
    });
    await expect(runtime({ maxResponseBytes: 4 }).status(identity)).rejects.toThrow(
      "isolation_rpc_response_limit",
    );
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });
});
