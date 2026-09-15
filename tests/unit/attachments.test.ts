import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAttachments, uploadBudgetMs } from "../../src/contracts/attachments.js";

describe("attachment guard (A-068, SEC)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-att-"));
    await writeFile(join(dir, "ok.ts"), "export const x = 1;\n");
    await writeFile(join(dir, "notes.md"), "# notes\n");
    await writeFile(join(dir, ".env"), "API=1\n");
    await writeFile(join(dir, "server.pem"), "-----BEGIN-----\n");
    await writeFile(join(dir, "leaky.json"), '{"auth":"Bearer abcdefghijklmnop"}\n');
    await writeFile(join(dir, "empty.txt"), "");
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "node_modules", "x", "index.js"), "x\n");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "ok.ts"), "dup\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts ordinary source files and resolves relative paths", async () => {
    const r = await checkAttachments(["ok.ts", join(dir, "notes.md")], dir);
    expect(r.ok).toBe(true);
    expect(r.paths).toEqual([join(dir, "ok.ts"), join(dir, "notes.md")]);
  });
  it("omitted attachments are fine", async () => {
    expect((await checkAttachments(undefined, dir)).ok).toBe(true);
  });
  it("refuses secret-looking names, extensions, directories, contents, empties, duplicates, missing", async () => {
    const r = await checkAttachments(
      [
        ".env",
        "server.pem",
        "node_modules/x/index.js",
        "leaky.json",
        "empty.txt",
        "ok.ts",
        "sub/ok.ts",
        "missing.txt",
      ],
      dir,
    );
    expect(r.ok).toBe(false);
    expect(r.paths).toEqual([]);
    const joined = r.errors.join("\n");
    expect(joined).toMatch(/\.env.*deny-list/);
    expect(joined).toMatch(/server\.pem.*deny-list/);
    expect(joined).toMatch(/index\.js.*denied directory/);
    expect(joined).toMatch(/leaky\.json.*secret pattern/);
    expect(joined).toMatch(/empty\.txt.*empty/);
    expect(joined).toMatch(/sub.*ok\.ts|attachments\/6.*duplicate/);
    expect(joined).toMatch(/missing\.txt.*cannot be read/);
    expect(joined).not.toMatch(/Bearer abcdefghijklmnop/); // never echo contents
  });
  it("scans by content regardless of extension and refuses symlinks (Codex P5-1)", async () => {
    await writeFile(join(dir, "report.pdf"), "Authorization: Bearer abcdefghijklmnop\n");
    const spoof = await checkAttachments(["report.pdf"], dir);
    expect(spoof.ok).toBe(false);
    expect(spoof.errors.join()).toMatch(/report\.pdf.*secret pattern/);
    await writeFile(join(dir, "real.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    expect((await checkAttachments(["real.png"], dir)).ok).toBe(true);
    try {
      await symlink(join(dir, ".env"), join(dir, "link.txt"), "file");
      const l = await checkAttachments(["link.txt"], dir);
      expect(l.ok).toBe(false);
      expect(l.errors.join()).toMatch(/link\.txt.*symbolic/);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err; // no symlink privilege
    }
  });
  it("rejects non-string entries and too many files", async () => {
    expect((await checkAttachments([1], dir)).ok).toBe(false);
    expect((await checkAttachments(new Array(21).fill("ok.ts"), dir)).ok).toBe(false);
  });
  it("upload budget grows with size", () => {
    expect(uploadBudgetMs(0)).toBe(60_000);
    expect(uploadBudgetMs(3 * 1024 * 1024)).toBe(105_000);
  });
});
