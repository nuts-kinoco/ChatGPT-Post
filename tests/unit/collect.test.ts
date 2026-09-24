import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Observation } from "../../src/chatgpt/completion.js";
import {
  buildRecoveredResult,
  collectLatestReply,
  confirmedConversationUrl,
  requestPathForCollect,
  writeRecoveredResult,
} from "../../src/cli/collect.js";
import type { Ports } from "../../src/state/ports.js";

const url = "https://chatgpt.com/c/recovery-proof";
const identity = {
  requestId: "20260924T000000Z-aaaaaaaa",
  conversationUrl: url,
  submittedAt: "2026-09-24T00:00:00.000Z",
  baselineAssistantCount: 4,
  submittedPrompt: "submitted prompt",
} as const;

function observation(assistantCount: number, streaming = false): Observation {
  return {
    t: 0,
    assistantCount,
    lastAssistantHash: "new-answer",
    lastAssistantEmpty: false,
    streaming,
    composerReady: !streaming,
    copyAvailable: !streaming,
    truncated: false,
    sidePanel: false,
    errorBanner: "none",
    challenge: "none",
  };
}

function portsFor(
  o: Observation,
  opts: { draftPresent?: boolean; ownership?: "match" | "mismatch"; images?: string[] } = {},
) {
  const calls: string[] = [];
  const ports = {
    lock: {
      acquire: async () => {
        calls.push("lock.acquire");
        return { kind: "ok" as const };
      },
      release: async () => calls.push("lock.release"),
    },
    browser: {
      checkProfilePath: async () => ({ ok: true as const }),
      checkProfileFree: async () => ({ free: true as const }),
      launch: async () => {
        calls.push("browser.launch");
        return { ok: true as const };
      },
      close: async () => calls.push("browser.close"),
    },
    chatgpt: {
      navigateAndObserveAuth: async () => ({ kind: "AUTH_OK" as const }),
      openConversationForCollect: async () => {
        calls.push("openConversationForCollect");
        return { kind: "ok" as const, draftPresent: opts.draftPresent ?? false };
      },
      currentUrl: async () => url,
      observe: async () => o,
      verifyLatestReplyOwnership: async () =>
        opts.ownership === "mismatch"
          ? { kind: "mismatch" as const, cause: "preceding prompt differs" }
          : { kind: "match" as const },
      extractLatest: async () => ({
        markdown: "recovered answer",
        method: "dom" as const,
        quality: "full" as const,
        modelSlug: "gpt-5-6",
      }),
      captureImages: async () => ({ saved: opts.images ?? [], warnings: [] }),
    },
  } as unknown as Pick<Ports, "lock" | "browser" | "chatgpt">;
  return { ports, calls };
}

describe("collectLatestReply (A-153)", () => {
  it("recovers exactly one reply and never enters or dispatches a prompt", async () => {
    const f = portsFor(observation(5));
    const result = await collectLatestReply(identity, f.ports);
    expect(result).toMatchObject({ ok: true, observedAssistantCount: 5 });
    expect(f.calls).toEqual([
      "lock.acquire",
      "browser.launch",
      "openConversationForCollect",
      "browser.close",
      "lock.release",
    ]);
    expect(f.calls.join(" ")).not.toMatch(/enterPrompt|dispatchSubmit|send/i);
  });

  it("fails closed when the reply is absent", async () => {
    const f = portsFor(observation(4));
    await expect(collectLatestReply(identity, f.ports)).resolves.toMatchObject({
      ok: false,
      code: "COLLECT_REPLY_ABSENT",
    });
  });

  it("fails closed when more than one reply could belong to the submit", async () => {
    const f = portsFor(observation(6));
    await expect(collectLatestReply(identity, f.ports)).resolves.toMatchObject({
      ok: false,
      code: "COLLECT_REPLY_AMBIGUOUS",
    });
  });

  it("collects with a saved draft, leaves it untouched, and reports the warning", async () => {
    const f = portsFor(observation(5), { draftPresent: true });
    const result = await collectLatestReply(identity, f.ports);
    expect(result).toMatchObject({ ok: true });
    if (result.ok)
      expect(result.warnings).toContain(
        "draft_present: existing composer draft was observed and left untouched",
      );
    expect(f.calls.join(" ")).not.toMatch(/clear|fill|enterPrompt|dispatchSubmit|send/i);
  });

  it("fails closed when the candidate's preceding user turn is not the submitted prompt", async () => {
    const f = portsFor(observation(5), { ownership: "mismatch" });
    await expect(collectLatestReply(identity, f.ports)).resolves.toMatchObject({
      ok: false,
      code: "COLLECT_REPLY_OWNERSHIP_MISMATCH",
    });
  });

  it("accepts a real result URL over a temporary WEB marker URL and otherwise rejects WEB", () => {
    expect(
      confirmedConversationUrl(
        "https://chatgpt.com/c/real-conversation",
        "https://chatgpt.com/c/WEB:temporary-client-id",
      ),
    ).toBe("https://chatgpt.com/c/real-conversation");
    expect(confirmedConversationUrl("https://chatgpt.com/c/WEB:temporary-client-id")).toBeNull();
  });

  it("uses a direct run marker's request path without requiring a jobs.db row", () => {
    expect(
      requestPathForCollect(
        "D:/isolated/requests/20260924T000000Z-aaaaaaaa/request.json",
        "D:/runtime",
        identity.requestId,
      ),
    ).toBe("D:/isolated/requests/20260924T000000Z-aaaaaaaa/request.json");
  });

  it("collects generated images into the recovered result directory", async () => {
    const f = portsFor(observation(5), { images: ["1.png"] });
    const result = await collectLatestReply(
      identity,
      f.ports,
      join(tmpdir(), "bridge-collect-images"),
    );
    expect(result).toMatchObject({ ok: true, images: ["images/1.png"] });
    if (result.ok) expect(result.extraction.markdown).toContain("![image 1](images/1.png)");
  });

  it("writes a distinct recovered result and leaves the original location available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-collect-"));
    const responsePath = join(dir, "recovered", "response.md");
    const result = buildRecoveredResult(
      identity,
      { markdown: "recovered answer", method: "dom", quality: "full", modelSlug: null },
      responsePath,
      "test",
      new Date("2026-09-24T00:01:00.000Z"),
      ["images/1.png"],
      ["draft_present: existing composer draft was observed and left untouched"],
    );
    const written = await writeRecoveredResult(join(dir, "recovered"), result, "recovered answer");
    expect(written.resultPath).toMatch(/recovered[\\/]result\.json$/);
    expect(JSON.parse(await readFile(written.resultPath, "utf8"))).toMatchObject({
      recoveredBy: "collect",
      images: ["images/1.png"],
    });
  });
});
