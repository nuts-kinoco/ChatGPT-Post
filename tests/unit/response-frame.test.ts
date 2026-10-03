import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createFramedPrompt,
  encodeResponseFrame,
  parseResponseFrame,
} from "../../src/contracts/response-frame.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { htmlToMarkdown } from "../../src/extraction/markdown.js";

const identity = { requestId: randomUUID(), taskSpecHash: "a".repeat(64), attemptId: randomUUID() };
const valid = encodeResponseFrame("A complete answer\nwith two lines", identity);
describe("full-response identity framing", () => {
  it("extracts complete content and separately binds raw/body bytes", () => {
    const parsed = parseResponseFrame(valid, identity);
    expect(parsed.markdown).toBe("A complete answer\nwith two lines");
    expect(parsed.rawSha256).toBe(sha256Bytes(Buffer.from(valid)));
    expect(parseResponseFrame(valid.replace(/\n/g, "\r\n"), identity).markdown).toBe(
      parsed.markdown,
    );
  });
  it.each(["requestId", "taskSpecHash", "attemptId"] as const)(
    "rejects an old/wrong %s",
    (field) => {
      const other = {
        ...identity,
        [field]: field === "taskSpecHash" ? "b".repeat(64) : randomUUID(),
      };
      expect(() => parseResponseFrame(valid, other)).toThrow();
    },
  );
  it.each([
    valid.replace(/^BEGIN/, "END"),
    valid.split("\n").slice(0, -2).join("\n"),
    valid + valid,
    `> ${valid.replace(/\n/g, "\n> ")}`,
    `\`\`\`text\n${valid}\`\`\``,
    `unrelated earlier answer\n${valid}`,
    `${valid}trailing unrelated answer`,
    "これで終わり",
  ])("rejects partial, duplicate, quoted, code-fenced or out-of-order frames", (candidate) => {
    expect(() => parseResponseFrame(candidate, identity)).toThrow();
  });
  it("does not mistake an echoed instruction prompt for a complete reply", () => {
    const prompt = createFramedPrompt(Buffer.from("Say hello"), identity);
    expect(() => parseResponseFrame(Buffer.from(prompt).toString(), identity)).toThrow();
  });
  it("rejects nested framing markers in a body rather than ending on a quoted marker", () => {
    const lines = valid.trimEnd().split("\n");
    lines.splice(1, 0, `> ${lines.at(-1)}`);
    expect(() => parseResponseFrame(lines.join("\n"), identity)).toThrow("body_invalid");
  });
  it("survives the preserved DOM-to-Markdown extraction without escaped marker syntax", () => {
    const lines = valid.trimEnd().split("\n");
    const html = `<p>${lines[0]}</p><p>A complete answer</p><p>${lines.at(-1)}</p>`;
    expect(parseResponseFrame(htmlToMarkdown(html), identity).markdown.trim()).toBe(
      "A complete answer",
    );
  });
  it("does not turn a valid frame into approval or execution success", () => {
    const result = parseResponseFrame(
      encodeResponseFrame("The command failed", identity),
      identity,
    );
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("approved");
    expect(result.markdown).toBe("The command failed");
  });
});
