import { describe, expect, it, vi } from "vitest";
import {
  decodeNtfsBundle,
  encodeNtfsBundle,
  MAX_NTFS_BUNDLE_BYTES,
  MAX_NTFS_BUNDLE_DATA_BYTES,
  MAX_NTFS_BUNDLE_INDEX_BYTES,
  MAX_NTFS_BUNDLE_MEMBER_BYTES,
  NTFS_BUNDLE_MAGIC,
  type NtfsBundleInput,
  type NtfsBundleMemberIdentity,
} from "../../src/archive/ntfs-bundle.js";
import { sha256Bytes } from "../../src/contracts/raw-bytes.js";

// These dependencies would turn a format-only import into storage/runtime activity.
vi.mock("../../src/archive/paths.js", () => {
  throw new Error("bundle must not import filesystem policy");
});
vi.mock("../../src/contracts/task.js", () => {
  throw new Error("bundle must not import schema file IO");
});
vi.mock("node:fs", () => {
  throw new Error("bundle must not import fs");
});
vi.mock("node:fs/promises", () => {
  throw new Error("bundle must not import fs promises");
});
vi.mock("node:sqlite", () => {
  throw new Error("bundle must not import SQLite");
});
vi.mock("node:child_process", () => {
  throw new Error("bundle must not import processes");
});

const data = (name: string, value = "sample"): NtfsBundleInput => ({
  name,
  bytes: Buffer.from(value),
});
const expected = (members: readonly NtfsBundleInput[]): NtfsBundleMemberIdentity[] =>
  members.map(({ name, bytes }) => ({
    name,
    length: bytes.byteLength,
    sha256: sha256Bytes(bytes),
  }));
function wire(index: string, count: number, body = Buffer.alloc(0)): Buffer {
  const raw = Buffer.from(index);
  const prefix = Buffer.alloc(16);
  prefix.write(NTFS_BUNDLE_MAGIC, "ascii");
  prefix.writeUInt32BE(raw.length, 8);
  prefix.writeUInt32BE(count, 12);
  return Buffer.concat([prefix, raw, body]);
}
const rowsWire = (rows: unknown[], body = Buffer.alloc(0), count = rows.length) =>
  wire(JSON.stringify({ members: rows }), count, body);
const emptyHash = sha256Bytes(Buffer.alloc(0));
const zero = (name: string) => ({ name, length: 0, sha256: emptyHash });
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture_missing");
  return value;
}

