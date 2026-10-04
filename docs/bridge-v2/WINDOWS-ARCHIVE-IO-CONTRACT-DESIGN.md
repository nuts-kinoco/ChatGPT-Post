# Operation-scoped Windows archive I/O contract (design draft)

Status: **design draft for review. No implementation, no native/runtime/OS/auth change.**
Base: PR #28 head `4253bf373d4564667cf2966a8eaf9cd5b3e3af02` (stacked on PR #27
`0e5e5a2f8474c9715e696bcf952c797cfb1db143`). PR #28 is an independent-review GO *candidate*;
this document does not merge or activate it. Windows archive storage stays refused
(`archive_windows_storage_unimplemented`) until every gate in section 8 passes.

Notation: **[F]** = fact in the checked-in source at the base above (file:line). **[P]** = proposal.
**[V]** = behavior of Windows/NTFS assumed here and *not verified in this work*; it must be
confirmed by the section 7 matrix on an authorized disposable host before it is relied on.
Only public source and PR metadata were used. No Microsoft page was re-read for this draft, so
every API behavior below is either quoted from the existing repo docs or marked [V].

## 1. Existing facts

| # | Fact | Evidence |
|---|---|---|
| F1 | Windows storage is refused in directory sync and directory checks; the POSIX owner/mode check is skipped on win32. | `durable.ts:55`, `paths.ts:73,80-81` |
| F2 | Reads are pathname based: `lstat` path, `open`, then compare `dev/ino/size` of the fd with the earlier `lstat`; `nlink` must be 1; `O_NOFOLLOW`. | `paths.ts:101-125` |
| F3 | Create is `O_CREAT|O_EXCL|O_NOFOLLOW`, bounded `writeAll` (non-progress is an error), `fsync`, close; parent re-checked before and after. | `paths.ts:135-161` |
| F4 | Publication: staged directory `staging-<uuid>`, per-file write plus pathname readback, directory fsync, then `existsSync(destination)` followed by `renameSync(stage, destination)`, then a durability barrier and byte verification. Cooperating publishers are serialized only by the caller's SQLite transaction. | `durable.ts:118-186`, `store.ts:486-487` |
| F5 | Crash recovery is idempotent by content: if the destination exists, verify exact bytes and commit; staging cleanup removes only files this call created, never recurses, and preserves anything uncertain. | `store.ts:459-463,495-515`, `durable.ts:185-199` |
| F6 | Root pin is `{device, inode}` from `lstat`. | `durable.ts:38-50` |
| F7 | PR #27 observes metadata only. Each ancestor and the target is opened with `READ_CONTROL|FILE_READ_ATTRIBUTES`, `FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS`, full read/write/delete sharing, no lease; owner/DACL/attributes/links/identity/final path come from that handle; delete-pending is rejected; handles are closed when the call returns. | `inspection.cpp:76-78,96-119`, `WINDOWS-ARCHIVE-INSPECTION.md:34-51` |
| F8 | PR #27 re-observes each handle and an independently reopened name, but states the window is not atomic, cannot detect change-and-restore, and that observations are "historical, not handles suitable for subsequent secure content IO". It has no durability API. | `inspection.cpp:164-182`, `WINDOWS-ARCHIVE-INSPECTION.md:43-58` |
| F9 | PR #28 is a pure predicate over that snapshot. Every result, including `candidate`, carries `basis: "historical-snapshot"` and `pathnameIoAuthorization: false`. It requires no reparse, link count 1, canonical single-volume chain, protected basic-ALLOW-only DACLs, explicit trusted SIDs and caller-supplied identity anchors. It has no token/AccessCheck, retained handle, anchor provenance or temporal stability. | `windows-snapshot-policy.ts:41-56,85`, `WINDOWS-ARCHIVE-SNAPSHOT-POLICY.md:35-39` |

**Gap.** Between a PR #28 `candidate` and any later `open/read/write/rename` by pathname, nothing
binds the checked objects to the objects actually touched. The contract below closes that gap
for the duration of one operation only.

## 2. Principles [P]

1. **Handle-first.** Authority is a set of live handles, never a path and never a stored decision.
2. **Same-object binding.** Every byte read or written, and every metadata decision, goes through
   a handle whose identity tuple was verified. Pathnames are used only to *acquire* handles and are never trusted afterwards.
