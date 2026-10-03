/** Fake processes only. Real filesystem checks protect synthetic ELF-shaped fixture bytes. */
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));

import { inspectAntigravityHelp } from "../../src/adapters/antigravity.js";
import { AntigravityCatalogSource } from "../../src/adapters/antigravity-catalog.js";
import {
  AntigravityMetadataProbe,
  inspectInstalledAntigravity,
} from "../../src/adapters/antigravity-probe.js";
import type { ProviderCatalogScope } from "../../src/contracts/provider-catalog.js";
import { sha256Bytes } from "../../src/contracts/task.js";

const help = await readFile(
  new URL("../fixtures/antigravity/help-1.2.15.txt", import.meta.url),
  "utf8",
);
class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
  close(code: number | null = 0) {
    this.emit("close", code);
  }
}
let directory: string;
let executable: string;
let bytes: Buffer;
let children: Child[];
beforeEach(async () => {
  directory = await mkdtemp(join(process.cwd(), ".agy-probe-fixture-"));
  executable = join(directory, "agy-fixture");
  bytes = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.from("synthetic fixture, never executed"),
  ]);
  await writeFile(executable, bytes, { mode: 0o700 });
  children = [];
  fake.spawn.mockReset();
  fake.spawn.mockImplementation(() => {
    const child = new Child();
    children.push(child);
    return child;
  });
});
afterEach(async () => {
  for (const child of children) child.close();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function probe(options = {}) {
  return new AntigravityMetadataProbe(
    { executable, expectedSha256: sha256Bytes(bytes), ownerUid: process.getuid?.() ?? 0 },
    options,
  );
}
async function spawned(index = 0): Promise<Child> {
  for (let n = 0; n < 100 && !children[index]; n++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  const child = children[index];
  if (!child) throw new Error("fixture spawn absent");
  return child;
}
describe("bounded Antigravity metadata process probe", () => {
  it.each([
    ["version", "--version"],
    ["help", "--help"],
    ["models", "models"],
  ] as const)(
    "uses only %s metadata argv with held fd and no inherited auth",
    async (operation, argument) => {
      vi.stubEnv("GEMINI_API_KEY", "synthetic-secret-not-real");
      vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-secret-not-real");
      const lease = probe().start(operation);
      const child = await spawned();
      const call = fake.spawn.mock.calls[0];
      expect(call?.[0]).toBe("/proc/self/fd/3");
      expect(call?.[1]).toEqual([argument]);
      const options = call?.[2];
      expect(options.shell).toBe(false);
      expect(options.argv0).toBe("agy");
      expect(options.stdio[0]).toBe("ignore");
      expect(typeof options.stdio[3]).toBe("number");
      expect(Object.keys(options.env).sort()).toEqual(["HOME", "LANG", "LC_ALL"]);
      expect(options.cwd).toBe(options.env.HOME);
      expect(options.cwd).not.toBe(process.cwd());
      child.stdout.write(Buffer.from("fixture metadata"));
      child.close();
      const result = await lease.result;
      await lease.exited;
      expect(result.kind).toBe("completed");
      expect(fake.spawn).toHaveBeenCalledTimes(1);
    },
  );
  it("captures stderr-only help and version without claiming auth, model availability or zero tools", async () => {
    const p = probe();
    const work = inspectInstalledAntigravity(p);
    const first = await spawned();
    first.stdout.write("1.2.15\n");
    first.close();
    const second = await spawned(1);
    second.stderr.write(help);
    second.close();
    const observed = await work;
    expect(observed.capabilities.helpSha256).toBe(sha256Bytes(Buffer.from(help)));
    expect(observed).toMatchObject({
      version: "1.2.15",
      authentication: "unknown",
      modelAvailability: "unknown",
      zeroTools: "unverified",
      osConfinementVerified: false,
    });
  });
  it("withholds authentication prompts and never proceeds with login", async () => {
    const lease = probe().start("models");
    const child = await spawned();
    child.stderr.write("Authentication required. Sign in at a fixture URL");
    expect(await lease.result).toEqual({
      kind: "failed",
      operation: "models",
      reason: "auth_required",
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.close(null);
    await lease.exited;
  });
  it("returns timeout while retaining ownership until actual process close", async () => {
    const p = probe({ timeoutMs: 100 });
    const lease = p.start("help");
    const child = await spawned();
    expect(await lease.result).toMatchObject({ reason: "timeout" });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(() => p.start("help")).toThrow("in_flight");
    child.stdout.write(help);
    expect(await lease.result).toMatchObject({ reason: "timeout" });
    child.close(null);
    await lease.exited;
    const next = p.start("version");
    const second = await spawned(1);
    second.stdout.write("1.2.15");
    second.close();
    await next.result;
    await next.exited;
  });
  it("does not let helper inspection hang after timeout or start its second command", async () => {
    const p = probe({ timeoutMs: 100 });
    const work = inspectInstalledAntigravity(p);
    const check = expect(work).rejects.toThrow("probe_timeout");
    const child = await spawned();
    await check;
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    expect(() => p.start("version")).toThrow("in_flight");
    child.close(null);
  });
  it("bounds combined stdout and stderr and ignores late output", async () => {
    const lease = probe({ maxOutputBytes: 12 }).start("help");
    const child = await spawned();
    child.stdout.write("12345678");
    child.stderr.write("12345");
    expect(await lease.result).toMatchObject({ reason: "output_limit" });
    child.stdout.write("late");
    child.close();
    await lease.exited;
  });
  it.each(["nonzero", "invalid_utf8", "nul", "error"])(
    "rejects %s process output",
    async (kind) => {
      const lease = probe().start("help");
      const child = await spawned();
      if (kind === "invalid_utf8") child.stdout.write(Buffer.from([0xff]));
      if (kind === "nul") child.stdout.write("bad\0text");
      if (kind === "error") child.emit("error", new Error("private diagnostic"));
      child.close(kind === "nonzero" ? 1 : 0);
      expect((await lease.result).kind).toBe("failed");
      await lease.exited;
    },
  );
  it.each(["hash", "symlink", "writable", "owner", "not_elf"])(
    "rejects %s before spawn",
    async (kind) => {
      let path = executable;
      let expected = sha256Bytes(bytes);
      let ownerUid = process.getuid?.() ?? 0;
      if (kind === "hash") expected = "f".repeat(64);
      if (kind === "symlink") {
        path += "-link";
        await symlink(executable, path);
      }
      if (kind === "writable") await chmod(executable, 0o777);
      if (kind === "owner") ownerUid++;
      if (kind === "not_elf") {
        bytes = Buffer.from("not an executable");
        await writeFile(executable, bytes);
        expected = sha256Bytes(bytes);
      }
      const lease = new AntigravityMetadataProbe({
        executable: path,
        expectedSha256: expected,
        ownerUid,
      }).start("version");
      expect(await lease.result).toMatchObject({ reason: "binary_untrusted" });
      await lease.exited;
      expect(fake.spawn).not.toHaveBeenCalled();
    },
  );
  it("does not accept task prompts or arbitrary operations", () => {
    expect(() => probe().start("--print" as "help")).toThrow("operation_invalid");
    expect(fake.spawn).not.toHaveBeenCalled();
  });
  it("keeps successful but unverified model text incomplete without inventing IDs", async () => {
    const p = probe();
    const capabilities = inspectAntigravityHelp(help, "1.2.15");
    const source = new AntigravityCatalogSource(p, {
      contextId: "isolated-fixture",
      binarySha256: sha256Bytes(bytes),
      capabilities,
    });
    const scope: ProviderCatalogScope = {
      providerId: "antigravity",
      routeId: "antigravity_cli",
      contextId: "isolated-fixture",
      revision: { kind: "cli_binary", id: sha256Bytes(bytes), version: "1.2.15" },
    };
    expect(() => source.start({ ...scope, providerId: "claude" })).toThrow("scope_mismatch");
    const lease = source.start(scope);
    const child = await spawned();
    child.stdout.write("future-gemini  Gemini example\nfuture-claude  Claude example\n");
    child.close();
    const result = await lease.result;
    await lease.exited;
    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") throw new Error("fixture");
    expect(result.snapshot).toMatchObject({
      complete: false,
      reason: "format_unverified",
      options: [],
      scope: { providerId: "antigravity" },
      accountAvailability: "unknown",
      executionAuthorized: false,
    });
    expect(result.snapshot.effortSyntax.values).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
