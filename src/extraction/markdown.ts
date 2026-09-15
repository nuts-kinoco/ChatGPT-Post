import TurndownService from "turndown";
// @ts-expect-error turndown-plugin-gfm ships no types
import { gfm } from "turndown-plugin-gfm";

let service: TurndownService | undefined;

function build(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    bulletListMarker: "-",
    emDelimiter: "*",
  });
  td.use(gfm);

  // KaTeX: prefer the TeX source stored in <annotation encoding="application/x-tex">
  td.addRule("katex", {
    filter: (node) =>
      node.nodeName === "SPAN" && (node as HTMLElement).classList?.contains("katex"),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
      const tex = annotation?.textContent?.trim();
      if (!tex) return el.textContent ?? "";
      const display = el.closest(".katex-display") !== null;
      return display ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
    },
  });

  // <pre><code class="language-xxx"> -> fenced block with language
  td.addRule("fencedWithLanguage", {
    // ChatGPT nests <pre><code> inside an outer <pre> that also holds the language header + copy button.
    // Handle the outermost <pre> only so the header is not emitted as prose.
    filter: (node) =>
      node.nodeName === "PRE" &&
      (node as HTMLElement).querySelector("code") !== null &&
      (node as HTMLElement).parentElement?.closest("pre") == null,
    replacement: (_content, node) => {
      const pre = node as HTMLElement;
      const code = pre.querySelector("code");
      const cls = code?.getAttribute("class") ?? "";
      let lang = /language-([A-Za-z0-9_+#-]+)/.exec(cls)?.[1] ?? "";
      const text = code?.textContent ?? "";
      if (!lang) {
        // ChatGPT renders the language as a header label inside <pre> (outside <code>)
        const header = (pre.textContent ?? "")
          .replace(text, "")
          .replace(/コピーする|Copy code|Copy/g, "")
          .trim();
        if (header && header.length <= 30 && !/\s/.test(header)) lang = header.toLowerCase();
      }
      const fence = text.includes("```") ? "````" : "```";
      return `\n\n${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}\n\n`;
    },
  });
  return td;
}

/** DOM (HTML string) -> Markdown. Throws on conversion failure so callers can degrade. */
export function htmlToMarkdown(html: string): string {
  service ??= build();
  return service.turndown(html).trim();
}
