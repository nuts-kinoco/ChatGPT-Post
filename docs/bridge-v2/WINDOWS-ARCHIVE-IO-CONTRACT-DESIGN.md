# Operation-scoped Windows archive IO contract (corrected candidate)

Status: **corrected design candidate; no native/runtime/OS/auth change or Windows activation.**
Fixed correction base: PR29 `3765d023683bbb20df24f7f674f2585664be3dd2`, stacked on
PR28 `4253bf373d4564667cf2966a8eaf9cd5b3e3af02` and PR27
`0e5e5a2f8474c9715e696bcf952c797cfb1db143`. Existing Windows storage guards remain refused.

[F] means a checked-in fact at PR29; [P] is a proposed contract; [V] requires actual
Windows measurement. Official pages in section 9 were re-read for this correction;
documentation and fake tests are not integration evidence.

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

**Gap.** PR28's historical candidate does not authorize later pathname IO and PR27
closes its observation handles. The following model describes a future retained-handle
contract; it does not implement that contract or authenticate adapter evidence.

## 2. Authority and independent trust [P]

One nonserializable operation owns symbolic references to a retained chain and its
children. Every pre-existing chain member, including existing read/recovery leaves,
requires an explicit Windows identity anchor with independent provenance. Root-only
trust is insufficient. Copying the same observation into expected identities is not
independent provenance. Missing trust refuses; there is no automatic POSIX-pin migration
or snapshot-derived pin. The real provenance provider and Windows pin schema remain [V].
Exclusive-created children bind to the live create result within that operation instead
of pretending a prior identity anchor exists for them.

A policy decision must be computed from those same retained handles in the same operation.
A stale PR28 candidate is rejected. Capability lifetime, anchor provenance and binding
cannot be proven by plain JSON claims; fake references only simulate these requirements.

Acquisition uses a retained parent plus exactly one validated component, with no absolute
open fallback. Root acquisition uses its explicit anchor. Noncanonical paths, UNC/device,
ADS, dot/empty components, reserved/8.3/case aliases and mapped/subst identity mismatches
are refused. `NtCreateFile` documents RootDirectory-relative names; exact options and
required behavior on this host remain [V]. No privilege is enabled.

Sharing protection is per held handle, never inherited from a leaf to ancestors.
One sharing violation is `archive_io_busy`, with no internal retry or sharing relaxation.
Share modes do not ensure owner/DACL/attributes are immutable, block every hardlink change,
or detect change-and-restore. Actual sharing/open-child behavior remains [V].

## 3. Stable facts and planned transitions [P]

Same-handle facts include volume serial / 128-bit file ID / kind, owner and DACL hashes,
links, reparse tag, delete-pending, attributes, size and final path. No SID/DACL/path data
is echoed by error results. Stable identity/security/link facts must match C0 throughout
C1 (before bytes), C2 (after IO/flush) and C3 (after rename, before commit).

Size and namespace spelling are phase-specific, not universally immutable:

- Read: exact bounded size, offsets and EOF; size remains the opened size.
- Exclusive create: new identity, file size 0, link count 1; writes advance to expected N.
- Explicit planned write-attribute changes (for example archive marking) must be declared;
  any unplanned attribute/security/link/reparse/delete-pending change refuses.
- Rename: staged namespace prefix becomes the destination prefix, but the same retained
  references and identity/security/link facts remain. No close/reopen substitution.

Comparisons cannot detect a change followed by restoration between checkpoints. A sharing
mask does not fix this ACL/attribute limitation. Candidate results make no tamper-prevention claim.

## 4. Verbs [P]

`read-file(max)`: acquire/verify C0/C1; bounded explicit-offset reads; require exact size
and EOF; C2 verification; return bytes only after verification and IO quiescence.

`create-file(bytes)`: acquire parent C0/C1; relative exclusive create with protected trusted
security descriptor [V]; bind its new retained handle at size 0; bounded write loop (positive
short progress is allowed; zero/negative/over-progress fails); same-handle readback; file
flush; C2 at size N. Standalone create/read then close only when no IO remains pending.

`publish-directory`: create a unique stage under the retained parent and keep stage, files
and all parents bound continuously. File close from standalone create is deferred inside
publication. Require stage directory durability before rename. Candidate rename uses
`FILE_RENAME_INFO` RootDirectory=retained parent, one relative destination component and
ReplaceIfExists=FALSE. This is documented API shape, **not verified host behavior**.
An existing destination (file/empty/nonempty directory) must conflict untouched. No
check-then-rename, replace, absolute-path, or POSIX-flag workaround is allowed.

