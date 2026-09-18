import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeConfig } from "../../src/cli/config.js";
import {
  jobStorePath,
  reconcileJob,
  type SpawnRunner,
  submitJob,
  waitForJob,
} from "../../src/cli/submit.js";
import { openJobStore } from "../../src/state/jobstore.js";

let dir: string;
let cfg: BridgeConfig;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-submit-"));
  cfg = {
    repoRoot: dir,
    runtimeDir: dir,
    profileDir: join(dir, "profile"),
    locksDir: join(dir, "locks"),
    stateDir: join(dir, "state"),
    artifactsDir: join(dir, "artifacts"),
    channel: "chrome",
    traceOnSuccess: false,
    imageViaViewer: false,
    logLevel: "error",
    bridgeVersion: "test",
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeRequest(id: string, promptText = "hi"): Promise<string> {
  const reqDir = join(dir, "requests", id);
  await mkdir(reqDir, { recursive: true });
  await writeFile(join(reqDir, "prompt.md"), promptText);
  const reqPath = join(reqDir, "request.json");
  await writeFile(
    reqPath,
    JSON.stringify({
      schemaVersion: "1.2",
      requestId: id,
      promptFile: "prompt.md",
      preset: "current",
      newChat: true,
      responseFormat: "markdown",
    }),
  );
  return reqPath;
}

describe("submitJob (Phase 1, A-132)", () => {
  it("validates, records a queued->running job, and calls the injected spawnRunner exactly once", async () => {
    const reqPath = await writeRequest("20260918T000001Z-aaaaaaaa");
    const calls: string[] = [];
    const spawn: SpawnRunner = async (requestPath) => {
      calls.push(requestPath);
      return 424242;
    };
    const out = await submitJob(cfg, reqPath, spawn);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.job.requestId).toBe("20260918T000001Z-aaaaaaaa");
    expect(out.job.status).toBe("running");
    expect(out.job.pid).toBe(424242);
    expect(out.alreadySubmitted).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("is idempotent: resubmitting the same requestId with identical content returns the existing job without spawning again", async () => {
    const reqPath = await writeRequest("20260918T000002Z-bbbbbbbb");
    let calls = 0;
    const spawn: SpawnRunner = async () => {
      calls++;
      return 1;
    };
    const first = await submitJob(cfg, reqPath, spawn);
    const second = await submitJob(cfg, reqPath, spawn);
    expect(first.ok && second.ok).toBe(true);
    expect(calls).toBe(1);
    if (second.ok) expect(second.alreadySubmitted).toBe(true);
  });

  it("refuses a resubmit under the same requestId with different content (conflict)", async () => {
    const reqPath = await writeRequest("20260918T000003Z-cccccccc", "hi");
    await submitJob(cfg, reqPath, async () => 1);
    // overwrite the prompt in place, then resubmit the same requestId
    await writeFile(join(dir, "requests", "20260918T000003Z-cccccccc", "prompt.md"), "different");
    const second = await submitJob(cfg, reqPath, async () => 2);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.cause).toMatch(/conflict/);
  });

  it("refuses an invalid request without touching the job store", async () => {
    const reqDir = join(dir, "requests", "bad");
    await mkdir(reqDir, { recursive: true });
    await writeFile(join(reqDir, "request.json"), "{}"); // missing required fields
    const out = await submitJob(cfg, join(reqDir, "request.json"), async () => 1);
    expect(out.ok).toBe(false);
  });

  it("A-132 Opus review, High #1: marks the job failed immediately if spawnRunner throws, instead of leaving it stuck at queued/pid:null forever", async () => {
    const reqPath = await writeRequest("20260918T000008Z-22222222");
    const out = await submitJob(cfg, reqPath, async () => {
      throw new Error("EACCES: could not open submit.log");
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.cause).toMatch(/failed to start the run/);
    const store = await openJobStore(jobStorePath(cfg));
    try {
      const job = store.get("20260918T000008Z-22222222");
      expect(job?.status).toBe("failed");
      expect(job?.errorCode).toBe("INTERNAL_ERROR");
    } finally {
      store.close();
    }
    // a subsequent submit of the same requestId must not be treated as "already submitted and
    // running forever" — the stuck-row bug meant idempotency permanently blocked any retry.
  });

  it("A-132 Opus review, High #1: marks the job failed if the spawned process reports no pid", async () => {
    const reqPath = await writeRequest("20260918T000009Z-33333333");
    const out = await submitJob(cfg, reqPath, async () => null);
    expect(out.ok).toBe(false);
    const store = await openJobStore(jobStorePath(cfg));
    try {
      expect(store.get("20260918T000009Z-33333333")?.status).toBe("failed");
    } finally {
      store.close();
    }
  });

  it("A-132 Opus review, Medium #5: the idempotency hash covers preset/model/newChat/etc., not just prompt+attachment bytes", async () => {
    const id = "20260918T000010Z-44444444";
    const reqDir = join(dir, "requests", id);
    await mkdir(reqDir, { recursive: true });
    await writeFile(join(reqDir, "prompt.md"), "same prompt");
    const reqPath = join(reqDir, "request.json");
    const write = (preset: string) =>
      writeFile(
        reqPath,
        JSON.stringify({
          schemaVersion: "1.2",
          requestId: id,
          promptFile: "prompt.md",
          preset,
          newChat: true,
          responseFormat: "markdown",
        }),
      );
    await write("current");
    const first = await submitJob(cfg, reqPath, async () => 1);
    expect(first.ok).toBe(true);
    // same prompt, same requestId, but a different preset -> must be a conflict, not silently
    // "already submitted" against the old (different) request.
    await write("high");
    const second = await submitJob(cfg, reqPath, async () => 2);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.cause).toMatch(/conflict/);
  });

  it("A-132 Opus review, Medium #6: refuses to spawn (and never inserts a row) while bridge.lock is genuinely busy, instead of spawning into ALREADY_RUNNING", async () => {
    const reqPath = await writeRequest("20260918T000011Z-55555555");
    await mkdir(cfg.locksDir, { recursive: true });
    await writeFile(
      join(cfg.locksDir, "bridge.lock"),
      JSON.stringify({
        pid: process.pid, // genuinely alive: this test process itself
        startedAt: new Date().toISOString(),
        token: "t",
        command: "run",
        requestId: null,
        hostname: osHostname(),
      }),
    );
    let calls = 0;
    const out = await submitJob(cfg, reqPath, async () => {
      calls++;
      return 1;
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.cause).toMatch(/ALREADY_RUNNING/);
    expect(calls).toBe(0); // never spawned into the busy lock
    const store = await openJobStore(jobStorePath(cfg));
    try {
      expect(store.get("20260918T000011Z-55555555")).toBeNull(); // never inserted either
    } finally {
      store.close();
    }
  });
});

describe("reconcileJob / waitForJob (Phase 1, A-132)", () => {
  it("reconcileJob promotes a running job to completed once result.json appears", async () => {
    const reqPath = await writeRequest("20260918T000004Z-dddddddd");
    const requestDir = join(dir, "requests", "20260918T000004Z-dddddddd");
    const out = await submitJob(cfg, reqPath, async () => 999999999); // pid unlikely to exist
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const store = await openJobStore(jobStorePath(cfg));
    try {
      // still "running" and no result.json yet -> reconcile is a no-op (pid may or may not be alive)
      await writeFile(
        join(requestDir, "result.json"),
        JSON.stringify({ status: "completed", error: null }),
      );
      const reconciled = await reconcileJob(store, store.get(out.job.requestId) as never, cfg);
      expect(reconciled.status).toBe("completed");
      expect(reconciled.resultPath).toBe(join(requestDir, "result.json"));
    } finally {
      store.close();
    }
  });

  it("reconcileJob marks a job failed (BROWSER_CRASHED: never dispatched) if its pid is dead, no result.json was ever written, and no submit.marker shows a dispatch", async () => {
    const reqPath = await writeRequest("20260918T000005Z-eeeeeeee");
    const out = await submitJob(cfg, reqPath, async () => 999999999); // almost certainly not alive
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const store = await openJobStore(jobStorePath(cfg));
    try {
      const reconciled = await reconcileJob(store, store.get(out.job.requestId) as never, cfg);
      expect(reconciled.status).toBe("failed");
      expect(reconciled.errorCode).toBe("BROWSER_CRASHED");
    } finally {
      store.close();
    }
  });

  it("A-134/A-135 (Phase 2 MVP, Opus-reviewed): reconcileJob reports SUBMIT_STATE_UNKNOWN whenever a submit.marker exists, regardless of which fields it has — presence alone means a submit was in flight", async () => {
    // A-135: the first cut of A-134 gated on marker.urlAfter specifically, which is only set
    // *after* a confirmed dispatch. That inverted the write-ahead guarantee: a crash between the
    // actual click and the UPDATE_MARKER write left urlAfter empty, and the buggy version called
    // that "safe to retry" -- precisely the dangerous window this check exists to catch. Every
    // marker variant below must be treated identically: something was submitted, don't guess.
    const { writeMarker, markerPath: mkPath } = await import("../../src/state/marker.js");
    const cases: Array<[string, (id: string) => Promise<void>]> = [
      [
        "full marker: dispatchedAt + urlAfter both set (confirmed dispatch)",
        (id) =>
          writeMarker(mkPath(cfg.stateDir, id), {
            requestId: id,
            writtenAt: new Date().toISOString(),
            urlBefore: "https://chatgpt.com/",
            baselineAssistantCount: 0,
            presetLabelBefore: "現在",
            dispatchedAt: new Date().toISOString(),
            urlAfter: "https://chatgpt.com/c/abc123",
          }),
      ],
      [
        "pre-dispatch marker only: no dispatchedAt/urlAfter yet (crash between the click and UPDATE_MARKER -- A-135's exact scenario)",
        (id) =>
          writeMarker(mkPath(cfg.stateDir, id), {
            requestId: id,
            writtenAt: new Date().toISOString(),
            urlBefore: "https://chatgpt.com/",
            baselineAssistantCount: 0,
            presetLabelBefore: "現在",
          }),
      ],
      [
        "dispatchedAt set but urlAfter is the empty string (non-chatgpt.com URL at dispatch time — controller.ts's own fallback)",
        (id) =>
          writeMarker(mkPath(cfg.stateDir, id), {
            requestId: id,
            writtenAt: new Date().toISOString(),
            urlBefore: "https://chatgpt.com/",
            baselineAssistantCount: 0,
            presetLabelBefore: "現在",
            dispatchedAt: new Date().toISOString(),
            urlAfter: "",
          }),
      ],
      [
        "unparseable/corrupt marker file (still counts as present per markerExists()'s own contract)",
        (id) => writeFile(mkPath(cfg.stateDir, id), "{not json"),
      ],
    ];
    let n = 0;
    for (const [, setup] of cases) {
      n++;
      const id = `20260918T00002${n}Z-99999999`;
      const reqPath = await writeRequest(id);
      const out = await submitJob(cfg, reqPath, async () => 999999999); // almost certainly not alive
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      await mkdir(join(cfg.stateDir, id), { recursive: true });
      await setup(id);
      const store = await openJobStore(jobStorePath(cfg));
      try {
        const reconciled = await reconcileJob(store, store.get(out.job.requestId) as never, cfg);
        expect(reconciled.status).toBe("failed");
        expect(reconciled.errorCode).toBe("SUBMIT_STATE_UNKNOWN");
      } finally {
        store.close();
      }
    }
  });

  it("waitForJob returns promptly once the job reaches a terminal state, without waiting for the full timeout", async () => {
    const reqPath = await writeRequest("20260918T000006Z-ffffffff");
    const requestDir = join(dir, "requests", "20260918T000006Z-ffffffff");
    const out = await submitJob(cfg, reqPath, async () => 999999999);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await writeFile(
      join(requestDir, "result.json"),
      JSON.stringify({ status: "completed", error: null }),
    );
    const store = await openJobStore(jobStorePath(cfg));
    try {
      const sleeps: number[] = [];
      const { job, timedOut } = await waitForJob(
        store,
        out.job.requestId,
        60_000,
        cfg,
        10,
        async (ms) => {
          sleeps.push(ms);
        },
      );
      expect(timedOut).toBe(false);
      expect(job?.status).toBe("completed");
      expect(sleeps).toHaveLength(0); // resolved on the very first poll, never slept
    } finally {
      store.close();
    }
  });

  it("A-132 Opus review, High #2: a foreign-host job (pid can't be checked remotely) is left alone, not guessed dead", async () => {
    const reqPath = await writeRequest("20260918T000012Z-66666666");
    const out = await submitJob(cfg, reqPath, async () => 12345);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const store = await openJobStore(jobStorePath(cfg));
    try {
      const job = store.get(out.job.requestId) as never;
      const reconciled = await reconcileJob(store, job, cfg, {
        isProcessAlive: () => false, // would look dead by a bare local check
        processStartedAt: async () => null,
        hostname: "some-other-host", // job.hostname is this test process's own real hostname
      });
      expect(reconciled.status).toBe("running"); // unchanged: can't verify remotely, assume live
    } finally {
      store.close();
    }
  });

  it("A-132 Opus review, High #2: a same-host job whose pid was reused by an unrelated process is correctly judged dead", async () => {
    const reqPath = await writeRequest("20260918T000013Z-77777777");
    const out = await submitJob(cfg, reqPath, async () => 12345);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const store = await openJobStore(jobStorePath(cfg));
    try {
      const job = store.get(out.job.requestId) as never;
      const reconciled = await reconcileJob(store, job, cfg, {
        isProcessAlive: () => true, // pid 12345 exists...
        // ...but it started well after this job recorded its own submittedAt -> reused
        processStartedAt: async () => new Date(Date.parse(job.submittedAt) + 60_000),
        hostname: job.hostname,
      });
      expect(reconciled.status).toBe("failed");
      expect(reconciled.errorCode).toBe("BROWSER_CRASHED"); // no submit.marker -> never dispatched
    } finally {
      store.close();
    }
  });

  it("A-132 Opus review, High #2: a job wrongly guessed 'failed' is corrected once result.json genuinely appears afterward", async () => {
    const reqPath = await writeRequest("20260918T000014Z-88888888");
    const requestDir = join(dir, "requests", "20260918T000014Z-88888888");
    const out = await submitJob(cfg, reqPath, async () => 999999999); // almost certainly dead
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const store = await openJobStore(jobStorePath(cfg));
    try {
      // first reconcile: no result.json yet, pid looks dead -> wrongly marked failed
      const first = await reconcileJob(store, store.get(out.job.requestId) as never, cfg);
      expect(first.status).toBe("failed");
      // the real run actually finishes a moment later
      await writeFile(
        join(requestDir, "result.json"),
        JSON.stringify({ status: "completed", error: null }),
      );
      const second = await reconcileJob(store, store.get(out.job.requestId) as never, cfg);
      expect(second.status).toBe("completed");
    } finally {
      store.close();
    }
  });

  it("waitForJob times out without altering the job itself (still running)", async () => {
    const reqPath = await writeRequest("20260918T000007Z-11111111");
    const out = await submitJob(cfg, reqPath, async () => process.pid); // this process: genuinely alive
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const store = await openJobStore(jobStorePath(cfg));
    try {
      const { job, timedOut } = await waitForJob(
        store,
        out.job.requestId,
        5,
        cfg,
        1,
        async () => undefined,
      );
      expect(timedOut).toBe(true);
      expect(job?.status).toBe("running");
    } finally {
      store.close();
    }
  });
});
