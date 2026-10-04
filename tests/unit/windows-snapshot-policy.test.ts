import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchiveWin32Entry } from "../../native/archive-inspection/index.js";
import {
  evaluateWindowsArchiveSnapshot,
  type WindowsArchiveSnapshotInput,
  type WindowsArchiveSnapshotPolicy,
} from "../../src/archive/windows-snapshot-policy.js";

// All SIDs/identities are synthetic constants; no host metadata or OS ACL calls.
const OWNER = "S-1-5-21-100-200-300-1001";
const SYSTEM = "S-1-5-18";
const ADMIN = "S-1-5-32-544";
const WORLD = "S-1-1-0";
const OTHER = "S-1-5-21-100-200-300-1002";
const FULL_DIRECTORY = 0x1f01ff;
const FULL_FILE_SUBSET = 0x1f01bf;
const READ_ONLY = 0x1200a9;
interface Ace {
  sid: string;
  mask: number;
  type?: number;
  flags?: number;
}
function acl(aces: Ace[]): string {
  const chunks = aces.map((ace) => {
    const parts = ace.sid.split("-").slice(2).map(Number);
    const subs = parts.slice(1),
      bytes = new Uint8Array(16 + subs.length * 4),
      view = new DataView(bytes.buffer);
    view.setUint8(0, ace.type ?? 0);
    view.setUint8(1, ace.flags ?? 0);
    view.setUint16(2, bytes.length, true);
    view.setUint32(4, ace.mask, true);
    view.setUint8(8, 1);
    view.setUint8(9, subs.length);
    let authority = parts[0] ?? 0;
    for (let i = 5; i >= 0; i--) {
      view.setUint8(10 + i, authority % 256);
      authority = Math.floor(authority / 256);
    }
    subs.forEach((value, i) => {
      view.setUint32(16 + i * 4, value, true);
    });
    return bytes;
  });
  const bytes = new Uint8Array(8 + chunks.reduce((size, chunk) => size + chunk.length, 0)),
    view = new DataView(bytes.buffer);
  view.setUint8(0, 2);
  view.setUint16(2, bytes.length, true);
  view.setUint16(4, aces.length, true);
  let offset = 8;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}
function setAcl(entry: ArchiveWin32Entry, aces: Ace[]) {
  entry.daclHex = acl(aces);
  entry.aceTypes = aces.map((ace) => ace.type ?? 0);
}
function fixture(): {
  observation: WindowsArchiveSnapshotInput;
  policy: WindowsArchiveSnapshotPolicy;
} {
  const entries: ArchiveWin32Entry[] = ["C:\\", "C:\\synthetic", "C:\\synthetic\\sample.txt"].map(
    (path, i) => ({
      path,
      finalPath: path,
      volumeSerialBytes: "0100000000000000",
      fileId128: (i + 1).toString(16).padStart(32, "0"),
      ownerSid: i === 0 ? SYSTEM : OWNER,
      daclHex: "",
      daclProtected: true,
      attributes: i === 2 ? 0x20 : 0x10,
      reparseTag: 0,
      linkCount: 1,
      directory: i !== 2,
      aceTypes: [],
    }),
  );
  for (const [i, entry] of entries.entries())
    setAcl(entry, [
      { sid: entry.ownerSid, mask: i === 2 ? FULL_FILE_SUBSET : FULL_DIRECTORY },
      ...(i === 2 ? [{ sid: SYSTEM, mask: FULL_FILE_SUBSET }] : [{ sid: WORLD, mask: READ_ONLY }]),
    ]);
  return {
    observation: { schema: "archive-win32-observation-1", entries },
    policy: {
      trustedSids: [SYSTEM, OWNER, ADMIN],
      targetKind: "file",
      expectedIdentities: entries.map(({ path, volumeSerialBytes, fileId128 }) => ({
        path,
        volumeSerialBytes,
        fileId128,
      })),
    },
  };
}
function check(f = fixture()) {
  return evaluateWindowsArchiveSnapshot(f.observation, f.policy);
}
function entry(f: ReturnType<typeof fixture>, index = 2) {
  return f.observation.entries[index] as ArchiveWin32Entry;
}
function patchHex(value: string, byte: number, hex: string) {
  return value.slice(0, byte * 2) + hex + value.slice(byte * 2 + hex.length);
}
afterEach(() => {
  for (const name of [
    "node:fs",
    "node:fs/promises",
    "node:child_process",
    "@anthropic-ai/claude-agent-sdk",
  ])
    vi.doUnmock(name);
  vi.resetModules();
});

