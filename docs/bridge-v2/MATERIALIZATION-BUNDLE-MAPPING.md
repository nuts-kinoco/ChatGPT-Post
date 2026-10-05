# Pure materialization bundle mapping

Reviewed starting point: PR17 work branch commit
`34a911e18f9af6e4e47ddead6fad0b3ee5294abc`, tree
`b38d8d2a30336a54b9701877a6779a5e9e788d27`.

`src/archive/materialization-bundle.ts` is an unconnected in-memory adapter. It
accepts the existing `VerifiedDeliveryMaterializationV1` structural input plus a
separately supplied `MaterializationBundleExpectation`, and returns only a
`Uint8Array` container. The historical input type name does not authenticate its
contents. No verified/provenance token, issuer authority or persistence receipt is
produced. A successful mapping is only byte and metadata consistency evidence.

## Mapping

The names match `src/archive/materialization-store.ts` at the reviewed baseline:

| Input bytes | Logical bundle member |
| --- | --- |
| `payloadBytes` | `results/result.json` |
| `deliveryManifestBytes` | `results/delivery-manifest.json` |
| `signedDeliveryManifestBytes` | `results/delivery-manifest.signed.json` |
| `receiptBytes` | `results/materialization-receipt.json` |
| Each verified artifact's bytes | `artifacts/artifact-${SHA256(UTF-8 artifactId)}.bin` |

Artifact IDs are validated using the existing descriptor contract, including
uniqueness and raw byte size/hash. Names are independent of source filenames and
content digest. For example ID `a` maps to
`artifacts/artifact-ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb.bin`.
The existing codec sorts the complete member set and owns bounded byte copies.
Its 128-member limit includes the four fixed members: at most **124 actually
materialized artifacts** are accepted. Existing per-member/aggregate/index bounds
remain enforced. Optional unavailable manifest entries remain in original
manifest metadata and do not generate artifact members. Required unavailable
entries are rejected. Empty artifact sets still retain all four fixed members
and the explicit manifest/receipt evidence.

## Independent expectations and consistency checks

The caller must retain the original admission binding and original exact member
identities (`name`, raw byte length, SHA-256) outside the candidate. There is no
helper that learns expectations from a candidate container, and no implicit
default expectation. Their provenance remains the caller's existing trusted
responsibility; this pure API cannot establish whether a caller fabricated them.

The mapper snapshots expected and candidate metadata, encodes bytes using the
codec, and decodes against the separately supplied original identities before
examining that private snapshot. Missing/extra members and raw hash/length
differences fail. It then checks the input/manifest/receipt binding against the
separate original binding, exact canonical manifest and receipt serialization,
payload hash/length, supplied manifest and receipt digests, receipt-to-manifest
digest, receipt metadata/descriptors, and the available manifest artifact set
against actual descriptors and byte size/hash. Signed envelope bytes remain opaque
and retain the existing 256 KiB limit. They are neither reserialized nor replaced
with an authenticated/decoded body. A retry with equal decoded JSON but different
original envelope bytes fails against the original raw expectation.

The mapper does not parse local ResultSpec or hosted frames, authenticate an
envelope, validate route receipt evidence, or resolve archive admission policy.
Those mandatory gates stay with the existing materializer and trusted sink.
`requiredArtifactsVerified: true` and typed `Verified` fields are consistency data,
not cryptographic proof. Synthetic local/hosted tests demonstrate format binding
only and are not execution or provider provenance evidence.

## Dependencies and ownership

Runtime imports are the pure materialization contract, raw-byte helpers and
bundle codec. The materializer import is type-only. The materialization contract's
parser import is moved from `task.ts` to the same existing `raw-bytes.ts` function;
this removes schema-loader IO from the contract dependency graph without changing
contract schemas or parser behavior. No existing materializer/sink calls this API.

Metadata is cloned before consistency checks, and codec byte snapshots reject
shared/detached/unsupported buffer inputs under its existing rules. Return bytes
do not alias inputs; decoder readback copies do not alias the container or each
other. This is not a sandbox for hostile JavaScript objects: ordinary input access
and cloning may invoke getters or proxy traps. Trusted callers must supply data
objects, and the API makes no claim to contain executable caller behavior.

## Acceptance and deferred work

Focused tests cover independent fixed-name/artifact-hash golden mapping, raw
member preservation, synthetic local/hosted and explicitly empty fixtures,
124/125-artifact boundaries, missing/extra/hash/length/binding rejection,
internally inconsistent manifest/receipt metadata, original envelope retries,
optional unavailable metadata, deterministic retries, copy isolation, and
throwing import mocks for filesystem, schema-loader, SQLite, processes and sink.
Existing codec and delivery-materializer tests remain relevant regressions.
Typecheck, lint and build must pass. Whole ordinary unit findings are reported
separately against the exact starting SHA; the preexisting Windows baseline is
not a green whole-suite claim.

No runtime wiring, native/filesystem probes, SQLite writes, ACK success, archive
migration, issuer-binding design, rejected R3 helper, credentials, permissions or
guard changes are part of this adapter. It establishes neither Windows file
publication/rename behavior nor retained-handle safety, independent trust-anchor
provenance, namespace durability, recovery correctness or readiness to ACK.
Those separate native/storage gates remain unimplemented and fail closed.
