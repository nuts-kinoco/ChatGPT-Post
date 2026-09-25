/**
 * 16-TEST-STRATEGY: every error code reachable through the real machine + controller with fake ports.
 * Each row states the injected failure and the contract it must produce (code, exit, submitted, status).
 */
import { describe, expect, it } from "vitest";
import type { Observation } from "../../src/chatgpt/completion.js";
import { type BridgeResult, ERROR_CODES, type ErrorCode } from "../../src/contracts/types.js";
import { RunController } from "../../src/state/controller.js";
import type { ChatGptPort, Ports } from "../../src/state/ports.js";

function obs(o: Partial<Observation>): Observation {
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

interface Harness {
  ports: Ports;
  results: BridgeResult[];
  timeline: Observation[];
  crash: (cause: string) => void;
}

function harness(): Harness {
  const results: BridgeResult[] = [];
  let mono = 0;
  let obsIndex = 0;
  const timeline: Observation[] = [
    obs({ assistantCount: 0 }),
    obs({ streaming: true, composerReady: false }),
    obs({ streaming: false }),
    obs({ streaming: false }),
  ];
  let crash: (cause: string) => void = () => undefined;
  const chatgpt: ChatGptPort = {
    navigateAndObserveAuth: async () => ({ kind: "AUTH_OK" }),
    openNewChat: async () => ({ kind: "ok" }),
    openConversation: async () => ({ kind: "ok" }),
    openProject: async () => ({ kind: "ok" }),
    resolveOrCreateProject: async () => ({
      kind: "ok",
      url: "https://chatgpt.com/g/g-p-project/project",
      created: false,
    }),
    resolvePreset: async () => ({
      kind: "observed",
      preset: "high",
      label: "高",
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
        presetLabel: "高",
      },
    }),
    dispatchSubmit: async () => ({ kind: "dispatched", url: "https://chatgpt.com/c/1" }),
    observe: async (t) => ({
      ...(timeline[Math.min(obsIndex++, timeline.length - 1)] ?? obs({})),
      t,
    }),
    currentUrl: async () => "https://chatgpt.com/c/1",
    extractLatest: async () => ({
      markdown: "ok",
      method: "copy",
      quality: "full",
      modelSlug: "gpt-5-6-thinking",
    }),
    inspectUiReport: async (d) => `${d}/inspect-ui.json`,
    restoreEffort: async () => ({ kind: "unchanged" }),
    captureImages: async () => ({ saved: [], warnings: [] }),
  };
  const h: Harness = {
    results,
    timeline,
    crash: (c) => crash(c),
    ports: {
      clock: {
        now: () => new Date("2026-09-15T12:00:00Z"),
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
        priorState: async () => "none",
        validate: async () => ({
          kind: "valid",
          request: {
            schemaVersion: "1.2",
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
        writeResponse: async () => "/req/response.md",
        writeResult: async (_d, r) => {
          results.push(r);
          return "/req/result.json";
        },
      },
      lock: {
        acquire: async () => ({ kind: "ok" }),
        verify: async () => true,
        release: async () => undefined,
        markerExists: async () => false,
        writeMarker: async () => undefined,
        updateMarker: async () => undefined,
        deleteMarker: async () => undefined,
      },
      browser: {
        checkProfilePath: async () => ({ ok: true }),
        checkProfileFree: async () => ({ free: true }),
        launch: async (o) => {
          crash = o.onCrash;
          return { ok: true };
        },
        capture: async () => "/art/screenshot.png",
        sealTrace: async () => undefined,
        finalizeTrace: async () => "/art/trace.zip",
        close: async () => undefined,
      },
      chatgpt,
      log: () => undefined,
      stderr: () => undefined,
    },
  };
  return h;
}

interface Row {
  code: ErrorCode;
  exit: number;
  submitted: "yes" | "no" | "unknown";
  status: BridgeResult["status"] | "none";
  inject: (h: Harness) => void;
}

const ROWS: Row[] = [
  {
    code: "INVALID_REQUEST",
    exit: 2,
    submitted: "no",
    status: "failed",
    inject: (h) => {
      h.ports.contracts.validate = async () => ({
        kind: "invalid",
        errors: ["/preset must be equal to one of the allowed values"],
      });
    },
  },
  {
    code: "INVALID_CONFIG",
    exit: 2,
    submitted: "no",
    status: "failed",
    inject: (h) => {
      h.ports.browser.checkProfilePath = async () => ({ ok: false, cause: "junction" });
    },
  },
  {
    code: "ALREADY_PROCESSED",
    exit: 4,
    submitted: "no",
    status: "none",
    inject: (h) => {
      h.ports.contracts.priorState = async () => "result";
    },
  },
  {
    code: "ALREADY_RUNNING",
    exit: 4,
    submitted: "no",
    status: "none",
    inject: (h) => {
      h.ports.lock.acquire = async () => ({ kind: "busy", cause: "held by pid 1" });
    },
  },
  {
    code: "SUBMIT_STATE_UNKNOWN",
    exit: 1,
    submitted: "unknown",
    status: "failed",
    inject: (h) => {
      h.ports.lock.markerExists = async () => true;
    },
  },
  {
    code: "SUBMIT_NOT_CONFIRMED",
    exit: 1,
    submitted: "no",
    status: "failed",
    inject: (h) => {
      h.ports.chatgpt.dispatchSubmit = async () => ({
        kind: "not_confirmed",
        cause: "composer retained exact prompt",
        url: "https://chatgpt.com/c/1",
      });
    },
  },
  {
    code: "PROFILE_IN_USE",
    exit: 4,
    submitted: "no",
    status: "failed",
    inject: (h) => {
      h.ports.browser.checkProfileFree = async () => ({ free: false, cause: "lockfile" });
    },
  },
  {
    code: "BROWSER_LAUNCH_FAILED",
    exit: 4,
    submitted: "no",
    status: "failed",
    inject: (h) => {
      h.ports.browser.launch = async () => ({ ok: false, cause: "no chrome" });
    },
  },
  {
    code: "INVALID_STATE",
    exit: 1,
    submitted: "no",
    status: "failed",
    inject: (h) => {
      h.ports.chatgpt.navigateAndObserveAuth = async () => ({
        kind: "WRONG_PAGE",
        url: "https://chatgpt.com/auth/x",
      });
    },
  },
  {
    code: "AUTH_REQUIRED",
    exit: 3,
    submitted: "no",
    status: "manual_intervention_required",
    inject: (h) => {
      h.ports.chatgpt.navigateAndObserveAuth = async () => ({ kind: "AUTH_REQUIRED" });
    },
  },
  {
    code: "CAPTCHA_OR_CHALLENGE",
    exit: 3,
    submitted: "no",
    status: "manual_intervention_required",
    inject: (h) => {
      h.ports.chatgpt.navigateAndObserveAuth = async () => ({
        kind: "CHALLENGE",
        challenge: "captcha",
      });
    },
  },
  {
    code: "MANUAL_INTERVENTION_REQUIRED",
    exit: 3,
    submitted: "no",
    status: "manual_intervention_required",
    inject: (h) => {
      h.ports.chatgpt.navigateAndObserveAuth = async () => ({
        kind: "CHALLENGE",
        challenge: "consent",
      });
    },
  },
  {
    code: "RATE_LIMITED",
    exit: 3,
    submitted: "yes",
    status: "manual_intervention_required",
    inject: (h) => {
      h.timeline.splice(1, 0, obs({ errorBanner: "rate_limited" }));
    },
  },
  {
    code: "MODEL_NOT_AVAILABLE",
    exit: 1,
    submitted: "no",
    status: "failed",
    inject: (h) => {
      h.ports.chatgpt.resolvePreset = async () => ({ kind: "not_available" });
    },
  },
  {
    code: "MODEL_NOT_VERIFIABLE",
    exit: 1,
    submitted: "no",
    status: "failed",
    inject: (h) => {
      h.ports.chatgpt.resolvePreset = async () => ({ kind: "not_verifiable", cause: "unmapped" });
    },
  },
  {
    code: "PROMPT_INPUT_FAILED",
    exit: 1,
    submitted: "no",
    status: "failed",
    inject: (h) => {
      h.ports.chatgpt.enterPrompt = async () => ({
        kind: "mismatch",
        cause: "attachment_failed: 0 chips",
      });
    },
  },
  {
    code: "PROMPT_SUBMIT_FAILED",
    exit: 1,
    submitted: "no",
    status: "failed",
    inject: (h) => {
      h.ports.chatgpt.openNewChat = async () => ({ kind: "failed", cause: "composer_not_empty" });
    },
  },
  {
    code: "GENERATION_TIMEOUT",
    exit: 1,
    submitted: "yes",
    status: "failed",
    inject: (h) => {
      // #124: streaming must be false here — a genuine stall (stop button already gone,
      // nothing changing) is the only case that should still map to plain GENERATION_TIMEOUT.
      h.timeline.splice(1, h.timeline.length, obs({ streaming: false, composerReady: false }));
      h.ports.contracts.validate = async () => ({
        kind: "valid",
        request: {
          schemaVersion: "1.2",
          requestId: "req-00000001",
          promptFile: "p",
          preset: "current",
          newChat: true,
          responseFormat: "markdown",
        },
        prompt: "hi",
        timeoutMs: 10_000,
        attachments: [],
        attachmentBytes: 0,
      });
    },
  },
  {
    code: "GENERATION_TIMEOUT_ACTIVE",
    exit: 1,
    submitted: "yes",
    status: "failed",
    inject: (h) => {
      // #124: the deadline hits while the stop button is still showing (streaming: true) —
      // this must NOT collapse into plain GENERATION_TIMEOUT, or callers can't tell "dead"
      // from "still running" and end up retrying into a second concurrent generation.
      h.timeline.splice(1, h.timeline.length, obs({ streaming: true, composerReady: false }));
      h.ports.contracts.validate = async () => ({
        kind: "valid",
        request: {
          schemaVersion: "1.2",
          requestId: "req-00000001",
          promptFile: "p",
          preset: "current",
          newChat: true,
          responseFormat: "markdown",
        },
        prompt: "hi",
        timeoutMs: 10_000,
        attachments: [],
        attachmentBytes: 0,
      });
    },
  },
  {
    code: "CONVERSATION_MISMATCH",
    exit: 1,
    submitted: "yes",
    status: "failed",
    inject: (h) => {
      // A-116: the page navigates to a different conversation mid-generation. currentUrl()
      // matches the dispatched conversation on the first observation tick (locking it), then
      // diverges — this must fail closed rather than silently rebind conversationUrl.
      let calls = 0;
      h.ports.chatgpt.currentUrl = async () => {
        calls++;
        return calls === 1 ? "https://chatgpt.com/c/1" : "https://chatgpt.com/c/2";
      };
    },
  },
  {
    code: "CHAT_ERROR",
    exit: 1,
    submitted: "yes",
    status: "failed",
    inject: (h) => {
      h.timeline.splice(1, 0, obs({ errorBanner: "chat_error" }));
    },
  },
  {
    code: "DOM_CHANGED",
    exit: 1,
    submitted: "no",
    status: "failed",
    inject: (h) => {
      h.ports.chatgpt.enterPrompt = async () => ({
        kind: "dom_unexpected",
        element: "composer",
        tried: ["css=#prompt-textarea -> 0"],
      });
    },
  },
  {
    code: "EXTRACTION_FAILED",
    exit: 1,
    submitted: "yes",
    status: "failed",
    inject: (h) => {
      h.ports.chatgpt.extractLatest = async () => ({ kind: "empty", cause: "canvas" });
    },
  },
  {
    code: "BROWSER_CRASHED",
    exit: 1,
    submitted: "yes",
    status: "failed",
    inject: (h) => {
      const orig = h.ports.chatgpt.observe;
      h.ports.chatgpt.observe = async (t) => {
        h.crash("page crashed");
        return orig(t);
      };
    },
  },
  {
    code: "WRITE_FAILED",
    exit: 1,
    submitted: "yes",
    status: "failed",
    inject: (h) => {
      h.ports.contracts.writeResponse = async () => {
        throw new Error("EBUSY");
      };
    },
  },
  {
    code: "INTERNAL_ERROR",
    exit: 1,
    submitted: "unknown",
    status: "failed",
    inject: (h) => {
      h.ports.chatgpt.dispatchSubmit = async () => {
        throw new Error("boom");
      };
    },
  },
];

describe("every error code through machine + controller (16 §3)", () => {
  it("the table covers all codes in ERROR_CODES", () => {
    expect([...new Set(ROWS.map((r) => r.code))].sort()).toEqual([...ERROR_CODES].sort());
  });
  for (const row of ROWS) {
    it(`${row.code}: exit ${row.exit}, submitted ${row.submitted}, status ${row.status}`, async () => {
      const h = harness();
      row.inject(h);
      const out = await new RunController(h.ports, {
        requestPath: "/req/request.json",
        artifactsRoot: "/art",
        bridgeVersion: "0.1.0",
        traceOnSuccess: false,
        observationIntervalMs: 0,
      }).run();
      expect(out.exitCode).toBe(row.exit);
      expect(out.state.terminal?.code).toBe(row.code);
      if (row.status === "none") {
        expect(out.result).toBeNull();
        expect(h.results).toEqual([]);
      } else {
        expect(out.result?.error?.code).toBe(row.code);
        expect(out.result?.status).toBe(row.status);
        expect(out.result?.submitted).toBe(row.submitted);
        expect(out.result?.error?.message.length ?? 0).toBeGreaterThan(0);
      }
    });
  }
});