If retained children/sharing cannot coexist with rename, publication is unsupported.
After rename: C3 with planned new paths on the same references, same-handle content
verification, file + directory/parent durability requirements, then candidate DB commit
and ACK. Failed post-publication verification preserves destination; no commit, deletion,
repair or adoption by that operation. SQLite serialization of cooperating publishers
continues to be required; fake effects do not touch a DB.

`recover-scan(parent)`: bound readonly enumeration; never delete during scan. Existing
staging is never implicitly adopted. Recovery remains the existing content-based protocol;
operation identities are not persisted. A later same-bytes replacement cannot be promised
rejected using the earlier operation's identity. Independently verified current chain +
content may satisfy recovery without proving continuity with the prior operation. No new
quarantine, journal, persisted identity record or repair protocol is introduced.

## 5. Durability and recovery [P]

D1 means OS-reported file-flush completion only, not controlled device cache behavior.
D2 means directory/namespace durability and remains unverified on Windows. Existing
file **and** directory durability criteria are preserved, including barriers before and
after publication. D1 alone cannot permit publication, DB commit or ACK. Without a proven
D2 mechanism, actual Windows publication remains unsupported; fake barriers are assumptions.

| Crash/evidence | Recovery |
|---|---|
| no destination, partial/complete staging | preserve staging; DB uncommitted; incomplete/no ACK; do not adopt old staging |
| rename lost, staging only | same preservation row, **never** the destination-exists row; no candidate DB commit |
| destination exists, DB uncommitted | independently verify full current chain + exact content + file/directory criteria before candidate commit |
| verified destination plus orphan staging | destination may satisfy the content protocol; orphan preserved and reported |
| DB committed, destination and contents still verified | candidate completion requires current content/trust/durability verification; DB alone is insufficient |
| DB committed, rename/file lost, missing destination/file or content mismatch | incomplete/no ACK; preserve staging/evidence; no inferred completion or invented DB repair |

Same-bytes cross-operation replacement remains a limit, including after a previous operation
refused an identity mismatch. In-operation handle identity is not a durable next-operation pin.

## 6. Deadline, pending IO and cleanup [P]

A deadline is an application failure observation, **not IO completion evidence**.
`CancelIoEx` requests cancellation and does not wait for completion; success or
ERROR_NOT_FOUND alone does not prove quiescence. Cancellation can race with successful
completion. While any issued request is pending: no cleanup, close, publication, DB commit
or ACK, and resources remain retained. Eventual terminal completion permits finalization,
not resumption of a timed-out operation. Physical drain latency remains [V].

After quiescence, cleanup may delete only objects this operation exclusive-created and
re-verified by the same retained references and stable facts, bottom-up, with no unknown
entries, changed parent, reparse, untrusted identity or recursion. Anything uncertain is
preserved. Published destinations and pre-existing/orphan staging are preserved. Cleanup
failure never replaces the first operation error. Close all references only after quiescence;
pending references are intentionally retained and must not be reported as closed/leak-free.

## 7. Negative-test matrix

N1-N29 below retain the original cases, with corrected expectations. A pure fake may represent
every row; it checks the modeled boundary only. W rows are still unperformed Windows tests,
not evidence that share modes, NT calls, handle counts or crash durability behave as modeled.
N11's equality case demonstrates an undetectable comparison limit; it cannot be called prevention.

