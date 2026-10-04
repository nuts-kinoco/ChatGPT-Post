import { types } from "node:util";
import type { ArchiveWin32Entry } from "../../native/archive-inspection/index.js";

export interface WindowsArchiveSnapshotInput {
  readonly schema: "archive-win32-observation-1";
  readonly entries: readonly ArchiveWin32Entry[];
}
export interface WindowsArchiveSnapshotPolicy {
  /** Caller-selected trust assumptions; never inferred from a process/token/environment. */
  readonly trustedSids: readonly string[];
  /** Caller-supplied historical anchors. The predicate cannot establish their provenance. */
  readonly expectedIdentities: readonly {
    readonly path: string;
    readonly volumeSerialBytes: string;
    readonly fileId128: string;
  }[];
  readonly targetKind: "file" | "directory";
}
export type WindowsArchiveSnapshotReason =
  | "candidate_subset_matched"
  | "input_invalid"
  | "policy_invalid"
  | "observation_invalid"
  | "trust_sid_unsupported"
  | "trust_sid_duplicate"
  | "owner_untrusted"
  | "owner_grant_missing"
  | "path_chain_invalid"
  | "identity_unverified"
  | "identity_changed"
  | "identity_duplicate"
  | "reparse_point"
  | "attributes_unsupported"
  | "object_kind_mismatch"
  | "hardlink_unverified"
  | "multiple_file_links"
  | "dacl_unprotected"
  | "dacl_missing_or_invalid"
  | "dacl_revision_unsupported"
  | "dacl_empty"
  | "ace_type_unsupported"
  | "ace_types_mismatch"
  | "ace_inheritance_unsupported"
  | "ace_mask_unsupported"
  | "ace_sid_duplicate"
  | "ace_sid_unsupported"
  | "ancestor_mutation_grant"
  | "target_untrusted_grant";
/** Historical structural candidate only. Never an authorization for later pathname IO. */
export interface WindowsArchiveSnapshotDecision {
  readonly schema: "archive-windows-snapshot-policy-1";
  readonly status: "candidate" | "rejected" | "unknown";
  readonly reason: WindowsArchiveSnapshotReason;
  readonly entryIndex: number | null;
  readonly basis: "historical-snapshot";
  readonly pathnameIoAuthorization: false;
}

