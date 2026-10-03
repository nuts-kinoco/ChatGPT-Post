# First real renderer wiring: exact proposed contract

Status: design for independent review, **not implemented or activated** by offline phase 1. Baseline: PR10 `b9be3404d007f74fea706126017dfb3136e12bd1`, with the additive offline renderer candidate. No new TaskSpec is proposed.

## Recommended next change

Connect the common brief to the existing composer/issuer preview and, behind an explicitly versioned recipient-owned policy, to **ordinary Chat hosted delivery first**. Keep every legacy request/policy byte path unchanged. The first production renderer accepts only the existing exact browser model IDs `gpt-5.6-sol` and `gpt-5.5`, separately registered by the recipient; discovery is never registration. Do not enable the new renderer for `current` or `latest` aliases. Do not change provider/model during a run.

This route already has authenticated output contracts, a durable one-attempt browser intent and exact-source prompt capture. It avoids entangling the current fixed Haiku trial or OS-confined CLI broker. No API caching flags are needed. CLI bootstrap relocation remains a later explicit route extension; it must not be claimed complete by browser wiring.

For this first wire, accept `bridge-task-brief-1` with `context: []` only. The common objective and constraints already live inside the approved task-file bytes, so this delivers real provider formatting without adding a remote/local context reader. Reject nonempty context at admission. An expanded materializer must receive a separate reviewed source authorization contract; the standalone offline file utility is never imported by the server.

## A. Existing composer/issuer boundary

- Preserve TaskSpec v2, raw task/spec hashing, existing issue/approve/start endpoints and their authorization
- The trusted recipe may encode a brief before creating `task_file_hash`. It must never accept an unbound semantic object after the task bytes are fixed
- One common form offers `answer`, `review`, `change`; existing free text uses explicit legacy mode. A task kind changes format, never paths, commands, mode, budget or model
- Extend the versioned issuer-template projection with a read-only `promptFormat` field: registered profile ID/version/digest, codec, provider/route/model, readiness and unresolved binding list. Use a new projection version so strict old consumers reject rather than misparse it
- Preview uses the exact prepared raw TaskSpec/task file already held by the composer, not another generated UUID or recipe call. Cache the same prepared bytes already bound to the existing composer preview. Stale registry/profile/policy revision rejects issue and requires a fresh preview
- Until the production policy below is actually installed, the new view remains `non-dispatch-preview` with current legacy dispatch clearly identified. No preview value is accepted by the host as a send receipt

## B. Recipient-owned policy version

Introduce a separately parsed `bridge-browser-delivery-policy-2`; do not append unauthenticated metadata to the current policy object. Its exact shape is:

```text
{
  schema: "bridge-browser-delivery-policy-2",
  delivery: <existing BrowserDeliveryPolicy fields, including expectedOutputPolicy>,
  prompt: {
    schema: "bridge-prompt-policy-1",
    rendererId: "bridge-hosted-prompt-1",
    rendererArtifactSha256: SHA256,
    profileId: ID,
    profileVersion: positive safe integer,
    profileSha256: SHA256,
    agentId: "chatgpt-browser",
    modelId: "gpt-5.6-sol" | "gpt-5.5",
    routeId: "ordinary_chat_browser",
    codec: "bridge-task-brief-1",
    contextMode: "none",
    outputParser: "response-frame-1+artifact-declaration-1",
    cacheControls: "none"
  }
}
```

`delivery` retains the current recipient/requester IDs, conversation URL, preset, maxStarts, deadline, response limit and complete required output policy. Its model must equal `prompt.modelId`. All existing validation still applies. The new schema rejects additional/duplicate keys, malformed text and unknown versions. Maximum raw policy size 128 KiB. Canonical compact JSON with explicit property order and one final LF is required; SHA-256 covers those exact raw policy bytes. The parsed object never stores its own hash.

The recipient's trusted installation loads this policy and a production profile registry. Both are deployment configuration, never task content or a value posted to an ordinary preview endpoint. The existing TaskSpec `policy_snapshot_sha256`, issuer destination policy hash, detached approval, output-contract binding and archived admission all bind the new exact policy digest. Existing V1 policy hashing and replay behavior are unchanged.

`rendererArtifactSha256` identifies a trusted build manifest: sorted relative renderer-module paths and SHA-256 of their exact compiled bytes. Startup must verify those bytes from the installed package and the registered profile before enabling the route. Neither the renderer digest nor the profile can be replaced by task input. A build/definition change produces a new policy digest and requires fresh request/approval bindings; no mutable global lookup may change an admitted request.

