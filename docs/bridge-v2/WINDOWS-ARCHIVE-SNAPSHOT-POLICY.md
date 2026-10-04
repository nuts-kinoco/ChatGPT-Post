# Pure Windows archive snapshot policy candidate

Base: PR27 head `0e5e5a2f8474c9715e696bcf952c797cfb1db143`.
`src/archive/windows-snapshot-policy.ts` consumes the existing
`archive-win32-observation-1` shape and explicit caller policy. It returns a frozen,
deterministic `candidate`, `rejected`, or `unknown` result with a fixed reason and
optional entry index. Both rejection and unknown mean no candidate.

Every result has `basis: "historical-snapshot"` and
`pathnameIoAuthorization: false`, including a candidate. The type explicitly
provides no authority for later pathname IO. No runtime guard consumes this result;
existing Windows archive/deployment/registry/SDK refusal remains unchanged.

## Information preflight and scope

The current observation contains owner SID, complete DACL bytes, ACE type list,
DACL protected flag, directory/attribute/reparse/link information, and volume/file
identity for every ancestor. `daclHex` contains the ordered basic ACE headers,
masks and SID bytes. Those bytes suffice for the closed serialized subset below;
the native API is not extended or invoked by this predicate. The native declaration
is imported only as a TypeScript type.

The bounded reader consumes a detached hexadecimal snapshot. It does not manipulate
a live Windows ACL, replace `IsValidAcl`, or certify arbitrary Windows security
descriptors. It checks the documented ACL/ACE/SID layout, exact bounds/alignment,
revision and reserved bytes, and cross-checks the separately reported ACE types.
Unknown layouts and trailing application data are outside the subset. Unused ACL
capacity is accepted only when zero-filled. Native observations already reject
missing/null DACLs; hand-supplied null/missing/corrupt representations never become
candidates. An empty DACL is also excluded: Windows distinguishes it from a null
DACL, and this policy requires an explicit owner metadata-read grant.

The API does not provide an access token, enabled groups, privilege context,
inheritance generation, baseline provenance, or a retained secure IO handle. None
is invented. All DENY and inheritance flags are excluded, so no inheritance
generation/order calculation is needed. Caller trust and identity anchors are
explicit assumptions, and no effective Windows AccessCheck is calculated.
This limited candidate does not establish actual access, temporal stability,
filesystem authenticity, hardlink stability, or durability.

## Exact conservative subset

Inputs must be plain own-data objects and dense ordinary arrays; proxies, getters,
extra/symbol fields, subclassed containers and damaged shapes fail closed without
coercion. Bounds are 128 entries/anchors/trust SIDs, 4096 path code units, 4096 ACEs
and at most 65535 ACL bytes. Missing information produces `unknown`.

Caller policy supplies exactly:

- `trustedSids`: a nonempty, duplicate-free set of canonical SID strings. Supported
  trust namespaces are explicitly supplied LocalSystem, builtin Administrators,
  and `S-1-5-21-A-B-C-RID` with RID >= 1000. Namespace acceptance never adds trust.
  Everyone, authenticated users, builtin Users/Guests, placeholders and predefined
  domain groups are not allowed as trust entries. This restriction can reject
  legitimate configurations. Custom account-store SIDs can identify users or
  groups: their classification/membership is not inferred or verified; the caller
  remains responsible for selecting bounded trusted principals.
- `expectedIdentities`: ordered historical path/volume-serial-bytes/file-ID anchors
  for the root, every ancestor, and target. The predicate does not establish their
  provenance. A caller copying an observation into these anchors establishes no
  independent trust or lease.
- `targetKind`: `file` or `directory`.

For a candidate:

1. The entire canonical uppercase-drive/backslash chain is present, with exact
   final-path spelling and exact anchor paths. UNC, device, ADS, control/dot/empty
   components, DOS names and aliases are excluded. No case folding is used.
2. Nonzero canonical 64-bit volume bytes / 128-bit identities match every anchor.
   Every entry is on the same reported volume and identities are distinct.
3. No reparse evidence is present. Kinds agree with directory attributes and the
   target request. Only ordinary attributes (readonly/hidden/system/directory/
   archive/normal/temporary/not-content-indexed) are supported; NORMAL must stand
   alone. Device/sparse/compressed/offline/encrypted/integrity/recall/unknown bits
   and zero attributes are excluded. Every observed link count must equal one;
   missing/invalid counts are unknown, multiple file links are rejected.
