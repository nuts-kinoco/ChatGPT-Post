import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ExactHostedSourceIdentity,
  ExactHostedSourceResolver,
  type HostedConversationSnapshot,
  type HostedSourceAvailable,
  type HostedSourceExpectation,
  type HostedSourceProvenanceV1,
  type HostedSourceRecoveryExpectation,
  type HostedSourceResolution,
  type HostedSourceSnapshotReader,
  type HostedTurnSnapshot,
  PlaywrightHostedSourceSnapshotReader,
} from "../../src/archive/hosted-source.js";
import {
  createFramedPrompt,
  encodeResponseFrame,
  parseResponseFrame,
} from "../../src/contracts/response-frame.js";
import { sha256Bytes } from "../../src/contracts/task.js";

const frameIdentity = {
  requestId: randomUUID(),
  taskSpecHash: "a".repeat(64),
  attemptId: randomUUID(),
};
const raw = encodeResponseFrame("The original answer", frameIdentity);
const parsed = parseResponseFrame(raw, frameIdentity);
const prompt = Buffer.from(
  createFramedPrompt(Buffer.from("Original task\n"), frameIdentity),
).toString();
const digest = (value: string | Uint8Array) =>
  sha256Bytes(typeof value === "string" ? Buffer.from(value) : value);
const identity: ExactHostedSourceIdentity = {
  conversationId: "conversation-1",
  userTurnId: "user-1",
  assistantTurnId: "assistant-1",
};
const expected: HostedSourceExpectation = {
  conversationId: identity.conversationId,
  promptText: prompt,
  promptSha256: digest(prompt),
  frame: { identity: frameIdentity, rawSha256: parsed.rawSha256, bodySha256: parsed.bodySha256 },
};
function user(messageId = "user-1", text = prompt): HostedTurnSnapshot {
  return { messageId, role: "user", text, markdown: "", artifacts: [] };
}
function assistant(messageId = "assistant-1", markdown = raw): HostedTurnSnapshot {
  return {
    messageId,
    role: "assistant",
    text: markdown,
    markdown,
    artifacts: [],
    artifactEnumerationKnown: true,
  };
}
function fixture(turns: HostedTurnSnapshot[] = [user(), assistant()]) {
  const snapshot: HostedConversationSnapshot = {
    state: "available",
    conversationId: identity.conversationId,
    turns,
  };
  const read = vi.fn(async () => snapshot);
  return { snapshot, read, resolver: new ExactHostedSourceResolver({ read }) };
}
function available(result: HostedSourceResolution): HostedSourceAvailable {
  if (result.state !== "available") throw new Error(result.reason);
  expect(result.state).toBe("available");
  return result;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("exact hosted source provenance (fake/local snapshots only)", () => {
  it("pins full prompt/frame identities separately and recovers an older reply after new turns", async () => {
    const f = fixture();
    const first = available(await f.resolver.pin(expected));
    expect(first.provenance.identity).toEqual(identity);
    expect(first.provenance.frame).toEqual(expected.frame);
    expect(first.provenance.promptSha256).toBe(digest(prompt));
    expect(first.provenance.userTextSha256).toBe(digest(prompt));
    expect(first.markdown).toBe("The original answer");
    expect(Buffer.from(first.bytes).toString()).toBe(raw);
    expect(Object.isFrozen(first.provenance.identity)).toBe(true);
    f.snapshot.turns = [
      ...f.snapshot.turns,
      user("user-2", "A later task"),
      assistant("assistant-2", "A newer answer"),
    ];
    const recovered = available(await f.resolver.resolve(first.provenance));
    expect(recovered).toEqual(first);
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("never replaces a missing pinned turn with a newer identical reply", async () => {
    const f = fixture();
    const pin = available(await f.resolver.pin(expected)).provenance;
    f.snapshot.turns = [user("user-2"), assistant("assistant-2")];
    expect(await f.resolver.resolve(pin)).toEqual({
      state: "unavailable",
      reason: "message_unavailable",
    });
  });
  it("requires unique prompt/frame discovery even when all response bytes are identical", async () => {
    const f = fixture([user(), assistant(), user("user-2"), assistant("assistant-2")]);
    expect(await f.resolver.pin(expected)).toEqual({
      state: "unavailable",
      reason: "ambiguous_source",
    });
    expect(available(await f.resolver.pin(expected, identity)).provenance.identity).toEqual(
      identity,
    );
  });
  it.each(["user-1", "assistant-1"])(
    "refuses duplicate stable message ID %s anywhere in the list",
    async (messageId) => {
      const f = fixture([user(), assistant(), assistant(messageId, "newer")]);
      expect(await f.resolver.pin(expected, identity)).toEqual({
        state: "unavailable",
        reason: "ambiguous_message_ids",
      });
    },
  );
  it.each([null, "", "bad/id", "x".repeat(129)])(
    "refuses unsupported message ID %s",
    async (messageId) => {
      const f = fixture([{ ...user(), messageId }, assistant()]);
      expect(await f.resolver.pin(expected)).toEqual({
        state: "unavailable",
        reason: "unsupported_message_ids",
      });
    },
  );
  it("refuses conversation changes during initial pin and recovery", async () => {
    const f = fixture();
    const pin = available(await f.resolver.pin(expected)).provenance;
    f.snapshot.conversationId = "different-conversation";
    expect(await f.resolver.pin(expected, identity)).toEqual({
      state: "unavailable",
      reason: "conversation_mismatch",
    });
    expect(await f.resolver.resolve(pin)).toEqual({
      state: "unavailable",
      reason: "conversation_mismatch",
    });
  });
  it("binds the assistant to the preceding user turn, even if another user has identical text", async () => {
    const f = fixture([user(), user("user-2"), assistant()]);
    expect(await f.resolver.pin(expected, identity)).toEqual({
      state: "unavailable",
      reason: "user_pairing_mismatch",
    });
  });
  it("does not pair an assistant with a future user or reversed roles", async () => {
    const f = fixture([assistant(), user()]);
    expect(await f.resolver.pin(expected, identity)).toEqual({
      state: "unavailable",
      reason: "user_pairing_mismatch",
    });
    const reversed = {
      ...identity,
      userTurnId: identity.assistantTurnId,
      assistantTurnId: identity.userTurnId,
    };
    expect(await f.resolver.pin(expected, reversed)).toEqual({
      state: "unavailable",
      reason: "user_pairing_mismatch",
    });
  });
  it("rejects wrong prompt hashes, changed prompt bytes, and collapsed prefixes", async () => {
    const f = fixture();
    expect(await f.resolver.pin({ ...expected, promptSha256: "b".repeat(64) })).toEqual({
      state: "unavailable",
      reason: "invalid_expectation",
    });
    for (const text of ["Wrong user prompt", `${prompt.slice(0, 180)}… Show more`]) {
      f.snapshot.turns = [user("user-1", text), assistant()];
      expect(await f.resolver.pin(expected, identity)).toEqual({
        state: "unavailable",
        reason: "prompt_mismatch",
      });
    }
  });
  it("permits only line-ending/outer-whitespace display changes, then pins observed text bytes", async () => {
    const f = fixture([user("user-1", `\n${prompt.replace(/\n/g, "\r\n").trim()}\n`), assistant()]);
    const pin = available(await f.resolver.pin(expected)).provenance;
    expect(pin.promptSha256).toBe(expected.promptSha256);
    expect(pin.userTextSha256).not.toBe(expected.promptSha256);
    f.snapshot.turns = [user(), assistant()];
    expect(await f.resolver.resolve(pin)).toEqual({
      state: "unavailable",
      reason: "prompt_mismatch",
    });
  });
  it.each(["requestId", "taskSpecHash", "attemptId"] as const)(
    "rejects the wrong frame %s",
    async (key) => {
      const f = fixture();
      const changed = structuredClone(expected);
      changed.frame.identity[key] = key === "taskSpecHash" ? "b".repeat(64) : randomUUID();
      expect(await f.resolver.pin(changed, identity)).toEqual({
        state: "unavailable",
        reason: "frame_mismatch",
      });
    },
  );
  it.each(["rawSha256", "bodySha256"] as const)("requires exact independent %s", async (key) => {
    const f = fixture();
    expect(
      await f.resolver.pin(
        { ...expected, frame: { ...expected.frame, [key]: "b".repeat(64) } },
        identity,
      ),
    ).toEqual({ state: "unavailable", reason: "content_hash_mismatch" });
  });
  it.each([
    prompt,
    raw + raw,
    raw.slice(0, -100),
    `> ${raw.replace(/\n/g, "\n> ")}`,
    `\`\`\`\n${raw}\`\`\``,
  ])("rejects echoed, duplicate, truncated, quoted and fenced responses", async (markdown) => {
    const f = fixture([user(), assistant("assistant-1", markdown)]);
    expect(await f.resolver.pin(expected, identity)).toEqual({
      state: "unavailable",
      reason: "frame_mismatch",
    });
  });
  it("detects response edits under unchanged IDs and stored hash changes", async () => {
    const f = fixture();
    const pin = available(await f.resolver.pin(expected)).provenance;
    expect(await f.resolver.resolve({ ...pin, contentSha256: "b".repeat(64) })).toEqual({
      state: "unavailable",
      reason: "content_hash_mismatch",
    });
    f.snapshot.turns = [
      user(),
      assistant("assistant-1", encodeResponseFrame("Changed answer", frameIdentity)),
    ];
    expect(await f.resolver.resolve(pin)).toEqual({
      state: "unavailable",
      reason: "content_hash_mismatch",
    });
  });
  it("fails closed on an unsupported provenance version or invalid identifiers", async () => {
    const f = fixture();
    const pin = available(await f.resolver.pin(expected)).provenance;
    expect(
      await f.resolver.resolve({
        ...pin,
        version: "hosted-source-2",
      } as unknown as HostedSourceProvenanceV1),
    ).toEqual({ state: "unavailable", reason: "unsupported_source_version" });
    expect(await f.resolver.pin(expected, { ...identity, userTurnId: "../latest" })).toEqual({
      state: "unavailable",
      reason: "invalid_identity",
    });
  });
  it("snapshots the expected identity before awaiting the reader", async () => {
    let finish: ((value: HostedConversationSnapshot) => void) | undefined;
    const resolver = new ExactHostedSourceResolver({
      read: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const mutableExpected = structuredClone(expected);
    const mutableIdentity = { ...identity };
    const result = resolver.pin(mutableExpected, mutableIdentity);
    mutableExpected.frame.identity.attemptId = randomUUID();
    mutableIdentity.assistantTurnId = "assistant-2";
    finish?.(fixture().snapshot);
    expect(available(await result).provenance.identity).toEqual(identity);
  });
});

describe("initial exact-attempt recovery without previously observed response hashes", () => {
  const recovery: HostedSourceRecoveryExpectation = {
    conversationId: identity.conversationId,
    promptText: prompt,
    promptSha256: digest(prompt),
    identity: frameIdentity,
  };
  it("observes hashes in one bounded read and keeps that source after a newer unrelated reply", async () => {
    const f = fixture([
      user(),
      assistant(),
      user("later-user", "other task"),
      assistant("later-assistant", "latest reply"),
    ]);
    const recovered = available(await f.resolver.recover(recovery));
    expect(recovered.provenance.identity).toEqual(identity);
    expect(recovered.provenance.frame).toEqual(expected.frame);
    expect(recovered.artifactInventory).toMatchObject({ enumerationKnown: true, artifacts: [] });
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(available(await f.resolver.resolve(recovered.provenance))).toEqual(recovered);
  });
  it("supports known exact message IDs while retaining frame/prompt checks", async () => {
    const f = fixture();
    expect(available(await f.resolver.recover(recovery, identity)).provenance.identity).toEqual(
      identity,
    );
    expect(await f.resolver.recover(recovery, { ...identity, userTurnId: "missing-user" })).toEqual(
      { state: "unavailable", reason: "message_unavailable" },
    );
    expect(
      await f.resolver.recover(recovery, { ...identity, artifactId: "unobserved-artifact" }),
    ).toEqual({ state: "unavailable", reason: "invalid_identity" });
  });
  it("never guesses between complete same-attempt frames, even with different response bytes", async () => {
    const f = fixture([
      user(),
      assistant(),
      user("another-user"),
      assistant("another-assistant", encodeResponseFrame("different answer", frameIdentity)),
    ]);
    expect(await f.resolver.recover(recovery)).toEqual({
      state: "unavailable",
      reason: "ambiguous_source",
    });
  });
  it.each(["requestId", "taskSpecHash", "attemptId"] as const)(
    "rejects wrong recovery frame %s",
    async (key) => {
      const f = fixture();
      const changed = structuredClone(recovery);
      changed.identity[key] = key === "taskSpecHash" ? "b".repeat(64) : randomUUID();
      expect(await f.resolver.recover(changed)).toEqual({
        state: "unavailable",
        reason: "message_unavailable",
      });
      expect(await f.resolver.recover(changed, identity)).toEqual({
        state: "unavailable",
        reason: "frame_mismatch",
      });
    },
  );
  it("rejects wrong conversation, prompt hash and full prompt ownership", async () => {
    const f = fixture();
    expect(await f.resolver.recover({ ...recovery, conversationId: "other-conversation" })).toEqual(
      { state: "unavailable", reason: "conversation_mismatch" },
    );
    expect(await f.resolver.recover({ ...recovery, promptSha256: "b".repeat(64) })).toEqual({
      state: "unavailable",
      reason: "invalid_expectation",
    });
    f.snapshot.turns = [user("user-1", `${prompt.slice(0, 180)}…`), assistant()];
    expect(await f.resolver.recover(recovery, identity)).toEqual({
      state: "unavailable",
      reason: "prompt_mismatch",
    });
  });
  it("does not accept prompt echoes or partial frames and retains all bounded limits", async () => {
    for (const text of [prompt, raw.slice(0, -80)]) {
      const f = fixture([user(), assistant("assistant-1", text)]);
      expect(await f.resolver.recover(recovery)).toEqual({
        state: "unavailable",
        reason: "message_unavailable",
      });
    }
    const f = fixture();
    expect(await new ExactHostedSourceResolver(f, { maxTurns: 1 }).recover(recovery)).toEqual({
      state: "unavailable",
      reason: "turn_limit_exceeded",
    });
  });
  it("keeps stored hash mismatch detection after initial recovery", async () => {
    const f = fixture();
    const recovered = available(await f.resolver.recover(recovery));
    f.snapshot.turns = [
      user(),
      assistant("assistant-1", encodeResponseFrame("changed afterwards", frameIdentity)),
    ];
    expect(await f.resolver.resolve(recovered.provenance)).toEqual({
      state: "unavailable",
      reason: "content_hash_mismatch",
    });
  });
});

describe("artifact identity and bounded reads", () => {
  const bytes = Buffer.from("Exact artifact bytes");
  const artifactExpected = {
    ...expected,
    artifact: { contentSha256: digest(bytes), sizeBytes: bytes.length },
  };
  const artifactIdentity = { ...identity, artifactId: "artifact-1" };
  function artifacts(items = [{ artifactId: "artifact-1", bytes }]) {
    return fixture([user(), { ...assistant(), artifacts: items }]);
  }
  it("distinguishes a trusted verified-empty set from absent enumeration evidence", async () => {
    const f = fixture();
    expect(available(await f.resolver.pin(expected)).artifactInventory).toMatchObject({
      enumerationKnown: true,
      artifacts: [],
    });
    const noProof = assistant();
    delete noProof.artifactEnumerationKnown;
    f.snapshot.turns = [user(), noProof];
    expect(available(await f.resolver.pin(expected)).artifactInventory).toMatchObject({
      enumerationKnown: false,
      artifacts: [],
    });
  });
  it("enumerates exact selected-turn stable IDs with hashes and sizes from actual adapter bytes", async () => {
    const f = artifacts();
    f.snapshot.turns = [
      ...f.snapshot.turns,
      user("new-user", "new task"),
      {
        ...assistant("new-assistant"),
        artifacts: [{ artifactId: "different-artifact", bytes: Buffer.from("unrelated") }],
      },
    ];
    expect(available(await f.resolver.pin(expected, identity)).artifactInventory).toMatchObject({
      enumerationKnown: true,
      artifacts: [
        {
          artifactId: "artifact-1",
          contentSha256: digest(bytes),
          sizeBytes: bytes.length,
          state: "available",
        },
      ],
    });
  });
  it("exposes unsupported and ambiguous required files without fabricating IDs or verified empty", async () => {
    const f = fixture([
      user(),
      {
        ...assistant(),
        artifacts: [
          { artifactId: null },
          { artifactId: "no-bytes" },
          { artifactId: "duplicate", bytes },
          { artifactId: "duplicate", bytes },
        ],
      },
    ]);
    const inventory = available(await f.resolver.pin(expected, identity)).artifactInventory;
    expect(inventory.enumerationKnown).toBe(true);
    expect(
      inventory.artifacts.map((artifact) => [artifact.artifactId, artifact.state, artifact.reason]),
    ).toEqual([
      [null, "unavailable", "unsupported_artifact_ids"],
      ["no-bytes", "unavailable", "artifact_bytes_unsupported"],
      ["duplicate", "unavailable", "ambiguous_artifact_ids"],
      ["duplicate", "unavailable", "ambiguous_artifact_ids"],
    ]);
    expect(inventory.artifacts[0]?.contentSha256).toBeNull();
    expect(inventory.artifacts[1]?.sizeBytes).toBeNull();
  });
  it("pins and rereads only the exact artifact in the exact older assistant turn", async () => {
    const f = artifacts();
    const first = available(await f.resolver.pin(artifactExpected, artifactIdentity));
    expect(first.provenance.representation).toBe("artifact_bytes");
    f.snapshot.turns = [
      ...f.snapshot.turns,
      user("user-2", "new task"),
      {
        ...assistant("assistant-2"),
        artifacts: [{ artifactId: "artifact-1", bytes: Buffer.from("wrong newer bytes") }],
      },
    ];
    expect(available(await f.resolver.resolve(first.provenance)).bytes).toEqual(
      Uint8Array.from(bytes),
    );
  });
  it("cannot use an artifact from another turn or invent an artifact ID", async () => {
    const f = fixture([
      user(),
      assistant(),
      user("user-2", "new task"),
      { ...assistant("assistant-2"), artifacts: [{ artifactId: "artifact-1", bytes }] },
    ]);
    expect(await f.resolver.pin(artifactExpected, artifactIdentity)).toEqual({
      state: "unavailable",
      reason: "artifact_unavailable",
    });
    f.snapshot.turns = [user(), { ...assistant(), artifacts: [{ artifactId: null, bytes }] }];
    expect(await f.resolver.pin(artifactExpected, artifactIdentity)).toEqual({
      state: "unavailable",
      reason: "unsupported_artifact_ids",
    });
  });
  it("refuses duplicate artifact IDs, absent bytes, wrong hashes and wrong sizes", async () => {
    const f = artifacts([
      { artifactId: "artifact-1", bytes },
      { artifactId: "artifact-1", bytes },
    ]);
    expect(await f.resolver.pin(artifactExpected, artifactIdentity)).toEqual({
      state: "unavailable",
      reason: "ambiguous_artifact_ids",
    });
    f.snapshot.turns = [user(), { ...assistant(), artifacts: [{ artifactId: "artifact-1" }] }];
    expect(await f.resolver.pin(artifactExpected, artifactIdentity)).toEqual({
      state: "unavailable",
      reason: "artifact_bytes_unsupported",
    });
    f.snapshot.turns = artifacts().snapshot.turns;
    for (const artifact of [
      { ...artifactExpected.artifact, contentSha256: "b".repeat(64) },
      { ...artifactExpected.artifact, sizeBytes: 1 },
    ]) {
      expect(await f.resolver.pin({ ...expected, artifact }, artifactIdentity)).toEqual({
        state: "unavailable",
        reason: "content_hash_mismatch",
      });
    }
  });
  it("rejects artifact selection without its independent hash/size expectation", async () => {
    expect(await artifacts().resolver.pin(expected, artifactIdentity)).toEqual({
      state: "unavailable",
      reason: "invalid_expectation",
    });
  });
  it("detects artifact mutation under the same stable ID", async () => {
    const f = artifacts();
    const pin = available(await f.resolver.pin(artifactExpected, artifactIdentity)).provenance;
    f.snapshot.turns = [
      user(),
      { ...assistant(), artifacts: [{ artifactId: "artifact-1", bytes: Buffer.from("mutated") }] },
    ];
    expect(await f.resolver.resolve(pin)).toEqual({
      state: "unavailable",
      reason: "content_hash_mismatch",
    });
  });
  it("never upgrades explicitly unavailable partial artifact bytes into available content", async () => {
    const f = fixture([
      user(),
      {
        ...assistant(),
        artifacts: [
          {
            artifactId: "artifact-1",
            bytes,
            unavailableReason: "artifact_unavailable",
          },
        ],
      },
    ]);
    expect(await f.resolver.pin(artifactExpected, artifactIdentity)).toEqual({
      state: "unavailable",
      reason: "artifact_unavailable",
    });
    const source = available(await f.resolver.pin(expected, identity));
    expect(source.artifactInventory.artifacts[0]?.state).toBe("unavailable");
    expect(source.artifactInventory.artifacts[0]?.reason).toBe("artifact_unavailable");
  });
  it("rejects excess turns rather than dropping old messages for a latest slice", async () => {
    const f = fixture();
    const resolver = new ExactHostedSourceResolver(f, { maxTurns: 1 });
    expect(await resolver.pin(expected)).toEqual({
      state: "unavailable",
      reason: "turn_limit_exceeded",
    });
    expect(f.read).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 1 }));
  });
  it("enforces message, total, artifact and per-turn artifact caps against adapter output", async () => {
    const f = artifacts();
    for (const limits of [{ maxSnapshotBytes: 100 }, { maxArtifactBytes: 1 }]) {
      expect(await new ExactHostedSourceResolver(f, limits).pin(expected)).toEqual({
        state: "unavailable",
        reason: "byte_limit_exceeded",
      });
    }
    f.snapshot.turns = [user(), assistant("assistant-1", "x".repeat(10000))];
    expect(await new ExactHostedSourceResolver(f, { maxMessageBytes: 5000 }).pin(expected)).toEqual(
      { state: "unavailable", reason: "byte_limit_exceeded" },
    );
    f.snapshot.turns = [
      user(),
      { ...assistant(), artifacts: [{ artifactId: "one" }, { artifactId: "two" }] },
    ];
    expect(
      await new ExactHostedSourceResolver(f, { maxArtifactsPerTurn: 1 }).pin(expected),
    ).toEqual({ state: "unavailable", reason: "artifact_limit_exceeded" });
  });
  it.each([
    { maxTurns: 0 },
    { maxTurns: 2049 },
    { maxSnapshotBytes: 17 * 1024 * 1024 },
    { timeoutMs: Infinity },
  ])("rejects invalid/unbounded configured limits %s", (limits) => {
    expect(() => new ExactHostedSourceResolver(fixture(), limits)).toThrow(
      "hosted_source_limits_invalid",
    );
  });
  it("returns explicit failure and bounded timeout without retrying the read", async () => {
    const read = vi.fn(async () => {
      throw new Error("private browser error");
    });
    expect(await new ExactHostedSourceResolver({ read }).pin(expected)).toEqual({
      state: "unavailable",
      reason: "source_read_failed",
    });
    expect(read).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    const stalled: HostedSourceSnapshotReader = { read: vi.fn(() => new Promise(() => {})) };
    const pending = new ExactHostedSourceResolver(stalled, { timeoutMs: 10 }).pin(expected);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toEqual({ state: "unavailable", reason: "source_read_timeout" });
    expect(stalled.read).toHaveBeenCalledTimes(1);
  });
});

/** Minimal DOM method doubles execute the real Page callback. No browser/model/network is started. */
function domFixture(
  html: string,
  options: {
    href?: string;
    missingId?: boolean;
    artifactIds?: Array<string | null>;
    extraTurns?: number;
  } = {},
) {
  const lineText = raw.trimEnd();
  const nodes = [
    {
      getAttribute: (name: string) =>
        name === "data-message-author-role" ? "user" : options.missingId ? null : "user-1",
      querySelectorAll: () => [],
      innerText: prompt,
      innerHTML: "",
    },
    {
      getAttribute: (name: string) =>
        name === "data-message-author-role" ? "assistant" : "assistant-1",
      querySelectorAll: (selector: string) =>
        selector === ".markdown"
          ? [{ innerText: lineText, innerHTML: html }]
          : (options.artifactIds ?? []).map((artifactId) => ({ getAttribute: () => artifactId })),
      innerText: lineText,
      innerHTML: html,
    },
  ];
  for (let n = 0; n < (options.extraTurns ?? 0); n++)
    nodes.push(nodes[1] as (typeof nodes)[number]);
  const document = {
    location: { href: options.href ?? "https://chatgpt.com/c/conversation-1" },
    querySelectorAll: () => nodes,
  };
  vi.stubGlobal("document", document);
  const evaluate = vi.fn(async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg));
  const reader = new PlaywrightHostedSourceSnapshotReader({ evaluate } as unknown as Pick<
    Page,
    "evaluate"
  >);
  return { reader, evaluate };
}
describe("production Page snapshot reader through local DOM doubles", () => {
  const [begin, body, end] = raw.trimEnd().split("\n");
  const html = `<p>${begin}</p><p>${body}</p><p>${end}</p>`;
  const domRaw = encodeResponseFrame("\nThe original answer\n", frameIdentity);
  const domParsed = parseResponseFrame(domRaw, frameIdentity);
  const domExpected = {
    ...expected,
    frame: {
      identity: frameIdentity,
      rawSha256: domParsed.rawSha256,
      bodySha256: domParsed.bodySha256,
    },
  };
  it("uses rendered stable IDs and deterministic HTML conversion with preserved framing", async () => {
    const f = domFixture(html);
    const source = available(await new ExactHostedSourceResolver(f.reader).pin(domExpected));
    expect(source.rawMarkdown).toBe(domRaw);
    expect(source.provenance.identity).toEqual(identity);
    expect(source.artifactInventory).toMatchObject({ enumerationKnown: false, artifacts: [] });
    expect(f.evaluate).toHaveBeenCalledTimes(1);
  });
  it.each([
    `<blockquote>${html}</blockquote>`,
    `<pre><code>${raw}</code></pre>`,
    `<p><code>${begin}</code><br>${body}<br><code>${end}</code></p>`,
  ])(
    "does not repair quoted or code-wrapped boundary markers into trusted framing",
    async (wrapped) => {
      const f = domFixture(wrapped);
      expect(await new ExactHostedSourceResolver(f.reader).pin(domExpected, identity)).toEqual({
        state: "unavailable",
        reason: "frame_mismatch",
      });
    },
  );
  it.each([
    "https://evil.example/c/conversation-1",
    "https://chatgpt.com/c/conversation-1?branch=new",
    "https://chatgpt.com/",
  ])("refuses unsupported or unapproved current page %s", async (href) => {
    const f = domFixture(html, { href });
    expect(await new ExactHostedSourceResolver(f.reader).pin(domExpected)).toEqual({
      state: "unavailable",
      reason: "conversation_unavailable",
    });
  });
  it("does not fabricate missing stable message IDs", async () => {
    const f = domFixture(html, { missingId: true });
    expect(await new ExactHostedSourceResolver(f.reader).pin(domExpected)).toEqual({
      state: "unavailable",
      reason: "unsupported_message_ids",
    });
  });
  it("reports real artifact links without IDs or a reviewed bytes reader as unsupported", async () => {
    const artifact = { contentSha256: digest("file"), sizeBytes: 4 };
    for (const artifactIds of [[null], ["artifact-1"]]) {
      const f = domFixture(html, { artifactIds });
      const source = available(
        await new ExactHostedSourceResolver(f.reader).pin(domExpected, identity),
      );
      expect(source.artifactInventory).toMatchObject({
        enumerationKnown: false,
        artifacts: [
          {
            artifactId: artifactIds[0],
            contentSha256: null,
            sizeBytes: null,
            state: "unavailable",
            reason:
              artifactIds[0] === null ? "unsupported_artifact_ids" : "artifact_bytes_unsupported",
          },
        ],
      });
      expect(
        await new ExactHostedSourceResolver(f.reader).pin(
          { ...domExpected, artifact },
          { ...identity, artifactId: "artifact-1" },
        ),
      ).toEqual({
        state: "unavailable",
        reason: artifactIds[0] === null ? "unsupported_artifact_ids" : "artifact_bytes_unsupported",
      });
      expect(f.evaluate).toHaveBeenCalledTimes(2);
    }
  });
  it("caps DOM turn/HTML/artifact reads before conversion or any content fetch", async () => {
    let f = domFixture(html, { extraTurns: 1 });
    expect(await new ExactHostedSourceResolver(f.reader, { maxTurns: 2 }).pin(domExpected)).toEqual(
      { state: "unavailable", reason: "turn_limit_exceeded" },
    );
    f = domFixture(`${html}<div>${"x".repeat(10000)}</div>`);
    expect(
      await new ExactHostedSourceResolver(f.reader, { maxMessageBytes: 5000 }).pin(domExpected),
    ).toEqual({ state: "unavailable", reason: "byte_limit_exceeded" });
    f = domFixture(html, { artifactIds: ["one", "two"] });
    expect(
      await new ExactHostedSourceResolver(f.reader, { maxArtifactsPerTurn: 1 }).pin(domExpected),
    ).toEqual({ state: "unavailable", reason: "artifact_limit_exceeded" });
  });
});