The production profile is a distinct reviewed record and renderer ID. Do **not** promote `bridge-offline-prompt-profile-1` to production or remove its warning text at runtime. Its initial production core, section ordering and output instructions get their own versioned golden fixtures and source pin.

## C. Acyclic preparation and exact output grammar

The production function is conceptually:

```text
renderBoundHostedPrompt(
  exact raw TaskSpec bytes,
  exact approved task-file bytes,
  verified immutable recipient policy/profile/build binding,
  admitted attempt UUID,
  exact authenticated output-contract bytes
) -> { promptBytes, stablePrefixBytes, immutable rendering bindings }
```

The host constructs this input only after the existing approval and one-start checks. There is no boolean `approved` argument that a caller can set to skip them. Every invocation rechecks request/task/policy/model/route/profile/contract agreement. It rejects a missing output contract, invalid brief, context, unavailable profile or renderer mismatch before a browser operation.

Order: fixed production core and output grammar; fixed provider/model profile; small task-kind delta; dynamic frame/contract binding; objective/constraints/deliverables/acceptance. Dynamic request/task hashes, attempt and contract bytes are never placed in the reusable prefix. No private chain-of-thought instruction, invented artifact hash, fixed ready-made answer or fake completion marker is added.

Refactor output grammar into shared helpers without changing legacy bytes:

- Extract exact frame-boundary/instruction generation from `contracts/response-frame.ts`; old `createFramedPrompt` must remain byte-for-byte identical for its existing inputs
- Extract the checked output-contract instruction block from `contracts/output-contract-prompt.ts`; validate against the **original approved task bytes**, not a reformatted semantic body
- Both old and new paths consume those same exact boundary/declaration helpers. Do not pass rewritten task bytes into the old contract function, because its task-file hash check would correctly reject them
- New renderer keeps `parseResponseFrame`, output-contract/declaration parser and exact hosted-source lookup semantics unchanged. The collector's expected-prompt reconstruction must be updated as specified below; it cannot retain the old prompt factory for V2

The existing hosted browser path creates no SessionBootstrapPlan in `promptFor`; therefore this first renderer records session/bootstrap as not applicable, rather than inventing an ACK/session value. CLI integration will require its own non-null bootstrap/ACK binding and preservation tests.

## D. Host-owned receipt and durable send boundary

New strict receipt, bounded to 8 KiB, canonical compact JSON plus LF:

```text
{
  schema: "bridge-hosted-prompt-receipt-1",
  requestId: UUID,
  attemptId: UUID,
  taskSpecSha256: SHA256,
  taskFileSha256: SHA256,
  policySnapshotSha256: SHA256,
  rendererId: "bridge-hosted-prompt-1",
  rendererArtifactSha256: SHA256,
  profileId: ID,
  profileVersion: positive safe integer,
  profileSha256: SHA256,
  routeId: "ordinary_chat_browser",
  modelId: "gpt-5.6-sol" | "gpt-5.5",
  codec: "bridge-task-brief-1",
  contextMode: "none",
  outputParser: "response-frame-1+artifact-declaration-1",
  outputContractSha256: SHA256,
  session: null,
  bootstrap: null,
  stablePrefixSha256: SHA256,
  stablePrefixSizeBytes: nonnegative safe integer,
  promptSha256: SHA256,
  promptSizeBytes: positive safe integer
}
```

No approval claim, timestamp requiring a new clock read, self-hash or receipt ID is needed: `(requestId, attemptId)` is its host-store key. The store may separately record receipt raw-byte digest for integrity. Neither receipt bytes nor final prompt digest appear in the prompt. A responder-supplied receipt is rejected; only a row committed by the trusted host is usable.

Proposed placement in `BrowserDeliveryService.start`:

1. In the existing BEGIN IMMEDIATE one-start transaction, load/revalidate exact approved request and fixed V2 binding; allocate the existing attempt UUID once
2. Render with that attempt and authenticated output contract, enforce a 1 MiB maximum prompt size (the existing exact-source reader limit), and insert the immutable receipt in a dedicated table keyed by request/attempt
3. Save the existing `attempted=true`, `state=unknown`, deadline/budget consumption and the receipt digest reference atomically; COMMIT before any file/browser effects. Render/validation failure rolls back before a start is admitted
4. Write exact prompt bytes with the existing exclusive-create file behavior. Before the browser runner can submit, verify its read prompt bytes against the committed receipt and frame identity. Recheck at the final controller handoff that accepts the in-memory prompt, so replacing a file between checks cannot substitute send bytes
5. Persisted receipt/binding disagreement, file mismatch, cancellation or expired deadline prevents submission. A crash after committed intent never creates another attempt; reconcile the original request. A matching cache prefix, missing receipt or new renderer is not a retry permission

