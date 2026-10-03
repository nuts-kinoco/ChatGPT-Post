# Bounded output-contract amendment for D07c

Status: review candidate, zero-artifact acceptance remains disabled until independent approval.
TaskSpec v2, ResultSpec v2, task Markdown hashes and existing response framing remain unchanged.

## Completeness claim

Full delivery means: the exact terminal payload/receipt, every output required by the authenticated
expected-output contract, and every artifact declared by the matching responder have been verified
and durably saved. It does not claim absence of invisible unrelated attachments anywhere in a chat.
Attachment count/byte caps apply only to generated attachments; mandatory response/source/declaration proof bytes retain independent implementation caps. No visible links alone is never evidence of an empty required set. A responder declaration grants no
authority and cannot narrow the requester’s expected set.

## Pre-admission contract (requester-authenticated)

A separate immutable `output-contract-1` body contains:

- schema, requestId, taskSpecHash, taskFileHash, route (`hosted_delivery` only in this amendment)
- requesterActorId, recipientActorId, policySnapshotSha256, registryRevision, registrySnapshotSha256, projectId, repoId, storageSlug
- destination: exact registered GitHub repository/branch/namespace and exact conversationId
- mode: `text_only` or `declared_artifacts`
- requiredOutputs: [{logicalName, mediaType, maxBytes}] using safe logical IDs, not paths/URLs
- allowAdditionalArtifacts: false; maxArtifacts (0–64); maxTotalBytes (0–64 MiB)
- declarationFormat: `bridge-artifact-declaration-1`

For text_only, requiredOutputs is exactly [], maxArtifacts=0 and maxTotalBytes=0. For
 declared_artifacts, requiredOutputs has at least one entry, names are unique and bounds cannot
exceed the archive implementation’s 16 MiB/file and 64 MiB/collection hard caps. There is no wildcard
that weakens the required set. The requester’s already-authorized expected output policy supplies
this contract; it is not derived from the responder’s text. An unknown/missing version stays blocked.
The signed issuance is explicitly versioned `bridge-issued-2`, with `outputContractSha256:string|null` and the existing historical project binding. Hosted issuance atomically appends task JSON, MD, request index, issued envelope and output_contract.json. Strict old unversioned issuance retains its old meaning and cannot be given a post-result contract. CLI outputContractSha256 stays null until separately designed local-route support. A recognized requester signature authenticates the submitted bytes only. The recipient must additionally look up a previously authorized trusted BrowserDeliveryPolicy expected-output scope, matching actors, policy hash, project/revision, registered destination and conversation, and reject any contract outside it. This reusable scope exists before per-request contracts and does not contain their future hashes, avoiding a circular policy/task/contract hash. Contract signatures cannot enable routes, permissions or new data sharing. Admission pins
that digest along with the route/request/task identity. Registry/storage changes cannot alter it.
No run/attempt/message identity exists yet; none is invented here. Old jobs cannot be retrofitted from current configuration or assigned text_only after a result arrives; explicit migration requires a separate approved design.

## Observed declaration (inside the exact matching response frame)

The first nonblank content line inside the validated outer response frame is:

```text
BRIDGE ARTIFACT DECLARATION {single-line strict JSON}
```

The JSON is `artifact-declaration-1` with requestId, taskSpecHash, attemptId, outputContractSha256,
and outputs: [{logicalName, mediaType, filename, contentSha256, sizeBytes}]. An explicitly empty
outputs array is mandatory for text_only. All declared outputs are required: required/declared/resolved observed attachment sets must match exactly, with no optional/additional-attachment loophole. No paths, URLs, credentials, requester authority, future
process IDs or fabricated provider artifact IDs are allowed. Strict UTF-8/duplicate-key/size checks
apply. Exactly one declaration is allowed, not in a quote/code fence; duplicate/nested/partial or
wrong-task/hash/attempt declarations reject. The ordinary answer follows the declaration. The
framed raw/body hash covers both declaration and answer; displayed answer may omit the declaration
only as a separate presentation projection, never by replacing the immutable payload bytes.

The model may not know provider-assigned artifact IDs. The trusted exact-message resolver binds
logical outputs to the actually observed source artifact IDs and byte hashes after generation. It
must reject ambiguous filename matches or missing stable source identity, and must fetch and verify
all declared bytes. Filenames alone never prove delivery. Unknown or inaccessible required bytes
remain delivery_pending. The trusted host computes SHA-256 from every fetched exact-source artifact itself and compares the model-supplied size/hash as constraints. Provider inability to satisfy the declared contract is unsupported/delivery_pending; never invent hashes. The responder declaration is correlation/data, not authenticated truth.

