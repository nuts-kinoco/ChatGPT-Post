/** In-memory container codec only: no storage, trust, publication or ACK authority. */
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/raw-bytes.js";

export const NTFS_BUNDLE_MAGIC = "NTFSBND1";
export const NTFS_BUNDLE_PREFIX_BYTES = 16;
export const MAX_NTFS_BUNDLE_INDEX_BYTES = 64 * 1024;
export const MAX_NTFS_BUNDLE_MEMBERS = 128;
export const MAX_NTFS_BUNDLE_MEMBER_BYTES = 16 * 1024 * 1024;
export const MAX_NTFS_BUNDLE_DATA_BYTES = 64 * 1024 * 1024;
export const MAX_NTFS_BUNDLE_BYTES =
  NTFS_BUNDLE_PREFIX_BYTES + MAX_NTFS_BUNDLE_INDEX_BYTES + MAX_NTFS_BUNDLE_DATA_BYTES;

export interface NtfsBundleInput {
  name: string;
  bytes: Uint8Array;
}
export interface NtfsBundleMemberIdentity {
  name: string;
  length: number;
  sha256: string;
}
export interface DecodedNtfsBundle {
  readonly format: "ntfs-bundle-1";
  readonly containerSha256: string;
  readonly members: readonly Readonly<NtfsBundleMemberIdentity>[];
  /** Fresh copy of the verified private snapshot on every call; never a mutable internal view. */
  memberBytes(name: string): Uint8Array;
}

const failures = new WeakMap<object, string>();
function fail(code: string): never {
  const error = new Error(`ntfs_bundle_${code}`);
  failures.set(error, code);
  throw error;
}
function checkedAdd(a: number, b: number, limit: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || b > limit - a)
    fail("size_limit");
  return a + b;
}
/** Same component alphabet, length and DOS exclusions as archive/paths.ts; no IO import. */
function validName(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) fail("name_invalid");
  for (const part of value.split("/")) {
    if (
      !part ||
      part.length > 120 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?![\s\S])/.test(part) ||
      /[. ](?![\s\S])/.test(part) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
    )
      fail("name_invalid");
  }
  return value;
}
function dataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object") fail("input_invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("input_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) fail("input_invalid");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("input_invalid");
    result[key] = descriptor.value;
  }
  return result;
}
function denseArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail("input_invalid");
  const count: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > MAX_NTFS_BUNDLE_MEMBERS
  )
    fail("count_limit");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== count + 1) fail("input_invalid");
  const result: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("input_invalid");
    result.push(descriptor.value);
  }
  return result;
}
function identities(value: unknown): NtfsBundleMemberIdentity[] {
  const result = denseArray(value).map((entry) => {
    const record = dataRecord(entry, ["name", "length", "sha256"]);
    const name = validName(record.name);
    if (
      typeof record.length !== "number" ||
      !Number.isSafeInteger(record.length) ||
      record.length < 0 ||
      Object.is(record.length, -0) ||
      record.length > MAX_NTFS_BUNDLE_MEMBER_BYTES
    )
      fail("size_limit");
    if (
      typeof record.sha256 !== "string" ||
      record.sha256.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(record.sha256)
    )
      fail("hash_invalid");
    return { name, length: record.length, sha256: record.sha256 };
  });
  checkNames(result);
  let size = 0;
  for (const row of result) size = checkedAdd(size, row.length, MAX_NTFS_BUNDLE_DATA_BYTES);
  return result;
}
function checkNames(rows: readonly { name: string }[]): void {
  const names = new Set<string>();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    if (names.has(key)) fail("name_collision");
    names.add(key);
  }
}
/** ASCII-only names make this comparison bytewise and independent of locale. */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
function canonicalIndex(rows: readonly NtfsBundleMemberIdentity[]): Buffer {
  const bytes = Buffer.from(JSON.stringify({ members: rows }), "utf8");
  if (bytes.byteLength > MAX_NTFS_BUNDLE_INDEX_BYTES) fail("index_limit");
  return bytes;
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
function byteView(value: unknown, limit: number): Uint8Array {
  if (!value) fail("bytes_invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) fail("bytes_invalid");
  const buffer: unknown = bufferGetter?.call(value);
  const offset: unknown = offsetGetter?.call(value);
  const length: unknown = lengthGetter?.call(value);
  // Shared memory cannot provide a coherent copy without a separate synchronization protocol.
  if (!(buffer instanceof ArrayBuffer) || typeof offset !== "number" || typeof length !== "number")
    fail("bytes_invalid");
  checkedAdd(0, length, limit);
  return new Uint8Array(buffer, offset, length);
}
function copyBytes(view: Uint8Array): Uint8Array {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}
/** Normalize exceptions from malformed/proxy/detached inputs without echoing caller text. */
function boundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    const code = error !== null && typeof error === "object" ? failures.get(error) : undefined;
    if (code) throw new Error(`ntfs_bundle_${code}`);
    return fail("input_invalid");
  }
}