A process restart after commit but before submission remains conservatively unknown, as today. It must not “repair” missing files by silently rerendering and sending. Existing result capture checks exact prompt/response source bytes; store the receipt digest with that provenance so a later collector cannot confuse legacy and rendered prompts.

Receipt migration: existing legacy rows have no new receipt and remain under their exact legacy policy path. New V2 rows require it; NULL/unknown schema never means legacy fallback. A single database configuration stays pinned to one policy digest as today; switching to V2 needs a separately configured instance or an explicit future migration, never overwriting active policy identity.

## E. Collection and replay are part of the same wire

`archive/payload-verifiers.ts` currently rebuilds `createOutputContractPrompt` and compares its hash with hosted source provenance. Changing only `BrowserDeliveryService.promptFor` would therefore break valid collection. This is a required integration change, not a later cleanup.

Introduce one shared `expectedHostedPrompt` selector for delivery capture/reconcile and collector verification. Its trusted input has a discriminated mode:

```text
{ mode: "legacy" }
OR
{
  mode: "bound-hosted-v1",
  policyRaw: exact registered V2 policy bytes,
  profileDefinitionRaw: exact registered production profile bytes,
  verifiedRendererArtifactSha256: installed verified build digest
}
```

It comes from the recipient-owned policy registry keyed by the approved task policy digest, never from responder output or an unauthenticated payload. The collector must have that historical registered definition/build available. V2 registry absence rejects as unsupported; it must not infer legacy mode from a missing optional field. Raw TaskSpec/task-file/output-contract bytes and frame attempt remain the existing independently checked context.

For `legacy`, call the original factory exactly. For `bound-hosted-v1`, revalidate all pins and deterministically reconstruct the production prompt; compare both exact prompt SHA-256 and the existing normalized DOM-match SHA-256 with provenance. This reconstruction is read-only verification, never a resend. The transport proof can remain `hosted-source-proof-2`, because its existing exact prompt hash commits the rendered bytes and the policy hash independently determines their approved construction. It must not be accepted without that trusted expected-prompt context.

The host's durable receipt stays host-owned. Associate its digest with the stored job/source record for local audit; do not add an unchecked model-authored receipt to transport artifacts or treat it as independent execution proof. A downstream collector verifies prompt construction from its historical trusted registry and existing admission/output-contract bindings, not solely from a remote receipt claim.

Required acceptance includes V2 successful capture -> authenticated transport -> collector verification -> archive roundtrip, plus restart and historical-policy lookup. Test unavailable history, changed profile/build and a legacy-shaped source proof claiming V2 prompt bytes. Preserve existing synthetic-only legacy exceptions without enabling them for production V2.

## F. Review and acceptance before implementation

The independent design review must approve: exact V2 policy bytes/digest rules and source-manifest verification, profile registration ownership, helper extraction preserving legacy grammar, receipt transaction placement, the final in-memory dispatch digest check, collector historical-policy reconstruction and restart migration rules.

Implementation tests must cover:

- Common form -> task-file hash -> raw TaskSpec -> approval/policy -> admitted attempt -> final prompt/receipt without a hash cycle
- Old launch/prompt functions are byte-identical; old hosted rows still reconcile without rerendering
- Three task kinds, both explicit registered browser models, text-only and declared-artifact output policies
- Changed policy/profile/model/route/task/contract/attempt, receipt mutation, stale preview and missing build manifest deny before browser submit
- Frame and artifact declaration parsing remain identical; forged “done,” invented file evidence or JSON conformance do not become success
- Crashes before/after receipt commit, prompt-write failure, concurrent starts, cancellation, deadline, changed prompt file, unknown dispatch and reconnect cause at most one attempted send and no automatic retry
- Preview/template/page load/profile listing remain non-inference; no new cache control, session reuse, billing switch or quota claim

Use synthetic browser-run doubles for this wire. The previously denied rendered-browser routes remain unrun; do not repeat them through another launcher or flags. Live model calls require a separate explicit test request.

The follow-on CLI proposal must independently pin CLI binary/authentication route, preserve the exact bootstrap digest/ACK, commit a receipt inside `cli-broker`'s existing durable plan before `runtime.start`, and bind both semantic prompt bytes and transport stdin bytes (Antigravity JSON framing differs). It must not reuse this browser receipt or alter the fixed Haiku no-tool trial.
