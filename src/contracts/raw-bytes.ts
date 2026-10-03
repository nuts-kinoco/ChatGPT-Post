/** Pure raw-byte helpers shared without importing schema loaders. */
import { createHash } from "node:crypto";
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** Protocol limits apply to the original byte sequences, before parsing or hashing. */
export const MAX_TASK_SPEC_BYTES = 256 * 1024;
export const MAX_TASK_FILE_BYTES = 1024 * 1024;

export function decodeStrictUtf8(bytes: Uint8Array, label: string): string {
  if (
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  )
    throw new Error(`${label} must be UTF-8 without a BOM`);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label} contains invalid UTF-8`);
  }
}

/** Parse exactly the supplied UTF-8 bytes. No BOM stripping or normalization occurs. */
export function parseStrictJsonBytes(bytes: Uint8Array): unknown {
  return parseCheckedJsonBytes(bytes, false);
}
/** External provider telemetry may contain fractional durations. Never use this for Bridge wire records. */
export function parseStrictProviderJsonBytes(bytes: Uint8Array): unknown {
  return parseCheckedJsonBytes(bytes, true);
}
function parseCheckedJsonBytes(bytes: Uint8Array, allowFractions: boolean): unknown {
  const source = decodeStrictUtf8(bytes, "JSON");
  // JSON.parse checks grammar; the second pass rejects duplicate decoded member names.
  const parsed: unknown = JSON.parse(source);
  let cursor = 0;
  const whitespace = () => {
    while (source[cursor] !== undefined && /[\x20\t\r\n]/.test(source[cursor] as string)) cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    while (cursor < source.length) {
      const char = source[cursor++];
      if (char === "\\") cursor++;
      else if (char === '"') return JSON.parse(source.slice(start, cursor)) as string;
    }
    throw new Error("Unterminated JSON string");
  };
  const value = (depth: number): void => {
    if (depth > 256) throw new Error("JSON nesting exceeds 256 levels");
    whitespace();
    const char = source[cursor];
    if (char === '"') {
      string();
      return;
    }
    if (char === "{") {
      cursor++;
      whitespace();
      const keys = new Set<string>();
      if (source[cursor] === "}") {
        cursor++;
        return;
      }
      while (cursor < source.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error(`Duplicate JSON key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        cursor++; // colon; grammar was already validated
        value(depth + 1);
        whitespace();
        if (source[cursor++] === "}") return;
      }
    } else if (char === "[") {
      cursor++;
      whitespace();
      if (source[cursor] === "]") {
        cursor++;
        return;
      }
      while (cursor < source.length) {
        value(depth + 1);
        whitespace();
        if (source[cursor++] === "]") return;
      }
    } else {
      while (cursor < source.length && !/[\x20\t\r\n,\]}]/.test(source[cursor] as string)) cursor++;
    }
  };
  value(0);
  const numberErrors = safeNumbers(parsed, allowFractions);
  if (numberErrors.length) throw new Error(numberErrors.join("; "));
  return parsed;
}

export function safeNumbers(data: unknown, allowFractions = false): string[] {
  const errors: string[] = [];
  const pending: { value: unknown; path: string }[] = [{ value: data, path: "" }];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    const { value, path } = current;
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        Math.abs(value) > Number.MAX_SAFE_INTEGER ||
        (!allowFractions && !Number.isSafeInteger(value)))
    ) {
      errors.push(`${path || "/"} must be a safe integer`);
    } else if (typeof value === "string" && /[\uD800-\uDFFF]/u.test(value)) {
      errors.push(`${path || "/"} contains an unpaired Unicode surrogate`);
    } else if (value !== null && typeof value === "object") {
      if (seen.has(value)) continue;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (/[\uD800-\uDFFF]/u.test(key))
          errors.push("JSON member name contains an unpaired Unicode surrogate");
        pending.push({ value: child, path: `${path}/${key}` });
      }
    }
  }
  return errors;
}
