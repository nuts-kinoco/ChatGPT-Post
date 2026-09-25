import { describe, expect, it } from "vitest";
import type { Observation } from "../../src/chatgpt/completion.js";
import { checkResultInvariants } from "../../src/contracts/invariants.js";
import type { BridgeResult } from "../../src/contracts/types.js";
import {
  POST_SUBMIT_STABILIZATION_AND_EXTRACTION_BUDGET_MS,
  preSubmitWatchdogBudgetMs,
  RunController,
} from "../../src/state/controller.js";
import type { ChatGptPort, Ports } from "../../src/state/ports.js";

interface Fake {
  ports: Ports;
  calls: string[];
  results: BridgeResult[];
  responses: string[];
  markers: Map<string, unknown>;
  lockBusy: boolean;
  lockVerify: boolean;
  timeline: Observation[];
}

function observation(o: Partial<Observation>): Observation {
  return {
    t: 0,
    assistantCount: 1,
    userTurnCount: 1,
    composerText: "",
    lastAssistantHash: "h",
    lastAssistantEmpty: false,
    streaming: false,
    composerReady: true,
    copyAvailable: true,
    truncated: false,
    sidePanel: false,
    errorBanner: "none",
    challenge: "none",
    ...o,
  };
}

function fake(
  over: Partial<ChatGptPort> = {},
  opts: {
    lockBusy?: boolean;
    lockVerify?: boolean;
    captureFails?: boolean;
    priorResult?: boolean;
    markerExists?: boolean;
  } = {},
): Fake {
  const calls: string[] = [];
  const results: BridgeResult[] = [];
  const responses: string[] = [];
  const markers = new Map<string, unknown>();
  let mono = 0;
  const timeline: Observation[] = [
    observation({ assistantCount: 0 }),
    observation({ streaming: true, composerReady: false }),
    observation({ streaming: true, composerReady: false }),
    observation({ streaming: false }),
    observation({ streaming: false }),
  ];
  let obsIndex = 0;
  const chatgpt: ChatGptPort = {
    navigateAndObserveAuth: async () => ({ kind: "AUTH_OK" }),
    openNewChat: async () => ({ kind: "ok" }),
    openConversation: async () => ({ kind: "ok" }),
    openProject: async () => ({ kind: "ok" }),
    openConversationForRecovery: async () => ({ kind: "ok", draftPresent: false }),
    resolveOrCreateProject: async () => ({
      kind: "ok",
      url: "https://chatgpt.com/g/g-p-project/project",
      created: false,
    }),
    resolvePreset: async () => ({
      kind: "observed",
      preset: "pro",
      label: "Pro",
      model: "latest",
      modelLabel: "最新",
    }),
    enterPrompt: async () => ({ kind: "ok" }),
    snapshotBaseline: async () => ({
      kind: "ok",
      baseline: {
        assistantCount: 0,
        userTurnCount: 0,
        url: "https://chatgpt.com/",
        presetLabel: "Pro",
      },
    }),
    dispatchSubmit: async () => ({ kind: "dispatched", url: "https://chatgpt.com/c/123" }),
    clearUnsentPrompt: async () => {
      calls.push("clearUnsentPrompt");
      return { kind: "cleared" };
    },
    observe: async (t) => {
      const o = timeline[Math.min(obsIndex++, timeline.length - 1)] ?? observation({});
      return { ...o, t };
    },
    currentUrl: async () => "https://chatgpt.com/c/123",
    recordRouteTelemetry: async () => null,
    extractLatest: async () => ({
      markdown: "# Bridge Smoke Test\n\nreq",
      method: "copy",
      quality: "full",
      modelSlug: "gpt-5-6",
    }),
    inspectUiReport: async (dir) => `${dir}/inspect-ui.json`,
    restoreEffort: async () => {
      calls.push("restoreEffort");
      return { kind: "unchanged" };
    },
    captureImages: async () => ({ saved: [], warnings: [] }),
    ...over,
  };
  const f: Fake = {
    calls,
    results,
    responses,
    markers,
    lockBusy: opts.lockBusy ?? false,
    lockVerify: opts.lockVerify ?? true,
    timeline,
    ports: {
      clock: {
        now: () => new Date(2026, 8, 15, 12, 0, 0),
        monotonic: () => (mono += 500),
        sleep: async () => undefined,
      },
      contracts: {
        readRequest: async () => ({
          kind: "read",
          requestId: "req-00000001",
          raw: {},
          requestDir: "/req",
        }),
        priorState: async () => (opts.priorResult ? "result" : "none"),
        validate: async () => ({
          kind: "valid",
          request: {
            schemaVersion: "1.0",
            requestId: "req-00000001",
            promptFile: "p",
            preset: "current",
            newChat: true,
            responseFormat: "markdown",
          },
          prompt: "hi",
          timeoutMs: 60_000,
          attachments: [],
          attachmentBytes: 0,
        }),
        writeResponse: async (_d, md) => {
          calls.push("writeResponse");
          responses.push(md);
          return "/req/response.md";
        },
        writeResult: async (_d, r) => {
          calls.push("writeResult");
          results.push(r);
          return "/req/result.json";
        },
      },
      lock: {
        acquire: async () => {
          calls.push("acquire");
          return f.lockBusy ? { kind: "busy", cause: "held" } : { kind: "ok" };
        },
        verify: async () => {
          calls.push("verify");
          return f.lockVerify;
        },
        release: async () => {
          calls.push("release");
        },
        markerExists: async () => opts.markerExists ?? false,
        writeMarker: async (id, m) => {
          calls.push("writeMarker");
          markers.set(id, m);
        },
        updateMarker: async () => {
          calls.push("updateMarker");
        },
        deleteMarker: async (id) => {
          calls.push("deleteMarker");
          markers.delete(id);
        },
      },
      browser: {
        checkProfilePath: async () => ({ ok: true }),
        checkProfileFree: async () => ({ free: true }),
        launch: async () => {
          calls.push("launch");
          return { ok: true };
        },
        capture: async () => {
          calls.push("capture");
          if (opts.captureFails) throw new Error("screenshot exploded");
          return "/art/screenshot.png";
        },
        sealTrace: async () => {
          calls.push("sealTrace");
        },
        finalizeTrace: async (_dir, keep) => {
          calls.push(`finalizeTrace:${keep}`);
          return keep ? "/art/trace.zip" : null;
        },
        close: async () => {
          calls.push("close");
        },
      },
      chatgpt,
      log: () => undefined,
      stderr: (m) => calls.push(`stderr:${m}`),
    },
  };
  return f;
}

