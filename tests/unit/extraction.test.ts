import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../../src/extraction/markdown.js";
import { verifyCandidate } from "../../src/extraction/verify.js";

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
});
