import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeSdkMessages } from "../../src/adapters/claude-sdk-messages.js";
import {
  fakeSdkTextAdapter,
  type SdkQueryLike,
  type SdkQueryPort,
} from "../../src/adapters/claude-sdk-text.js";
import { canonicalSdkMessage } from "../../src/adapters/sdk-json-boundary.js";
import { sdkFixture } from "../helpers/sdk-text-fixture.js";

function port(events: unknown[]) {
  const close = vi.fn();
  const query = vi.fn(() => ({
    close,
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  }));
  return { close, query };
}
afterEach(() => vi.useRealTimers());
describe("official-SDK boundary through fake SDK only", () => {
  it("builds exact safe options and proves only iterator completion", async () => {
    const f = sdkFixture(),
      p = port(f.events),
      a = fakeSdkTextAdapter(p),
      run = a.begin(f.plan());
    const result = await run.outcome;
    await run.settled;
    expect(result.state).toBe("response_received");
    expect(result.liveProviderCallObserved).toBe(false);
    expect(result.osProcessExit).toBe("unobserved");
    expect(result.observation).not.toHaveProperty("exitCode");
    expect(result.observation?.completion).toBe("sdk_iterator_completed");
    expect(p.query).toHaveBeenCalledOnce();
    expect(p.close).toHaveBeenCalledOnce();
    const call = p.query.mock.calls[0] as unknown as [
      { options: Record<string, unknown>; prompt: string },
    ];
    const o = call[0].options;
    expect(o.tools).toEqual([]);
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.maxTurns).toBe(1);
    expect(o.maxThinkingTokens).toBe(0);
    expect(o.model).toBe(f.request.model);
    expect(o).not.toHaveProperty("spawnClaudeCodeProcess");
    expect(o).not.toHaveProperty("resume");
    expect(o).not.toHaveProperty("fallbackModel");
    expect(o).not.toHaveProperty("systemPrompt");
    expect(o.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(o.persistSession).toBe(false);
    expect(o.verbatimPrompts).toBe(true);
    expect(call[0].prompt).toContain(f.attemptId);
    expect(Buffer.from(result.privateMessages).toString()).toContain("system");
  });
  it("serialized plans and a reused opaque plan cannot trigger another query", async () => {
    const f = sdkFixture(),
      p = port(f.events),
      a = fakeSdkTextAdapter(p),
      plan = f.plan();
    expect(() => a.begin(JSON.parse(JSON.stringify(plan)))).toThrow("not_available");
    await a.begin(plan).outcome;
    expect(() => a.begin(plan)).toThrow("not_available");
    expect(p.query).toHaveBeenCalledOnce();
  });
  it("synchronous query failure remains unknown, without raw error text or retry", async () => {
    const f = sdkFixture(),
      query = vi.fn(() => {
        throw new Error("SECRET=hidden");
      });
    const r = await fakeSdkTextAdapter({ query }).begin(f.plan()).outcome;
    expect(r.state).toBe("unknown");
    expect(r.failureCode).toBe("sdk_text_query_failed");
    expect(r.liveProviderCallObserved).toBe(false);
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(query).toHaveBeenCalledOnce();
  });
  it("pre-aborted and expired plans make zero calls", async () => {
    const f = sdkFixture(),
      p = port(f.events),
      abort = new AbortController();
    abort.abort();
    expect((await fakeSdkTextAdapter(p).begin(f.plan(), abort.signal).outcome).state).toBe(
      "not_started",
    );
    expect(p.query).not.toHaveBeenCalled();
  });
  it.each(["missing", "extra", "model", "tools", "usage", "queued", "deferred"])(
    "rejects %s and closes once",
    async (kind) => {
      const f = sdkFixture(),
        events = structuredClone(f.events);
      if (kind === "missing") events.pop();
      else if (kind === "extra") events.push(events[2] ?? {});
      else if (kind === "model") Object.assign(events[0] ?? {}, { model: "other" });
      else if (kind === "tools") Object.assign(events[0] ?? {}, { tools: ["Bash"] });
      else if (kind === "usage") Object.assign(events[2] ?? {}, { modelUsage: {} });
      else
        Object.assign(
          events[2] ?? {},
          kind === "queued" ? { queued_turn_count: 1 } : { deferred_tool_use: {} },
        );
      const p = port(events),
        r = await fakeSdkTextAdapter(p).begin(f.plan()).outcome;
      expect(r.state).toBe("unknown");
      expect(p.query).toHaveBeenCalledOnce();
      expect(p.close).toHaveBeenCalledOnce();
      expect(r).not.toHaveProperty("observation");
    },
  );
  it("holds unknown ownership after deadline until a late iterator actually settles", async () => {
    vi.useFakeTimers();
    const f = sdkFixture(),
      close = vi.fn();
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    const p: SdkQueryPort = {
      query: vi.fn(() => ({
        close,
        async *[Symbol.asyncIterator]() {
          await wait;
          yield* f.events;
        },
      })),
    };
    const run = fakeSdkTextAdapter(p).begin(f.plan());
    let settled = false;
    void run.settled.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(66000);
    const r = await run.outcome;
    expect(r.state).toBe("unknown");
    expect(r.cleanup).toBe("pending");
    expect(settled).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    release();
    await run.settled;
    expect(settled).toBe(true);
    expect(p.query).toHaveBeenCalledOnce();
    expect(await run.outcome).toBe(r);
  });
  it("cancel during pending next closes and retains no fake completion", async () => {
    const f = sdkFixture(),
      close = vi.fn();
    let done!: () => void;
    const w = new Promise<void>((r) => (done = r));
    const q: SdkQueryLike = {
      close,
      async *[Symbol.asyncIterator]() {
        await w;
        yield* f.events;
      },
    };
    const run = fakeSdkTextAdapter({ query: () => q }).begin(f.plan());
    run.cancel();
    done();
    const r = await run.outcome;
    expect(r.state).toBe("unknown");
    expect(r.failureCode).toBe("sdk_text_cancelled");
    expect(close).toHaveBeenCalledOnce();
  });
  it("stderr is counted, never retained, and synchronous overflow still closes the returned query", async () => {
    const f = sdkFixture(),
      close = vi.fn();
    const r = await fakeSdkTextAdapter({
      query: ({ options }) => {
        options.stderr?.("secret".repeat(20000));
        return {
          close,
          async *[Symbol.asyncIterator]() {
            yield* f.events;
          },
        };
      },
    }).begin(f.plan()).outcome;
    expect(r.state).toBe("unknown");
    expect(r.failureCode).toBe("text_provider_stderr_limit");
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(close).toHaveBeenCalledOnce();
  });
  it("revalidates private canonical SDK evidence without constructing a query", async () => {
    const f = sdkFixture(),
      r = await fakeSdkTextAdapter(port(f.events)).begin(f.plan()).outcome;
    const parser = new ClaudeSdkMessages(
      {
        binding: f.binding,
        attemptId: f.attemptId,
        binarySha256ObservedBefore: f.profile.binarySha256,
        cliVersion: "2.1.288",
      },
      () => {},
    );
    for (const line of Buffer.from(r.privateMessages).toString().trimEnd().split("\n"))
      parser.feedMessage(JSON.parse(line));
    const recovered = parser.complete({
      sdkIteratorCompleted: true,
      sdkCloseRequested: true,
      cancelled: false,
      finishedAtMs: f.now,
      deadlineAtMs: f.now + 60000,
    });
    expect(recovered.observation).toEqual(r.observation);
  });
});
describe("bounded SDK value canonicalization before serialization", () => {
  it("round trips ordinary finite JSON", () => {
    const value = { a: [1, 0.2, true, null, "a\n🐈"] };
    expect(JSON.parse(canonicalSdkMessage(value, 262144).toString())).toEqual(value);
  });
  it.each([NaN, Infinity, undefined, BigInt(1), new Date(), () => 1])(
    "rejects non-JSON input %s",
    (v) => expect(() => canonicalSdkMessage(v, 262144)).toThrow(),
  );
  it("rejects cycles, deep values and oversized arrays", () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => canonicalSdkMessage(cycle, 262144)).toThrow();
    let deep: unknown = null;
    for (let i = 0; i < 35; i++) deep = [deep];
    expect(() => canonicalSdkMessage(deep, 262144)).toThrow();
    expect(() => canonicalSdkMessage(Array(16385), 262144)).toThrow();
  });
  it("never invokes getters", () => {
    const get = vi.fn(() => "secret");
    const v = {};
    Object.defineProperty(v, "a", { enumerable: true, get });
    expect(() => canonicalSdkMessage(v, 262144)).toThrow("accessor");
    expect(get).not.toHaveBeenCalled();
  });
  it("bounds escaped strings before allocating their large JSON encoding", () => {
    expect(() => canonicalSdkMessage("\u0001".repeat(100000), 262144)).toThrow("limit");
    expect(() => canonicalSdkMessage("x".repeat(262145), 262144)).toThrow("limit");
    expect(() => canonicalSdkMessage("\ud800", 262144)).toThrow("unicode");
  });
  it("bounds cumulative keys and values", () => {
    expect(() =>
      canonicalSdkMessage(
        Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [String(i), i])),
        262144,
      ),
    ).toThrow("shape_limit");
  });
});
