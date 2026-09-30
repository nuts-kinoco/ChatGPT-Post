import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../../src/extraction/markdown.js";
import {
  MIN_COVERAGE,
  verifyCandidate,
  verifyCompleteness,
  verifyStructure,
  verifyWhitespaceStructure,
} from "../../src/extraction/verify.js";

const innerText = `Bridge Smoke Test

request id: 20260915T060516Z-0e5dbaf9

TypeScript
function hello_bridge() {
  console.log("hello");
}`;

const copyMarkdown = `# Bridge Smoke Test

request id: \`20260915T060516Z-0e5dbaf9\`

\`\`\`typescript
function hello_bridge() {
  console.log("hello");
}
\`\`\``;

describe("verifyCandidate (10 §7, AC-022)", () => {
  it("accepts Markdown whose tokens cover the rendered text (language label tolerated)", () => {
    const v = verifyCandidate(copyMarkdown, innerText);
    expect(v.ok).toBe(true);
    expect(v.coverage ?? 0).toBeGreaterThanOrEqual(0.85);
  });
  it("rejects a different message", () => {
    expect(verifyCandidate("# Something else entirely\n\nnope nope nope", innerText).ok).toBe(
      false,
    );
  });
  it("rejects a truncated conversion", () => {
    expect(verifyCandidate("# Bridge Smoke Test", innerText).ok).toBe(false);
  });
  it("rejects empty innerText and empty candidate", () => {
    expect(verifyCandidate(copyMarkdown, "   ").ok).toBe(false);
    expect(verifyCandidate("", innerText).ok).toBe(false);
  });

  // A-129 (Phase 0-D-2, ChatGPT Pro self-review §2.4): an operator flip used to be invisible to
  // coverage (both `!=` and `==` tokenized to nothing — pure separators), so a code snippet whose
  // only real difference was the operator still passed at 100% coverage.
  it("detects an operator change that the old word-only tokenizer was blind to", () => {
    const v = verifyCandidate("count == limit", "count != limit");
    expect(v.ok).toBe(false);
    expect(v.coverage ?? 1).toBeLessThan(MIN_COVERAGE);
  });
  it("still accepts an exact operator match", () => {
    expect(verifyCandidate("count != limit", "count != limit").ok).toBe(true);
  });
});

describe("htmlToMarkdown (ADR-004, AC-023)", () => {
  it("converts ChatGPT's nested code block with header label into a fenced block with language", () => {
    const html = `<div class="markdown"><h1>Bridge Smoke Test</h1><p>request id: <code>abc-12345678</code></p>
<pre><div><div><div><svg></svg>TypeScript</div><div><button aria-label="コピーする"></button></div></div>
<div id="code-block-viewer"><pre><code><span>function</span><span> hello_bridge() {\n  console.log("hello");\n}</span></code></pre></div></div></pre></div>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("# Bridge Smoke Test");
    expect(md).toContain("`abc-12345678`");
    expect(md).toMatch(
      /```typescript\nfunction hello_bridge\(\) \{\n {2}console\.log\("hello"\);\n\}\n```/,
    );
    expect(md).not.toMatch(/\nTypeScript\n/);
  });
  it("keeps language classes, tables, KaTeX and lists", () => {
    const html = `<div><pre><code class="language-python">print(1)</code></pre>
<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
<p>inline <span class="katex"><span class="katex-mathml"><math><semantics><mrow></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span></span> math</p>
<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul></div>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("```python\nprint(1)\n```");
    expect(md).toMatch(/\| a \| b \|/);
    expect(md).toContain("$x^2$");
    expect(md).toMatch(/-\s+one\n-\s+two\n\s+-\s+nested/);
  });
  it("preserves verbatim code, UI noise, multiple blocks, and a safe fence length", () => {
    const source = `def _lookup(items):\n    value = items[0]\n    return value === ${"```"}tick${"```"} and _name\n`;
    const html = `<p>nested <code>inline_code</code></p><pre><div>Python</div><button>Copy code</button><pre><code class="language-python">${source}</code></pre></pre><pre><code>  second = [2]</code></pre>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("````python");
    expect(md).toContain(source);
    expect(md).toContain("nested `inline_code`");
    expect(md).toContain("  second = [2]");
    expect(md).not.toContain("Copy code");
    expect(md).not.toMatch(/\\[[_=]/);
  });
  it("keeps a 30KB code block as one fenced block", () => {
    const source = "    _value = values[0]\n".repeat(1_500);
    const md = htmlToMarkdown(`<pre><code class="language-python">${source}</code></pre>`);
    expect(md).toContain(source);
    expect(md.match(/^```/gm) ?? []).toHaveLength(2);
  });
  it("fences a CodeMirror line-element viewer without paragraphising its lines", () => {
    const html = `<div class="cm-content"><div class="cm-line">def _lookup(items):</div><div class="cm-line">    value = items[0]</div><div class="cm-line">    return value</div></div>`;
    expect(htmlToMarkdown(html)).toBe(
      "```\ndef _lookup(items):\n    value = items[0]\n    return value\n```",
    );
  });
  it("also recognises a conservative container with multiple cm-line children", () => {
    const html = `<section><div class="cm-line">if ready:</div><div class="cm-line">\treturn _value</div></section>`;
    expect(htmlToMarkdown(html)).toContain("```\nif ready:\n\treturn _value\n```");
  });
});

