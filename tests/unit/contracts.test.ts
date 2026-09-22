import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFile, normaliseResponseBody } from "../../src/contracts/atomic-write.js";
import { checkResultInvariants } from "../../src/contracts/invariants.js";
import { isValidRequestId, readRequestFile, validateAndLoad } from "../../src/contracts/request.js";
import { validateRequest, validateResult } from "../../src/contracts/schema.js";
import {
  type BridgeResult,
  ERROR_CODES,
  NO_RESULT_CODES,
  statusFor,
} from "../../src/contracts/types.js";

const BOM = "\uFEFF";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-contracts-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const okReq = {
  schemaVersion: "1.0",
  requestId: "20260914T113000Z-a1b2c3d4",
  promptFile: "prompt.md",
  preset: "current",
  newChat: true,
  responseFormat: "markdown",
};

describe("request.json (12-IO-CONTRACT §2, AC-006)", () => {
  it("accepts a minimal valid request (timeoutMs optional)", () => {
    expect(validateRequest(okReq).valid).toBe(true);
  });
  it.each([
    ["newChat false", { ...okReq, newChat: false }],
    ["unknown preset", { ...okReq, preset: "gpt5" }],
    ["schemaVersion", { ...okReq, schemaVersion: "2.0" }],
    ["unknown field", { ...okReq, extra: 1 }],
    ["timeoutMs too small", { ...okReq, timeoutMs: 100 }],
    [
      "missing requestId",
      (() => {
        const { requestId: _r, ...rest } = okReq;
        return rest;
      })(),
    ],
    ["requestId trailing dot", { ...okReq, requestId: "abcdefgh." }],
    ["requestId too short", { ...okReq, requestId: "ab" }],
  ])("rejects %s", (_name, bad) => {
    expect(validateRequest(bad).valid).toBe(false);
  });
  it("rejects Windows reserved device names", () => {
    expect(isValidRequestId("CON.abcdefg1")).toBe(false);
    expect(isValidRequestId("nul.20260914")).toBe(false);
    expect(isValidRequestId("COM1")).toBe(false);
    expect(isValidRequestId("consensus-2026")).toBe(true);
  });

  it("reads BOM-prefixed request.json and prompt.md", async () => {
    await writeFile(join(dir, "request.json"), BOM + JSON.stringify(okReq), "utf8");
    await writeFile(join(dir, "prompt.md"), `${BOM}hello`, "utf8");
    const r = await readRequestFile(join(dir, "request.json"));
    expect(r.kind).toBe("read");
    if (r.kind !== "read") return;
    expect(r.requestId).toBe(okReq.requestId);
    const v = await validateAndLoad(r.raw, r.requestDir);
    expect(v.kind).toBe("valid");
    if (v.kind === "valid") {
      expect(v.prompt).toBe("hello");
      expect(v.timeoutMs).toBe(900_000);
    }
  });

  it("returns requestId null for missing / invalid ids but still reads", async () => {
    await writeFile(
      join(dir, "request.json"),
      JSON.stringify({ ...okReq, requestId: "x" }),
      "utf8",
    );
    const r = await readRequestFile(join(dir, "request.json"));
    expect(r.kind === "read" && r.requestId).toBeNull();
  });

  it("unreadable: missing file, syntax error, UTF-16", async () => {
    expect((await readRequestFile(join(dir, "nope.json"))).kind).toBe("unreadable");
    await writeFile(join(dir, "bad.json"), "{not json", "utf8");
    expect((await readRequestFile(join(dir, "bad.json"))).kind).toBe("unreadable");
    await writeFile(
      join(dir, "u16.json"),
      Buffer.from(`\uFEFF${JSON.stringify(okReq)}`, "utf16le"),
    );
    expect((await readRequestFile(join(dir, "u16.json"))).kind).toBe("unreadable");
  });

  it("invalid: prompt missing / empty", async () => {
    expect((await validateAndLoad(okReq, dir)).kind).toBe("invalid");
    await writeFile(join(dir, "prompt.md"), "   \n", "utf8");
    const v = await validateAndLoad(okReq, dir);
    expect(v.kind).toBe("invalid");
    if (v.kind === "invalid") expect(v.errors.join()).toMatch(/empty/);
  });
});