type FailureStatus = "rejected" | "unknown";
class PolicyFailure {
  constructor(
    readonly status: FailureStatus,
    readonly reason: WindowsArchiveSnapshotReason,
    readonly index: number | null = null,
  ) {}
}
function fail(
  status: FailureStatus,
  reason: WindowsArchiveSnapshotReason,
  index: number | null = null,
): never {
  throw new PolicyFailure(status, reason, index);
}
function decision(
  status: WindowsArchiveSnapshotDecision["status"],
  reason: WindowsArchiveSnapshotReason,
  entryIndex: number | null,
): WindowsArchiveSnapshotDecision {
  return Object.freeze({
    schema: "archive-windows-snapshot-policy-1",
    status,
    reason,
    entryIndex,
    basis: "historical-snapshot",
    pathnameIoAuthorization: false,
  });
}
function record(
  value: unknown,
  keys: readonly string[],
  reason: WindowsArchiveSnapshotReason,
  index: number | null = null,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail("unknown", reason, index);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("unknown", reason, index);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (
    names.length !== keys.length ||
    names.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail("unknown", reason, index);
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail("unknown", reason, index);
    copy[key] = descriptor.value;
  }
  return copy;
}
function array(
  value: unknown,
  maximum: number,
  reason: WindowsArchiveSnapshotReason,
  index: number | null = null,
): unknown[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    fail("unknown", reason, index);
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const length = descriptors.length?.value;
  if (
    !Number.isInteger(length) ||
    length < 1 ||
    length > maximum ||
    Reflect.ownKeys(descriptors).length !== length + 1
  )
    fail("unknown", reason, index);
  const copy: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const key = String(i);
    if (!Object.hasOwn(descriptors, key)) fail("unknown", reason, index);
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail("unknown", reason, index);
    copy.push(descriptor.value);
  }
  return copy;
}
function uint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}
function sid(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 184 ||
    !/^S-1-(0|[1-9][0-9]{0,14})(?:-(?:0|[1-9][0-9]{0,9})){1,15}(?![\s\S])/.test(value)
  )
    return false;
  const parts = value.split("-").slice(2).map(Number);
  return (
    (parts[0] ?? Infinity) <= 0xffffffffffff && parts.slice(1).every((part) => part <= 0xffffffff)
  );
}
function trustSid(value: string): boolean {
  return (
    value === "S-1-5-18" ||
    value === "S-1-5-32-544" ||
    (/^S-1-5-21-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)(?![\s\S])/.test(
      value,
    ) &&
      Number(value.split("-").at(-1)) >= 1000)
  );
}
function identity(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[0-9a-f]+(?![\s\S])/.test(value) &&
    !/^0+$/.test(value)
  );
}
function paths(value: unknown): string[] {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 4096 ||
    !/^[A-Z]:\\/.test(value)
  )
    fail("unknown", "path_chain_invalid");
  const chain = [value.slice(0, 3)];
  if (value.length === 3) return chain;
  for (const part of value.slice(3).split("\\")) {
    if (
      !part ||
      /[<>:"/|?*]/.test(part) ||
      [...part].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(
        part,
      )
    )
      fail("unknown", "path_chain_invalid");
    const previous = chain.at(-1) as string;
    chain.push(`${previous}${chain.length === 1 ? "" : "\\"}${part}`);
    if (chain.length > 128) fail("unknown", "path_chain_invalid");
  }
  return chain;
}
interface Ace {
  type: number;
  flags: number;
  mask: number;
  sid: string;
}
function acl(value: unknown, index: number): Ace[] {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 65535 * 2 ||
    value.length % 8 !== 0 ||
    !/^[0-9a-f]+(?![\s\S])/.test(value)
  )
    fail("unknown", "dacl_missing_or_invalid", index);
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  const view = new DataView(bytes.buffer);
  if (view.getUint8(0) !== 2) fail("unknown", "dacl_revision_unsupported", index);
  if (
    view.getUint8(1) !== 0 ||
    view.getUint16(6, true) !== 0 ||
    view.getUint16(2, true) !== bytes.length
  )
    fail("unknown", "dacl_missing_or_invalid", index);
  const count = view.getUint16(4, true);
  if (count > 4096) fail("unknown", "dacl_missing_or_invalid", index);
  if (!count) fail("rejected", "dacl_empty", index);
  let offset = 8;
  const aces: Ace[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 20 > bytes.length) fail("unknown", "dacl_missing_or_invalid", index);
    const type = view.getUint8(offset),
      flags = view.getUint8(offset + 1),
      size = view.getUint16(offset + 2, true);
    if (type !== 0 && type !== 1) fail("unknown", "ace_type_unsupported", index);
    if (size % 4 || offset + size > bytes.length || size < 20)
      fail("unknown", "dacl_missing_or_invalid", index);
    const sidOffset = offset + 8,
      subCount = view.getUint8(sidOffset + 1);
    if (
      view.getUint8(sidOffset) !== 1 ||
      subCount < 1 ||
      subCount > 15 ||
      size !== 16 + subCount * 4
    )
      fail("unknown", "dacl_missing_or_invalid", index);
    let authority = 0;
    for (let b = 0; b < 6; b++) authority = authority * 256 + view.getUint8(sidOffset + 2 + b);
    let trustee = `S-1-${authority}`;
    for (let b = 0; b < subCount; b++) trustee += `-${view.getUint32(sidOffset + 8 + b * 4, true)}`;
    aces.push({ type, flags, mask: view.getUint32(offset + 4, true), sid: trustee });
    offset += size;
  }
  // The native snapshot may include unused ACL capacity. Accept only zero padding.
  for (; offset < bytes.length; offset++)
    if (bytes[offset] !== 0) fail("unknown", "dacl_missing_or_invalid", index);
  return aces;
}

// Concrete file/directory + standard rights only. Never map generic masks.
const CONCRETE_RIGHTS = 0x001f01ff;
const ANCESTOR_READ_ONLY = 0x001200a9;
const OWNER_METADATA_READ = 0x00020080;
const ENTRY_KEYS = [
  "path",
  "finalPath",
  "volumeSerialBytes",
  "fileId128",
  "ownerSid",
  "daclHex",
  "daclProtected",
  "attributes",
  "reparseTag",
  "linkCount",
  "directory",
  "aceTypes",
];

