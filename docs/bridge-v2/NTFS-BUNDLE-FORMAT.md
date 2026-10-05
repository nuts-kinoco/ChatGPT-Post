# ntfs-bundle-1: immutable in-memory container format

Status: format implementation and design-review candidate only. Based on PR17
`14655e42562c52c56b5db8e62c5d16f3ce5e25be`. No runtime consumes this codec. Importing it
does not access files, Windows APIs, SQLite, transport, credentials or models. The name
does not establish NTFS support. All existing Windows refusal guards remain unchanged.

## Exact bytes

The container has a fixed 16-byte prefix, a canonical UTF-8 JSON index, then raw member
bytes concatenated in index order. There is no compression, timestamp, padding, directory
entry, offset field, external reference or trailing data.

| Offset | Size | Encoding |
| --- | --- | --- |
| 0 | 8 | ASCII `NTFSBND1` (hex `4e544653424e4431`), including format version 1 |
| 8 | 4 | Unsigned big-endian index byte length |
| 12 | 4 | Unsigned big-endian member count |
| 16 | index length | Canonical index, no BOM or final newline |
| 16 + index length | sum of member lengths | Raw bytes, including zero-length members |

The only index root key is `members`. Each row has exactly these keys in this order:

```json
{"members":[{"name":"result.json","length":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}]}
```

For that example the one member is the ASCII bytes `abc`. SHA-256 is over the member's
exact raw bytes. Rows are sorted by unsigned ASCII bytewise name order, independent of
locale. Canonical JSON is compact `JSON.stringify` of that exact root/row construction:
no whitespace, escaped names, alternate key order, duplicate decoded JSON keys, extra
fields, alternate number spelling or uppercase digests. Integers use plain decimal
digits; zero is `0`, never `-0`. The decoder compares the original index bytes to this
serialization after strict UTF-8/duplicate-key/integer validation. Canonical JSON here
is a format-specific definition, not a claim to implement general JSON canonicalization.

Names are logical relative slash-separated names, at most 4096 ASCII characters. Each
component uses the existing archive `portableFilename` rules: 1–120 characters,
alphanumeric first, then alphanumeric/dot/underscore/hyphen, no trailing dot/space,
and no `CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9` or `LPT0`–`LPT9` stem (case-insensitive,
including extensions). Absolute, empty, dot, parent, backslash, ADS, control and Unicode
names are rejected. Entire names must be unique including ASCII case folding.
These are logical members only; the codec does not extract paths or authorize filesystem
layout. A future extraction adapter must separately reject file/directory prefix conflicts.

Limits, inclusive: 128 members (zero is allowed), 16 MiB per member, 64 MiB aggregate raw
data, 64 KiB index, and `64 MiB + 64 KiB + 16` container bytes. Every cumulative addition
is checked as a safe nonnegative integer against its bound before allocation or access.
Lengths do not authorize offsets: offsets are computed cumulatively from 16 + index length.
All rows and every exact member hash must match; the final cumulative end must be exact EOF.

## API and ownership

`encodeNtfsBundle([{name, bytes}, ...])` captures independent copies before hashing and
concatenation. Input ordering does not affect output. The returned container is caller-owned.

`decodeNtfsBundle(container, expectedMembers)` requires the exact expected set of
`{name,length,sha256}` identities. Expected ordering is immaterial. Authentication/provenance
of that set is a separate caller responsibility; a self-derived set does not prove trust.
Missing/extra/name/length/hash differences are rejected. This includes a retry whose raw
signed envelope differs even if its decoded logical payload appears equal. The codec does
not verify signatures, publish retries, select a destination or provide idempotency authority.

The decoder takes a bounded private snapshot of the container before parsing and hashing.
Metadata is detached and frozen. `memberBytes(name)` returns a fresh copy of the verified
snapshot on every call, not a retained mutable alias. Mutating the input, expected records
or a previously returned member cannot change later reads or recorded hashes. Returned
copies themselves are mutable; a caller must keep or reverify any bytes it later changes.
SharedArrayBuffer is refused because concurrent copying is not a coherent snapshot protocol.
Detached views are refused. Ordinary Uint8Array and Buffer subviews are supported without
consulting shadow buffer/length accessors. Cross-realm and typed-array subclasses are outside
the supported API; record accessors, sparse arrays and extra fields are refused. Proxy traps
may run during shape inspection, so this is not an execution boundary for hostile JS code.
Exceptions from caller traps are reduced to fixed diagnostics without reading their message.

`containerSha256` identifies container bytes only. It never replaces the existing raw
TaskSpec, payload, artifact, manifest, signed envelope or receipt hashes. Existing pins and
archives retain their existing meaning; there is no migration, adoption or reinterpretation.
No filesystem or transport code calls this API in this change.

## Publication remains unresolved

The proposed future storage unit is one immutable bundle file rather than a directory of
open child files. This removes the directory-with-open-child structure from publication;
it does not prove that a held bundle handle can be renamed or that publication is durable.
The existing directory contract remains historical/unconnected, not rewritten or enabled.

Separate design and actual-host evidence are required for independent trust-anchor provenance,
retained same-object user-mode access, ancestor/ACL/alias/race protection, bounded secure
creation, same-filesystem atomic no-replace publication with compatible handle sharing,
namespace durability before and after publication, crash/recovery, and durable DB/materialization
before ACK. `FlushFileBuffers` on contents alone is not a namespace durability proof.
Recovery must preserve original signed-envelope identity; matching logical payload cannot
authorize replacement, re-signing, a new request or model replay.

No close/reopen substitution, POSIX rename flags, elevated volume flush, protection removal,
or rejected R3/issuer design is part of this proposal. Parsing success proves byte-format
consistency and the supplied expected-set match only. It proves neither durable storage,
Windows activation, execution success nor permission to ACK.

References: [Microsoft directory rename restrictions](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information#remarks),
[file flush contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers),
[existing requirements](CONSOLIDATED-DESIGN.md), and
[unconnected Windows IO contract](WINDOWS-ARCHIVE-IO-CONTRACT-DESIGN.md).

## Verification scope

The unit suite covers an independently specified golden vector, raw binary/empty members,
deterministic ordering, count/index/member/aggregate limits, unsafe arithmetic metadata,
every truncation point of a nonempty fixture, trailing data, malformed/noncanonical JSON,
names and case collisions, missing/extra expected members, content/hash mutation, differing
signed-envelope retries, private-copy ownership, shared/detached inputs and exception secrecy.
Import-blocking mocks keep storage/process/schema-loader dependencies out of the codec.
These tests perform in-memory format checks, never native filesystem probes or model calls.

```sh
node node_modules/vitest/vitest.mjs run tests/unit/ntfs-bundle.test.ts
npm run typecheck
npm run lint
npm run build
```
