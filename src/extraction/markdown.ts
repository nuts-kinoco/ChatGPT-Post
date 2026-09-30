import TurndownService from "turndown";
// @ts-expect-error turndown-plugin-gfm ships no types
import { gfm } from "turndown-plugin-gfm";

let service: TurndownService | undefined;

// Turndown collapses ordinary text-node whitespace before custom rules run. Protect only leading
// whitespace in recognised CodeMirror line elements so the code-viewer rule can restore it.
const CODE_INDENT_SPACE = "\uE000";
const CODE_INDENT_TAB = "\uE001";

function protectCodeViewerIndentation(html: string): string {
  return html.replace(
    /(<[A-Za-z][^>]*\bclass=(?:"[^"]*cm-line[^"]*"|'[^']*cm-line[^']*'|[^\s>]*cm-line[^\s>][^>]*)[^>]*>)([ \t]+)/g,
    (_match, opening: string, indentation: string) =>
      `${opening}${indentation
        .replaceAll(" ", CODE_INDENT_SPACE)
        .replaceAll("\t", CODE_INDENT_TAB)}`,
  );
}

function restoreCodeViewerWhitespace(text: string): string {
  return text.replaceAll(CODE_INDENT_SPACE, " ").replaceAll(CODE_INDENT_TAB, "\t");
}

function codeViewerLines(node: HTMLElement): HTMLElement[] {
  const matchesLine = (child: Element) =>
    child.classList.contains("cm-line") ||
    child.getAttribute("class")?.includes("cm-line") === true;
  if (node.classList.contains("cm-content")) {
    return Array.from(node.querySelectorAll<HTMLElement>(".cm-line, [class*='cm-line']"));
  }
  const direct = Array.from(node.children).filter(matchesLine) as HTMLElement[];
  return direct.length >= 2 ? direct : [];
}

function fenceFor(text: string): string {
  const longestBacktickRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

function build(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    bulletListMarker: "-",
    emDelimiter: "*",
  });
  td.use(gfm);

  // Some code viewers (notably CodeMirror) render one block element per source line instead of a
  // <pre><code>. Join only recognised line children, before Turndown can turn them into paragraphs.
  td.addRule("lineElementCodeViewer", {
    filter: (node) => {
      if (node.nodeType !== 1) return false;
      const el = node as HTMLElement;
      if (codeViewerLines(el).length === 0) return false;
      const parent = el.parentElement;
      return parent === null || codeViewerLines(parent).length === 0;
    },
    replacement: (_content, node) => {
      const text = codeViewerLines(node as HTMLElement)
        .map((line) => restoreCodeViewerWhitespace(line.textContent ?? ""))
        .join("\n");
      const fence = fenceFor(text);
      return `\n\n${fence}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}\n\n`;
    },
  });

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
      // `textContent` is deliberately used without Turndown's normal escaping or paragraph
      // handling: code is data, including its leading spaces and newlines.
      const fence = fenceFor(text);
      return `\n\n${fence}${lang}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}\n\n`;
    },
  });
  return td;
}

/** DOM (HTML string) -> Markdown. Throws on conversion failure so callers can degrade. */
export function htmlToMarkdown(html: string): string {
  service ??= build();
  return restoreCodeViewerWhitespace(service.turndown(protectCodeViewerIndentation(html)).trim());
}
