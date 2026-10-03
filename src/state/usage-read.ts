/** Bounded reads for local lifecycle evidence, before allocation or JSON parsing. */
import { open } from "node:fs/promises";
export const USAGE_BINDING_MAX_BYTES = 16 * 1024;
export const USAGE_MARKER_MAX_BYTES = 256 * 1024;
export const USAGE_RESULT_MAX_BYTES = 2 * 1024 * 1024;
export async function readBoundedUsageText(path: string, maximum: number): Promise<string> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > USAGE_RESULT_MAX_BYTES)
    throw new Error("usage_read_limit_invalid");
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximum)
      throw new Error("usage_evidence_oversized_or_invalid");
    // One extra byte detects growth after stat without reading an unbounded replacement file.
    const bytes = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size <= maximum) {
      const chunk = await file.read(bytes, size, bytes.length - size, null);
      if (chunk.bytesRead === 0) break;
      size += chunk.bytesRead;
    }
    if (size > maximum) throw new Error("usage_evidence_oversized_or_invalid");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, size),
    );
  } finally {
    await file.close();
  }
}
