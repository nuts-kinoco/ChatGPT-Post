import { describe, expect, it } from "vitest";
import { classifyProject, normalisePrompt } from "../../src/chatgpt/page.js";

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
