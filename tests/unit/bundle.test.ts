import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBundle } from "../../src/bundle/bundle.js";

describe("bundle (21 §2)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-bundle-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(dir, "src", "b.md"), "# b\n\n```ts\ncode\n```\n");
    await writeFile(join(dir, "node_modules", "x", "i.js"), "x\n");
    await writeFile(join(dir, ".env"), "SECRET=1\n");
    await writeFile(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("includes source, skips node_modules/.env/binaries, fences longer than inner fences", async () => {
    const r = await buildBundle({ root: dir, include: [], exclude: [], maxBytes: 100_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const md = r.result.markdown;
    expect(r.result.included.map((f) => f.path)).toEqual(["src/a.ts", "src/b.md"]);
    expect(md).toContain("### src/a.ts\n\n```typescript\nexport const a = 1;\n```");
    expect(md).toContain("````markdown\n# b");
    expect(md).not.toContain("SECRET=1");
    expect(md).not.toContain("node_modules/x/i.js");
    expect(md).not.toContain("logo.png");
  });
  it("respects include globs and the byte budget (omitted files listed)", async () => {
    const r = await buildBundle({
      root: dir,
      include: ["src/**/*.ts"],
      exclude: [],
      maxBytes: 100_000,
    });
    expect(r.ok && r.result.included.map((f) => f.path)).toEqual(["src/a.ts"]);
    const small = await buildBundle({ root: dir, include: [], exclude: [], maxBytes: 10 });
    expect(small.ok && small.result.omitted.length).toBe(2);
    expect(small.ok && small.result.markdown).toContain("omitted to stay under 10 bytes");
  });
  it("refuses when a file content looks like a secret", async () => {
    await writeFile(join(dir, "src", "c.ts"), 'const t = "Bearer abcdefghijklmnopqrstuvwxyz";\n');
    const r = await buildBundle({ root: dir, include: [], exclude: [], maxBytes: 100_000 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(/src\/c\.ts: content matches a secret pattern/);
    expect(!r.ok && r.errors.join()).not.toMatch(/abcdefghijklmnopqrstuvwxyz/);
  });
});
