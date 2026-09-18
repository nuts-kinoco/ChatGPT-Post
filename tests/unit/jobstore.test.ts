import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobAlreadyExistsError, type JobRow, openJobStore } from "../../src/state/jobstore.js";

function row(over: Partial<JobRow> = {}): JobRow {
  return {
    requestId: "20260918T000000Z-aaaaaaaa",
    status: "queued",
    requestPath: "/req/request.json",
    requestDir: "/req",
    inputHash: "hash1",
    pid: null,
    hostname: "test-host",
    submittedAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    resultPath: null,
    errorCode: null,
    exitCode: null,
    ...over,
  };
}

describe("JobStore (Phase 1, A-132)", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-jobstore-"));
    dbPath = join(dir, "sub", "jobs.db");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the DB file (and parent dir) lazily, persists a row, and reads it back", async () => {
    const store = await openJobStore(dbPath);
    try {
      store.insert(row());
      const got = store.get("20260918T000000Z-aaaaaaaa");
      expect(got).toEqual(row());
      expect(store.get("no-such-id")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("update() merges a partial patch and returns the new row", async () => {
    const store = await openJobStore(dbPath);
    try {
      store.insert(row());
      const updated = store.update("20260918T000000Z-aaaaaaaa", {
        status: "completed",
        pid: 4242,
        resultPath: "/req/result.json",
      });
      expect(updated.status).toBe("completed");
      expect(updated.pid).toBe(4242);
      expect(updated.resultPath).toBe("/req/result.json");
      // untouched fields survive the patch
      expect(updated.inputHash).toBe("hash1");
      expect(store.get("20260918T000000Z-aaaaaaaa")).toEqual(updated);
    } finally {
      store.close();
    }
  });

  it("update() throws for an unknown requestId rather than silently creating one", async () => {
    const store = await openJobStore(dbPath);
    try {
      expect(() => store.update("missing", { status: "failed" })).toThrow();
    } finally {
      store.close();
    }
  });

  it("survives being reopened against the same file (durability across process restarts)", async () => {
    const first = await openJobStore(dbPath);
    first.insert(row({ status: "running", pid: 111 }));
    first.close();

    const second = await openJobStore(dbPath);
    try {
      const got = second.get("20260918T000000Z-aaaaaaaa");
      expect(got?.status).toBe("running");
      expect(got?.pid).toBe(111);
    } finally {
      second.close();
    }
  });

  it("insert() throws a typed JobAlreadyExistsError for a duplicate requestId, not an opaque native error (A-132 Opus review #4)", async () => {
    const store = await openJobStore(dbPath);
    try {
      store.insert(row());
      expect(() => store.insert(row())).toThrow(JobAlreadyExistsError);
      try {
        store.insert(row());
        throw new Error("expected insert() to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(JobAlreadyExistsError);
        expect((err as JobAlreadyExistsError).requestId).toBe("20260918T000000Z-aaaaaaaa");
      }
    } finally {
      store.close();
    }
  });

  it("update() only rewrites the patched columns, leaving untouched columns unaffected by concurrent state (A-132 Opus review #13)", async () => {
    const store = await openJobStore(dbPath);
    try {
      store.insert(row());
      // patch touches only `pid`; every other column (including ones a concurrent writer might
      // have since changed) must be preserved exactly, not silently reset to the value this
      // caller last read.
      const updated = store.update("20260918T000000Z-aaaaaaaa", { pid: 555 });
      expect(updated.pid).toBe(555);
      expect(updated.status).toBe("queued");
      expect(updated.hostname).toBe("test-host");
    } finally {
      store.close();
    }
  });
});
