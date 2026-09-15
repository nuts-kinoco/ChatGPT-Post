import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export class AtomicWriteError extends Error {
  constructor(
    public readonly target: string,
    public override readonly cause: unknown,
  ) {
    super(`atomic write failed for ${basename(target)}`);
    this.name = "AtomicWriteError";
  }
}

export interface AtomicWriteOptions {
  /** Injected for tests; defaults to a random suffix. */
  tmpSuffix?: string;
  /** Windows: retry rename once after this delay when EPERM (file open elsewhere). */
  epermRetryDelayMs?: number;
  /** Test hook invoked between the temp write and the rename. */
  beforeRename?: (tmpPath: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * tmp -> fsync -> rename in the same directory (FR-013). Content is written as UTF-8 without BOM.
 */
export async function atomicWriteFile(
  target: string,
  content: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const suffix = opts.tmpSuffix ?? `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const tmp = join(dir, `${basename(target)}.tmp-${suffix}`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, content, null, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    opts.beforeRename?.(tmp);
    try {
      renameSync(tmp, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY") {
        await sleep(opts.epermRetryDelayMs ?? 200);
        renameSync(tmp, target);
      } else {
        throw err;
      }
    }
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw new AtomicWriteError(target, err);
  }
}

/** Normalise a Markdown body for response.md: strip trailing whitespace/newlines, append one LF (FR-012). */
export function normaliseResponseBody(markdown: string): string {
  const BOM = String.fromCharCode(0xfeff);
  return `${markdown.split(BOM).join("").replace(/\s+$/u, "")}\n`;
}