3. **Operation scope.** One capability per operation (`read-file`, `create-file`, `publish-directory`,
   `recover-scan`). It is single use, non-serializable, never cached or shared, and invalid after close.
4. **Fail closed, report truthfully.** Unknown metadata, unsupported filesystem, or an unproven
   durability tier is an error or an explicit tier label, never a silent success.
5. **No new state.** Recovery relies on the existing content-hash idempotence (F5). No journal or marker files.
6. **Bounded.** Every open, read, write and flush has a per-operation deadline; expiry is an error, never an unbounded wait or a hidden retry.

## 3. Types and binding

```ts
type ArchiveIdentity = {            // all from the same handle
  volumeSerialBytes: string;        // as PR27, 16 hex chars (little-endian memory form)
  fileId128: string;                // FILE_ID_INFO
  kind: "file" | "directory";
};
type ArchiveHandleFacts = ArchiveIdentity & {
  attributes: number; reparseTag: 0; links: number;     // links must be 1 for files
  size: bigint | null; deletePending: false;
  ownerSidHash: string; daclHash: string;               // hashes only; no SID/DACL echoed
};
```

- **Capability** = {live handle chain root→target, per-handle `ArchiveHandleFacts` taken *after* open,
  PR #28 decision computed from a snapshot of those same retained handles, root anchor}.
  A decision computed from an earlier, separate observation is not accepted: `historical-snapshot`
  stays a label, and the contract adds the missing live retention. [P]
- **Root anchor.** The existing `OwnedRootIdentity` (F6) gains a Windows variant
  `{volumeSerialBytes, fileId128}` pinned at the user-triggered root configuration/probe. The first
  pin is a user-trust action; this draft does not claim to authenticate it. [P]
- **JS surface.** Handles never cross into JavaScript. The binding returns plain data
  (bytes, facts hashes, fixed error code) and closes everything before returning, or exposes only
  an operation object whose methods are the verbs in section 4 and a mandatory `close()`. [P]
- **Needs a future native entry** (`openArchiveChain`) that returns retained handles plus the snapshot
  from them. PR #27's `inspectChain` cannot be reused as is (F7, F8). This is a requirement, not an implementation. [P]

## 4. Acquisition and verification [P]

1. **Pre-open (pure).** Reject non-canonical forms before any open: UNC/device/`\\?\`, ADS, DOS 8.3 aliases,
   trailing dot/space, reserved names, case mismatch, mapped/`subst` drives (reuse PR #27's rules and
   `portableFilename`, `paths.ts:26-37`).
2. **Open chain.** Open the root handle, then each component. Preferred: relative-to-parent-handle
   opens ([V] requires an NT-level API; open decision D1). Fallback: absolute opens in order, where
   safety comes from step 3, not from the open. Every open uses `OPEN_EXISTING`,
   `FILE_FLAG_OPEN_REPARSE_POINT`, noninheritable handles, no privilege enabled.
3. **Verify on the handles, before any content I/O (checkpoint C0).** For each handle: identity equals the
   anchor (chain, root pin); `GetFinalPathNameByHandle` equals the canonical path; no reparse tag; kind matches; delete-pending false;
   links == 1 (files); attribute set within the PR #28 subset; owner/DACL equal what PR #28 evaluated;
   then run the PR #28 predicate on the snapshot of those retained handles (`candidate` required, but never sufficient alone).
4. **Sharing.** Content and ancestor handles held by an operation use the narrowest sharing that still lets
   the operation run: files deny write and delete for others; directories deny delete/rename.
   Protection is **per held handle**: every ancestor and the leaf is held and denies delete individually.
   No propagation from a child handle to its parents is assumed ([V]: whether an open descendant also blocks
   a parent rename is measured, not relied on). A sharing violation (AV, indexer, another process) is
   `archive_io_busy`: no retry inside the operation.
5. **Re-verify at checkpoints** C1 (before first byte), C2 (after last write and flush, or after last read),
   C3 (after publication, before the caller commits): re-read the same facts from the same handle and compare the whole tuple.
   Any difference is `archive_io_metadata_changed`. Limit: change-and-restore between checkpoints is not detectable
   by comparison alone (F8); only the sharing denial in step 4 bounds it.

## 5. Verbs

### 5.1 `read-file(max)`
Acquire and verify (C0). Size from the handle's end-of-file, bounded by the existing limit. Read with explicit offsets
until exactly that size, then confirm EOF and an unchanged size (parity with `paths.ts:119-127`). C2 re-check. Close.
Never read through a path after acquisition.

### 5.2 `create-file(bytes)` (exclusive create + write + flush)
1. Parent chain acquired and verified (C0). 2. `CREATE_NEW` for the leaf (the O_EXCL equivalent; an existing name is
`archive_io_exists`, never an overwrite), noninheritable, explicit protected DACL granting only trusted principals and
including the owner `READ_CONTROL|FILE_READ_ATTRIBUTES` grant that PR #28 requires ([V] attaching the descriptor at creation
avoids an unprotected window; confirm). Requested rights include data read/write, `READ_CONTROL`, `FILE_READ_ATTRIBUTES`,
and `DELETE` only when cleanup needs it. 3. Verify the new object on its handle (C0'): new identity not equal to any chain anchor,
kind file, size 0, links 1, no reparse, final path as expected. 4. Bounded write loop with explicit offsets; zero or negative
progress, or progress beyond the remainder, is an error (parity with `writeAll`). 5. Read back through the **same handle**, compare
hash. 6. Flush the file handle (`FlushFileBuffers`); failure is `archive_io_flush_failed`. 7. C2 re-check; record the final tuple
{identity, size, hash, daclHash, links}. 8. Close.

### 5.3 `publish-directory` (stage, publish, verify)
Keeps the existing shape (F4): `staging-<requestId>-<uuid>` under the verified parent, files created by 5.2.
- **Binding across rename.** Windows is expected to refuse renaming a directory that has open child handles ([V]), so file handles
  are closed before publication and the **post-publication reopen is the binding**: reopen every file via a fresh chain and require the
  recorded tuple from 5.2 (identity, size, hash, daclHash, links = 1). The directory handle is retained through rename.
- **No-replace publication.** Rename by handle to the destination with replace disabled so an existing destination fails atomically
  ([V]: `SetFileInformationByHandle` / `FILE_RENAME_INFO` with `ReplaceIfExists = FALSE`, and whether a relative root handle is allowed;
  open decision D3). This replaces the `existsSync` then `renameSync` race (F4). After rename, the retained directory handle's final path
  and identity must equal the destination and the staged identity (C3). An existing destination is `archive_io_publish_conflict` (retryable by the caller, as today).
- **Post-publication mismatch.** If the reopen verification fails (identity, size, hash, DACL hash, links), the caller must not commit.
  The destination is preserved untouched and reported as `archive_io_post_publish_mismatch`; it is never deleted, repaired or
  adopted. A later attempt finds the destination, re-verifies exact bytes, fails the same way and refuses (existing F5 behavior).
  The window between closing file handles and reopening can therefore end in *detection*, not prevention. Whether a
  POSIX-semantics rename (`FILE_RENAME_FLAG_POSIX_SEMANTICS`, [V]) could rename with file handles still held is part of D6.
- **Caller commit order is unchanged.** The SQLite transaction (F4) still serializes cooperating publishers; the contract adds atomic no-replace on top of it, not instead of it.

### 5.4 `recover-scan(parent)`
Read-only enumeration of one verified parent through its handle. Classify children by name pattern `staging-<requestId>-<uuid>`
only. Never delete in the scan. Report per child: kind, identity, link/reparse facts, and whether every entry is in the expected set.

## 6. Durability and crash recovery [P]

Report a tier on every publication; do not claim more than was proven:

| Tier | Meaning on Windows | Claimed? |
|---|---|---|
| D0 | none | n/a |
| D1 | the OS reported completion of `FlushFileBuffers` on the file handle; device write-cache behavior is not controlled or claimed | yes, after 5.2 step 6 |
| D2 | directory-entry/rename durability | **unproven** [V]: no documented directory-fsync equivalent is used here; `MOVEFILE_WRITE_THROUGH` is path-based and would break handle binding; volume flush needs elevation (prohibited) |

The contract therefore requires recovery to be correct **without** D2. Crash points and outcomes:

| Crash after | Observable state | Recovery |
|---|---|---|
| nothing / stage dir created | empty or partial staging | preserve; `recover-scan` reports; cleanup only by 6.1 rules |
| files written and flushed, not renamed | complete staging, no destination | preserve; republish creates a new staging; never adopt old staging implicitly |
| rename done, DB not committed | destination exists | verify exact bytes by `read-file` (existing F5 behavior), then commit |
| rename lost (D2 gap) | staging only | same as the previous row |
| older orphan staging **and** a verified destination both exist | destination + `staging-*` | destination is authoritative once verified; the orphan is preserved, reported by `recover-scan`, never adopted or auto-deleted |
| committed | destination + DB row | nothing |

### 6.1 Failure and cleanup (applies to every verb)
- Native RAII/`finally`: every handle is closed on every exit; an error never leaks a handle.
- Errors are fixed codes plus a numeric Win32 code; no path, SID or DACL is echoed (PR #27 convention):
  `archive_io_identity_changed`, `archive_io_reparse`, `archive_io_links`, `archive_io_metadata_changed`,
  `archive_io_busy`, `archive_io_timeout`, `archive_io_exists`, `archive_io_flush_failed`, `archive_io_publish_conflict`,
  `archive_io_post_publish_mismatch`,
  `archive_io_cleanup_uncertain`, `archive_io_unsupported_filesystem`. They map into the existing `ArchiveError` shape.
- Cleanup removes only objects **this operation created**, each re-verified on its own handle against the recorded identity
  before deletion (delete by handle, [V]), bottom-up (files, then child directories, then staging). It never recurses, never
  follows a reparse point, and never deletes anything it cannot identify. On any doubt it **preserves** and reports
  `archive_io_cleanup_uncertain` with the staging *name* only (parity with `durable.ts:197`, `store.ts:502`). A cleanup failure never masks the original error.

## 7. Negative-test matrix

Layers: **U** = TypeScript unit with a deterministic fake native adapter (no OS); **W** = Windows integration on an
authorized disposable host in owned fixtures only (no user data, no ACL change outside the fixture, no elevation).
Every W row also asserts: handle count returns to baseline, fixture left byte-identical or preserved as stated.
"Observe" rows record actual Windows behavior to confirm or refute a [V] assumption; they are not pass/fail until reviewed.

| ID | Case | How injected | Expected | L |
|---|---|---|---|---|
| N1 | Reparse (junction/symlink) at root, each ancestor, and leaf | create before open | `archive_io_reparse`, no I/O, no cleanup of foreign data | W |
| N2 | Ancestor swapped to reparse after C0 | other process, while held | rename/swap blocked (observe) or C1/C2 mismatch; never a read/write through the new target | W |
| N3 | Target replaced (delete + recreate) between snapshot and open | owned helper process | `archive_io_identity_changed` | W |
| N4 | Target replaced after open, before read/write | owned helper | blocked by sharing (observe) or C2 mismatch; no foreign bytes returned | W |
| N5 | Existing hardlink (links 2) at open | `CreateHardLink` in fixture | `archive_io_links` | W |
| N6 | Hardlink added while handle held | owned helper | blocked (observe) or C2/C3 `archive_io_links`; output quarantined | W |
| N7 | DACL/owner changed between checkpoints | fixture-local `SetSecurityInfo` | `archive_io_metadata_changed` | W |
| N8 | Attribute change (readonly, hidden, sparse, compressed, encrypted, offline) | fixture-local | `archive_io_metadata_changed` or PR #28 `attributes_unsupported` | W |
| N9 | Size change by another writer / truncate / extend during read | helper with and without share | blocked (observe) or `archive_io_metadata_changed`; never a torn read | W |
| N10 | Delete-pending set via another handle | delete disposition | rejected at C0 or C2 | W |
| N11 | Change-and-restore of an ACL between checkpoints | helper | **documented undetectable by comparison**; sharing denial effect recorded (observe) | W |
| N12 | Exclusive create over an existing file | pre-existing leaf | `archive_io_exists`; existing bytes and DACL untouched | W/U |
| N13 | Publish onto an existing destination (file, empty directory, non-empty directory) | pre-existing; the empty-directory case confirms or refutes the [V] no-replace behavior | `archive_io_publish_conflict`; destination untouched; staging preserved or cleaned per 6.1 | W/U |
| N14 | Two concurrent publishers, same destination | two owned processes | exactly one wins; the loser is conflict; no mixed content | W |
| N15 | Short, zero and over-progress write | fake adapter | error, no loop, cleanup per 6.1 | U |
| N16 | Flush failure and read-back mismatch | fake adapter | `archive_io_flush_failed` / hash mismatch; no publication | U |
| N17 | Crash at each phase (before create, mid-write, after flush, before/after rename, before commit) | kill the owned child process | outcomes exactly as the section 6 table; recovery idempotent | W |
| N18 | Cleanup after parent swapped to a junction | helper | nothing deleted through it; `archive_io_cleanup_uncertain` | W |
| N19 | Unknown extra file inside staging | fixture | preserved, not deleted, reported | W/U |
| N20 | Path forms: ADS, 8.3 alias, trailing dot/space, device names, UNC, `\\?\`, case variants, `subst`/mapped drive | inputs | rejected before any open | U/W |
| N21 | File ID reuse after delete/recreate of the same name | fixture loop | record whether identities differ; if reuse occurs, the held handle (not the ID) must be the binding | W observe |
| N22 | Unsupported filesystem (no 128-bit ID: FAT/exFAT, network, removable) | volume fixture | `archive_io_unsupported_filesystem` | W |
| N23 | Sharing violation, oplock holder or slow AV-like reader on the file/ancestor | helper holding it with no share, with an oplock, or reading slowly | `archive_io_busy` or `archive_io_timeout`, single attempt, no retry, no hang past the deadline | W |
| N24 | Denied `READ_CONTROL` / unreadable DACL | fixture ACL | fixed error, no fallback | W |
| N25 | Oversize file/total/entry count | inputs at and over each limit | existing size-limit errors, nothing written past the limit | U |
| N26 | Handle leak on every error path above | baseline handle count | no growth | W |
| N27 | PR #28 `candidate` + stale snapshot (opened earlier) | pass an older decision | rejected: decision not computed from the retained chain | U |
| N28 | File replaced or altered after close, before the post-publication reopen | helper in the window | `archive_io_post_publish_mismatch`; destination preserved; retry refuses | W |
| N29 | Orphan staging plus verified destination | fixture | destination verified, orphan preserved and reported | W/U |

## 8. Gates and sequence

1. **Design review of this document** (current). No implementation starts before it is closed.
2. **Interface + fake adapter + U rows** (pure TypeScript, deterministic fault injection). Windows storage still refused.
3. **Native `openArchiveChain` and verbs** on an authorized disposable host, `/W4 /WX`, existing tooling only.
4. **W rows N1-N24 and N26-N29**, evidence recorded without SIDs/DACLs/paths. All [V] items are resolved or rejected explicitly.
5. **Activation** only by an explicit later decision; default remains refusal.

Out of scope here: runtime/supervisor/issuer binding, authentication or ACL changes, any native I/O code, a durability claim stronger than D1.

## 9. Open decisions for reviewers

- **D1** Relative opens through an NT-level API versus absolute opens plus handle verification (section 4 step 2).
- **D2** Exact sharing masks and expected AV/indexer interference (section 4 step 4); is `archive_io_busy` without retry acceptable operationally?
- **D3** Rename primitive and no-replace semantics (section 5.3).
- **D4** Is D1 durability plus recovery-without-D2 acceptable, or must the activation gate require a proven directory-durability method?
- **D5** Root anchor provenance and the pin schema change for Windows (section 3).
- **D6** Whether the post-rename reopen (detection, not prevention) is an acceptable binding, or file handles must be kept open (a different publication shape, possibly POSIX-semantics rename).

## 10. Second-opinion record

One review pass by `gemini-3.8-flash-low` via the AGY CLI (`--mode plan`, existing authentication, no tools requested), given only this draft and five
questions. The tool returned no model name; the requested model is the only evidence of what ran. Findings were checked against the source and the
[V] labels, not accepted wholesale.

- **Adopted:** post-publication tamper handling (5.3, N28); orphan staging next to a verified destination (section 6, N29); D1 reworded to OS-reported completion only;
  oplock/slow-reader case and per-operation deadlines (principle 6, N23); per-handle (not propagated) sharing protection (section 4).
- **Kept as [V], not as fact:** the claim that `ReplaceIfExists=FALSE` can overwrite an empty destination directory is unsupported here; N13 now tests it explicitly.
- **Already in the draft:** strict identity match on reopen (F9/5.3).
