import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeOutputRoot, writeNewFile } from "../../src/archive/paths.js";

const faults = vi.hoisted(() => ({
  write: null as null | ((...args: unknown[]) => number),
  sync: null as null | ((fd: number) => void),
  read: null as null | ((...args: unknown[]) => number),
  unlink: null as null | (() => never),
  writes: 0,
  syncs: 0,
  closed: [] as number[],
}));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeSync: (...args: unknown[]) => {
      faults.writes++;
      return faults.write ? faults.write(...args) : Reflect.apply(real.writeSync, real, args);
    },
    fsyncSync: (fd: number) => {
      faults.syncs++;
      if (faults.sync) faults.sync(fd);
      else real.fsyncSync(fd);
    },
    readSync: (...args: unknown[]) =>
      faults.read ? faults.read(...args) : Reflect.apply(real.readSync, real, args),
    unlinkSync: (path: string) => {
      if (faults.unlink) faults.unlink();
      else real.unlinkSync(path);
    },
    closeSync: (fd: number) => {
      faults.closed.push(fd);
      real.closeSync(fd);
    },
  };
});
const real = await vi.importActual<typeof import("node:fs")>("node:fs");
const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "archive-write-progress-"));
  roots.push(path);
  return path;
}
function shortWrite(args: unknown[], count: number): number {
  const [fd, data, offset = 0] = args;
  const bytes = typeof data === "string" ? Buffer.from(data) : (data as Uint8Array);
  return real.writeSync(fd as number, bytes, offset as number, count);
}
afterEach(() => {
  faults.write = null;
  faults.sync = null;
  faults.read = null;
  faults.unlink = null;
  faults.writes = 0;
  faults.syncs = 0;
  faults.closed.length = 0;
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("archive write progress and probe readback", () => {
  it("writes exact bytes through repeated positive short writes, then syncs and closes", () => {
    const path = join(root(), "bytes.bin"),
      bytes = Buffer.from("abcdefg");
    faults.write = (...args) => shortWrite(args, Math.min(2, args[3] as number));
    writeNewFile(path, bytes);
    expect(readFileSync(path)).toEqual(bytes);
    expect(faults.writes).toBe(4);
    expect(faults.syncs).toBe(1);
    expect(faults.closed).toHaveLength(1);
  });
  it.each([0, -1, Number.NaN, 0.5, 99])(
    "rejects nonprogress/invalid byte count %s before another write",
    (count) => {
      const path = join(root(), "bytes.bin");
      faults.write = () => {
        // Bound the old buggy loop without relying on a timer that synchronous I/O would block.
        if (faults.writes > 1) throw new Error("unexpected_second_write");
        return count;
      };
      expect(() => writeNewFile(path, Buffer.from("abc"))).toThrow(
        "archive_write_verification_failed",
      );
      expect(faults.writes).toBe(1);
      expect(faults.syncs).toBe(0);
      expect(faults.closed).toHaveLength(1);
    },
  );
  it("rejects zero progress after a partial write and closes the descriptor", () => {
    const path = join(root(), "bytes.bin");
    faults.write = (...args) => {
      if (faults.writes === 1) return shortWrite(args, 2);
      if (faults.writes === 2) return 0;
      throw new Error("unexpected_third_write");
    };
    expect(() => writeNewFile(path, Buffer.from("abc"))).toThrow(
      "archive_write_verification_failed",
    );
    expect(readFileSync(path, "utf8")).toBe("ab");
    expect(faults.syncs).toBe(0);
    expect(faults.closed).toHaveLength(1);
  });
  it("probe completes short writes and removes its verified file", () => {
    const path = root();
    faults.write = (...args) => shortWrite(args, Math.min(2, (args[3] as number | undefined) ?? 5));
    expect(probeOutputRoot(path)).toEqual({ writable: true, cleaned: true });
    expect(faults.writes).toBe(3);
    expect(readdirSync(path)).toEqual([]);
  });
  it("probe rejects zero progress and cleans up", () => {
    const path = root();
    faults.write = () => {
      if (faults.writes > 1) throw new Error("unexpected_second_write");
      return 0;
    };
    expect(() => probeOutputRoot(path)).toThrow("archive_write_verification_failed");
    expect(faults.syncs).toBe(0);
    expect(readdirSync(path)).toEqual([]);
  });
  it("probe rejects corrupted readback and cleans up", () => {
    const path = root();
    faults.sync = (fd) => {
      real.fsyncSync(fd);
      real.writeSync(fd, Buffer.from("wrong"), 0, 5, 0);
    };
    expect(() => probeOutputRoot(path)).toThrow("archive_write_verification_failed");
    expect(readdirSync(path)).toEqual([]);
  });
  it.each([3, 7])("probe rejects readback length %s and cleans up", (length) => {
    const path = root();
    faults.sync = (fd) => {
      real.fsyncSync(fd);
      real.ftruncateSync(fd, length);
    };
    expect(() => probeOutputRoot(path)).toThrow("archive_write_verification_failed");
    expect(readdirSync(path)).toEqual([]);
  });
  it("probe reads back through positive short reads", () => {
    const path = root();
    faults.read = (...args) => {
      const [fd, bytes, offset, length, position] = args;
      return real.readSync(
        fd as number,
        bytes as Buffer,
        offset as number,
        Math.min(2, length as number),
        position as number,
      );
    };
    expect(probeOutputRoot(path)).toEqual({ writable: true, cleaned: true });
    expect(readdirSync(path)).toEqual([]);
  });
  it("probe still supports a trusted root that is not owner-only", () => {
    const path = join(root(), "output");
    real.mkdirSync(path, { mode: 0o755 });
    expect(probeOutputRoot(path)).toEqual({ writable: true, cleaned: true });
    expect(readdirSync(path)).toEqual([]);
  });
  it("cleanup failure cannot report cleaned success", () => {
    const path = root(),
      error = Object.assign(new Error("synthetic cleanup fault"), { code: "EIO" });
    faults.unlink = () => {
      throw error;
    };
    expect(() => probeOutputRoot(path)).toThrow(error);
    expect(faults.closed).toHaveLength(1);
    expect(readdirSync(path)).toHaveLength(1);
  });
  it("write exceptions retain their identity and close the descriptor", () => {
    const path = join(root(), "bytes.bin"),
      error = Object.assign(new Error("synthetic write fault"), { code: "ENOSPC" });
    faults.write = () => {
      throw error;
    };
    expect(() => writeNewFile(path, Buffer.from("abc"))).toThrow(error);
    expect(faults.closed).toHaveLength(1);
    expect(faults.syncs).toBe(0);
  });
  it("probe preserves an I/O exception, closes and cleans up", () => {
    const path = root(),
      error = Object.assign(new Error("synthetic disk fault"), { code: "EIO" });
    faults.sync = () => {
      throw error;
    };
    expect(() => probeOutputRoot(path)).toThrow(error);
    expect(faults.closed).toHaveLength(1);
    expect(readdirSync(path)).toEqual([]);
  });
  it("Windows policy fails before any write", () => {
    const path = root();
    expect(() => probeOutputRoot(path, { platform: "win32" })).toThrow(
      "archive_windows_storage_unimplemented",
    );
    expect(() =>
      writeNewFile(join(path, "bytes.bin"), Buffer.from("abc"), { platform: "win32" }),
    ).toThrow("archive_windows_storage_unimplemented");
    expect(faults.writes).toBe(0);
    expect(readdirSync(path)).toEqual([]);
  });
});