| ID | Case | How injected | Expected | L |
|---|---|---|---|---|
| N1 | Reparse (junction/symlink) at root, each ancestor, and leaf | create before open | `archive_io_reparse`, no I/O, no cleanup of foreign data | W |
| N2 | Ancestor swapped to reparse after C0 | other process, while held | rename/swap blocked (observe) or C1/C2 mismatch; never a read/write through the new target | W |
| N3 | Target replaced (delete + recreate) between snapshot and open | owned helper process | `archive_io_identity_changed` | W |
| N4 | Target replaced after open, before read/write | owned helper | blocked by sharing (observe) or C2 mismatch; no foreign bytes returned | W |
| N5 | Existing hardlink (links 2) at open | `CreateHardLink` in fixture | `archive_io_links` | W |
| N6 | Hardlink added while handle held | owned helper | blocked (observe) or C2/C3 `archive_io_links`; no ACK; preserve uncertain state; no new quarantine protocol | W |
| N7 | DACL/owner changed between checkpoints | fixture-local `SetSecurityInfo` | `archive_io_metadata_changed` | W |
| N8 | Attribute change (readonly, hidden, sparse, compressed, encrypted, offline) | fixture-local | `archive_io_metadata_changed` or PR #28 `attributes_unsupported` | W |
| N9 | Size change by another writer / truncate / extend during read | helper with and without share | blocked (observe) or `archive_io_metadata_changed`; never a torn read | W |
| N10 | Delete-pending set via another handle | delete disposition | rejected at C0 or C2 | W |
| N11 | Change-and-restore of an ACL between checkpoints | helper | **documented undetectable by comparison**; sharing does not guarantee ACL/attribute invariance | W |
| N12 | Exclusive create over an existing file | pre-existing leaf | `archive_io_exists`; existing bytes and DACL untouched | W/U |
| N13 | Publish onto an existing destination (file, empty directory, non-empty directory) | pre-existing; the empty-directory case confirms or refutes the [V] no-replace behavior | `archive_io_publish_conflict`; destination untouched; staging preserved or cleaned per 6.1 | W/U |
| N14 | Two concurrent publishers, same destination | two owned processes | exactly one wins; the loser is conflict; no mixed content | W |
| N15 | Short, zero and over-progress write | fake adapter | positive short progress advances bounded loop; zero/negative/over-progress errors; cleanup only after quiescence | U |
| N16 | Flush failure and read-back mismatch | fake adapter | `archive_io_flush_failed` / hash mismatch; no publication | U |
| N17 | Crash at each phase (before create, mid-write, after flush, before/after rename, before commit) | kill the owned child process | outcomes exactly as the section 6 table; recovery idempotent | W |
| N18 | Cleanup after parent swapped to a junction | helper | nothing deleted through it; `archive_io_cleanup_uncertain` | W |
| N19 | Unknown extra file inside staging | fixture | preserved, not deleted, reported | W/U |
| N20 | Path forms: ADS, 8.3 alias, trailing dot/space, device names, UNC, `\\?\`, case variants, `subst`/mapped drive | inputs | rejected before any open | U/W |
| N21 | File ID reuse after delete/recreate of the same name | fixture loop | record whether identities differ; if reuse occurs, the held handle (not the ID) must be the binding | W observe |
| N22 | Unsupported filesystem (no 128-bit ID: FAT/exFAT, network, removable) | volume fixture | `archive_io_unsupported_filesystem` | W |
| N23 | Sharing violation, oplock holder or slow AV-like reader on the file/ancestor | helper holding it with no share, with an oplock, or reading slowly | one attempt, no sharing relaxation; timeout is pending/no ACK until IO completes, with no cleanup/close/commit | W |
| N24 | Denied `READ_CONTROL` / unreadable DACL | fixture ACL | fixed error, no fallback | W |
| N25 | Oversize file/total/entry count | inputs at and over each limit | existing size-limit errors, nothing written past the limit | U |
| N26 | Handle leak on every error path above | baseline handle count | no growth | W |
| N27 | PR #28 `candidate` + stale snapshot (opened earlier) | pass an older decision | rejected: decision not computed from the retained chain | U |
| N28 | Continuous binding unavailable / later-operation same-bytes replacement | helper in the window | publication unsupported without continuous binding; in-operation mismatch refuses; later content-only recovery does not guarantee identity rejection | W/U |
| N29 | Orphan staging plus verified destination | fixture | destination verified, orphan preserved and reported | W/U |

## 8. Conservative decisions, gates and limits

D1: retained-parent-relative single components only. D2: one busy failure, no relaxed
sharing/retry. D3: RootDirectory + ReplaceIfExists FALSE is only a candidate pending host
measurement. D4: preserve file + directory criteria, with no D1 downgrade. D5: independent
provenance for **every** pre-existing chain member, missing trust refuses, no automatic
pin migration. D6: continuous children/parent binding through rename; otherwise publication
unsupported, with no post-reopen/POSIX workaround.

Sequence: docs consistency review, then a separate pure state-machine/fake-test commit;
future native implementation and authorized W measurements only by another explicit task.
Activation needs a later explicit decision and verified Windows gates. No native dependency,
real FS adapter, OS ACL/auth change, model call or runtime guard change is part of this work.

PR29's recorded AGY/Claude review is historical and was not rerun. Its close/reopen and D1
suggestions are superseded by sections 4-6. No current assertion relies on that review as
host evidence. A fake model cannot authenticate anchor provenance or adapter assertions,
prove NTFS race resistance, certify directory durability or enable Windows storage.

## 9. Official references re-read for this correction

- [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile): RootDirectory-relative ObjectName; chosen single-component restriction is stricter.
- [FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info): relative RootDirectory and ReplaceIfExists fields; continuous-child/sharing behavior remains unverified.
- [CancelIoEx](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelioex): request cancellation, not completion waiting.
- [MS-FSA FileRenameInformation](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/87f86c9b-6c2a-4803-84b7-131a74a434fa): reference object-store rename algorithm, not target-host evidence.