function run(f: Fake, extra: Partial<ConstructorParameters<typeof RunController>[1]> = {}) {
  return new RunController(f.ports, {
    requestPath: "/req/request.json",
    artifactsRoot: "/art",
    bridgeVersion: "0.1.0",
    traceOnSuccess: false,
    observationIntervalMs: 0,
    ...extra,
  }).run();
}

describe("RunController", () => {
  it("A-152: reports the derived pre-submit budget, then reports timeoutMs only after dispatch", async () => {
    const f = fake();
    const seen: Array<["pre" | "submit", number]> = [];
    await run(f, {
      onPreSubmitBudgetKnown: (budget) => seen.push(["pre", budget]),
      onSubmitDispatched: (timeout) => seen.push(["submit", timeout]),
    });
    expect(seen).toEqual([
      ["pre", 632_000],
      ["submit", 60_000],
    ]);
    expect(preSubmitWatchdogBudgetMs(1024 * 1024, 1)).toBe(782_000);
    expect(POST_SUBMIT_STABILIZATION_AND_EXTRACTION_BUDGET_MS).toBe(125_000);
  });

  it("SIGTERM-style interruption writes a terminal result, closes/detaches, then releases the lock", async () => {
    let rejectObserve: ((reason: Error) => void) | null = null;
    const f = fake({
      observe: async () =>
        new Promise<Observation>((_resolve, reject) => {
          rejectObserve = reject;
        }),
    });
    const originalClose = f.ports.browser.close;
    f.ports.browser.close = async () => {
      await originalClose();
      rejectObserve?.(new Error("session closed"));
    };
    const controller = new RunController(f.ports, {
      requestPath: "/req/request.json",
      artifactsRoot: "/art",
      bridgeVersion: "0.1.0",
      traceOnSuccess: false,
      observationIntervalMs: 0,
    });
    const running = controller.run();
    for (let i = 0; i < 20 && rejectObserve === null; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    await controller.interrupt("SIGTERM");
    const out = await running;
    expect(out.result?.error?.code).toBe("INTERNAL_ERROR");
    expect(out.result?.error?.cause).toContain("SIGTERM");
    expect(f.calls.indexOf("writeResult")).toBeLessThan(f.calls.lastIndexOf("close"));
    expect(f.calls.lastIndexOf("close")).toBeLessThan(f.calls.indexOf("release"));
  });

  it("happy path: completed, response then result, close before release", async () => {
    const f = fake();
    const observe = f.ports.chatgpt.observe;
    f.ports.chatgpt.observe = async (elapsed) => {
      f.calls.push("observe");
      return observe(elapsed);
    };
    const out = await run(f);
    expect(out.exitCode).toBe(0);
    expect(out.result?.status).toBe("completed");
    expect(out.result?.observedPreset).toBe("pro");
    expect(out.result?.requestedModel).toBe("current");
    expect(out.result?.observedModel).toBe("latest");
    expect(out.result?.observedModelSlug).toBe("gpt-5-6");
    expect(out.result?.schemaVersion).toBe("1.2");
    expect(out.result?.images).toEqual([]);
    expect(out.result?.submitted).toBe("yes");
    expect(out.result?.conversationUrl).toBe("https://chatgpt.com/c/123");
    expect(f.calls.indexOf("writeMarker")).toBeLessThan(f.calls.indexOf("writeResponse"));
    expect(f.calls.indexOf("verify")).toBeLessThan(f.calls.indexOf("writeMarker"));
    expect(f.calls.indexOf("writeResponse")).toBeLessThan(f.calls.indexOf("writeResult"));
    expect(f.calls.indexOf("close")).toBeLessThan(f.calls.indexOf("release"));
    expect(f.calls.indexOf("restoreEffort")).toBeLessThan(f.calls.indexOf("close"));
    expect(f.calls).toContain("sealTrace"); // sealed before the long response wait
    expect(f.calls).toContain("finalizeTrace:false"); // trace on success disabled
    expect(f.calls.indexOf("sealTrace")).toBeLessThan(f.calls.indexOf("observe"));
  });

  it("A-144: a direct Project URL keeps A-106 routing and reports its handshake", async () => {
    const projectUrl = "https://chatgpt.com/g/g-p-existing/project";
    const calls: string[] = [];
    const f = fake({
      resolveOrCreateProject: async () => {
        calls.push("resolve");
        return { kind: "ok", url: projectUrl, created: false };
      },
      openProject: async (url) => {
        calls.push(`open:${url}`);
        return { kind: "ok" };
      },
    });
    f.ports.contracts.validate = async () => ({
      kind: "valid",
      request: {
        schemaVersion: "1.3",
        requestId: "req-00000001",
        promptFile: "p",
        preset: "current",
        newChat: true,
        project: projectUrl,
        responseFormat: "markdown",
      },
      prompt: "hi",
      timeoutMs: 60_000,
      attachments: [],
      attachmentBytes: 0,
    });
    const out = await run(f);
    expect(calls).toEqual([`open:${projectUrl}`]);
    expect(out.result?.project).toEqual({
      requested: projectUrl,
      resolvedUrl: projectUrl,
      created: false,
    });
  });

  it("A-144: a Project name resolves before openProject and reports creation", async () => {
    const resolvedUrl = "https://chatgpt.com/g/g-p-created/project";
    const calls: string[] = [];
    const f = fake({
      resolveOrCreateProject: async (name) => {
        calls.push(`resolve:${name}`);
        return { kind: "ok", url: resolvedUrl, created: true };
      },
      openProject: async (url) => {
        calls.push(`open:${url}`);
        return { kind: "ok" };
      },
    });
    f.ports.contracts.validate = async () => ({
      kind: "valid",
      request: {
        schemaVersion: "1.3",
        requestId: "req-00000001",
        promptFile: "p",
        preset: "current",
        newChat: true,
        project: "EMAKINOCO-Win",
        responseFormat: "markdown",
      },
      prompt: "hi",
      timeoutMs: 60_000,
      attachments: [],
      attachmentBytes: 0,
    });
    const out = await run(f);
    expect(calls).toEqual(["resolve:EMAKINOCO-Win", `open:${resolvedUrl}`]);
    expect(out.result?.project).toEqual({
      requested: "EMAKINOCO-Win",
      resolvedUrl,
      created: true,
    });
  });

  it("A-144: a failed name resolution keeps a partial handshake instead of hiding the request", async () => {
    const f = fake({
      resolveOrCreateProject: async () => ({
        kind: "dom_unexpected",
        element: "projectSidebarItem",
        tried: [],
      }),
    });
    f.ports.contracts.validate = async () => ({
      kind: "valid",
      request: {
        schemaVersion: "1.3",
        requestId: "req-00000001",
        promptFile: "p",
        preset: "current",
        newChat: true,
        project: "EMAKINOCO-Win",
        responseFormat: "markdown",
      },
      prompt: "hi",
      timeoutMs: 60_000,
      attachments: [],
      attachmentBytes: 0,
    });
    const out = await run(f);
    expect(out.result?.error?.code).toBe("DOM_CHANGED");
    expect(out.result?.project).toEqual({
      requested: "EMAKINOCO-Win",
      resolvedUrl: null,
      created: null,
    });
  });

  it("A-146 follow-up: uncertain Project creation writes an honest handshake and does not resolve again", async () => {
    let resolveCalls = 0;
    const f = fake({
      resolveOrCreateProject: async () => {
        resolveCalls++;
        return {
          kind: "creation_uncertain",
          cause:
            "Project creation was submitted but not confirmed; check the sidebar manually before retrying.",
        };
      },
    });
    f.ports.contracts.validate = async () => ({
      kind: "valid",
      request: {
        schemaVersion: "1.3",
        requestId: "req-00000001",
        promptFile: "p",
        preset: "current",
        newChat: true,
        project: "EMAKINOCO-Uncertain",
        responseFormat: "markdown",
      },
      prompt: "hi",
      timeoutMs: 60_000,
      attachments: [],
      attachmentBytes: 0,
    });
    const out = await run(f);
    expect(resolveCalls).toBe(1);
    expect(out.result?.status).toBe("manual_intervention_required");
    expect(out.result?.error).toMatchObject({
      code: "MANUAL_INTERVENTION_REQUIRED",
      retryable: false,
      cause: expect.stringContaining("submitted but not confirmed"),
    });
    expect(out.result?.project).toEqual({
      requested: "EMAKINOCO-Uncertain",
      resolvedUrl: null,
      created: null,
    });
  });

  it("A-148: a phase timeout after the create boundary aborts the abandoned task and is manual", async () => {
    let resolveCalls = 0;
    let lateConfirmClicks = 0;
    const f = fake({
      resolveOrCreateProject: async (_name, control) => {
        resolveCalls++;
        control?.markSubmitted();
        await new Promise<void>((done) => control?.signal.addEventListener("abort", done));
        // This represents the abandoned page task resuming after the controller's race. It must
        // observe abort before attempting the irreversible confirm click.
        if (!control?.signal.aborted) lateConfirmClicks++;
        return { kind: "retry", cause: "aborted before confirm" };
      },
    });
    f.ports.contracts.validate = async () => ({
      kind: "valid",
      request: {
        schemaVersion: "1.3",
        requestId: "req-00000001",
        promptFile: "p",
        preset: "current",
        newChat: true,
        project: "EMAKINOCO-Timeout",
        responseFormat: "markdown",
      },
      prompt: "hi",
      timeoutMs: 60_000,
      attachments: [],
      attachmentBytes: 0,
    });
    // The fake monotonic clock advances 500 ms on each read. This makes the create effect start
    // after its AUTH_CHECKED allowance, while still proving that the already-marked boundary wins.
    const out = await run(f, { phaseLimitsMs: { AUTH_CHECKED: 1 } });
    await Promise.resolve(); // let the aborted, raced promise reach its guarded late-click branch
    expect(resolveCalls).toBe(1);
    expect(lateConfirmClicks).toBe(0);
    expect(out.result?.status).toBe("manual_intervention_required");
    expect(out.result?.error?.code).toBe("MANUAL_INTERVENTION_REQUIRED");
    expect(out.result?.project).toEqual({
      requested: "EMAKINOCO-Timeout",
      resolvedUrl: null,
      created: null,
    });
  });

  it("A-148: an AUTH_CHECKED retry receives a fresh phase budget", async () => {
    let attempts = 0;
    const f = fake({
      resolveOrCreateProject: async () => {
        attempts++;
        return attempts === 1
          ? { kind: "retry" as const, cause: "first absence scan was inconclusive" }
          : {
              kind: "creation_uncertain" as const,
              cause: "Project creation was submitted but not confirmed",
            };
      },
    });
    f.ports.contracts.validate = async () => ({
      kind: "valid",
      request: {
        schemaVersion: "1.3",
        requestId: "req-00000001",
        promptFile: "p",
        preset: "current",
        newChat: true,
        project: "EMAKINOCO-Retry-Budget",
        responseFormat: "markdown",
      },
      prompt: "hi",
      timeoutMs: 60_000,
      attachments: [],
      attachmentBytes: 0,
    });
    // One attempt consumes 500 ms in this fake clock. Without the retry reset the second call has
    // no remaining 600 ms allowance and becomes DOM_CHANGED instead of reaching its own outcome.
    const out = await run(f, { phaseLimitsMs: { AUTH_CHECKED: 600 } });
    expect(attempts).toBe(2);
    expect(out.result?.status).toBe("manual_intervention_required");
    expect(out.result?.error?.code).toBe("MANUAL_INTERVENTION_REQUIRED");
  });

  it("ALREADY_RUNNING: no browser, no result.json, exit 4", async () => {
    const f = fake({}, { lockBusy: true });
    const out = await run(f);
    expect(out.exitCode).toBe(4);
    expect(out.result).toBeNull();
    expect(f.calls).not.toContain("launch");
    expect(f.calls).not.toContain("writeResult");
  });

  it("ALREADY_PROCESSED: nothing written, exit 4", async () => {
    const f = fake({}, { priorResult: true });
    const out = await run(f);
    expect(out.exitCode).toBe(4);
    expect(f.calls).not.toContain("acquire");
    expect(f.results).toEqual([]);
  });

  it("marker present: SUBMIT_STATE_UNKNOWN after lock, exit 1, submitted unknown", async () => {
    const f = fake({}, { markerExists: true });
    const out = await run(f);
    expect(out.exitCode).toBe(1);
    expect(out.result?.error?.code).toBe("SUBMIT_STATE_UNKNOWN");
    expect(out.result?.submitted).toBe("unknown");
    expect(f.calls).toContain("acquire");
    expect(f.calls).not.toContain("launch");
  });

  it("lock lost before marker: no marker, no submit, ALREADY_RUNNING", async () => {
    const f = fake({}, { lockVerify: false });
    const out = await run(f);
    expect(out.exitCode).toBe(4);
    expect(f.calls).not.toContain("writeMarker");
    expect(f.results).toEqual([]);
  });

  it("best-effort capture failure still writes result.json with a warning", async () => {
    const f = fake(
      { navigateAndObserveAuth: async () => ({ kind: "AUTH_REQUIRED" }) },
      { captureFails: true },
    );
    const out = await run(f);
    expect(out.exitCode).toBe(3);
    expect(out.result?.status).toBe("manual_intervention_required");
    expect(out.result?.error?.code).toBe("AUTH_REQUIRED");
    // A-151 writes the terminal protocol before slow diagnostics.  A later capture
    // failure therefore cannot delay or rewrite the already-observable result.
    expect(out.result?.warnings.join()).not.toMatch(/capture_failed/);
    expect(out.result?.artifacts).toEqual([]);
    expect(f.calls.indexOf("writeResult")).toBeLessThan(f.calls.indexOf("capture"));
  });

  it("SUBMIT_ABORTED: click not dispatched, marker deleted, submitted no", async () => {
    const f = fake({ dispatchSubmit: async () => ({ kind: "aborted" }) });
    const out = await run(f);
    expect(out.exitCode).toBe(1);
    expect(out.result?.error?.code).toBe("MODEL_NOT_VERIFIABLE");
    expect(out.result?.error?.cause).toBe("preset_changed");
    expect(out.result?.submitted).toBe("no");
    expect(f.calls).toContain("deleteMarker");
  });

  it("A-155: a retained exact draft after the click is SUBMIT_NOT_CONFIRMED, safe to retry, and never observed", async () => {
    const f = fake({
      dispatchSubmit: async () => ({
        kind: "not_confirmed",
        cause: "composer retained the exact prompt",
        url: "https://chatgpt.com/c/123",
      }),
      observe: async () => {
        throw new Error("must not enter response observation for an unsent prompt");
      },
    });
    const out = await run(f);
    expect(out.result?.error?.code).toBe("SUBMIT_NOT_CONFIRMED");
    expect(out.result?.submitted).toBe("no");
    expect(out.result?.error?.retryable).toBe(true);
    expect(f.calls).toContain("deleteMarker");
    expect(f.calls).not.toContain("updateMarker");
  });

  it("A-155: a cleared composer without a user turn remains SUBMIT_STATE_UNKNOWN", async () => {
    const f = fake({
      dispatchSubmit: async () => ({
        kind: "unknown",
        cause: "composer cleared but no turn",
        url: "https://chatgpt.com/c/123",
      }),
    });
    const out = await run(f);
    expect(out.result?.error?.code).toBe("SUBMIT_STATE_UNKNOWN");
    expect(out.result?.submitted).toBe("unknown");
    expect(f.calls).not.toContain("deleteMarker");
  });

  it("A-155: failed marker cleanup downgrades a not-sent observation to unknown", async () => {
    const f = fake({
      dispatchSubmit: async () => ({
        kind: "not_confirmed",
        cause: "composer retained the exact prompt",
        url: "https://chatgpt.com/c/123",
      }),
    });
    f.ports.lock.deleteMarker = async () => {
      throw new Error("sharing violation");
    };
    const out = await run(f);
    expect(out.result?.error?.code).toBe("SUBMIT_STATE_UNKNOWN");
    expect(out.result?.submitted).toBe("unknown");
    expect(out.result?.error?.retryable).toBe(false);
  });

  it("A-155b: an existing-chat dispatch with an exact retained draft is cleaned then fails early", async () => {
    let observations = 0;
    const f = fake({
      observe: async (t) => {
        observations++;
        return observation({
          t,
          assistantCount: 0,
          userTurnCount: 0,
          composerText: "hi",
          streaming: false,
        });
      },
    });
    f.ports.contracts.validate = async () => ({
      kind: "valid",
      request: {
        schemaVersion: "1.0",
        requestId: "req-00000001",
        promptFile: "p",
        preset: "current",
        newChat: false,
        responseFormat: "markdown",
      },
      prompt: "hi",
      timeoutMs: 60_000,
      attachments: [],
      attachmentBytes: 0,
    });
    const out = await run(f);
    expect(out.result?.error?.code).toBe("SUBMIT_NOT_CONFIRMED");
    expect(out.result?.submitted).toBe("no");
    expect(observations).toBeLessThan(80); // 35 s grace, never the 60 s response timeout
    expect(f.calls).toContain("clearUnsentPrompt");
    expect(f.calls).toContain("deleteMarker");
  });

  it("A-155b: a moved new-chat URL with a retained composer is unknown and never cleaned/retried", async () => {
    const f = fake({
      observe: async (t) =>
        observation({
          t,
          assistantCount: 0,
          userTurnCount: 0,
          composerText: "hi",
          streaming: false,
        }),
    });
    const out = await run(f);
    expect(out.result?.error?.code).toBe("SUBMIT_STATE_UNKNOWN");
    expect(out.result?.submitted).toBe("unknown");
    expect(f.calls).not.toContain("clearUnsentPrompt");
    expect(f.calls).not.toContain("deleteMarker");
  });

  it("timeout while stalled (not streaming): GENERATION_TIMEOUT, submitted yes", async () => {
    const f = fake({
      observe: async (t) => observation({ streaming: false, composerReady: false, t }),
    });
    const out = await run(f);
    expect(out.result?.error?.code).toBe("GENERATION_TIMEOUT");
    expect(out.result?.submitted).toBe("yes");
    expect(out.exitCode).toBe(1);
  });

  it("timeout while still streaming: GENERATION_TIMEOUT_ACTIVE, submitted yes (#124)", async () => {
    const f = fake({
      observe: async (t) => observation({ streaming: true, composerReady: false, t }),
    });
    const out = await run(f);
    expect(out.result?.error?.code).toBe("GENERATION_TIMEOUT_ACTIVE");
    expect(out.result?.submitted).toBe("yes");
    expect(out.exitCode).toBe(1);
  });

  it("A-153: a stable rendered reply with a stuck stop button is rechecked by fresh navigation", async () => {
    let reloaded = false;
    let reopenCalls = 0;
    const f = fake({
      openConversation: async () => {
        reloaded = true;
        reopenCalls++;
        return { kind: "ok" };
      },
      observe: async (t) =>
        observation({
          t,
          assistantCount: 1,
          streaming: !reloaded,
          composerReady: reloaded,
          copyAvailable: reloaded,
        }),
    });
    const out = await run(f);
    expect(reopenCalls).toBe(1);
    expect(out.result?.status).toBe("completed");
    expect(out.result?.warnings).toContain("stuck_stop_recovered_by_fresh_navigation");
  });

  it("empty extraction: EXTRACTION_FAILED", async () => {
    const f = fake({ extractLatest: async () => ({ kind: "empty", cause: "empty" }) });
    const out = await run(f);
    expect(out.result?.error?.code).toBe("EXTRACTION_FAILED");
    expect(f.calls).not.toContain("writeResponse");
  });

  it("preset current not verifiable: fail closed before any prompt input", async () => {
    const f = fake({ resolvePreset: async () => ({ kind: "not_verifiable", cause: "unmapped" }) });
    const out = await run(f);
    expect(out.result?.error?.code).toBe("MODEL_NOT_VERIFIABLE");
    expect(out.result?.submitted).toBe("no");
    expect(f.calls).not.toContain("writeMarker");
  });

  it("restore_effort_failed lands in result.json (restore runs before WRITE_RESULT, Codex P7-1)", async () => {
    const f = fake({
      restoreEffort: async () => ({ kind: "failed", cause: "slider at 2, expected 3" }),
    });
    const out = await run(f);
    expect(out.result?.status).toBe("completed");
    expect(out.result?.warnings.join()).toContain("restore_effort_failed: slider at 2, expected 3");
    expect(f.results[0]?.warnings.join()).toContain("restore_effort_failed"); // the written document
  });

  it("image capture timeout aborts the capture and waits for it (Codex P7-2)", async () => {
    let aborted = false;
    const f = fake({
      captureImages: (_dir, signal) =>
        new Promise((res) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            res({ saved: [], warnings: ["image_capture_failed: image 1: aborted"] });
          });
        }),
    });
    const out = await new RunController(f.ports, {
      requestPath: "/req/request.json",
      artifactsRoot: "/art",
      bridgeVersion: "0.1.0",
      traceOnSuccess: false,
      observationIntervalMs: 0,
      imageCaptureBudgetMs: 30,
    }).run();
    expect(aborted).toBe(true);
    expect(out.result?.status).toBe("completed");
    expect(out.result?.images).toEqual([]);
    expect(out.result?.warnings).toContain("image_capture_failed: timeout");
  });

  it("image-only turn: success only when an image was saved (never an empty success)", async () => {
    const ok = fake({
      extractLatest: async () => ({
        markdown: "",
        method: "dom",
        quality: "full",
        modelSlug: "gpt-5-6",
      }),
      captureImages: async () => ({ saved: ["1.png"], warnings: [] }),
    });
    const o1 = await run(ok);
    expect(o1.result?.status).toBe("completed");
    expect(o1.result?.images).toEqual(["images/1.png"]);
    expect(ok.responses[0]).toBe("![image 1](images/1.png)\n");
    const bad = fake({
      extractLatest: async () => ({
        markdown: "",
        method: "dom",
        quality: "full",
        modelSlug: "gpt-5-6",
      }),
      captureImages: async () => ({
        saved: [],
        warnings: ["image_capture_failed: image 1: HTTP 403"],
      }),
    });
    const o2 = await run(bad);
    expect(o2.result?.status).toBe("failed");
    expect(o2.result?.error?.code).toBe("EXTRACTION_FAILED");
    expect(o2.result?.warnings.join()).toContain("image_capture_failed");
  });

  // Codex P4-High-1 (15 §4, 13 §6): result.json must not carry URL query/fragment or secrets
  it("result.json: conversationUrl is origin+path, cause/warnings are redacted", async () => {
    const f = fake(
      {
        dispatchSubmit: async () => ({
          kind: "dispatched",
          url: "https://chatgpt.com/c/WEB:abc?token=SECRET1#frag",
        }),
        currentUrl: async () => "https://chatgpt.com/c/123?token=SECRET2",
        extractLatest: async () => ({
          kind: "empty",
          cause: "page https://chatgpt.com/c/123?sid=SECRET3 said Authorization: Bearer SECRET4",
        }),
      },
      { captureFails: true },
    );
    (f.ports.browser as { capture: () => Promise<string> }).capture = async () => {
      throw new Error("cookie: __Secure-next-auth=SECRET5; https://x.y/z?k=SECRET6");
    };
    const out = await run(f);
    const json = JSON.stringify(out.result);
    expect(out.result?.conversationUrl).toBe("https://chatgpt.com/c/123");
    expect(out.result?.error?.code).toBe("EXTRACTION_FAILED");
    expect(json).not.toMatch(/SECRET[1-6]/);
    expect(out.result?.error?.cause).toContain("Authorization: [REDACTED]");
    expect(out.result?.error?.message).not.toMatch(/SECRET/);
    // The trace/capture warning is post-result diagnostic work (A-151), so the
    // terminal document remains the pre-artifact snapshot.
    expect(out.result?.warnings.join("\n")).not.toContain("SECRET");
  });

  // Codex review of A-106, High: pathname-shape alone isn't enough — origin must match too, or a
  // same-shaped path on another origin would be captured as conversationUrl.
  it("A-106: conversationUrl capture accepts the Project-nested form but rejects a foreign origin", async () => {
    const nested = await run(
      fake({
        currentUrl: async () =>
          "https://chatgpt.com/g/g-p-6aa226cca960819188ec3e6b03c25580-pixivvault/c/abc123",
      }),
    );
    expect(nested.result?.conversationUrl).toBe(
      "https://chatgpt.com/g/g-p-6aa226cca960819188ec3e6b03c25580-pixivvault/c/abc123",
    );

    const foreign = await run(fake({ currentUrl: async () => "https://evil.example/g/g-p-x/c/y" }));
    expect(foreign.result?.conversationUrl).not.toBe("https://evil.example/g/g-p-x/c/y");
  });

  // A-116 (ChatGPT Pro redesign review, 2026-09-18, §3.1): reproduces the exact scenario the
  // review demonstrated live against this codebase — without a lock, observeLoop() kept rebinding
  // conversationUrl to whatever currentUrl() returned on every tick, so a mid-generation
  // navigation to a *different* conversation (that happens to look equally "complete") got
  // silently adopted as this request's own answer. Before the fix this test would have reached
  // status:"completed" with responseFile set; it must instead fail closed.
  it("A-116: a mid-generation navigation to a different conversation fails closed instead of adopting that conversation's answer", async () => {
    let calls = 0;
    const f = fake({
      currentUrl: async () => {
        calls++;
        return calls === 1 ? "https://chatgpt.com/c/123" : "https://chatgpt.com/c/999";
      },
    });
    const out = await run(f);
    expect(out.result?.status).toBe("failed");
    expect(out.result?.error?.code).toBe("CONVERSATION_MISMATCH");
    expect(out.result?.submitted).toBe("yes");
    // must keep the originally-bound conversation, never silently rebind to the other one
    expect(out.result?.conversationUrl).toBe("https://chatgpt.com/c/123");
    expect(out.result?.responseFile).toBeNull();
    expect(f.calls).not.toContain("writeResponse");
    expect(checkResultInvariants(out.result as BridgeResult)).toEqual([]);
  });

  it("REL-3: a repeated unrelated route drift is recorded, re-opened read-only twice, then fails closed when the locked conversation has no reply", async () => {
    const target = "https://chatgpt.com/c/123";
    const unrelated = "https://chatgpt.com/c/sidebar-top-entry";
    let firstObservation = true;
    let validatingRecovery = false;
    let recoveryAttempts = 0;
    const f = fake({
      observe: async (t) => observation({ t, assistantCount: 0, userTurnCount: 1 }),
      currentUrl: async () => {
        if (validatingRecovery) {
          validatingRecovery = false;
          return target;
        }
        if (firstObservation) {
          firstObservation = false;
          return target;
        }
        return unrelated;
      },
      openConversationForRecovery: async (url) => {
        recoveryAttempts++;
        expect(url).toBe(target);
        validatingRecovery = true;
        return { kind: "ok", draftPresent: false };
      },
      recordRouteTelemetry: async (_dir, entry) => {
        expect(entry.observedUrl).toBe(unrelated);
        expect(entry.processNavigationInFlight).toBe(false);
        return "/art/route-events.jsonl";
      },
    });
    const out = await run(f);
    expect(recoveryAttempts).toBe(2);
    expect(out.result?.error?.code).toBe("CONVERSATION_MISMATCH");
    expect(out.result?.conversationUrl).toBe(target);
    expect(out.result?.artifacts).toContain("/art/route-events.jsonl");
    expect(f.calls).not.toContain("writeResponse");
  });

  it("REL-3: a read-only recovery completes only after baseline-plus-one and prompt ownership prove the locked conversation reply", async () => {
    const target = "https://chatgpt.com/c/123";
    const unrelated = "https://chatgpt.com/c/sidebar-top-entry";
    let drifted = false;
    let recovered = false;
    let ownershipChecks = 0;
    const f = fake({
      observe: async (t) => {
        if (recovered)
          return observation({
            t,
            assistantCount: 1,
            userTurnCount: 1,
            streaming: false,
            lastAssistantEmpty: false,
          });
        return observation({ t, assistantCount: 0, userTurnCount: 1 });
      },
      currentUrl: async () => (drifted && !recovered ? unrelated : target),
      openConversationForRecovery: async () => {
        recovered = true;
        return { kind: "ok", draftPresent: false };
      },
      verifyLatestReplyOwnership: async () => {
        ownershipChecks++;
        return { kind: "match" };
      },
      recordRouteTelemetry: async () => "/art/route-events.jsonl",
    });
    // The first post-dispatch tick locks the target; the next reproduces the 173-second drift.
    const originalCurrentUrl = f.ports.chatgpt.currentUrl;
    let urlCalls = 0;
    f.ports.chatgpt.currentUrl = async () => {
      urlCalls++;
      if (urlCalls === 2) drifted = true;
      return originalCurrentUrl();
    };
    const out = await run(f);
    expect(out.result?.status).toBe("completed");
    expect(ownershipChecks).toBe(1);
    expect(out.result?.conversationUrl).toBe(target);
    expect(f.calls).toContain("writeResponse");
  });

  // A-113 (AGY/Antigravity independent review, 2026-09-18): if the real result fails its own
  // schema (e.g. A-112's missing ErrorCode enum entry), the bridge must not just log to stderr and
  // write nothing — that leaves an external watcher with no terminal record to react to at all.
  it("A-113: a result that fails contract validation gets a minimal, valid emergency fallback instead of no file at all", async () => {
    const f = fake({
      observe: async (t) => observation({ streaming: false, composerReady: false, t }),
    });
    let call = 0;
    const realWriteResult = f.ports.contracts.writeResult;
    f.ports.contracts.writeResult = async (dir, r) => {
      call++;
      if (call === 1)
        throw new Error("schema: /error/code must be equal to one of the allowed values");
      return realWriteResult(dir, r);
    };
    const out = await run(f);
    // Codex review: RunOutcome.result (and run --json's stdout) must match what's actually on
    // disk — both are the fallback, not the original schema-invalid result.
    expect(out.result?.error?.code).toBe("INTERNAL_ERROR");
    expect(f.results).toHaveLength(1);
    const written = f.results[0];
    expect(written).toBe(out.result);
    expect(written?.status).toBe("failed");
    expect(written?.warnings.join()).toContain("GENERATION_TIMEOUT");
    expect(checkResultInvariants(written as BridgeResult)).toEqual([]);
  });

  it("A-130 (Phase 0-E, ChatGPT Pro redesign review §3.5): a write failure on the normal-completion path still produces a result.json, not nothing", async () => {
    const f = fake();
    let call = 0;
    const realWriteResult = f.ports.contracts.writeResult;
    f.ports.contracts.writeResult = async (dir, r) => {
      call++;
      if (call === 1) throw new Error("disk full");
      return realWriteResult(dir, r);
    };
    const out = await run(f);
    // must have retried after the first failure, not given up (the pre-fix bug: exactly 1 call,
    // no result.json ever written for this transition)
    expect(call).toBeGreaterThanOrEqual(2);
    expect(f.results).toHaveLength(1);
    expect(out.result).toBe(f.results[0]);
    expect(out.result?.status).toBe("failed");
    expect(out.result?.error?.code).toBe("WRITE_FAILED");
    expect(out.result?.error?.cause).toContain("disk full");
    expect(checkResultInvariants(out.result as BridgeResult)).toEqual([]);
  });

  it("A-113: error.cause is capped at 200 chars (the schema's limit, not the 500-char warnings cap) even in the fallback", async () => {
    const longCause = "x".repeat(300);
    const f = fake({
      observe: async (t) => observation({ streaming: false, composerReady: false, t }),
    });
    let call = 0;
    const realWriteResult = f.ports.contracts.writeResult;
    f.ports.contracts.writeResult = async (dir, r) => {
      call++;
      if (call === 1) throw new Error(longCause);
      return realWriteResult(dir, r);
    };
    const out = await run(f);
    expect(out.result?.error?.code).toBe("INTERNAL_ERROR");
    expect((out.result?.error?.cause ?? "").length).toBeLessThanOrEqual(200);
    expect(checkResultInvariants(out.result as BridgeResult)).toEqual([]);
  });
});
