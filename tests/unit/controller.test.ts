import { describe, expect, it } from "vitest";
import type { Observation } from "../../src/chatgpt/completion.js";
import type { BridgeResult } from "../../src/contracts/types.js";
import { RunController } from "../../src/state/controller.js";
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
      baseline: { assistantCount: 0, url: "https://chatgpt.com/", presetLabel: "Pro" },
    }),
    dispatchSubmit: async () => ({ kind: "dispatched", url: "https://chatgpt.com/c/123" }),
    observe: async (t) => {
      const o = timeline[Math.min(obsIndex++, timeline.length - 1)] ?? observation({});
      return { ...o, t };
    },
    currentUrl: async () => "https://chatgpt.com/c/123",
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
        stopTrace: async () => {
          calls.push("stopTrace");
          return "/art/trace.zip";
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

function run(f: Fake) {
  return new RunController(f.ports, {
    requestPath: "/req/request.json",
    artifactsRoot: "/art",
    bridgeVersion: "0.1.0",
    traceOnSuccess: false,
    observationIntervalMs: 0,
  }).run();
}

describe("RunController", () => {
  it("happy path: completed, response then result, close before release", async () => {
    const f = fake();
    const out = await run(f);
    expect(out.exitCode).toBe(0);
    expect(out.result?.status).toBe("completed");
    expect(out.result?.observedPreset).toBe("pro");
    expect(out.result?.requestedModel).toBe("current");
    expect(out.result?.observedModel).toBe("latest");
    expect(out.result?.observedModelSlug).toBe("gpt-5-6");
    expect(out.result?.schemaVersion).toBe("1.1");
    expect(out.result?.submitted).toBe("yes");
    expect(out.result?.conversationUrl).toBe("https://chatgpt.com/c/123");
    expect(f.calls.indexOf("writeMarker")).toBeLessThan(f.calls.indexOf("writeResponse"));
    expect(f.calls.indexOf("verify")).toBeLessThan(f.calls.indexOf("writeMarker"));
    expect(f.calls.indexOf("writeResponse")).toBeLessThan(f.calls.indexOf("writeResult"));
    expect(f.calls.indexOf("close")).toBeLessThan(f.calls.indexOf("release"));
    expect(f.calls.indexOf("restoreEffort")).toBeLessThan(f.calls.indexOf("close"));
    expect(f.calls).not.toContain("stopTrace"); // trace on success disabled
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
    expect(out.result?.warnings.join()).toMatch(/capture_failed/);
    expect(out.result?.artifacts).toEqual(["/art/trace.zip"]);
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

  it("timeout during generation: GENERATION_TIMEOUT, submitted yes", async () => {
    const f = fake({
      observe: async (t) => observation({ streaming: true, composerReady: false, t }),
    });
    const out = await run(f);
    expect(out.result?.error?.code).toBe("GENERATION_TIMEOUT");
    expect(out.result?.submitted).toBe("yes");
    expect(out.exitCode).toBe(1);
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
    expect(out.result?.warnings.join("\n")).toContain("[REDACTED]");
  });
});
