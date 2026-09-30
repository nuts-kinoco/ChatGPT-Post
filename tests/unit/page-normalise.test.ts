import { describe, expect, it } from "vitest";
import { classifyProject, normalisePrompt } from "../../src/chatgpt/page.js";
import { userTurnMatchesPrompt } from "../../src/chatgpt/prompt-match.js";
import {
  collapsedLongJapaneseUserTurn,
  longJapanesePrompt,
} from "../fixtures/collapsed-long-japanese-user-turn.js";

describe("normalisePrompt (A-128, Phase 0-D-1, ChatGPT Pro self-review §2.3)", () => {
  it("no longer treats differently-spaced content as identical", () => {
    expect(normalisePrompt('print("a b")')).not.toBe(normalisePrompt('print("ab")'));
  });
  it("preserves code indentation", () => {
    const a = "if x:\n    y()\n";
    const b = "if x:\ny()\n";
    expect(normalisePrompt(a)).not.toBe(normalisePrompt(b));
  });
  it("still normalises CRLF/CR to LF (benign line-ending differences)", () => {
    expect(normalisePrompt("a\r\nb")).toBe(normalisePrompt("a\nb"));
    expect(normalisePrompt("a\rb")).toBe(normalisePrompt("a\nb"));
  });
  it("still normalises NBSP/full-width via NFKC", () => {
    expect(normalisePrompt("a\u00a0b")).toBe(normalisePrompt("a b"));
  });
  it("trims only the string's own leading/trailing whitespace", () => {
    expect(normalisePrompt("  hello  ")).toBe("hello");
    expect(normalisePrompt("hello\n")).toBe("hello");
  });
});

describe("userTurnMatchesPrompt (A-191)", () => {
  it("keeps exact short-prompt matching unchanged", () => {
    expect(userTurnMatchesPrompt("short prompt", "short prompt")).toBe(true);
  });

  it("accepts ChatGPT's collapsed 2000+ character Japanese prompt fixture", () => {
    expect(longJapanesePrompt.length).toBeGreaterThan(2000);
    expect(collapsedLongJapaneseUserTurn.split("\n")).toHaveLength(16);
    expect(userTurnMatchesPrompt(collapsedLongJapaneseUserTurn, longJapanesePrompt)).toBe(true);
  });

  it("accepts ellipsis-only and English UI-residue collapsed turns", () => {
    const prompt = `request: ${"x".repeat(180)}`;
    expect(userTurnMatchesPrompt(`${prompt.slice(0, 120)}...`, prompt)).toBe(true);
    expect(userTurnMatchesPrompt(`${prompt.slice(0, 120)}\nShow more`, prompt)).toBe(true);
    expect(userTurnMatchesPrompt(`${prompt.slice(0, 120)}\n折りたたむ`, prompt)).toBe(true);
  });

  it("tolerates existing normalisation differences", () => {
    const prompt = "  日本語\r\n本文\u00a0です  ";
    expect(userTurnMatchesPrompt("日本語\n本文 です", prompt)).toBe(true);
  });

  it("allows trailing attachment-chip text only when requested by the ownership caller", () => {
    const rendered = "submitted prompt\nfile.txt";
    expect(userTurnMatchesPrompt(rendered, "submitted prompt")).toBe(false);
    expect(userTurnMatchesPrompt(rendered, "submitted prompt", { allowTrailingText: true })).toBe(
      true,
    );
  });

  it("rejects empty, different, and short shared-prefix turns", () => {
    const prompt = `request: ${"a".repeat(160)}`;
    expect(userTurnMatchesPrompt("", prompt)).toBe(false);
    expect(userTurnMatchesPrompt(`other: ${"a".repeat(160)}`, prompt)).toBe(false);
    expect(userTurnMatchesPrompt(`${prompt.slice(0, 119)}…`, prompt)).toBe(false);
  });
});

describe("classifyProject (A-144)", () => {
  it("preserves the existing full Project URL path and treats every other string as a name", () => {
    const url = "https://chatgpt.com/g/g-p-6aa226cca960819188ec3e6b03c25580-pixivvault/project";
    expect(classifyProject(url)).toEqual({ kind: "url", url });
    expect(classifyProject("EMAKINOCO-Win")).toEqual({
      kind: "name",
      name: "EMAKINOCO-Win",
    });
    expect(classifyProject("https://chatgpt.com/c/not-a-project")).toEqual({
      kind: "name",
      name: "https://chatgpt.com/c/not-a-project",
    });
  });
});
