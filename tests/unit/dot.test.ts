import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyDotCollect } from "../../src/cli/collect.js";
import { checkResultInvariants } from "../../src/contracts/invariants.js";
import { validateAndLoad } from "../../src/contracts/request.js";
import { validateRequest, validateResult } from "../../src/contracts/schema.js";
import type { BridgeRequest, BridgeResult } from "../../src/contracts/types.js";
import {
  type DotProgress,
  type DotRow,
  decideDotCompletion,
  dotCompletionToken,
  dotMarkerSeen,
  dotPrefix,
  dotPrompt,
  dotReplyTagInstruction,
  dotSelectionWarnings,
  dotWarnings,
  hasTypingIndicator,
  isHistorySettled,
  sanitizeDotFilename,
  selectDotReplies,
} from "../../src/dot/completion.js";
import { DotController } from "../../src/dot/controller.js";
import { DotFailure, type DotPage } from "../../src/dot/page.js";
import type { Ports } from "../../src/state/ports.js";

const id = "20261001T120000Z-a1b2c3d4";
const raw = {
  schemaVersion: "1.2",
  requestId: id,
  target: "dot",
  promptFile: "prompt.md",
  responseFormat: "markdown",
};
const row = (id: string, text: string, self = false): DotRow => ({
  id,
  text,
  self,
  html: `<p>${text}</p>`,
  files: [],
});
const own = row("own", dotPrefix(id), true);
const reply = row("reply", "以上で完了");