describe("atomic write (FR-013, AC-009)", () => {
  it("writes via tmp + rename with no partial content at the final path", async () => {
    const target = join(dir, "out.txt");
    let sawFinalDuringWrite = false;
    await atomicWriteFile(target, "hello", {
      beforeRename: async () => {
        sawFinalDuringWrite = await readFile(target, "utf8").then(
          () => true,
          () => false,
        );
      },
    });
    expect(sawFinalDuringWrite).toBe(false);
    expect(await readFile(target, "utf8")).toBe("hello");
  });
  it("cleans up tmp on failure", async () => {
    const target = join(dir, "sub", "out.txt");
    await expect(
      atomicWriteFile(target, "x", {
        beforeRename: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow(/atomic write failed/);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(dir, "sub"))).toEqual([]);
  });
  it("normalises response body: BOM removed, trailing whitespace collapsed to one LF", () => {
    expect(normaliseResponseBody(`${BOM}# Hi\n\n\n  `)).toBe("# Hi\n");
  });
});

function baseResult(over: Partial<BridgeResult> = {}): BridgeResult {
  return {
    schemaVersion: "1.2",
    bridgeVersion: "0.1.0",
    requestId: "20260914T113000Z-a1b2c3d4",
    status: "completed",
    requestedPreset: "current",
    observedPreset: "pro",
    requestedModel: "current",
    observedModel: "latest",
    observedModelSlug: "gpt-5-6",
    submitted: "yes",
    conversationUrl: "https://chatgpt.com/c/abc",
    responseFile: "S:/x/response.md",
    extractionMethod: "copy",
    extractionQuality: "full",
    startedAt: "2026-09-14T11:30:00.000+09:00",
    completedAt: "2026-09-14T11:33:12.412+09:00",
    durationMs: 192412,
    artifacts: [],
    images: [],
    warnings: [],
    error: null,
    ...over,
  };
}

describe("result.json schema + invariants (AC-007)", () => {
  it("accepts the completed example", () => {
    expect(validateResult(baseResult()).valid).toBe(true);
    expect(checkResultInvariants(baseResult())).toEqual([]);
  });
  // Every member of contracts/types.ts's ERROR_CODES must also be in the result schema's
  // errorCode enum — the two are hand-kept in sync (a JSON schema can't import a TS const), and a
  // code added to one without the other passes typecheck/lint/build cleanly while silently
  // breaking WRITE_RESULT for that one code at runtime (discovered live 2026-09-17: a code missing
  // from the schema made checkResultInvariants() reject every result carrying it, so no
  // result.json was ever written for that failure — the opposite of what result.json is for).
  it("every ErrorCode in contracts/types.ts validates against the result schema (schema sync)", () => {
    // ALREADY_PROCESSED / ALREADY_RUNNING never reach WRITE_RESULT by design (NO_RESULT_CODES —
    // the bridge only reports them on stderr), so there is no result.json shape to check for them.
    for (const code of ERROR_CODES.filter((c) => !NO_RESULT_CODES.includes(c))) {
      const result = baseResult({
        status: statusFor(code),
        // SUBMIT_STATE_UNKNOWN is special-cased to "unknown" regardless of phase (invariants.ts
        // expectedSubmitted()); every other code here uses phase: GENERATING, a post-submission
        // state, so "yes" is what the real controller would produce for it.
        submitted: code === "SUBMIT_STATE_UNKNOWN" ? "unknown" : "yes",
        responseFile: null,
        extractionMethod: null,
        extractionQuality: null,
        error: { code, message: "m", retryable: false, phase: "GENERATING", cause: null },
      });
      expect(checkResultInvariants(result), `error code ${code} should validate`).toEqual([]);
    }
  });
  it("1.2: images[] must be images/<n>.<ext>, unique, and only on completed (Codex P6-3)", () => {
    expect(checkResultInvariants(baseResult({ images: ["images/1.png", "images/2.jpg"] }))).toEqual(
      [],
    );
    expect(checkResultInvariants(baseResult({ images: ["../x.png"] })).join()).toMatch(/images:/);
    expect(checkResultInvariants(baseResult({ images: ["images/0.png"] })).join()).toMatch(
      /images:/,
    );
    expect(
      checkResultInvariants(baseResult({ images: ["images/1.png", "images/1.png"] })).join(),
    ).toMatch(/duplicate/);
    expect(validateResult(baseResult({ images: ["C:/x/1.png"] })).valid).toBe(false);
  });
  it("1.2: newChat false requires conversationUrl on chatgpt.com/c/", () => {
    expect(validateRequest({ ...okReq, schemaVersion: "1.2", newChat: false }).valid).toBe(false);
    expect(
      validateRequest({
        ...okReq,
        schemaVersion: "1.2",
        newChat: false,
        conversationUrl: "https://chatgpt.com/c/6aa8f9e7-f47c-83e8-9f20-e6e71c33026f",
      }).valid,
    ).toBe(true);
    expect(
      validateRequest({ ...okReq, newChat: false, conversationUrl: "https://evil.example/c/x" })
        .valid,
    ).toBe(false);
    expect(
      validateRequest({ ...okReq, newChat: true, conversationUrl: "https://chatgpt.com/c/abc" })
        .valid,
    ).toBe(false);
  });
  it("1.3 (A-106): project is only valid with newChat true, on chatgpt.com, and mutually exclusive with conversationUrl", () => {
    const projectUrl =
      "https://chatgpt.com/g/g-p-6aa226cca960819188ec3e6b03c25580-pixivvault/project";
    expect(validateRequest({ ...okReq, schemaVersion: "1.3", project: projectUrl }).valid).toBe(
      true,
    );
    // accepted regardless of declared schemaVersion, same as model/attachments (documentation only)
    expect(validateRequest({ ...okReq, project: projectUrl }).valid).toBe(true);
    // newChat: false + project is rejected (project only makes sense when starting a new chat)
    expect(
      validateRequest({
        ...okReq,
        newChat: false,
        conversationUrl: "https://chatgpt.com/c/abc1234",
        project: projectUrl,
      }).valid,
    ).toBe(false);
    // project and conversationUrl together are rejected even with newChat: true (conversationUrl
    // requires newChat: false, so this is really the same "not both" rule from the other side)
    expect(
      validateRequest({
        ...okReq,
        newChat: true,
        project: projectUrl,
        conversationUrl: "https://chatgpt.com/c/abc1234",
      }).valid,
    ).toBe(false);
    // A-144: URL-shaped strings that are not a Project-home URL are Project names, so they remain
    // accepted here and resolve-or-create later fails closed if the sidebar cannot confirm them.
    expect(
      validateRequest({ ...okReq, project: "https://evil.example/g/g-p-x/project" }).valid,
    ).toBe(true);
    expect(validateRequest({ ...okReq, project: "https://chatgpt.com/g/g-p-x" }).valid).toBe(true);
    expect(
      validateRequest({
        ...okReq,
        project: "https://chatgpt.com/c/6aa8f9e7-f47c-83e8-9f20-e6e71c33026f",
      }).valid,
    ).toBe(true);
  });
  it("1.3 (A-106): conversationUrl also accepts the Project-nested conversation form", () => {
    expect(
      validateRequest({
        ...okReq,
        newChat: false,
        conversationUrl:
          "https://chatgpt.com/g/g-p-6aa226cca960819188ec3e6b03c25580-pixivvault/c/6aaa4a53-70e8-83e8-b14f-c5c99647ca3e",
      }).valid,
    ).toBe(true);
    // same nested shape on a different origin must still be rejected
    expect(
      validateRequest({
        ...okReq,
        newChat: false,
        conversationUrl: "https://evil.example/g/g-p-x/c/y",
      }).valid,
    ).toBe(false);
  });
  it("1.1: model is optional in request (default current) and rejects unknown models", () => {
    expect(validateRequest({ ...okReq, schemaVersion: "1.1" }).valid).toBe(true);
    expect(validateRequest({ ...okReq, schemaVersion: "1.1", model: "gpt-5.5" }).valid).toBe(true);
    expect(validateRequest({ ...okReq, model: "latest" }).valid).toBe(true);
    expect(validateRequest({ ...okReq, model: "gpt-9" }).valid).toBe(false);
    expect(validateResult(baseResult({ observedModel: "current" as never })).valid).toBe(false);
    expect(
      validateResult(
        baseResult({ requestedModel: null, observedModel: null, observedModelSlug: null }),
      ).valid,
    ).toBe(true);
  });
  const failed = (
    code: BridgeResult["error"] extends infer E ? (E extends { code: infer C } ? C : never) : never,
    phase: string,
    submitted: BridgeResult["submitted"],
    cause: string | null = null,
  ) =>
    baseResult({
      status: "failed",
      observedPreset: null,
      submitted,
      conversationUrl: null,
      responseFile: null,
      extractionMethod: null,
      extractionQuality: null,
      error: {
        code,
        message: "x",
        retryable: false,
        phase: phase as BridgeResult["error"] extends infer E
          ? E extends { phase: infer P }
            ? P
            : never
          : never,
        cause,
      },
    });
  it("rejects observedPreset=current, failed+MI code, MI+failed code, ALREADY_RUNNING, missing warnings", () => {
    expect(validateResult(baseResult({ observedPreset: "current" as never })).valid).toBe(false);
    expect(validateResult(failed("AUTH_REQUIRED", "BROWSER_STARTED", "no")).valid).toBe(false);
    expect(
      validateResult({
        ...failed("CHAT_ERROR", "GENERATING", "yes"),
        status: "manual_intervention_required",
      }).valid,
    ).toBe(false);
    expect(validateResult(failed("ALREADY_RUNNING", "VALIDATED", "no")).valid).toBe(false);
    const { warnings: _w, ...noWarn } = baseResult();
    expect(validateResult(noWarn).valid).toBe(false);
  });
  it("submitted derivation invariants", () => {
    expect(
      checkResultInvariants(failed("PROMPT_SUBMIT_FAILED", "PROMPT_SUBMITTING", "unknown")),
    ).toEqual([]);
    expect(
      checkResultInvariants(failed("PROMPT_SUBMIT_FAILED", "PROMPT_SUBMITTING", "no")),
    ).not.toEqual([]);
    expect(
      checkResultInvariants(
        failed("MODEL_NOT_VERIFIABLE", "PROMPT_SUBMITTING", "no", "preset_changed"),
      ),
    ).toEqual([]);
    expect(checkResultInvariants(failed("GENERATION_TIMEOUT", "GENERATING", "yes"))).toEqual([]);
    expect(checkResultInvariants(failed("GENERATION_TIMEOUT", "GENERATING", "no"))).not.toEqual([]);
    expect(
      checkResultInvariants(failed("SUBMIT_STATE_UNKNOWN", "LOCK_ACQUIRED", "unknown")),
    ).toEqual([]);
    expect(checkResultInvariants(failed("INVALID_REQUEST", "PRIOR_RESULT_CHECKED", "no"))).toEqual(
      [],
    );
  });
});