4. Every owner is explicitly trusted. Every DACL is protected, revision 2,
   nonempty, and contains only basic ALLOW ACEs with zero flags. DENY, object,
   callback, conditional, inherited, inherit-only and all propagating ACEs are
   excluded. Duplicate ACE trustees and CREATOR/OWNER_RIGHTS/SELF semantics are
   excluded. ACE order is preserved; no ACE is sorted, offset or merged.
5. Masks are nonzero concrete file/directory plus standard rights within
   `0x001f01ff`. Generic/maximum-allowed/system-security/reserved rights are unknown.
   `FILE_DELETE_CHILD` on a file is outside the subset. At least one direct owner
   ACE visibly contains `READ_CONTROL | FILE_READ_ATTRIBUTES` (`0x00020080`). This
   is a structural requirement; it does not establish token access.
6. Every grant on the target is to an explicitly trusted SID. Ancestors may grant
   untrusted subjects only the concrete readonly/traverse/list mask `0x001200a9`.
   Add-file, add-subdirectory, write-data/EA/attributes, delete-child, DELETE,
   WRITE_DAC and WRITE_OWNER grants to outsiders are rejected. A DENY ACE is never
   used to neutralize them. Trusted principals' rights remain a caller assumption.

Ancestor checks address namespace replacement: child DELETE and parent
FILE_DELETE_CHILD are distinct rights. Readonly ancestor grants do not grant child
access; the target's own protected DACL is checked separately. No assumption is
made about effective grants from actual token groups or bypass privileges.

## Verification and reproducibility

Only synthetic SID/ACL/identity/path constants are used. Tests do not call native
inspection, change OS ACLs, elevate, read actual user files or start SDK/model calls.
Import-blocking tests exclude filesystem, child-process and SDK dependencies; a
temporary guarded `process` property confirms the predicate reads no ambient
process/environment trust. Snapshot evaluation itself performs no IO.

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/windows-snapshot-policy.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome.cmd check .
git diff --check
```

Final local evidence: 138 unit cases passed, root typecheck passed, repository lint
passed (350 files), and diff/secret checks passed. Existing tools/dependencies were
reused without installation. Sources contain only synthetic identities, and the
result never echoes raw SID/DACL/path data. The construction-vs-throw allocation
comment nit is a separate minimal commit; native behavior is unchanged.

Negative cases cover broad/duplicate/malformed trust, untrusted owner, absent owner
grant, target disclosure, every ancestor mutation bit, DENY ordering, inherited and
unsupported ACEs/masks, null/empty/broken binary ACLs, reparse at each depth,
unverified/multiple links, missing/mismatching/duplicate identity, damaged shapes,
getters/proxies and ambiguous paths. A fixed golden binary ACL supplements the
synthetic builder. No differential Windows AccessCheck, live native-to-policy run,
adversarial race, full-suite, Linux host or durability acceptance is claimed.

## Official design references

- [File access rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights) and [constants](https://learn.microsoft.com/en-us/windows/win32/fileio/file-access-rights-constants): concrete rights, generic mappings, deletion and child access distinctions.
- [ACE ordering](https://learn.microsoft.com/en-us/windows/win32/secauthz/order-of-aces-in-a-dacl): explicit/inherited and deny/allow order dependence; DENY is excluded from this subset.
- [Inheritance rules](https://learn.microsoft.com/en-us/windows/win32/secauthz/ace-inheritance-rules): effective/inherit-only propagation and placeholder mapping; all flags are excluded.
- [Null versus empty DACL](https://learn.microsoft.com/en-us/windows/win32/secauthz/null-dacls-and-empty-dacls).
- [ACL](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-acl), [ACE header](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-ace_header), [basic ALLOW ACE](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-access_allowed_ace), and [SID packet format](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-dtyp/f992ad60-0fe4-4b87-9fed-beb478836861): bounded serialized layout. Live ACLs remain opaque Windows-managed objects.
- [Well-known SIDs](https://learn.microsoft.com/en-us/windows/win32/secauthz/well-known-sids): broad principals/placeholders; this predicate performs no identity or group lookup.