describe("ntfs-bundle-1 format only", () => {
  it("has an independent empty golden vector with exact prefix and no padding", () => {
    const golden = Buffer.concat([
      Buffer.from("4e544653424e44310000000e00000000", "hex"),
      Buffer.from('{"members":[]}'),
    ]);
    expect(Buffer.from(encodeNtfsBundle([]))).toEqual(golden);
    const result = decodeNtfsBundle(golden, []);
    expect(result.format).toBe("ntfs-bundle-1");
    expect(result.containerSha256).toBe(sha256Bytes(golden));
    expect(result.members).toEqual([]);
    expect(() => result.memberBytes("absent")).toThrow("ntfs_bundle_member_missing");
    expect(result).not.toHaveProperty("ackCandidate");
    expect(result).not.toHaveProperty("windowsStorageEnabled");
  });
  it("matches an independent nonempty multi-member golden vector", () => {
    const golden = Buffer.concat([
      Buffer.from("4e544653424e4431000000d500000002", "hex"),
      Buffer.from(
        '{"members":[{"name":"a","length":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},{"name":"b","length":5,"sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}]}',
      ),
      Buffer.from("61626368656c6c6f", "hex"),
    ]);
    expect(Buffer.from(encodeNtfsBundle([data("b", "hello"), data("a", "abc")]))).toEqual(golden);
    const result = decodeNtfsBundle(golden, [
      {
        name: "a",
        length: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
      {
        name: "b",
        length: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
    ]);
    expect(result.memberBytes("a")).toEqual(Uint8Array.of(97, 98, 99));
    expect(result.memberBytes("b")).toEqual(Uint8Array.of(104, 101, 108, 108, 111));
  });
  it("roundtrips raw binary, zero bytes and nested member names", () => {
    const members = [
      data("result.json"),
      data("artifacts/zero.bin", ""),
      {
        name: "artifacts/raw.bin",
        bytes: Uint8Array.from([0, 255, 128, 13, 10]),
      },
    ];
    const result = decodeNtfsBundle(encodeNtfsBundle(members), expected(members));
    for (const member of members)
      expect(result.memberBytes(member.name)).toEqual(Uint8Array.from(member.bytes));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.members)).toBe(true);
    expect(result.members.every(Object.isFrozen)).toBe(true);
  });
  it("sorts by ASCII bytes, with deterministic input and expected-identity ordering", () => {
    const members = [data("z"), data("a"), data("Zed"), data("Abel")];
    const a = encodeNtfsBundle(members);
    const b = encodeNtfsBundle([...members].reverse());
    expect(a).toEqual(b);
    expect(decodeNtfsBundle(a, expected(members).reverse()).members.map((row) => row.name)).toEqual(
      ["Abel", "Zed", "a", "z"],
    );
  });
  it("keeps encoded and decoded snapshots independent of every external buffer", () => {
    const backing = Buffer.from("XXhelloYY");
    const source = backing.subarray(2, 7);
    const members = [{ name: "a", bytes: source }];
    const identities = expected(members);
    const encoded = encodeNtfsBundle(members);
    source.fill(0);
    const result = decodeNtfsBundle(encoded, identities);
    const digest = result.containerSha256;
    encoded.fill(255);
    required(identities[0]).sha256 = emptyHash;
    const returned = result.memberBytes("a");
    expect(Buffer.from(returned).toString()).toBe("hello");
    returned.fill(0);
    expect(Buffer.from(result.memberBytes("a")).toString()).toBe("hello");
    expect(result.containerSha256).toBe(digest);
    expect(result.members[0]?.sha256).toBe(sha256Bytes(Buffer.from("hello")));
  });
  it("copies members before later caller traps can mutate an earlier buffer", () => {
    const first = data("a");
    const identities = expected([first, data("b")]);
    const second = new Proxy(data("b"), {
      ownKeys(target) {
        first.bytes.fill(0);
        return Reflect.ownKeys(target);
      },
    });
    const result = decodeNtfsBundle(encodeNtfsBundle([first, second]), identities);
    expect(Buffer.from(result.memberBytes("a")).toString()).toBe("sample");
  });
  it.each([
    "",
    "/a",
    "a/",
    "a//b",
    ".",
    "..",
    "a/../b",
    "a\\b",
    "a:b",
    "a.",
    "a ",
    "a\n",
    "é",
    "CON",
    "con.json",
    "aux/x",
    "COM0",
    "lpt9.txt",
    "_a",
    "-a",
    "a".repeat(121),
  ])("rejects invalid logical name %j on both sides", (name) => {
    expect(() => encodeNtfsBundle([data(name, "")])).toThrow("ntfs_bundle_name_invalid");
    expect(() => decodeNtfsBundle(rowsWire([zero(name)]), [])).toThrow("ntfs_bundle_name_invalid");
  });
  it.each([
    ["a", "a"],
    ["a", "A"],
    ["dir/a", "DIR/A"],
  ])("rejects name collision %j / %j", (first, second) => {
    const names = [first, second];
    expect(() => encodeNtfsBundle(names.map((name) => data(name, "")))).toThrow(
      "ntfs_bundle_name_collision",
    );
    expect(() => decodeNtfsBundle(rowsWire(names.map(zero)), [])).toThrow(
      "ntfs_bundle_name_collision",
    );
    expect(() => decodeNtfsBundle(encodeNtfsBundle([]), names.map(zero))).toThrow(
      "ntfs_bundle_name_collision",
    );
  });
  it("accepts 128 members and rejects 129 before constructing an index", () => {
    const members = Array.from({ length: 128 }, (_, i) => data(`a${i}`, ""));
    expect(decodeNtfsBundle(encodeNtfsBundle(members), expected(members)).members).toHaveLength(
      128,
    );
    expect(() => encodeNtfsBundle([...members, data("extra", "")])).toThrow(
      "ntfs_bundle_count_limit",
    );
    expect(() => decodeNtfsBundle(rowsWire([], Buffer.alloc(0), 129), [])).toThrow(
      "ntfs_bundle_count_limit",
    );
  });
  it("accepts exact member and aggregate byte limits, and rejects either excess", () => {
    const block = new Uint8Array(MAX_NTFS_BUNDLE_MEMBER_BYTES);
    const members = Array.from({ length: 4 }, (_, i) => ({ name: `a${i}`, bytes: block }));
    const encoded = encodeNtfsBundle(members);
    expect(encoded.byteLength).toBeGreaterThan(MAX_NTFS_BUNDLE_DATA_BYTES);
    expect(encoded.byteLength).toBeLessThanOrEqual(MAX_NTFS_BUNDLE_BYTES);
    expect(decodeNtfsBundle(encoded, expected(members)).members).toHaveLength(4);
    expect(() =>
      encodeNtfsBundle([...members, { name: "extra", bytes: Uint8Array.of(1) }]),
    ).toThrow("ntfs_bundle_size_limit");
    expect(() =>
      encodeNtfsBundle([{ name: "a", bytes: new Uint8Array(MAX_NTFS_BUNDLE_MEMBER_BYTES + 1) }]),
    ).toThrow("ntfs_bundle_size_limit");
  });
  it("rejects a container over the maximum before copying or parsing it", () => {
    expect(() => decodeNtfsBundle(new Uint8Array(MAX_NTFS_BUNDLE_BYTES + 1), [])).toThrow(
      "ntfs_bundle_size_limit",
    );
  });
  it("bounds the index independently, including an encoder-generated large index", () => {
    const longName = Array.from({ length: 33 }, () => "a".repeat(120)).join("/");
    expect(() =>
      encodeNtfsBundle(Array.from({ length: 17 }, (_, i) => data(`${i}/${longName}`, ""))),
    ).toThrow("ntfs_bundle_index_limit");
    const raw = wire(" ".repeat(MAX_NTFS_BUNDLE_INDEX_BYTES + 1), 0);
    expect(() => decodeNtfsBundle(raw, [])).toThrow("ntfs_bundle_index_limit");
  });
  it("accepts an exact-maximum container with a canonical index of exactly 64 KiB", () => {
    const nameOfLength = (length: number) =>
      "a/".repeat(Math.floor((length - 1) / 2)) + (length % 2 ? "a" : "aa");
    const members = Array.from({ length: 16 }, (_, i) => data(`${i}/${nameOfLength(3900)}`, ""));
    const block = new Uint8Array(MAX_NTFS_BUNDLE_MEMBER_BYTES);
    for (let i = 0; i < 4; i++) required(members[i]).bytes = block;
    const currentLength = Buffer.byteLength(JSON.stringify({ members: expected(members) }));
    let extra = MAX_NTFS_BUNDLE_INDEX_BYTES - currentLength;
    for (let i = 0; i < members.length && extra > 0; i++) {
      const row = required(members[i]);
      const addition = Math.min(extra, 4096 - row.name.length);
      row.name = `${i}/${nameOfLength(3900 + addition)}`;
      extra -= addition;
    }
    expect(extra).toBe(0);
    const bytes = encodeNtfsBundle(members);
    expect(bytes.byteLength).toBe(MAX_NTFS_BUNDLE_BYTES);
    expect(new DataView(bytes.buffer).getUint32(8, false)).toBe(MAX_NTFS_BUNDLE_INDEX_BYTES);
    expect(decodeNtfsBundle(bytes, expected(members)).members).toHaveLength(16);
  });
  it.each([
    -1,
    -0,
    0.5,
    16 * 1024 * 1024 + 1,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    1e100,
  ])("rejects invalid expected length %s without arithmetic wrapping", (length) => {
    expect(() => decodeNtfsBundle(encodeNtfsBundle([]), [{ ...zero("a"), length }])).toThrow();
  });
  it.each(["-1", "-0", "0.5", "16777217", "9007199254740991", "9007199254740992", "1e100"])(
    "rejects unsafe wire length %s",
    (length) => {
      const raw = wire(`{"members":[{"name":"a","length":${length},"sha256":"${emptyHash}"}]}`, 1);
      expect(() => decodeNtfsBundle(raw, [])).toThrow();
    },
  );
  it("rejects aggregate overflow from index metadata before reading member bytes", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      ...zero(`a${i}`),
      length: MAX_NTFS_BUNDLE_MEMBER_BYTES,
    }));
    expect(() => decodeNtfsBundle(rowsWire(rows), [])).toThrow("ntfs_bundle_size_limit");
  });
  it("rejects huge unsigned prefix lengths and counts without allocation", () => {
    const prefix = Buffer.from(encodeNtfsBundle([]));
    prefix.writeUInt32BE(0xffffffff, 8);
    expect(() => decodeNtfsBundle(prefix, [])).toThrow("ntfs_bundle_index_limit");
    prefix.writeUInt32BE(14, 8);
    prefix.writeUInt32BE(0xffffffff, 12);
    expect(() => decodeNtfsBundle(prefix, [])).toThrow("ntfs_bundle_count_limit");
  });
  it("rejects every truncation position in a complete nonempty container", () => {
    const members = [data("a", "first"), data("b", "second")];
    const bytes = encodeNtfsBundle(members);
    for (let i = 0; i < bytes.length; i++)
      expect(() => decodeNtfsBundle(bytes.subarray(0, i), expected(members))).toThrow();
    expect(() => decodeNtfsBundle(bytes, expected(members))).not.toThrow();
  });
  it("rejects a single-bit mutation at every position of a complete container", () => {
    const members = [data("a", "raw bytes")];
    const bytes = encodeNtfsBundle(members);
    for (let i = 0; i < bytes.length; i++) {
      const mutated = Uint8Array.from(bytes);
      mutated[i] = required(mutated[i]) ^ 1;
      expect(() => decodeNtfsBundle(mutated, expected(members))).toThrow();
    }
  });
  it("rejects corrupted magic, count mismatch, extra tail and same-length content mutation", () => {
    const members = [data("a")];
    const bytes = Buffer.from(encodeNtfsBundle(members));
    bytes[0] ^= 1;
    expect(() => decodeNtfsBundle(bytes, expected(members))).toThrow("ntfs_bundle_magic_invalid");
    bytes[0] ^= 1;
    bytes.writeUInt32BE(0, 12);
    expect(() => decodeNtfsBundle(bytes, expected(members))).toThrow("ntfs_bundle_count_mismatch");
    bytes.writeUInt32BE(1, 12);
    expect(() =>
      decodeNtfsBundle(Buffer.concat([bytes, Buffer.from([0])]), expected(members)),
    ).toThrow("ntfs_bundle_trailing_bytes");
    bytes[bytes.length - 1] ^= 1;
    expect(() => decodeNtfsBundle(bytes, expected(members))).toThrow("ntfs_bundle_hash_mismatch");
  });
  it.each([
    '{ "members":[]}',
    '{"members":[]}\n',
    '{"members":[],"offset":0}',
    '{"members":[],"members":[]}',
    '{"\\u006dembers":[]}',
    '\ufeff{"members":[]}',
    '{"members":{}}',
    '{"members":[null]}',
  ])("rejects malformed/noncanonical index %j", (index) => {
    expect(() => decodeNtfsBundle(wire(index, 0), [])).toThrow();
  });
  it("rejects noncanonical row keys, member order, numeric spelling, hashes and external references", () => {
    const row = zero("a");
    const indices = [
      JSON.stringify({ members: [{ sha256: row.sha256, name: "a", length: 0 }] }),
      JSON.stringify({ members: [zero("b"), row] }),
      JSON.stringify({ members: [row] }).replace('"length":0', '"length":0e0'),
      JSON.stringify({ members: [{ ...row, offset: 16 }] }),
      JSON.stringify({ members: [{ ...row, url: "https://example.invalid/a" }] }),
      JSON.stringify({ members: [{ ...row, sha256: row.sha256.toUpperCase() }] }),
    ];
    for (const index of indices)
      expect(() => decodeNtfsBundle(wire(index, index.includes('"b"') ? 2 : 1), [row])).toThrow();
    expect(() => decodeNtfsBundle(wire('{"members":[]}\xff', 0), [])).toThrow();
    const invalidUtf8 = rowsWire([]);
    invalidUtf8[16] = 0xff;
    expect(() => decodeNtfsBundle(invalidUtf8, [])).toThrow("ntfs_bundle_input_invalid");
  });
  it("requires the exact expected set, lengths and member hashes", () => {
    const members = [data("a"), data("b", "")];
    const bytes = encodeNtfsBundle(members);
    const rows = expected(members);
    for (const mismatch of [
      rows.slice(0, 1),
      [...rows, zero("extra")],
      [{ ...required(rows[0]), name: "different" }, required(rows[1])],
      [{ ...required(rows[0]), length: 0 }, required(rows[1])],
      [{ ...required(rows[0]), sha256: emptyHash }, required(rows[1])],
    ])
      expect(() => decodeNtfsBundle(bytes, mismatch)).toThrow("ntfs_bundle_members_mismatch");
  });
  it.each([emptyHash.toUpperCase(), `${emptyHash}\n`, "0".repeat(63), "g".repeat(64)])(
    "rejects malformed hashes on both wire and expected metadata",
    (sha256) => {
      const row = { ...zero("a"), sha256 };
      expect(() => decodeNtfsBundle(rowsWire([row]), [zero("a")])).toThrow(
        "ntfs_bundle_hash_invalid",
      );
      expect(() => decodeNtfsBundle(rowsWire([zero("a")]), [row])).toThrow(
        "ntfs_bundle_hash_invalid",
      );
    },
  );
  it("does not adopt a retry with a different raw signed envelope, even for equal logical payload", () => {
    const first = [data("receipt.json", '{"payload":"same","signature":"aaaa"}')];
    const retry = [data("receipt.json", '{"payload":"same","signature":"bbbb"}')];
    const one = encodeNtfsBundle(first);
    const two = encodeNtfsBundle(retry);
    expect(one).not.toEqual(two);
    expect(() => decodeNtfsBundle(two, expected(first))).toThrow("ntfs_bundle_members_mismatch");
    expect(decodeNtfsBundle(one, expected(first)).members[0]?.sha256).toBe(
      sha256Bytes(required(first[0]).bytes),
    );
  });
  it("rejects sparse/accessor/extra-field input without invoking ordinary getters", () => {
    let calls = 0;
    const getter = {
      name: "a",
      get bytes() {
        calls++;
        return Buffer.alloc(0);
      },
    };
    const arrayGetter = [data("a")];
    Object.defineProperty(arrayGetter, "0", {
      get() {
        calls++;
        return data("a");
      },
    });
    for (const input of [new Array(1), arrayGetter, [getter], [{ ...data("a"), extra: true }]])
      expect(() => encodeNtfsBundle(input)).toThrow("ntfs_bundle_input_invalid");
    expect(calls).toBe(0);
    const badExpected = [
      Object.defineProperty(zero("a"), "sha256", {
        get() {
          calls++;
          return emptyHash;
        },
      }),
    ];
    expect(() => decodeNtfsBundle(encodeNtfsBundle([]), badExpected)).toThrow(
      "ntfs_bundle_input_invalid",
    );
    expect(calls).toBe(0);
  });
  it("rejects shared/detached buffers and cannot be redirected by shadow byte getters", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(1));
    expect(() => encodeNtfsBundle([{ name: "a", bytes: shared }])).toThrow(
      "ntfs_bundle_bytes_invalid",
    );
    expect(() => decodeNtfsBundle(shared, [])).toThrow("ntfs_bundle_bytes_invalid");
    const detached = Uint8Array.of(1);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(() => encodeNtfsBundle([{ name: "a", bytes: detached }])).toThrow(
      "ntfs_bundle_input_invalid",
    );
    const bytes = Uint8Array.of(1, 2);
    let calls = 0;
    Object.defineProperty(bytes, "byteLength", {
      get() {
        calls++;
        return 0;
      },
    });
    Object.defineProperty(bytes, "buffer", {
      get() {
        calls++;
        return new ArrayBuffer(0);
      },
    });
    const identities = [{ name: "a", length: 2, sha256: sha256Bytes(Uint8Array.of(1, 2)) }];
    expect(
      decodeNtfsBundle(encodeNtfsBundle([{ name: "a", bytes }]), identities).memberBytes("a"),
    ).toEqual(Uint8Array.of(1, 2));
    expect(calls).toBe(0);
  });
  it("redacts exceptions from caller-controlled proxy traps", () => {
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("private_value");
        },
      },
    );
    expect(() => encodeNtfsBundle([proxy as NtfsBundleInput])).toThrow("ntfs_bundle_input_invalid");
    let calls = 0;
    const error = Object.defineProperty(new Error(), "message", {
      get() {
        calls++;
        throw new Error("private_value");
      },
    });
    const accessorError = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw error;
        },
      },
    );
    expect(() => encodeNtfsBundle([accessorError as NtfsBundleInput])).toThrow(
      "ntfs_bundle_input_invalid",
    );
    expect(calls).toBe(0);
  });
});