## Same-attempt provenance and observed contradictions

Append an `output-observation-1` observation after a real attempt exists: admission/contract digest,
actual attemptId, exact conversation/user-turn/assistant-turn IDs, raw/body/declaration hashes,
resolved logicalName→sourceArtifactId/contentHash/size bindings, observed artifact indicators and
source-reader capability/version. Never mutate the pre-admission pin.

The exact-source reader checks rendered artifact indicators in the selected message. An observed
undeclared attachment, conflicting filename/hash/size, duplicate source mapping, unsupported artifact
widget, or ambiguous/missing message identity blocks full delivery. Ordinary web links in answer
prose are not automatically attachments. Observation is bounded to the selected message and known
UI artifact surfaces; unsupported surfaces remain explicitly unverified rather than claimed absent.
A later unrelated chat turn is irrelevant and must never be selected as a fallback.

A text-only job can establish a verified empty declared artifact set only when all of these hold:
1. requester-authenticated text_only contract with zero required/allowed artifacts
2. exact matching response frame and explicit matching empty responder declaration
3. stable exact source-message provenance and matching prompt ownership
4. successful bounded contradiction check of the selected message, with no observed attachment or
   unsupported/ambiguous artifact signal
5. requester verifies/saves payload and source/declaration proof bytes under its pinned root

This proves the agreed text-only output contract, not an account-wide or hidden-attachment absence. Global DOM artifactEnumerationKnown remains unknown; a separate hosted-source-proof-2 field records completenessScope:"bound_output_contract" plus outputContractSha256/declarationSha256/contradictionCheck. It must never set global enumerationKnown=true merely because text_only passed. declarationSha256 covers the exact raw UTF-8 declaration JSON bytes on that line, without parse/reserialize normalization. Unknown-contract, missing-declaration, expected-set-mismatch, declared-set-mismatch, observed-attachment-mismatch and unsupported-artifact-surface remain distinct bounded error codes.

## Supplemental proof and compatibility

Signed delivery-manifest-1 continues to carry all required source/declaration proof artifacts and
actual output descriptors; it binds the exact immutable terminal payload. Hosted source proof gets
a new version `hosted-source-proof-2` for contract/declaration/observation fields; never reinterpret
version 1 bytes. materialization-receipt-1 keeps its existing fields and binds the signed delivery
manifest digest, exact payload/event and verified required artifact set. Thus the contract proof is
transitively hash-bound without changing local ResultSpec or frozen ACK bytes. Recipient and workflow
ACK gates must validate the appropriate source-proof version and contract digest; payload-only ACK
or old proof lacking required output evidence remains insufficient. Raw artifact sharing still needs
explicit configured destination/data scope. No zero-output rule authorizes upload, execution or review.

## Required portable tests

- valid explicit text-only zero declaration; missing declaration stays pending
- task/hash/route/contract/attempt mismatch, undeclared observed link, unsupported widget and hidden
  unrelated later turn; no latest-message substitution
- omitted required output, extra declared output, duplicate name/source, wrong MIME/hash/size, cap
  overflow, inaccessible bytes and filename-only identity all reject
- declaration cannot overwrite expected policy or expand sharing destinations
- unknown contract/proof versions and old payload-only ACK remain insufficient
- both sender-local and requester materialization preserve pinned roots and retry without generation
- tests remain synthetic until real approved browser/CLI roundtrips at a reviewed head prove behavior

### Exact contract digest and authority ordering

Hash the exact raw UTF-8 output-contract BODY bytes before wrapping them in a detached requester
signature envelope. The contract may not refer to the final issued-document hash. The order is
registered policy → TaskSpec → output-contract body → issued envelope; no backward hash reference.
Claim/start must validate the requester-signed contract against the trusted recipient’s preapproved
scope and the exact registered destination before accepting it. A correctly signed out-of-scope
contract is rejected, not shown as executable. All identity and output-set fields use strict versioned
schema validation; required/declaration/observed resolved attachment equality is exact and case-sensitive over logical-name sets. Declared and resolved content hashes and byte sizes must match; policy MIME types and per-item/aggregate byte bounds are checked separately. RequiredOutputs intentionally has no future content hash. Portable filename ambiguity checks apply at storage/source mapping.

Additional amendment tests: a valid requester signature with wrong or out-of-scope host policy or destination rejects; replacing a contract after admission rejects; partial/crashed atomic issuance is never accepted; historical jobs cannot gain a post-result/current-config contract; successful contract-scoped text-only zero leaves global DOM enumerationKnown unknown.
