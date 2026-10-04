/** Test-only helper regression: diagnostics are structured, bounded and never echo secrets. */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_ERROR_CODES,
  DIAGNOSTIC_LIMIT,
  describeChild,
  readMarker,
  waitForChild,
  // @ts-expect-error Plain .mjs test helper without declarations.
} from "../../scripts/child-diagnostics.mjs";

const SECRET = "credential_example_value";

describe("child CLI diagnostics", () => {
  it("reports an early exit before a marker with the allowlisted code only", () => {
    const text = describeChild({
      label: "main/SIGTERM",
      code: 1,
      signal: null,
      marker: { state: "missing" },
      stderr: `${JSON.stringify({ error: "sdk_text_operation_failed", reexecute: false })}\n`,
    });
    expect(text).toContain("exit=1");
    expect(text).toContain("marker=missing");
    expect(text).toContain("stderr_codes=sdk_text_operation_failed");
    expect(text).toContain("timeout=false");
  });
  it("reports spawn failure, signal and timeout as finite fields", () => {
    const text = describeChild({
      label: "issuer-catalogue/open-error",
      spawnError: Object.assign(new Error(`${SECRET} C:\\Users\\someone\\x`), { code: "ENOENT" }),
      signal: "SIGKILL",
      timedOut: true,
      marker: { state: "invalid" },
      stderr: "",
    });
    expect(text).toContain("spawn=ENOENT");
    expect(text).toContain("signal=SIGKILL");
    expect(text).toContain("timeout=true");
    expect(text).toContain("marker=invalid");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("Users");
  });
  it("never prints secret sentinels, unknown codes, stacks or paths from stderr", () => {
    const stderr = [
      JSON.stringify({ error: SECRET, reexecute: false }),
      JSON.stringify({ error: "totally_unknown_code_xyz", message: SECRET }),
      `Error: ${SECRET}\n    at C:\\Users\\someone\\secret\\file.js:1:1`,
      `${SECRET} /home/someone/.ssh/id_rsa`,
    ].join("\n");
    const text = describeChild({
      label: "x",
      code: 1,
      signal: null,
      marker: { state: "ok" },
      stderr,
    });
    for (const forbidden of [SECRET, "totally_unknown_code_xyz", "someone", "id_rsa", "at C:"])
      expect(text).not.toContain(forbidden);
    expect(text).toContain("stderr_codes=none");
    expect(text).toContain("stderr_unknown_omitted=2");
    expect(text).toContain("stderr_unstructured_omitted=3");
  });
  it("omits an unsafe label or errno-like strings and stays within the size bound", () => {
    const hostile = `${SECRET}\n${"A".repeat(10_000)}`;
    const text = describeChild({
      label: hostile,
      spawnError: { code: hostile },
      signal: hostile,
      code: 1,
      marker: { state: hostile },
      stderr: ALLOWED_ERROR_CODES.map((c) => JSON.stringify({ error: c })).join("\n") + hostile,
    });
    expect(text.length).toBeLessThanOrEqual(DIAGNOSTIC_LIMIT);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("label=omitted");
    expect(text).toContain("spawn=other");
    expect(text).toContain("signal=other");
    expect(text).toContain("marker=unknown");
  });
  it("classifies marker states after the child has ended", async () => {
    const dir = await mkdtemp(join(tmpdir(), "child-diag-"));
    try {
      expect(await readMarker(join(dir, "none.json"))).toEqual({ state: "missing" });
      await writeFile(join(dir, "bad.json"), "{not json");
      expect(await readMarker(join(dir, "bad.json"))).toEqual({ state: "invalid" });
      await writeFile(join(dir, "ok.json"), '{"started":true}');
      expect(await readMarker(join(dir, "ok.json"))).toEqual({
        state: "ok",
        value: { started: true },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("describes a real child that exits before writing its marker, keeping raw stderr intact", async () => {
    const child = spawn(
      process.execPath,
      ["-e", `console.error(JSON.stringify({error:"${SECRET}"}));process.exit(3)`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    // The raw stream stays available for leak assertions; only the diagnosis is sanitized.
    expect(stderr).toContain(SECRET);
    const text = describeChild({
      label: "real",
      code,
      signal: null,
      marker: { state: "missing" },
      stderr,
    });
    expect(text).toContain("exit=3");
    expect(text).not.toContain(SECRET);
  });
  it("reports a spawn failure for a nonexistent executable", async () => {
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const child = spawn(join(tmpdir(), "definitely-not-an-executable-xyz"), []);
      child.once("error", resolve);
    });
    expect(
      describeChild({ label: "spawn", spawnError: error, marker: { state: "missing" } }),
    ).toContain("spawn=ENOENT");
  });
});

describe("child wait ordering", () => {
  it("does not settle on a kept error until close, then reads the final marker", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
    const order: string[] = [];
    const waiting = waitForChild(child as never, { timeoutMs: 60_000 });
    const settled = waiting.result.then((r: unknown) => {
      order.push("settled");
      return r;
    });
    child.emit("error", Object.assign(new Error("late"), { code: "EPERM" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(order).toEqual([]); // error alone must not end the wait
    expect(waiting.failed()).toBe(true); // but readiness can see the failure
    order.push("close");
    child.emit("close", 1, null);
    const result = await settled;
    expect(order).toEqual(["close", "settled"]);
    expect(result).toMatchObject({ code: 1, signal: null, timedOut: false });
    expect((result as { spawnError: { code: string } }).spawnError.code).toBe("EPERM");
    waiting.dispose();
  });
  it("reports a spawn failure with no process after a bounded grace even without close", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
    const waiting = waitForChild(child as never, { timeoutMs: 60_000, spawnFailureGraceMs: 20 });
    child.emit("error", Object.assign(new Error("x"), { code: "ENOENT" }));
    const result = await waiting.result;
    expect((result as { spawnError: { code: string } }).spawnError.code).toBe("ENOENT");
    waiting.dispose();
  });
  it("real spawn failure: error is kept and close is still awaited", async () => {
    const child = spawn(join(tmpdir(), "definitely-not-an-executable-xyz"), []);
    const events: string[] = [];
    child.on("error", () => events.push("error"));
    child.on("close", () => events.push("close"));
    const result = await waitForChild(child).result;
    expect((result as { spawnError: { code: string } }).spawnError.code).toBe("ENOENT");
    expect(events[0]).toBe("error");
  });
  it("real timeout: kill happens, and the result is settled only after the process closed", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let closed = false;
    child.once("close", () => {
      closed = true;
    });
    const result = await waitForChild(child, { timeoutMs: 300 }).result;
    expect(result.timedOut).toBe(true);
    expect(closed).toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
  it("real early exit: failed() sees it before close is awaited; marker is read after close", async () => {
    const dir = await mkdtemp(join(tmpdir(), "child-wait-"));
    try {
      const child = spawn(process.execPath, ["-e", "process.exit(5)"], { stdio: "ignore" });
      const waiting = waitForChild(child);
      for (let i = 0; i < 500 && !waiting.failed(); i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(waiting.failed()).toBe(true);
      const result = await waiting.result;
      expect(result).toMatchObject({ code: 5, timedOut: false });
      expect(await readMarker(join(dir, "never-written.json"))).toEqual({ state: "missing" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("unreadable marker (a directory in its place) is classified without touching permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "child-unread-"));
    try {
      expect(await readMarker(dir)).toEqual({ state: "unreadable" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
