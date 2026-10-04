# Windows archive metadata observation (candidate only)

This independent Node-API component observes metadata for an explicitly supplied
absolute local Windows path and its ancestors. It is not connected to archive,
deployment, registry, or SDK runtime acceptance. Existing Windows rejection guards
remain in place. It has no process, authentication, signing, privilege, ACL mutation,
service, driver, or file-content operations.

## Contract

Load the compiled binding explicitly; importing existing runtime code does not load it:

```js
const { inspectChain } = require("./dist/archive-inspection/archive-inspection.node");
const observation = inspectChain("C:\\owned-fixture\\sample.txt");
```

The declaration in `native/archive-inspection/index.d.ts` documents the result.
`archive-win32-observation-1` contains ordered entries from the drive root through
the supplied target. Every entry contains its path, normalized final path, owner SID,
complete DACL bytes, DACL protected flag, ACE types, attributes, reparse tag, link
count, directory flag, volume serial bytes and 128-bit file identity.
Volume serial bytes are the hexadecimal little-endian memory representation, not
a formatted numerical serial. DACL bytes are an observation, not an effective
access calculation. No field represents trust, availability, or permission.
Owner SIDs and DACLs are private metadata; do not publish raw observations.

Input is one primitive string only, bounded to 4096 UTF-16 code units and 128
entries. It requires an uppercase drive letter and canonical backslash components.
UNC/device paths, ADS, controls, empty/dot components, reserved DOS names, and
trailing dots/spaces/slashes are rejected before opening anything. A mapped drive
or alias that produces a different normalized path is rejected.

Each entry is opened with `OPEN_EXISTING`, `READ_CONTROL | FILE_READ_ATTRIBUTES`,
`FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS`, and noninheritable
handles. Read/write/delete sharing remains enabled; the binding acquires no lease.
No privilege is enabled. Backup semantics permits opening directories.
Owner/DACL (`GetSecurityInfo`), attributes/tag, identity and standard information
(`GetFileInformationByHandleEx`) are obtained from that entry's same handle.
Final path is also queried from the handle. All ancestor handles remain open until
the call finishes and are closed on success and exception.

Each handle is observed twice initially. After all entries are opened, each held
handle and an independently reopened name are compared against the initial full
snapshot. Detected differences throw `archive_inspection_changed`. This is a bounded
observation window: it does **not** make the traversal or security-descriptor reads
atomic and cannot detect every concurrent change (including change-and-restore).
`FILE_FLAG_OPEN_REPARSE_POINT` applies to the final component of each open, so every
ancestor is inspected separately. It does not guarantee an intermediate component
was never followed during a racing open. Returned observations are historical, not
handles suitable for subsequent secure content IO.

Errors throw fixed codes with a numeric Win32 error and omit path/owner/DACL data.
There is no fallback. Reparse points, delete-pending objects, missing/invalid/null
DACLs, missing/invalid owner SIDs, failed/unsupported identity queries, path aliases,
and ACE types other than basic allow/deny are rejected. Empty non-null DACLs can be
observed; the binding makes no access decision about them. A caller must not convert
successful observation into a storage permission. No durability API is implemented.

## Build with existing tooling

Windows x64 Node and an existing MSVC/Windows SDK are required. The script does not
install or download tooling. Supply the Node headers and x64 import library for the
local Node version, with their official SHA256 checksums independently verified:

```powershell
./scripts/build-archive-inspection.ps1 `
  -NodeIncludeDirectory '<verified Node headers>/include/node' `
  -NodeImportLibrary '<verified x64>/node.lib' `
  -MsvcDirectory '<existing MSVC tools version>' `
  -WindowsSdkDirectory '<existing Windows Kits/10>' `
  -WindowsSdkVersion '<existing SDK version>'
node scripts/test-archive-inspection.mjs
```

Compiler/linker outputs and owned test fixtures stay under ignored `dist/`.
The build uses `/W4 /WX`, C++17 and Node-API version 8. No binary is checked in.
This candidate has no automatic installation or runtime loader.

## Local unit evidence

Windows x64, Node v24.16.0, MSVC 14.44.35207, Windows SDK 10.0.26100.0:
9 cases / 148 assertions passed in the dedicated worktree on 2026-10-04 UTC.
The assertion count includes ancestor observations and varies with fixture depth.
Tests create only synthetic owned fixtures and emit no owner/DACL values.

- All ancestors, file/directory fields, metadata shapes and stable repeat observations.
- Hardlinks report the same volume/file identity and link count 2.
- Missing names, non-string inputs and ambiguous path forms throw.
- A fixture junction is rejected as the target and as an ancestor.
- Replacing a file between calls produces a distinct identity.

Within-call adversarial races, null/unsupported ACL fixtures, denied READ_CONTROL,
unusual filesystems, network mappings, resource exhaustion and crash cleanup have
not been verified. Replacement between calls is not a concurrent-race proof.
ACL policy, actual archive reads/writes, durable publication and runtime activation
are outside these unit checks. This candidate does not complete or pass Bridge v2.

## Primary references

- [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo): same-handle security metadata, READ_CONTROL and race limitation.
- [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew): requested access, sharing, noninheritance, reparse and directory flags.
- [GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex).
- [FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info).
- [Node 24.16.0 checksums](https://nodejs.org/download/release/v24.16.0/SHASUMS256.txt).