it("unique token, normalized prompt and one final instruction", () => {
  const token = dotCompletionToken(id);
  expect(dotMarkerSeen(`${token}extra`, token)).toBe(false);
  expect(dotMarkerSeen(token, token)).toBe(true);
  expect(token).toBe(`完了: ${id}`);
  const prompt = dotPrompt(id, "hello\r\nworld");
  expect(prompt.startsWith(`${dotPrefix(id)}\n\nhello\nworld\n\n`)).toBe(true);
  expect(prompt.endsWith("完了前には書かないでください。")).toBe(true);
  expect(prompt.split(token)).toHaveLength(2);
  const tag = dotReplyTagInstruction(id);
  expect(prompt).toBe(
    `${dotPrefix(id)}\n\nhello\nworld\n\n${tag}\nすべての作業が完了した時点でのみ、FINAL返信の最終行に「${token}」をそのまま書いてください。完了前には書かないでください。`,
  );
  expect(dotPrompt(id, token)).toBe(`${dotPrefix(id)}\n\n${token}\n\n${tag}`);
  expect(dotPrompt(id, "hello DONE", "DONE")).toBe(`${dotPrefix(id)}\n\nhello DONE\n\n${tag}`);
  expect(dotPrompt(id, "hello", "CUSTOM")).toContain("「CUSTOM」");
});
it.each(["dot is typing…", "DOT IS TYPING...", "入力中"])("typing: %s", (text) =>
  expect(hasTypingIndicator(text)).toBe(true),
);
it.each(["配信済み", "既読 12:34", "以上で完了", ""])("not typing: %s", (text) =>
  expect(hasTypingIndicator(text)).toBe(false),
);
it.each(["../../bad\\name.md", "CON.md", "\x00\x1f\x7f", "..", "a:b?.txt", "NUL", "a".repeat(300)])(
  "safe filename: %s",
  (name) => {
    const safe = sanitizeDotFilename(name);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checks removal of malicious filename controls
    expect(safe).not.toMatch(/[\x00-\x1f\x7f/\\<>:"|?*]/);
    expect(safe).not.toContain("..");
    expect(safe.length).toBeGreaterThan(0);
    expect(safe.length).toBeLessThanOrEqual(161);
    expect(safe).not.toMatch(/^(CON|NUL)(\.|$)/i);
  },
);

describe("pure completion", () => {
  it("requires own row and a subsequent reply", () => {
    for (const rows of [[], [reply], [reply, own], [own]]) {
      const start = decideDotCompletion({ rows, typing: false }, id, 0);
      expect(decideDotCompletion({ rows, typing: false }, id, 30_000, start.progress).done).toBe(
        false,
      );
    }
  });
  it("sentinel still requires three seconds without typing", () => {
    const rows = [own, reply];
    const busy = decideDotCompletion({ rows, typing: true }, id, 0, undefined, "以上で完了");
    const stopped = decideDotCompletion(
      { rows, typing: false },
      id,
      1000,
      busy.progress,
      "以上で完了",
    );
    expect(
      decideDotCompletion({ rows, typing: false }, id, 3999, stopped.progress, "以上で完了").done,
    ).toBe(false);
    expect(
      decideDotCompletion({ rows, typing: false }, id, 5000, stopped.progress, "以上で完了").done,
    ).toBe(true);
  });
  it("uses quiet fallback without sentinel; resets on row/text/file changes", () => {
    const rows = [own, row("r", `requestId: ${id} one`)];
    const start = decideDotCompletion({ rows, typing: false }, id, 0);
    expect(decideDotCompletion({ rows, typing: false }, id, 24_999, start.progress).done).toBe(
      false,
    );
    expect(decideDotCompletion({ rows, typing: false }, id, 25_000, start.progress).done).toBe(
      true,
    );
    for (const changed of [
      [...rows, reply],
      [own, row("r", `requestId: ${id} two`)],
      [own, { ...row("r", `requestId: ${id} one`), files: ["x.mdを開く"] }],
    ]) {
      expect(
        decideDotCompletion({ rows: changed, typing: false }, id, 25_000, start.progress).done,
      ).toBe(false);
    }
  });
  it("checks the last reply and stops attributing after the last tagged row", () => {
    const rows = [row("old", "old"), own, reply, row("later", "more")];
    const first = decideDotCompletion({ rows, typing: false }, id, 0);
    const last = decideDotCompletion(
      { rows, typing: false },
      id,
      3000,
      first.progress,
      "以上で完了",
    );
    expect(last.done).toBe(false);
    expect(last.replies.map((r) => r.id)).toEqual(["reply"]);
    expect(last.selection).toMatchObject({ excludedRows: 1, excludedFiles: 0 });
  });
  it("fails closed for duplicate requestId or subsequent human input", () => {
    for (const rows of [
      [own, reply, own],
      [own, reply, row("human", "PO", true)],
    ]) {
      const start = decideDotCompletion({ rows, typing: false }, id, 0);
      const end = decideDotCompletion({ rows, typing: false }, id, 30_000, start.progress);
      expect(end.conflict).toBe(true);
      expect(end.done).toBe(false);
    }
  });
});

describe("history settling", () => {
  it("requires two seconds of unchanged samples, including empty history", () => {
    expect(isHistorySettled([])).toBe(false);
    expect(isHistorySettled([{ count: 0, at: 0 }])).toBe(false);
    expect(
      isHistorySettled([
        { count: 0, at: 0 },
        { count: 0, at: 1999 },
      ]),
    ).toBe(false);
    expect(
      isHistorySettled([
        { count: 0, at: 0 },
        { count: 0, at: 2000 },
      ]),
    ).toBe(true);
  });
  it("restarts the window after progressive growth or a returning count", () => {
    const samples = [
      { count: 20, at: 0 },
      { count: 32, at: 3000 },
      { count: 20, at: 3300 },
    ];
    expect(isHistorySettled([...samples, { count: 20, at: 5299 }])).toBe(false);
    expect(isHistorySettled([...samples, { count: 20, at: 5300 }])).toBe(true);
  });
});
it.each(["later self", "duplicate"])("conflict persistence: %s", (kind) => {
  const rows = [own, reply, kind === "duplicate" ? own : row("human", "PO", true)];
  const snapshot = { rows, typing: false };
  const first = decideDotCompletion(snapshot, id, 100);
  const transient = decideDotCompletion(snapshot, id, 2099, first.progress);
  expect(transient.conflictPersistent).toBe(false);
  expect(decideDotCompletion(snapshot, id, 2100, transient.progress).conflictPersistent).toBe(true);
  const clear = decideDotCompletion(
    { rows: [own, reply], typing: false },
    id,
    2099,
    transient.progress,
  );
  expect(clear.progress.conflictSince).toBeNull();
  expect(clear.conflictPersistent).toBe(false);
  const restarted = decideDotCompletion(snapshot, id, 2100, clear.progress);
  expect(restarted.progress.conflictSince).toBe(2100);
  expect(restarted.conflictPersistent).toBe(false);
});
it("own-row temporary to server ID swap retains prefix and position ownership", () => {
  let progress: DotProgress | undefined;
  for (const [at, rowId] of [
    [0, "temporary"],
    [1500, "server"],
    [6500, "server"],
  ] as const) {
    const decision = decideDotCompletion(
      { rows: [{ ...own, id: rowId }, reply], typing: false },
      id,
      at,
      progress,
      reply.text,
    );
    expect(decision.conflict).toBe(false);
    expect(decision.ownRow?.id).toBe(rowId);
    expect(decision.done).toBe(at === 6500);
    progress = decision.progress;
  }
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(process.cwd(), ".dot-unit-"));
  await writeFile(join(dir, "prompt.md"), "hello");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
it("validates targets/markers and preserves chat requirements", () => {
  expect(validateRequest(raw).valid).toBe(true);
  expect(validateRequest({ ...raw, attachments: ["file.md"] }).valid).toBe(false);
  expect(
    validateRequest({
      ...raw,
      newChat: "ignored",
      preset: {},
      model: true,
      project: null,
      conversationUrl: 123,
    }).valid,
  ).toBe(true);
  expect(validateRequest({ ...raw, schemaVersion: "1.3" }).valid).toBe(true);
  expect(validateRequest({ ...raw, target: "wrong" }).valid).toBe(false);
  expect(validateRequest({ ...raw, completionMarker: "x".repeat(80) }).valid).toBe(true);
  expect(validateRequest({ ...raw, completionMarker: "x".repeat(81) }).valid).toBe(false);
  expect(validateRequest({ ...raw, completionMarker: "" }).valid).toBe(false);
  expect(validateRequest({ ...raw, target: "chat" }).valid).toBe(false);
  expect(validateRequest({ ...raw, target: "chat", preset: "high", newChat: true }).valid).toBe(
    true,
  );
  expect(validateRequest({ ...raw, target: "chat", preset: "high", newChat: false }).valid).toBe(
    false,
  );
});
it("ignores all five chat fields with explicit warnings and rejects attachments before reading them", async () => {
  const input = {
    ...raw,
    newChat: false,
    preset: "unknown",
    model: "unknown",
    project: "p",
    conversationUrl: "ignored",
  };
  const valid = await validateAndLoad(input, dir);
  expect(valid.kind).toBe("valid");
  if (valid.kind === "valid")
    expect(dotWarnings(valid.request)).toEqual([
      "dot_ignores_newChat",
      "dot_ignores_preset",
      "dot_ignores_model",
      "dot_ignores_project",
      "dot_ignores_conversationUrl",
    ]);
  expect(await validateAndLoad({ ...raw, attachments: ["nonexistent"] }, dir)).toEqual({
    kind: "invalid",
    errors: ["attachments are not supported for target dot yet"],
  });
  expect((await validateAndLoad({ ...raw, attachments: [] }, dir)).kind).toBe("valid");
});

function harness(
  mode:
    | "ok"
    | "unknown"
    | "timeout"
    | "dialog"
    | "click"
    | "priorMarker"
    | "drift"
    | "busy"
    | "secret"
    | "downloadCrash"
    | "gone"
    | "hung"
    | "transientConflict"
    | "persistentConflict"
    | "duplicateConflict" = "ok",
) {
  let mono = 0;
  let sent = false;
  let onCrash: (cause: string) => void = () => {};
  const calls: string[] = [];
  const results: BridgeResult[] = [];
  const request = { ...raw, completionMarker: "以上で完了", timeoutMs: 20_000 } as BridgeRequest;
  const ports = {
    clock: {
      now: () => new Date(1_790_851_200_000 + mono),
      monotonic: () => mono,
      sleep: async (ms: number) => {
        mono += ms;
      },
    },
    contracts: {
      readRequest: async () => ({ kind: "read", requestId: id, raw: request, requestDir: dir }),
      priorState: async () => "none",
      validate: async () => ({
        kind: "valid",
        request,
        prompt: mode === "secret" ? "Bearer synthetic-test-token" : "hello",
        timeoutMs: request.timeoutMs,
        attachments: [],
        attachmentBytes: 0,
      }),
      writeResponse: async () => {
        calls.push("response");
        return join(dir, "response.md");
      },
      writeResult: async (_: string, result: BridgeResult) => {
        expect(checkResultInvariants(result)).toEqual([]);
        results.push(result);
        return join(dir, "result.json");
      },
    },
    lock: {
      acquire: async () =>
        mode === "busy" ? { kind: "busy", cause: "busy" } : { kind: "ok", token: "token" },
      verify: async () => true,
      release: async () => {
        calls.push("release");
      },
      markerExists: async () => mode === "priorMarker",
      writeMarker: async () => {
        calls.push("marker");
      },
      updateMarker: async () => {},
      deleteMarker: async () => {
        calls.push("deleteMarker");
      },
      deleteStopRequest: async () => {},
      readStopRequest: async () => null,
    },
    browser: {
      checkProfilePath: async () => ({ ok: true }),
      checkProfileFree: async () => ({ free: true }),
      launch: async (options: { onCrash: (cause: string) => void }) => {
        onCrash = options.onCrash;
        calls.push("launch");
        return { ok: true };
      },
      close: async () => {
        calls.push("close");
      },
    },
    log: () => {},
    stderr: () => {},
  } as unknown as Ports;
  const dot = {
    currentUrl: () =>
      mode === "drift" && sent
        ? "https://chatgpt.com/dots/11111111-1111-1111-1111-111111111111"
        : "https://chatgpt.com/dots/00000000-0000-0000-0000-000000000000",
    navigate: async () => {},
    prepare: async (prompt: string) => {
      expect(prompt).toBe(dotPrompt(id, "hello", request.completionMarker));
    },
    send: async () => {
      calls.push("send");
      sent = true;
      if (mode === "hung") mono = 20_001;
      if (mode === "click") throw new DotFailure("SUBMIT_STATE_UNKNOWN", "click uncertain");
    },
    safety: async () => {
      if (mode === "dialog" && sent)
        throw new DotFailure("MANUAL_INTERVENTION_REQUIRED", "approval");
    },
    snapshot: async () => {
      if (
        sent &&
        (mode === "transientConflict" ||
          mode === "persistentConflict" ||
          mode === "duplicateConflict")
      ) {
        const conflict = mode !== "transientConflict" || (mono >= 450 && mono < 1800);
        return {
          rows: conflict
            ? [own, reply, mode === "persistentConflict" ? row("human", "PO", true) : own]
            : [own, reply],
          typing: false,
        };
      }
      if (mode === "hung" && sent) return new Promise<never>(() => {});
      if (mode === "gone" && sent) return { rows: mono >= 450 ? [] : [own], typing: false };
      return {
        rows:
          !sent || mode === "unknown"
            ? []
            : mode === "timeout"
              ? [own, row("interim", `requestId: ${id}\nworking`)]
              : [own, reply],
        typing: false,
      };
    },
    extract: () => ({ markdown: "以上で完了", warnings: [] }),
    files: async () => {
      if (mode === "downloadCrash") onCrash("synthetic download crash");
      return { files: [], warnings: ["file_download_failed: x: timeout"] };
    },
  } satisfies Pick<
    DotPage,
    "currentUrl" | "navigate" | "prepare" | "send" | "safety" | "snapshot" | "extract" | "files"
  >;
  const controller = new DotController(
    ports,
    {
      requestPath: join(dir, "request.json"),
      artifactsRoot: dir,
      bridgeVersion: "test",
      traceOnSuccess: false,
    },
    () => dot,
  );
  return { controller, calls, results, request, dot };
}
it("builds schema 1.3 only for dot; validates unchanged chat schema 1.2", async () => {
  const h = harness();
  const out = await h.controller.run();
  expect(out.exitCode).toBe(0);
  expect(out.result).toMatchObject({
    schemaVersion: "1.3",
    target: "dot",
    completionMarker: reply.text,
    replyCount: 1,
    files: [],
    submitted: "yes",
  });
  expect(h.calls.indexOf("marker")).toBeLessThan(h.calls.indexOf("send"));
  expect(h.calls.filter((c) => c === "send")).toHaveLength(1);
  expect(out.result?.warnings).toContain("file_download_failed: x: timeout");
  expect(h.calls).not.toContain("deleteMarker");
  if (!out.result) throw new Error("missing result");
  const {
    target: _target,
    replyCount: _count,
    files: _files,
    completionMarker: _marker,
    ...chat
  } = out.result;
  const chatResult = { ...chat, schemaVersion: "1.2", observedPreset: "high" };
  expect(validateResult(chatResult).valid).toBe(true);
  expect(validateResult({ ...chatResult, schemaVersion: "1.3" }).valid).toBe(false);
  expect(validateResult({ ...out.result, schemaVersion: "1.2" }).valid).toBe(false);
});
it.each([
  ["unknown", "SUBMIT_STATE_UNKNOWN", "unknown", 1],
  ["click", "SUBMIT_STATE_UNKNOWN", "unknown", 1],
  ["timeout", "GENERATION_TIMEOUT", "yes", 1],
  ["dialog", "MANUAL_INTERVENTION_REQUIRED", "unknown", 3],
  ["drift", "CONVERSATION_MISMATCH", "unknown", 1],
  ["gone", "CONVERSATION_MISMATCH", "yes", 1],
  ["hung", "SUBMIT_STATE_UNKNOWN", "unknown", 1],
] as const)("%s stops once and preserves the marker", async (mode, code, submitted, exitCode) => {
  const h = harness(mode);
  const out = await h.controller.run();
  expect(out.exitCode).toBe(exitCode);
  expect(out.result?.error?.code).toBe(code);
  expect(out.result?.submitted).toBe(submitted);
  expect(out.result?.conversationUrl).toContain("/dots/");
  expect(h.calls.filter((c) => c === "send")).toHaveLength(1);
  expect(h.calls).not.toContain("deleteMarker");
  expect(h.calls).toContain("release");
});
it("existing marker blocks launch/send", async () => {
  const h = harness("priorMarker");
  const out = await h.controller.run();
  expect(out.result?.submitted).toBe("unknown");
  expect(h.calls).not.toContain("launch");
  expect(h.calls).not.toContain("send");
});
it("busy lock writes no result and never launches", async () => {
  const h = harness("busy");
  const out = await h.controller.run();
  expect(out.exitCode).toBe(4);
  expect(out.result).toBeNull();
  expect(h.calls).toEqual([]);
});
it("secret-pattern prompts are refused before lock and browser", async () => {
  const h = harness("secret");
  const out = await h.controller.run();
  expect(out.exitCode).toBe(2);
  expect(out.result?.error?.code).toBe("INVALID_REQUEST");
  expect(out.result?.submitted).toBe("no");
  expect(h.calls).toEqual([]);
});
it("a browser crash while downloading is a warning after reply extraction", async () => {
  const h = harness("downloadCrash");
  const out = await h.controller.run();
  expect(out.exitCode).toBe(0);
  expect(out.result?.warnings).toContain("file_download_failed: browser: synthetic download crash");
  expect(out.result?.responseFile).toContain("response.md");
});

it.each(["transientConflict", "persistentConflict", "duplicateConflict"] as const)(
  "controller tolerates only transient conflicts: %s",
  async (mode) => {
    const h = harness(mode);
    const out = await h.controller.run();
    expect(out.result?.error?.code ?? null).toBe(
      mode === "transientConflict" ? null : "CONVERSATION_MISMATCH",
    );
    expect(out.result?.durationMs).toBeGreaterThanOrEqual(2000);
    expect(h.calls.filter((c) => c === "send")).toHaveLength(1);
  },
);

it("marker is authoritative after 60 seconds quiet and settles trailing file rows", () => {
  const snapshot = { rows: [own, row("interim", "working")], typing: false };
  const first = decideDotCompletion(snapshot, id, 0, undefined, "DONE");
  expect(decideDotCompletion(snapshot, id, 60_000, first.progress, "DONE").done).toBe(false);
  const marked = { rows: [own, row("r", "DONE")], typing: false };
  const seen = decideDotCompletion(marked, id, 60_000, first.progress, "DONE");
  const trailing = {
    rows: [...marked.rows, { ...row("file", ""), files: ["Open x.md"] }],
    typing: false,
  };
  const changed = decideDotCompletion(trailing, id, 64_000, seen.progress, "DONE");
  expect(changed.done).toBe(false);
  expect(decideDotCompletion(trailing, id, 68_999, changed.progress, "DONE").done).toBe(false);
  expect(decideDotCompletion(trailing, id, 69_000, changed.progress, "DONE").done).toBe(true);
});

it("collect classifies marker, typing, missing and ambiguous own rows", () => {
  const snapshot = { rows: [reply, own, row("r", "DONE")], typing: true };
  expect(classifyDotCollect(snapshot, id, "DONE", "thread")).toMatchObject({
    ok: true,
    status: { state: "complete", markerSeen: true, typing: true, replyCount: 1 },
  });
  expect(classifyDotCollect(snapshot, id, "absent", "thread")).toMatchObject({
    status: { state: "in_progress" },
  });
  expect(classifyDotCollect(snapshot, id, undefined, "thread")).toMatchObject({
    status: { state: "unknown" },
  });
  expect(classifyDotCollect({ rows: [reply], typing: false }, id, "DONE", "thread")).toMatchObject({
    code: "COLLECT_REPLY_ABSENT",
  });
  expect(
    classifyDotCollect({ rows: [own, own], typing: false }, id, "DONE", "thread"),
  ).toMatchObject({ code: "COLLECT_REPLY_AMBIGUOUS" });
});

it("marker timeout writes interim response while retaining terminal failure semantics", async () => {
  const h = harness("timeout");
  const out = await h.controller.run();
  expect(out.result).toMatchObject({
    status: "failed",
    submitted: "yes",
    replyCount: 1,
    responseFile: null,
    error: { code: "GENERATION_TIMEOUT" },
  });
  expect(out.result?.warnings).toContain("dot_marker_not_seen");
  expect(h.calls).toContain("response");
});

it("default controller ignores generic phrases and waits for its exact token", async () => {
  const h = harness();
  delete h.request.completionMarker;
  let reads = 0;
  h.dot.snapshot = async () => ({
    rows: h.calls.includes("send")
      ? [own, row("r", ++reads < 80 ? reply.text : dotCompletionToken(id))]
      : [],
    typing: false,
  });
  h.request.timeoutMs = 60_000;
  const out = await h.controller.run();
  expect(out.exitCode).toBe(0);
  expect(reads).toBeGreaterThan(80);
  expect(out.result?.completionMarker).toBe(dotCompletionToken(id));
  expect(validateResult(out.result).valid).toBe(true);
});

describe("shared-thread attribution (A-200)", () => {
  // Entirely synthetic wording; no real thread content.
  const tagged = (rowId: string, text: string, files: string[] = []) => ({
    ...row(rowId, `requestId: ${id}\n${text}`),
    files,
  });
  const drow = (rowId: string, text: string, files: string[]) => ({ ...row(rowId, text), files });
  const other = "20261001T130000Z-ffffffff";
  const po = row("po", "架空の別件の相談です", true);
  const select = (rows: DotRow[], marker?: string) =>
    selectDotReplies(rows, rows.indexOf(own), id, marker);

  it("collects tagged replies and their files, excludes unrelated rows by count only", () => {
    const rows = [
      row("before", "以前の架空の返信"),
      own,
      tagged("a", "受け付けました", ["a.mdを開く"]),
      drow("noise", "無関係な架空の返信", ["private.mdを開く"]),
      po,
      drow("p1", "別件への架空の返信1", ["p1.mdを開く", "p2.mdを開く"]),
      row("p2", "別件への架空の返信2"),
      tagged("late", "遅れて届いた本件の返信"),
    ];
    const selection = select(rows, dotCompletionToken(id));
    expect(selection.replies.map((r) => r.id)).toEqual(["a", "late"]);
    expect(selection).toMatchObject({
      excludedRows: 3,
      excludedFiles: 3,
      untaggedRows: 1,
      untaggedFiles: 1,
    });
    const warnings = dotSelectionWarnings(selection);
    expect(warnings).toEqual([
      "dot_unrelated_rows_excluded: 3 rows, 3 files",
      "dot_untagged_rows_after_own_reply: 1 rows, 1 files",
    ]);
    expect(warnings.join()).not.toMatch(/private|p1\.md|架空/);
  });
  it("never includes untagged continuations; counts them separately for manual follow-up", () => {
    const rows = [
      own,
      row("pre", "前の依頼への返信かもしれない"),
      tagged("a", "着手します"),
      drow("mid", "途中経過", ["draft.mdを開く"]),
      drow("final", `最終版です\n${dotCompletionToken(id)}`, ["final.mdを開く"]),
      drow("trail", "", ["trail.mdを開く"]),
    ];
    const selection = select(rows, dotCompletionToken(id));
    expect(selection.replies.map((r) => r.id)).toEqual(["a", "final"]);
    expect(selection.replies.flatMap((r) => r.files)).toEqual(["final.mdを開く"]);
    expect(selection).toMatchObject({
      excludedRows: 3,
      excludedFiles: 2,
      untaggedRows: 2,
      untaggedFiles: 2,
    });
    expect(dotSelectionWarnings(selection)).toEqual([
      "dot_unrelated_rows_excluded: 3 rows, 2 files",
      "dot_untagged_rows_after_own_reply: 2 rows, 2 files",
    ]);
  });
  it("marker row followed only by attachment rows: attachments stay excluded", () => {
    const rows = [
      own,
      tagged("a", `完成しました\n${dotCompletionToken(id)}`),
      drow("f1", "", ["x.mdを開く"]),
      drow("f2", "", ["y.mdを開く"]),
    ];
    const selection = select(rows, dotCompletionToken(id));
    expect(selection.replies.map((r) => r.id)).toEqual(["a"]);
    expect(selection.replies.flatMap((r) => r.files)).toEqual([]);
    expect(selection).toMatchObject({
      excludedRows: 2,
      excludedFiles: 2,
      untaggedRows: 2,
      untaggedFiles: 2,
    });
  });
  it("custom generic marker counts only before the next self row; other requestIds never count", () => {
    const rows = [
      own,
      row("m", "以上で完了"),
      po,
      drow("pm", "以上で完了", ["p.mdを開く"]),
      row("both", `requestId: ${id} と requestId: ${other} の比較`),
      row("foreign", `requestId: ${other}\n別の依頼の返信`),
    ];
    const selection = select(rows, "以上で完了");
    expect(selection.replies.map((r) => r.id)).toEqual(["m"]);
    expect(selection).toMatchObject({ excludedRows: 3, excludedFiles: 1 });
  });
  it("non-standard requestIds containing a timestamp-shaped id still match themselves", () => {
    const custom = "job-20261001T120000Z-a1b2c3d4-x";
    const mine = row("m", `requestId: ${custom}\n本件`);
    const self = row("own", dotPrefix(custom), true);
    expect(selectDotReplies([self, mine], 0, custom).replies).toEqual([mine]);
    const foreign = row("f", `requestId: ${custom}\n比較: 20261001T130000Z-ffffffff`);
    expect(selectDotReplies([self, foreign], 0, custom).replies).toEqual([]);
  });
  it("unrelated-only replies give replyCount 0 and never complete", () => {
    const rows = [own, drow("x", "無関係な架空の返信", ["x.mdを開く"]), po, row("y", "以上で完了")];
    const snapshot = { rows, typing: false };
    expect(classifyDotCollect(snapshot, id, dotCompletionToken(id), "thread")).toMatchObject({
      ok: true,
      replies: [],
      selectionWarnings: ["dot_unrelated_rows_excluded: 2 rows, 1 files"],
      status: { state: "in_progress", markerSeen: false, replyCount: 0, files: [] },
    });
    expect(classifyDotCollect(snapshot, id, "以上で完了", "thread")).toMatchObject({
      status: { state: "in_progress", replyCount: 0 },
    });
    const solo = { rows: [own, row("x", "無関係な架空の返信")], typing: false };
    const first = decideDotCompletion(solo, id, 0);
    const later = decideDotCompletion(solo, id, 60_000, first.progress);
    expect(later.replies).toEqual([]);
    expect(later.done).toBe(false);
  });
  it("collect counts only attributed files and still fails closed on duplicate own rows", () => {
    const rows = [
      own,
      tagged("a", `${dotCompletionToken(id)}`, ["mine.mdを開く"]),
      drow("x", "別件", ["theirs.mdを開く"]),
    ];
    expect(
      classifyDotCollect({ rows, typing: false }, id, dotCompletionToken(id), "t"),
    ).toMatchObject({ status: { state: "complete", replyCount: 1, files: ["mine.md"] } });
    expect(
      classifyDotCollect({ rows: [...rows, own], typing: false }, id, undefined, "t"),
    ).toMatchObject({ ok: false, code: "COLLECT_REPLY_AMBIGUOUS" });
  });
  it("dotPrompt adds the requestId-first instruction once", () => {
    const tag = dotReplyTagInstruction(id);
    expect(tag).toContain(`先頭の行に「requestId: ${id}」`);
    expect(tag).toContain("添付を付ける返信にも");
    expect(dotPrompt(id, "依頼").split(tag)).toHaveLength(2);
    const already = `依頼\n返信はすべて先頭の行に「requestId: ${id}」を書くこと`;
    expect(dotPrompt(id, already)).not.toContain(tag);
    expect(dotPrompt(id, already)).toContain(dotCompletionToken(id));
    expect(dotPrompt(id, "a\r\nb").startsWith(`${dotPrefix(id)}\n\na\nb\n\n${tag}\n`)).toBe(true);
  });
});

it("run attributes only tagged replies and reports exclusion counts", async () => {
  const h = harness();
  delete h.request.completionMarker;
  const files: DotRow[][] = [];
  h.dot.files = async (rows) => {
    files.push(rows);
    return { files: [], warnings: [] };
  };
  h.dot.snapshot = async () => ({
    rows: h.calls.includes("send")
      ? [
          own,
          row("noise", "前の依頼への架空の返信"),
          { ...row("mine", `requestId: ${id}\n${dotCompletionToken(id)}`), files: ["m.mdを開く"] },
          { ...row("trail", ""), files: ["t.mdを開く"] },
        ]
      : [],
    typing: false,
  });
  const out = await h.controller.run();
  expect(out.exitCode).toBe(0);
  expect(out.result?.replyCount).toBe(1);
  expect(files[0]?.map((r) => r.id)).toEqual(["mine"]);
  expect(out.result?.warnings).toContain("dot_unrelated_rows_excluded: 2 rows, 1 files");
  expect(out.result?.warnings).toContain("dot_untagged_rows_after_own_reply: 1 rows, 1 files");
  expect(out.result?.warnings.filter((w) => w.startsWith("dot_unrelated"))).toHaveLength(1);
});