export function encodeNtfsBundle(input: readonly NtfsBundleInput[]): Uint8Array {
  return boundary(() => {
    let total = 0;
    const members = denseArray(input).map((entry) => {
      const record = dataRecord(entry, ["name", "bytes"]);
      const name = validName(record.name);
      const view = byteView(record.bytes, MAX_NTFS_BUNDLE_MEMBER_BYTES);
      total = checkedAdd(total, view.byteLength, MAX_NTFS_BUNDLE_DATA_BYTES);
      return { name, bytes: copyBytes(view) };
    });
    checkNames(members);
    members.sort(byName);
    const index = canonicalIndex(
      members.map(({ name, bytes }) => ({
        name,
        length: bytes.byteLength,
        sha256: sha256Bytes(bytes),
      })),
    );
    const start = checkedAdd(NTFS_BUNDLE_PREFIX_BYTES, index.byteLength, MAX_NTFS_BUNDLE_BYTES);
    const output = new Uint8Array(checkedAdd(start, total, MAX_NTFS_BUNDLE_BYTES));
    output.set(Buffer.from(NTFS_BUNDLE_MAGIC, "ascii"));
    const header = new DataView(output.buffer);
    header.setUint32(8, index.byteLength, false);
    header.setUint32(12, members.length, false);
    output.set(index, NTFS_BUNDLE_PREFIX_BYTES);
    let offset = start;
    for (const member of members) {
      output.set(member.bytes, offset);
      offset = checkedAdd(offset, member.bytes.byteLength, output.byteLength);
    }
    return output;
  });
}

/** Expected identities are mandatory, but their authentication is the caller's separate duty. */
export function decodeNtfsBundle(
  input: Uint8Array,
  expectedMembers: readonly NtfsBundleMemberIdentity[],
): DecodedNtfsBundle {
  return boundary(() => {
    const expected = identities(expectedMembers).sort(byName);
    // Capture a private snapshot before parsing/hashing. No input buffer is returned or retained.
    const bytes = copyBytes(byteView(input, MAX_NTFS_BUNDLE_BYTES));
    if (bytes.byteLength < NTFS_BUNDLE_PREFIX_BYTES) fail("truncated");
    if (!Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from(NTFS_BUNDLE_MAGIC, "ascii")))
      fail("magic_invalid");
    const header = new DataView(bytes.buffer);
    const indexLength = header.getUint32(8, false);
    const count = header.getUint32(12, false);
    if (indexLength > MAX_NTFS_BUNDLE_INDEX_BYTES) fail("index_limit");
    if (count > MAX_NTFS_BUNDLE_MEMBERS) fail("count_limit");
    const start = checkedAdd(NTFS_BUNDLE_PREFIX_BYTES, indexLength, MAX_NTFS_BUNDLE_BYTES);
    if (start > bytes.byteLength) fail("truncated");
    const index = bytes.subarray(NTFS_BUNDLE_PREFIX_BYTES, start);
    const record = dataRecord(parseStrictJsonBytes(index), ["members"]);
    const members = identities(record.members);
    if (members.length !== count) fail("count_mismatch");
    if (
      members.some(
        (row, i) => i > 0 && byName(members[i - 1] as NtfsBundleMemberIdentity, row) >= 0,
      )
    )
      fail("index_noncanonical");
    if (!Buffer.from(index).equals(canonicalIndex(members))) fail("index_noncanonical");
    if (
      expected.length !== members.length ||
      members.some((row, i) => {
        const other = expected[i];
        return (
          !other ||
          row.name !== other.name ||
          row.length !== other.length ||
          row.sha256 !== other.sha256
        );
      })
    )
      fail("members_mismatch");
    const ranges = new Map<string, { start: number; end: number }>();
    let offset = start;
    for (const member of members) {
      const end = checkedAdd(offset, member.length, MAX_NTFS_BUNDLE_BYTES);
      if (end > bytes.byteLength) fail("truncated");
      if (sha256Bytes(bytes.subarray(offset, end)) !== member.sha256) fail("hash_mismatch");
      ranges.set(member.name, { start: offset, end });
      offset = end;
    }
    if (offset !== bytes.byteLength) fail("trailing_bytes");
    return Object.freeze({
      format: "ntfs-bundle-1" as const,
      containerSha256: sha256Bytes(bytes),
      members: Object.freeze(members.map((row) => Object.freeze(row))),
      memberBytes(name: string): Uint8Array {
        const range = ranges.get(name);
        if (!range) fail("member_missing");
        return copyBytes(bytes.subarray(range.start, range.end));
      },
    });
  });
}
