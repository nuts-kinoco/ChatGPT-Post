import { execSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yazl from "yazl";
import { checkProfilePath } from "../../src/browser/profile-guard.js";
import {
  reduceNetworkLine,
  sanitizeEntries,
  sanitizeTraceZip,
} from "../../src/browser/trace-sanitizer.js";
import { REPO_ROOT } from "../../src/contracts/schema.js";
import {
  FORBIDDEN_CODE_TOKENS,
  FORBIDDEN_PACKAGES,
  SECRET_PATTERNS,
} from "../../src/diagnostics/forbidden-tokens.js";
import { containsSecret, redact, redactSecrets } from "../../src/diagnostics/redact.js";

describe("redact (SEC-005, 15 §4)", () => {
  it("masks bearer, cookie/authorization headers, sk- keys, __Secure- cookies, JWT, url query/fragment", () => {
    const input = [
      "Authorization: Bearer abc.def-ghi",
      "cookie: __Secure-next-auth.session-token=xyz; other=1",
      "key sk-ABCDEFGHIJKLMNOP",
      "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig",
      "https://auth.openai.com/cb?code=SECRET&state=1#access_token=TOK",
    ].join("\n");
    const out = redactSecrets(input);
    expect(out).not.toMatch(/abc\.def-ghi|xyz|ABCDEFGHIJKLMNOP|eyJhbGci|SECRET|TOK/);
    expect(out).toMatch(/Authorization: \[REDACTED\]/);
    expect(out).toMatch(/https:\/\/auth\.openai\.com\/cb\?…/);
    expect(containsSecret(input)).toBe(true);
    expect(containsSecret(out)).toBe(false);
    expect(containsSecret("We use cookies to improve")).toBe(false);
  });
  it("truncates to 200 chars with a length suffix", () => {
    const long = "x".repeat(500);
    const r = redact(long);
    expect(r.startsWith("x".repeat(200))).toBe(true);
    expect(r).toMatch(/…\(500 chars\)$/);
  });
});

describe("trace sanitizer (SEC-010, 15 §3)", () => {
  function line(url: string, mime: string, sha1: string): string {
    return JSON.stringify({
      type: "resource-snapshot",
      snapshot: {
        request: {
          url,
          method: "GET",
          headers: [{ name: "cookie", value: "__Secure-a=b" }],
          postData: { text: "secret" },
        },
        response: {
          status: 200,
          headers: [{ name: "set-cookie", value: "x=y" }],
          content: { mimeType: mime, _sha1: sha1 },
        },
      },
    });
  }
  it("reduces network lines and classifies resources", () => {
    const allowed = new Set<string>();
    const dropped = new Set<string>();
    const css = reduceNetworkLine(
      line("https://chatgpt.com/a.css?v=1#f", "text/css", "aaa"),
      allowed,
      dropped,
    );
    const html = reduceNetworkLine(
      line("https://chatgpt.com/", "text/html", "bbb"),
      allowed,
      dropped,
    );
    expect(css).not.toMatch(/cookie|__Secure|secret|\?v=1/);
    expect(JSON.parse(css ?? "{}").snapshot.request.url).toBe("https://chatgpt.com/a.css");
    expect(html).not.toMatch(/_sha1/);
    expect(allowed.has("aaa")).toBe(true);
    expect(dropped.has("bbb")).toBe(true);
  });
  it("keeps css/fonts/screencast, drops html/json, redacts trace.trace, leaves 'cookies' prose", async () => {
    const entries = new Map<string, Buffer>([
      [
        "trace.network",
        Buffer.from(
          `${line("https://chatgpt.com/a.css", "text/css", "aaa")}\n${line("https://chatgpt.com/", "text/html", "bbb")}\n${line("https://chatgpt.com/api", "application/json", "ccc")}\n`,
        ),
      ],
      ["resources/aaa.css", Buffer.from("body{}")],
      [
        "resources/bbb.html",
        Buffer.from('<script>{"accessToken":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y"}</script>'),
      ],
      ["resources/ccc.json", Buffer.from("{}")],
      ["resources/ddd.jpeg", Buffer.from("jpg")],
      // Codex P4-High-2: not in .network, not referenced by .trace -> must be dropped whatever the extension
      ["resources/unknown.css", Buffer.from("/* Authorization: Bearer secret */")],
      ["resources/unknown.svg", Buffer.from("<svg/>")],
      ["resources/unknown.png", Buffer.from("png")],
      [
        "trace.trace",
        Buffer.from(
          '{"type":"frame-snapshot","html":"We use cookies to improve"}\n{"type":"x","url":"https://a.b/c?token=1"}\n{"type":"y","text":"Bearer abcdef"}\n{"type":"screencast-frame","sha1":"ddd.jpeg","pageId":"p1"}\n',
        ),
      ],
      // A-126 (Phase 0-C-5, ChatGPT Pro redesign review §2.15): a hypothetical future entry type
      // that is none of .network / resources/* / a known TEXT_ENTRY suffix. Before the fix, this
      // fell through to an unconditional pass-through and carried its secret unredacted.
      ["trace-metadata.json", Buffer.from('{"note":"Bearer abcdefghijklmnop"}\n')],
      ["trace-thumbnail.dat", Buffer.from([0x00, 0x01, 0x02, 0x03])], // genuinely binary: kept as-is
    ]);
    const { out, report } = await sanitizeEntries(entries);
    expect(out.has("resources/aaa.css")).toBe(true);
    expect(out.has("resources/ddd.jpeg")).toBe(true);
    expect(out.has("resources/bbb.html")).toBe(false);
    expect(out.has("resources/ccc.json")).toBe(false);
    expect(out.has("resources/unknown.css")).toBe(false);
    expect(out.has("resources/unknown.svg")).toBe(false);
    expect(out.has("resources/unknown.png")).toBe(false);
    const trace = out.get("trace.trace")?.toString("utf8") ?? "";
    expect(trace).toMatch(/We use cookies to improve/);
    expect(trace).not.toMatch(/token=1|Bearer abcdef/);
    expect(report.resourcesDropped).toBe(5);
    expect(report.textLinesRedacted).toBe(3); // 2 in trace.trace + 1 in the unknown text entry
    const net = out.get("trace.network")?.toString("utf8") ?? "";
    expect(net).not.toMatch(/headers|postData|__Secure/);
    expect(out.get("trace-metadata.json")?.toString("utf8")).not.toMatch(/Bearer abcdefghijklmnop/);
    expect(out.get("trace-thumbnail.dat")).toEqual(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    for (const [, buf] of out) expect(containsSecret(buf.toString("utf8"))).toBe(false);
  });
  it("round-trips through a real zip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-trace-"));
    try {
      const zip = new yazl.ZipFile();
      zip.addBuffer(Buffer.from('{"type":"y","text":"Bearer abcdef"}\n'), "trace.trace");
      zip.addBuffer(Buffer.from("x"), "resources/zzz.html");
      zip.addBuffer(Buffer.from("y"), "resources/orphan.jpeg");
      zip.end();
      const inPath = join(dir, "in.zip");
      await new Promise<void>((res, rej) => {
        zip.outputStream
          .pipe(createWriteStream(inPath))
          .on("close", () => res())
          .on("error", rej);
      });
      const outPath = join(dir, "sub", "out.zip");
      const report = await sanitizeTraceZip(inPath, outPath);
      expect((await stat(outPath)).size).toBeGreaterThan(0);
      expect(report.resourcesDropped).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("profile guard (FR-015, Codex F-01)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-profile-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("rejects regular User Data roots (case-insensitive, nested)", async () => {
    const env = { LOCALAPPDATA: join(dir, "Local"), APPDATA: join(dir, "Roaming") };
    await mkdir(join(env.LOCALAPPDATA, "Google", "Chrome", "User Data", "Default"), {
      recursive: true,
    });
    expect(
      (await checkProfilePath(join(env.LOCALAPPDATA, "google", "chrome", "user data"), env)).ok,
    ).toBe(false);
    expect(
      (
        await checkProfilePath(
          join(env.LOCALAPPDATA, "Google", "Chrome", "User Data", "Default"),
          env,
        )
      ).ok,
    ).toBe(false);
    expect((await checkProfilePath(join(dir, "runtime", "profile"), env)).ok).toBe(true);
  });
  it("rejects a junction / symlink that points at User Data (Windows)", async () => {
    if (process.platform !== "win32") return;
    const env = { LOCALAPPDATA: join(dir, "Local"), APPDATA: join(dir, "Roaming") };
    const target = join(env.LOCALAPPDATA, "Google", "Chrome", "User Data");
    await mkdir(target, { recursive: true });
    const link = join(dir, "innocent");
    try {
      execSync(`cmd /c mklink /J "${link}" "${target}"`, { stdio: "ignore" });
    } catch {
      return; // junction creation not permitted in this environment
    }
    const v = await checkProfilePath(link, env);
    expect(v.ok).toBe(false);
    expect(v.ok ? "" : v.cause).toMatch(/symlink|junction/);
    const nested = await checkProfilePath(join(link, "sub"), env);
    expect(nested.ok).toBe(false);
  });
});

describe("forbidden tokens / packages / secrets (AC-029)", () => {
  async function walk(d: string, out: string[] = []): Promise<string[]> {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, out);
      else if (/\.(ts|js|json|html)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  it("src/** and tests/fixtures/** contain no forbidden tokens or secret-looking content", async () => {
    const files = [...(await walk(join(REPO_ROOT, "src")))];
    try {
      files.push(...(await walk(join(REPO_ROOT, "tests", "fixtures"))));
    } catch {
      /* no fixtures yet */
    }
    const violations: string[] = [];
    for (const f of files) {
      if (f.endsWith("forbidden-tokens.ts") || f.endsWith("redact.ts")) continue;
      const text = await readFile(f, "utf8");
      for (const { token, reason } of FORBIDDEN_CODE_TOKENS)
        if (text.includes(token)) violations.push(`${f}: ${token} (${reason})`);
      for (const { name, re } of SECRET_PATTERNS)
        if (re.test(text)) violations.push(`${f}: secret pattern ${name}`);
    }
    expect(violations).toEqual([]);
  });
  it("package.json has no forbidden packages", async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const n of names)
      for (const f of FORBIDDEN_PACKAGES) expect(n.startsWith(f) || n === f).toBe(false);
  });
});
