/**
 * 21 §2 / A-068: context bundle — turns a local repository slice into one Markdown document (tree +
 * fenced file contents [+ git diff]) that can be pasted into prompt.md or attached. ChatGPT Web cannot
 * read local files, so this is how a repository reaches it. The same secret guard as attachments
 * applies: a single offending file refuses the whole bundle (names only in the error).
 */
import { execFile } from "node:child_process";
import { glob, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { containsSecret } from "../diagnostics/redact.js";

const execFileAsync = promisify(execFile);

export interface BundleOptions {
  root: string;
  include: string[];
  exclude: string[];
  maxBytes: number;
  /** git ref to diff against (e.g. "HEAD~1" or "main"); omitted = no diff section. */
  diffRef?: string;
}

export const DEFAULT_EXCLUDES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/runtime/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.kdbx",
  "**/id_rsa*",
  "**/*.lock",
  "**/package-lock.json",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.webp",
  "**/*.ico",
  "**/*.zip",
  "**/*.gz",
  "**/*.pdf",
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
  "**/*.exe",
  "**/*.dll",
  "**/*.so",
  "**/*.dylib",
  "**/*.bin",
];

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".md": "markdown",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".sh": "bash",
  ".ps1": "powershell",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".html": "html",
  ".css": "css",
  ".xml": "xml",
};

export interface BundleFile {
  path: string;
  bytes: number;
}

export interface BundleResult {
  markdown: string;
  included: BundleFile[];
  omitted: BundleFile[];
  totalBytes: number;
}

function fenceFor(text: string): string {
  let longest = 3;
  for (const m of text.matchAll(/`{3,}/g)) longest = Math.max(longest, m[0].length + 1);
  return "`".repeat(longest);
}

function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function listFiles(opts: BundleOptions): Promise<string[]> {
  const root = resolve(opts.root);
  const exclude = [...DEFAULT_EXCLUDES, ...opts.exclude];
  const found = new Set<string>();
  for (const pattern of opts.include.length > 0 ? opts.include : ["**/*"]) {
    for await (const entry of glob(pattern, { cwd: root, exclude, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const abs = resolve(entry.parentPath, entry.name);
      found.add(relative(root, abs).split(sep).join("/"));
    }
  }
  return [...found].sort();
}

export async function buildBundle(
  opts: BundleOptions,
): Promise<{ ok: true; result: BundleResult } | { ok: false; errors: string[] }> {
  const root = resolve(opts.root);
  const files = await listFiles(opts);
  const errors: string[] = [];
  const included: BundleFile[] = [];
  const omitted: BundleFile[] = [];
  const sections: string[] = [];
  let total = 0;
  for (const rel of files) {
    const abs = resolve(root, rel);
    const st = await stat(abs);
    if (st.size === 0) continue;
    const buf = await readFile(abs);
    if (isProbablyBinary(buf)) continue;
    const text = buf.toString("utf8");
    if (containsSecret(text)) {
      errors.push(`${rel}: content matches a secret pattern`);
      continue;
    }
    if (total + st.size > opts.maxBytes) {
      omitted.push({ path: rel, bytes: st.size });
      continue;
    }
    total += st.size;
    included.push({ path: rel, bytes: st.size });
    const fence = fenceFor(text);
    const lang = LANG_BY_EXT[extname(rel).toLowerCase()] ?? "";
    sections.push(
      `### ${rel}\n\n${fence}${lang}\n${text.replace(/\r\n/g, "\n").replace(/\n?$/, "\n")}${fence}\n`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };

  let diffSection = "";
  if (opts.diffRef) {
    try {
      // user excludes also narrow the diff (":(glob,exclude)<pattern>" pathspecs)
      const pathspecs = [".", ...opts.exclude.map((g) => `:(glob,exclude)${g}`)];
      const { stdout } = await execFileAsync(
        "git",
        ["-C", root, "diff", opts.diffRef, "--", ...pathspecs],
        { maxBuffer: 50 * 1024 * 1024 },
      );
      if (containsSecret(stdout))
        return { ok: false, errors: ["git diff: content matches a secret pattern"] };
      const fence = fenceFor(stdout);
      diffSection = `\n## git diff ${opts.diffRef}\n\n${fence}diff\n${stdout.replace(/\n?$/, "\n")}${fence}\n`;
    } catch (err) {
      return { ok: false, errors: [`git diff failed: ${(err as Error).message}`] };
    }
  }

  const tree = files.map((f) => `- ${f}`).join("\n");
  const omittedNote =
    omitted.length > 0
      ? `\n> ${omitted.length} file(s) omitted to stay under ${opts.maxBytes} bytes: ${omitted.map((o) => o.path).join(", ")}\n`
      : "";
  const markdown = `# Context bundle\n\nroot: \`${root.split(sep).join("/")}\`\nfiles: ${included.length} included, ${omitted.length} omitted, ${total} bytes\n${omittedNote}\n## Tree\n\n${tree}\n\n## Files\n\n${sections.join("\n")}${diffSection}`;
  return { ok: true, result: { markdown, included, omitted, totalBytes: total } };
}