describe("extraction structure and completeness (A2/A4)", () => {
  const source = "def _lookup(items):\n    value = items[0]\n    return value == _name\n";
  const html = `<pre><div>Python</div><button>Copy code</button><pre><code class="language-python">${source}</code></pre></pre><pre><code>  second = [2]</code></pre>`;
  const good = `\`\`\`python\n${source}\`\`\`\n\n\`\`\`\n  second = [2]\n\`\`\``;

  it("accepts matching multiple DOM code blocks", () => {
    expect(verifyStructure(good, html)).toEqual({ ok: true, reason: "ok" });
  });
  it("rejects lost indentation, punctuation escaping, and unclosed fences", () => {
    expect(verifyStructure(good.replace(/ {4}/g, ""), html).ok).toBe(false);
    expect(verifyStructure(good.replace("_lookup", "\\_lookup"), html).ok).toBe(false);
    expect(verifyStructure(good.replace(/\n```$/, ""), html).reason).toContain("unclosed");
  });
  it("warns only for conservative truncation signals", () => {
    const truncated = `${"A complete sentence. ".repeat(50)}${"This answer stops mid sentence ".repeat(2)}`;
    expect(verifyCompleteness(truncated).ok).toBe(false);
    expect(verifyCompleteness("A normal short answer without a period")).toEqual({
      ok: true,
      reason: "ok",
    });
    expect(verifyCompleteness("- short list item")).toEqual({ ok: true, reason: "ok" });
    expect(verifyCompleteness("https://example.test/path")).toEqual({ ok: true, reason: "ok" });
    const long = "Complete prose. ".repeat(100);
    expect(verifyCompleteness(`${long}\n以上で完了`)).toEqual({ ok: true, reason: "ok" });
    expect(verifyCompleteness(`${long}\n| value | status |`)).toEqual({ ok: true, reason: "ok" });
    expect(verifyCompleteness(`${long}\n## Closing heading`)).toEqual({ ok: true, reason: "ok" });
    expect(verifyCompleteness("```python\nvalue = _name").reason).toContain("unclosed");
    expect(verifyCompleteness(`${"long prose. ".repeat(100)}\n\`\`\`\ncode\n\`\`\``)).toEqual({
      ok: true,
      reason: "ok",
    });
  });
  it("A2b detects the real flattened code-viewer candidate against preserved innerText", () => {
    const broken = readFileSync(
      new URL("../fixtures/broken-code-viewer-response.md", import.meta.url),
      "utf8",
    );
    const reference = `Python
def _lookup(items):
    value = items[0]
    result = _normalise(value)
    if result == _name:
        return [result]
    for item in items:
        if item.startswith("a"):
            return [item]
    return []`;
    const result = verifyWhitespaceStructure(broken, reference);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("leading indentation");
  });
  it("A2b leaves ordinary prose, lists, and properly fenced code full", () => {
    const prose = "First paragraph.\n\nSecond paragraph.";
    const list = "- one\n- two\n  - nested";
    const code =
      "```python\ndef _lookup(items):\n    value = items[0]\n    if value:\n        return value\n    return None\n```";
    expect(verifyWhitespaceStructure(prose, prose)).toEqual({ ok: true, reason: "ok" });
    expect(verifyWhitespaceStructure(list, list)).toEqual({ ok: true, reason: "ok" });
    expect(verifyWhitespaceStructure(code, code)).toEqual({ ok: true, reason: "ok" });
  });
  it("A2b detects collapsed lines and paragraph inflation without treating escaped prose as loss", () => {
    const shortLines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    expect(verifyWhitespaceStructure("x".repeat(3_001), shortLines).reason).toContain("collapsed");

    const rawProse = "snake_case_names x = y [links](u) *emphasis*";
    const escapedProse = "snake\\_case\\_names x \\= y \\[links](u) \\*emphasis\\*";
    expect(verifyWhitespaceStructure(escapedProse, rawProse)).toEqual({ ok: true, reason: "ok" });

    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    expect(verifyWhitespaceStructure(lines.join("\n\n"), lines.join("\n")).reason).toContain(
      "paragraph inflation",
    );
  });
  it("flags the saved truncated response tail", () => {
    const tail = readFileSync(
      new URL("../fixtures/truncated-response-tail.md", import.meta.url),
      "utf8",
    );
    expect(tail.length).toBeGreaterThan(800);
    expect(verifyCompleteness(tail)).toEqual({
      ok: false,
      reason: "long answer ends without terminal punctuation or closing structure",
    });
  });
  it("keeps ordinary escaped Markdown prose full after HTML conversion", () => {
    const html = `<h2>Summary</h2><p>Use snake_case_names when <code>x = y</code> and see <a href="u">links</a> with <em>emphasis</em>.</p><table><thead><tr><th>name</th><th>value</th></tr></thead><tbody><tr><td>alpha</td><td>1</td></tr></tbody></table><ul><li>first item</li><li>second item</li></ul>`;
    const markdown = htmlToMarkdown(html);
    const innerText =
      "Summary\n\nUse snake_case_names when x = y and see links with emphasis.\n\nname\tvalue\nalpha\t1\n\nfirst item\nsecond item";
    expect(markdown).toContain("snake\\_case\\_names");
    expect(markdown).toContain("x = y");
    expect(verifyCandidate(markdown, innerText).ok).toBe(true);
    expect(verifyStructure(markdown, html)).toEqual({ ok: true, reason: "ok" });
    expect(verifyWhitespaceStructure(markdown, innerText)).toEqual({ ok: true, reason: "ok" });
    expect(verifyCompleteness(markdown)).toEqual({ ok: true, reason: "ok" });
  });
});