/** No IO, AccessCheck, token/group lookup, native binding load, SDK, or ambient trust. */
export function evaluateWindowsArchiveSnapshot(
  observation: unknown,
  explicitPolicy: unknown,
): WindowsArchiveSnapshotDecision {
  try {
    const policy = record(
      explicitPolicy,
      ["trustedSids", "expectedIdentities", "targetKind"],
      "policy_invalid",
    );
    if (policy.targetKind !== "file" && policy.targetKind !== "directory")
      fail("unknown", "policy_invalid");
    const trusted = new Set<string>();
    for (const value of array(policy.trustedSids, 128, "policy_invalid")) {
      if (!sid(value)) fail("unknown", "policy_invalid");
      if (!trustSid(value)) fail("rejected", "trust_sid_unsupported");
      if (trusted.has(value)) fail("rejected", "trust_sid_duplicate");
      trusted.add(value);
    }
    const expected = array(policy.expectedIdentities, 128, "identity_unverified").map((value) =>
      record(value, ["path", "volumeSerialBytes", "fileId128"], "identity_unverified"),
    );
    const input = record(observation, ["schema", "entries"], "observation_invalid");
    if (input.schema !== "archive-win32-observation-1") fail("unknown", "observation_invalid");
    const entries = array(input.entries, 128, "observation_invalid").map((value, index) =>
      record(value, ENTRY_KEYS, "observation_invalid", index),
    );
    const chain = paths(entries.at(-1)?.path);
    if (entries.length !== chain.length || expected.length !== chain.length)
      fail("unknown", "path_chain_invalid");
    const seenIdentities = new Set<string>();
    let volume: string | undefined;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index] as Record<string, unknown>,
        anchor = expected[index] as Record<string, unknown>;
      const target = index === entries.length - 1;
      if (
        entry.path !== chain[index] ||
        entry.finalPath !== entry.path ||
        anchor.path !== entry.path
      )
        fail("unknown", "path_chain_invalid", index);
      if (
        !identity(entry.volumeSerialBytes, 16) ||
        !identity(entry.fileId128, 32) ||
        !identity(anchor.volumeSerialBytes, 16) ||
        !identity(anchor.fileId128, 32)
      )
        fail("unknown", "identity_unverified", index);
      if (
        entry.volumeSerialBytes !== anchor.volumeSerialBytes ||
        entry.fileId128 !== anchor.fileId128 ||
        (volume && volume !== entry.volumeSerialBytes)
      )
        fail("rejected", "identity_changed", index);
      volume = entry.volumeSerialBytes;
      const key = `${volume}:${entry.fileId128}`;
      if (seenIdentities.has(key)) fail("rejected", "identity_duplicate", index);
      seenIdentities.add(key);
      if (!uint32(entry.attributes) || !uint32(entry.reparseTag))
        fail("unknown", "observation_invalid", index);
      if ((entry.attributes & 0x400) !== 0 || entry.reparseTag !== 0)
        fail("rejected", "reparse_point", index);
      // Device, sparse, compressed, offline, encrypted, integrity, virtual/recall and
      // unknown attributes are outside this subset. Ordinary + directory bits only.
      if (entry.attributes === 0 || (entry.attributes & ~0x21b7) !== 0)
        fail("unknown", "attributes_unsupported", index);
      if ((entry.attributes & 0x80) !== 0 && entry.attributes !== 0x80)
        fail("unknown", "attributes_unsupported", index);
      const directory = (entry.attributes & 0x10) !== 0;
      if (
        typeof entry.directory !== "boolean" ||
        directory !== entry.directory ||
        (!target && !directory) ||
        (target && directory !== (policy.targetKind === "directory"))
      )
        fail("rejected", "object_kind_mismatch", index);
      if (!uint32(entry.linkCount) || entry.linkCount === 0)
        fail("unknown", "hardlink_unverified", index);
      if (directory && entry.linkCount !== 1) fail("unknown", "hardlink_unverified", index);
      if (!directory && entry.linkCount !== 1) fail("rejected", "multiple_file_links", index);
      if (!sid(entry.ownerSid)) fail("unknown", "observation_invalid", index);
      if (!trusted.has(entry.ownerSid)) fail("rejected", "owner_untrusted", index);
      if (typeof entry.daclProtected !== "boolean") fail("unknown", "observation_invalid", index);
      if (!entry.daclProtected) fail("rejected", "dacl_unprotected", index);
      const aces = acl(entry.daclHex, index);
      const reportedTypes = array(entry.aceTypes, 4096, "ace_types_mismatch", index);
      if (
        reportedTypes.length !== aces.length ||
        aces.some((ace, i) => reportedTypes[i] !== ace.type)
      )
        fail("unknown", "ace_types_mismatch", index);
      const trustees = new Set<string>();
      let ownerGrant = false;
      for (const ace of aces) {
        // Reject all DENY ACEs: never offset an ALLOW or simulate Windows ordering.
        if (ace.type !== 0) fail("unknown", "ace_type_unsupported", index);
        if (ace.flags !== 0) fail("unknown", "ace_inheritance_unsupported", index);
        if (
          !ace.mask ||
          (ace.mask & ~CONCRETE_RIGHTS) !== 0 ||
          (!directory && (ace.mask & 0x40) !== 0)
        )
          fail("unknown", "ace_mask_unsupported", index);
        if (ace.sid.startsWith("S-1-3-") || ace.sid === "S-1-5-10")
          fail("unknown", "ace_sid_unsupported", index);
        if (trustees.has(ace.sid)) fail("rejected", "ace_sid_duplicate", index);
        trustees.add(ace.sid);
        if (!trusted.has(ace.sid)) {
          if (target) fail("rejected", "target_untrusted_grant", index);
          if ((ace.mask & ~ANCESTOR_READ_ONLY) !== 0)
            fail("rejected", "ancestor_mutation_grant", index);
        }
        if (ace.sid === entry.ownerSid && (ace.mask & OWNER_METADATA_READ) === OWNER_METADATA_READ)
          ownerGrant = true;
      }
      if (!ownerGrant) fail("rejected", "owner_grant_missing", index);
    }
    return decision("candidate", "candidate_subset_matched", null);
  } catch (error) {
    if (error instanceof PolicyFailure) return decision(error.status, error.reason, error.index);
    return decision("unknown", "input_invalid", null);
  }
}