describe("pure Windows archive snapshot subset", () => {
  it("returns an immutable historical candidate with no pathname IO authority", () => {
    const f = fixture(),
      before = JSON.stringify(f),
      result = check(f);
    expect(result).toEqual({
      schema: "archive-windows-snapshot-policy-1",
      status: "candidate",
      reason: "candidate_subset_matched",
      entryIndex: null,
      basis: "historical-snapshot",
      pathnameIoAuthorization: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(f)).toBe(before);
    expect(check(f)).toEqual(result);
    expect(result).not.toHaveProperty("ownerSid");
    expect(result).not.toHaveProperty("daclHex");
  });
  it("consumes the current native result shape; no extra native evidence is invented", () => {
    const f = fixture();
    expect(check(f).status).toBe("candidate");
    expect(Object.keys(entry(f))).toHaveLength(12);
  });
  it("supports a private directory target", () => {
    const f = fixture();
    (f.policy as { targetKind: string }).targetKind = "directory";
    entry(f).directory = true;
    entry(f).attributes = 0x10;
    setAcl(entry(f), [{ sid: OWNER, mask: FULL_DIRECTORY }]);
    expect(check(f).status).toBe("candidate");
  });
  it("accepts allow-only ordering without reordering or calculating effective access", () => {
    const f = fixture();
    setAcl(entry(f), [
      { sid: SYSTEM, mask: FULL_FILE_SUBSET },
      { sid: OWNER, mask: FULL_FILE_SUBSET },
    ]);
    expect(check(f).status).toBe("candidate");
  });
  it("matches an independently written basic-ACE golden encoding", () => {
    const f = fixture();
    entry(f).daclHex =
      "02002c0001000000000024008000020001050000000000051500000064000000c80000002c010000e9030000";
    entry(f).aceTypes = [0];
    expect(acl([{ sid: OWNER, mask: 0x20080 }])).toBe(entry(f).daclHex);
    expect(check(f).status).toBe("candidate");
  });
  it("accepts zero unused ACL capacity only", () => {
    const f = fixture();
    entry(f).daclHex += "00000000";
    const size = entry(f).daclHex.length / 2;
    entry(f).daclHex = patchHex(
      entry(f).daclHex,
      2,
      `${(size & 255).toString(16).padStart(2, "0")}${(size >> 8).toString(16).padStart(2, "0")}`,
    );
    expect(check(f).status).toBe("candidate");
    entry(f).daclHex = `${entry(f).daclHex.slice(0, -2)}01`;
    expect(check(f).reason).toBe("dacl_missing_or_invalid");
  });
  it.each([
    WORLD,
    "S-1-5-11",
    "S-1-5-32-545",
    "S-1-5-32-546",
    "S-1-2-0",
    "S-1-3-0",
    "S-1-3-4",
    "S-1-5-21-100-200-300-513",
  ])("never accepts a broad/placeholder/predefined group as an explicit trusted SID: %s", (sid) => {
    const f = fixture();
    (f.policy.trustedSids as string[]).push(sid);
    expect(check(f)).toMatchObject({ status: "rejected", reason: "trust_sid_unsupported" });
  });
  it("rejects duplicate trusted SIDs", () => {
    const f = fixture();
    (f.policy.trustedSids as string[]).push(OWNER);
    expect(check(f).reason).toBe("trust_sid_duplicate");
  });
  it.each([
    "s-1-5-18",
    "S-01-5-18",
    "S-1-05-18",
    "S-1-5-018",
    "S-1-5-18\n",
    "S-1-5-4294967296",
    "S-1-281474976710656-1",
    "S-1-5",
    "S-1-5-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1",
    18,
    null,
  ])("rejects malformed trust SID: %s", (value) => {
    const f = fixture();
    (f.policy as unknown as { trustedSids: unknown[] }).trustedSids = [value];
    expect(check(f)).toMatchObject({ status: "unknown", reason: "policy_invalid" });
  });
  it.each([0, 1, 2])("requires an explicitly trusted owner at every depth: %s", (index) => {
    const f = fixture();
    entry(f, index).ownerSid = OTHER;
    expect(check(f)).toMatchObject({
      status: "rejected",
      reason: "owner_untrusted",
      entryIndex: index,
    });
  });
  it("requires a direct owner metadata-read ACE without merging grants", () => {
    const f = fixture();
    setAcl(entry(f), [{ sid: OWNER, mask: 0x80 }]);
    expect(check(f).reason).toBe("owner_grant_missing");
    setAcl(entry(f), [
      { sid: OWNER, mask: 0x80 },
      { sid: OWNER, mask: 0x20000 },
    ]);
    expect(check(f).reason).toBe("ace_sid_duplicate");
  });
  it.each([WORLD, OTHER, "S-1-5-11", "S-1-5-32-545"])(
    "rejects all target grants to an untrusted SID: %s",
    (sid) => {
      const f = fixture();
      setAcl(entry(f), [
        { sid: OWNER, mask: FULL_FILE_SUBSET },
        { sid, mask: READ_ONLY },
      ]);
      expect(check(f).reason).toBe("target_untrusted_grant");
    },
  );
  it.each([0x2, 0x4, 0x10, 0x40, 0x100, 0x10000, 0x40000, 0x80000])(
    "rejects ancestor modification/deletion/replacement grant bit %s",
    (mask) => {
      const f = fixture();
      setAcl(entry(f, 1), [
        { sid: OWNER, mask: FULL_DIRECTORY },
        { sid: WORLD, mask },
      ]);
      expect(check(f)).toMatchObject({
        status: "rejected",
        reason: "ancestor_mutation_grant",
        entryIndex: 1,
      });
    },
  );
  it.each([false, true])(
    "never uses a DENY to neutralize unsafe ALLOW, denyFirst=%s",
    (denyFirst) => {
      const f = fixture(),
        allow = { sid: WORLD, mask: 0x40 },
        deny = { ...allow, type: 1 };
      setAcl(entry(f, 1), [
        { sid: OWNER, mask: FULL_DIRECTORY },
        ...(denyFirst ? [deny, allow] : [allow, deny]),
      ]);
      expect(check(f).status).not.toBe("candidate");
    },
  );
  it("rejects even an otherwise harmless basic DENY", () => {
    const f = fixture();
    setAcl(entry(f), [
      { sid: OTHER, mask: 1, type: 1 },
      { sid: OWNER, mask: FULL_FILE_SUBSET },
    ]);
    expect(check(f)).toMatchObject({ status: "unknown", reason: "ace_type_unsupported" });
  });
  it.each([1, 2, 4, 8, 16, 17, 19, 255])(
    "rejects every supported/unknown inheritance flag combination %s",
    (flags) => {
      const f = fixture();
      setAcl(entry(f, 1), [{ sid: OWNER, mask: FULL_DIRECTORY, flags }]);
      expect(check(f).reason).toBe("ace_inheritance_unsupported");
    },
  );
  it("rejects inherited dangerous rights without crediting inherit-only suppression", () => {
    const f = fixture();
    setAcl(entry(f, 1), [
      { sid: OWNER, mask: FULL_DIRECTORY },
      { sid: WORLD, mask: 0x40, flags: 0x18 },
    ]);
    expect(check(f).reason).toBe("ace_inheritance_unsupported");
  });
  it.each([0, 0x80000000, 0x40000000, 0x20000000, 0x10000000, 0x02000000, 0x01000000, 0x200, 0x40])(
    "rejects zero/generic/reserved/unsupported target mask %s",
    (mask) => {
      const f = fixture();
      setAcl(entry(f), [{ sid: OWNER, mask }]);
      expect(check(f).reason).toBe("ace_mask_unsupported");
    },
  );
  it.each(["S-1-3-0", "S-1-3-4", "S-1-5-10"])(
    "rejects special owner/self SID semantics %s",
    (sid) => {
      const f = fixture();
      setAcl(entry(f, 1), [
        { sid: OWNER, mask: FULL_DIRECTORY },
        { sid, mask: READ_ONLY },
      ]);
      expect(check(f).reason).toBe("ace_sid_unsupported");
    },
  );
  it.each([2, 5, 9, 11, 255])("rejects unsupported ACE type %s", (type) => {
    const f = fixture();
    setAcl(entry(f), [{ sid: OWNER, mask: FULL_FILE_SUBSET, type }]);
    expect(check(f).reason).toBe("ace_type_unsupported");
  });
  it.each([null, undefined, "", "00", "0200080000000000", "02002c0001000000ff", "NOTHEX"])(
    "rejects null/missing/empty/truncated DACL %s",
    (value) => {
      const f = fixture();
      (entry(f) as unknown as { daclHex: unknown }).daclHex = value;
      expect(check(f).status).not.toBe("candidate");
    },
  );
  it.each([
    [0, "04", "dacl_revision_unsupported"],
    [1, "01", "dacl_missing_or_invalid"],
    [2, "0800", "dacl_missing_or_invalid"],
    [4, "ffff", "dacl_missing_or_invalid"],
    [6, "0100", "dacl_missing_or_invalid"],
    [10, "1300", "dacl_missing_or_invalid"],
    [10, "ffff", "dacl_missing_or_invalid"],
    [16, "02", "dacl_missing_or_invalid"],
    [17, "10", "dacl_missing_or_invalid"],
  ] as const)("rejects malformed binary DACL at offset %s", (offset, value, reason) => {
    const f = fixture();
    entry(f).daclHex = patchHex(entry(f).daclHex, offset, value);
    expect(check(f).reason).toBe(reason);
  });
  it("rejects native ACE type-list disagreement and duplicate ACE SID", () => {
    const f = fixture();
    entry(f).aceTypes = [1, 0];
    expect(check(f).reason).toBe("ace_types_mismatch");
    setAcl(entry(f), [
      { sid: OWNER, mask: FULL_FILE_SUBSET },
      { sid: OWNER, mask: READ_ONLY },
    ]);
    expect(check(f).reason).toBe("ace_sid_duplicate");
  });
  it("rejects a non-protected DACL", () => {
    const f = fixture();
    entry(f, 0).daclProtected = false;
    expect(check(f).reason).toBe("dacl_unprotected");
  });
  it.each([0, 1, 2])("rejects reparse evidence at every depth: %s", (index) => {
    const f = fixture();
    entry(f, index).attributes |= 0x400;
    expect(check(f).reason).toBe("reparse_point");
    entry(f, index).attributes &= ~0x400;
    entry(f, index).reparseTag = 0xa0000003;
    expect(check(f).reason).toBe("reparse_point");
  });
  it.each([undefined, null, 0, -1, 1.5, "1"])(
    "fails closed when link count is unverified %s",
    (count) => {
      const f = fixture();
      (entry(f) as unknown as { linkCount: unknown }).linkCount = count;
      expect(check(f).status).not.toBe("candidate");
    },
  );
  it("rejects multiple file links and unsupported directory link counts", () => {
    const f = fixture();
    entry(f).linkCount = 2;
    expect(check(f).reason).toBe("multiple_file_links");
    entry(f).linkCount = 1;
    entry(f, 1).linkCount = 2;
    expect(check(f).reason).toBe("hardlink_unverified");
  });
  it("rejects missing identity anchors, changed identity and duplicate identities", () => {
    const f = fixture();
    (f.policy as unknown as { expectedIdentities: unknown }).expectedIdentities = undefined;
    expect(check(f).reason).toBe("identity_unverified");
    const changed = fixture();
    entry(changed, 1).fileId128 = "f".repeat(32);
    expect(check(changed).reason).toBe("identity_changed");
    const duplicate = fixture();
    entry(duplicate, 1).fileId128 = entry(duplicate, 0).fileId128;
    (duplicate.policy.expectedIdentities[1] as { fileId128: string }).fileId128 = entry(
      duplicate,
      1,
    ).fileId128;
    expect(check(duplicate).reason).toBe("identity_duplicate");
  });
  it.each(["", "0".repeat(32), "A".repeat(32), "a".repeat(31), `${"a".repeat(32)}\n`, null])(
    "rejects unknown/noncanonical identity %s",
    (value) => {
      const f = fixture();
      (entry(f) as unknown as { fileId128: unknown }).fileId128 = value;
      expect(check(f).reason).toBe("identity_unverified");
    },
  );
  it("rejects changed volume, final path alias, missing ancestor, and object-kind conflict", () => {
    const f = fixture();
    entry(f, 1).volumeSerialBytes = "0200000000000000";
    expect(check(f).reason).toBe("identity_changed");
    const alias = fixture();
    entry(alias).finalPath = "C:\\synthetic\\SAMPLE.TXT";
    expect(check(alias).reason).toBe("path_chain_invalid");
    const missing = fixture();
    (missing.observation.entries as ArchiveWin32Entry[]).splice(1, 1);
    expect(check(missing).reason).toBe("path_chain_invalid");
    const kind = fixture();
    entry(kind, 1).directory = false;
    expect(check(kind).reason).toBe("object_kind_mismatch");
  });
  it.each([
    "relative",
    "c:\\sample",
    "\\\\server\\share",
    "\\\\?\\C:\\sample",
    "C:\\a:ads",
    "C:\\a\\..\\b",
    "C:\\a\\",
    "C:\\CON",
    "C:\\COM\u00b9",
    "C:\\a\u0000b",
  ])("rejects ambiguous chain path %s", (path) => {
    const f = fixture();
    entry(f).path = path;
    expect(check(f).reason).toBe("path_chain_invalid");
  });
  it.each([0, 0x40, 0x200, 0x800, 0x1000, 0x4000, 0x8000, 0x100000, 0xffffffff, 0x90])(
    "rejects unsupported/conflicting object attributes %s",
    (attributes) => {
      const f = fixture();
      entry(f).attributes = attributes;
      expect(check(f).status).not.toBe("candidate");
    },
  );
  it("rejects missing/wrong metadata fields and extra success claims", () => {
    const f = fixture();
    const value = entry(f) as unknown as Record<string, unknown>;
    delete value.ownerSid;
    expect(check(f).reason).toBe("observation_invalid");
    const extra = fixture();
    Object.assign(extra.observation, { available: true });
    expect(check(extra).reason).toBe("observation_invalid");
    const wrong = fixture();
    (entry(wrong) as unknown as { daclProtected: unknown }).daclProtected = "true";
    expect(check(wrong).reason).toBe("observation_invalid");
  });
  it.each([null, undefined, 1, "observation", [], new Map()])(
    "rejects damaged observation type %s",
    (value) => {
      expect(evaluateWindowsArchiveSnapshot(value, fixture().policy).status).toBe("unknown");
    },
  );
  it("rejects getters and proxies without invoking them", () => {
    let calls = 0;
    const f = fixture();
    Object.defineProperty(entry(f), "ownerSid", {
      enumerable: true,
      get() {
        calls++;
        return OWNER;
      },
    });
    expect(check(f).status).toBe("unknown");
    expect(calls).toBe(0);
    const proxy = new Proxy(fixture().observation, {
      get() {
        calls++;
        throw new Error("must not run");
      },
      ownKeys() {
        calls++;
        return [];
      },
    });
    expect(evaluateWindowsArchiveSnapshot(proxy, fixture().policy).status).toBe("unknown");
    expect(calls).toBe(0);
  });
  it("rejects array accessors, sparse arrays, extra properties and overlong arrays", () => {
    let calls = 0;
    const f = fixture();
    Object.defineProperty(f.policy.trustedSids, "0", {
      enumerable: true,
      get() {
        calls++;
        return SYSTEM;
      },
    });
    expect(check(f).status).toBe("unknown");
    expect(calls).toBe(0);
    for (const values of [
      new Array(2),
      Object.assign([SYSTEM], { hidden: true }),
      Array(129).fill(SYSTEM),
    ]) {
      const bad = fixture();
      (bad.policy as { trustedSids: string[] }).trustedSids = values;
      expect(check(bad).status).toBe("unknown");
    }
  });
  it("loads without file IO, child-process or SDK imports", async () => {
    for (const name of [
      "node:fs",
      "node:fs/promises",
      "node:child_process",
      "@anthropic-ai/claude-agent-sdk",
    ])
      vi.doMock(name, () => {
        throw new Error("forbidden import");
      });
    vi.resetModules();
    const module = await import("../../src/archive/windows-snapshot-policy.js");
    expect(
      module.evaluateWindowsArchiveSnapshot(fixture().observation, fixture().policy).status,
    ).toBe("candidate");
  });
  it("does not read process/environment as a trust source", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
    let result: ReturnType<typeof evaluateWindowsArchiveSnapshot> | undefined;
    try {
      Object.defineProperty(globalThis, "process", {
        configurable: true,
        get() {
          throw new Error("no process reads");
        },
      });
      result = check();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "process", descriptor);
    }
    expect(result?.status).toBe("candidate");
  });
});
