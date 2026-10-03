# Registered hosted prompt rendering

This implements the reviewed browser-first production wiring with fake-only verification. No route is automatically enabled. No live Chat/model call, new API route, cache-control flag, session reuse, native installer or Windows validation is part of this change. The separate fixed Haiku text trial is unchanged.

## Scope and compatibility amendment

The first renderer supports only recipient-registered `chatgpt-browser` tasks with model `gpt-5.6-sol` or `gpt-5.5`, `read_only`, no commands, `bridge-task-brief-1` and an empty context manifest. Discovery does not register a model. `current`, `latest`, arbitrary dotted models and another provider cannot select this renderer.

TaskSpec's original generic model-ID grammar excluded periods, so those two existing browser IDs could not previously pass the TaskSpec validator. This change is an **additive browser-specific validation amendment**, not a claim of byte-identical frozen protocol semantics: exactly the two IDs are additionally accepted only when `agent` equals `chatgpt-browser`. The shared generic ID definition, other agents, all existing generic model IDs, TaskSpec fields/version/raw-byte hashing and local ResultSpec remain unchanged. There is no normalization or alias conversion. Ordinary Chat still produces hosted evidence rather than a local-process ResultSpec.

The original legacy prompt factories are byte-identical for existing inputs, with explicit golden-equivalence tests. Their instruction generation was extracted into shared helpers so new and old paths use the same frame/declaration grammar. `contracts/raw-bytes.ts` holds the former hash/strict UTF-8/JSON functions; existing task-module exports remain available. No legacy task file is re-encoded.

## Fixed installation and trusted host boundary

`npm run build` compiles the application and runs `scripts/write-hosted-renderer-manifest.mjs`. `npm test` builds first so tests verify current compiled assets. The generated manifest includes fourteen fixed files: eleven compiled JS modules, the complete fixed import graph, the fixed-content catalog and package metadata. Shared brief, parser/hash, frame/output-contract helpers and profile/core constants are included. No third-party loader/schema dependency enters this pure rendering closure; the existing full TaskSpec validator remains a separate host admission check.

The build fails if the known import graph changes, a dependency is missing, or an external/dynamic/escaping import is introduced. It produces no cache object and makes no network/model call. The manifest digest belongs to the installed compiled bytes, not a source-directory label or a lockfile alone.

`verifyInstalledHostedRenderer` reads only the known package/manifest paths, checks exact bytes, graph, constants and aliases, verifies a strict canonical production profile and creates an opaque policy-scoped handle. Callers cannot choose a module root, path, callback or implementation. A digest string or plain object is not a handle. Declared `additionalLoaders` must be empty. The host administrator, configured Node runtime/loader and existing host filesystem protection are the explicit TCB. This is not native runtime attestation or protection against malicious same-privilege host mutation. No new OS security setting is required.

The initial registry contains one installed implementation revision. Historical policies may refer to that exact registered implementation/profile; a missing, revoked, changed or uninstalled historical build is unavailable. It is never fetched, evaluated, replaced with current code or used to trigger a resend. `reverifyInstalledHostedRenderer` checks installed assets at host admission/history lookup. Renderer execution itself is pure over captured values. `revokeHostedRenderer` invalidates an existing opaque handle.

## Explicit trusted deployment construction

The deployment owns the following order; these inputs are not an HTTP/task/model API:

1. Build and obtain the exact generated manifest digest
2. Create/encode a canonical production profile with `createProductionPromptProfile` / `encodeProductionPromptProfile`; hash its exact bytes
3. Create/encode `BrowserDeliveryPolicyV2` with `encodeBrowserDeliveryPolicyV2`. It contains the existing delivery scope and required expected-output policy plus the exact profile/build/model/route pins. Hash its exact bytes; there is no embedded self-hash
4. Verify the installed renderer with exact profile bytes/digests, build digest and that policy digest; register it with `registerHostedPromptPolicy(policyRaw, renderer)`
5. Pass the opaque registered policy as the existing `BrowserDeliveryService` policy argument. This selects V2 explicitly; a raw V2-shaped object or forged handle is rejected. The existing V1 object argument retains its legacy path and original policy hashing
6. Put registrations in `HostedPromptPolicyRegistry`. Use `createHostedPromptFormatLookup(registry, explicitlyKnownLegacyPolicyHashes)` for the trusted composer port. Unknown registration throws; only an explicitly recognized legacy policy returns null
7. Pass the historical registered policy resolver to `createHostedPayloadContext` for requester collection. It accepts either a registered V2 policy or a positively registered old expected-output policy; unknown history returns null and rejects

Existing configured destinations must use the new exact policy digest before preparing/issuing V2 requests. The existing deployment bridge and signed issue/approval endpoints remain the activation boundary. No default configuration, existing policy, account or budget is silently changed. See `COMPOSER-PROMPT-WIRING.md` for the common form and display-only pre-approval view.

## Policy, receipt and one-attempt order

`bridge-browser-delivery-policy-2` is canonical compact UTF-8 JSON plus exactly one LF, maximum 128 KiB. It rejects duplicate/extra/missing keys, malformed encoding, invalid enum/identity/time values and noncanonical bytes. Delivery scope and all expected-output constraints are preserved. `policy_snapshot_sha256` binds the exact raw new policy. The original V1 hash and replay behavior are untouched.

Receipt schema `bridge-hosted-prompt-receipt-1` is canonical JSON plus LF, maximum 8 KiB. It binds request/attempt, original task/spec/policy hashes, renderer build/profile, exact model/route/codec/output parser, authenticated output-contract hash, stable-prefix hash/size and complete prompt hash/size. Session/bootstrap are null because this browser path does not create a CLI bootstrap. The receipt contains neither its own hash nor an approval/success claim, and its final prompt digest is not embedded in that prompt.

`BrowserDeliveryService.start` creates the receipt inside the existing BEGIN IMMEDIATE transaction, after approval/budget/cancellation checks and allocation of the original attempt UUID. Rendering failure rolls back before any attempt or budget is persisted. Receipt insertion, job intent and budget consumption commit atomically before all file/browser effects.

Both existing bounds apply: at most 1 MiB of rendered UTF-8, and at most 20,000 JavaScript string characters accepted by the browser request loader. The stricter character rejection happens before intent commit. Exact-boundary and zero-start/zero-budget tests cover this. Neither limit was enlarged.

After commit, prompt and request files keep their exclusive-create behavior. A trusted closure compares the exact loaded request and prompt against the committed receipt before the browser runner. The production runner passes that closure to `RunController`; it checks the validated **in-memory** prompt before browser work, before entering text and immediately before dispatch. Changing a file after a prior check cannot replace the actual send bytes unnoticed. Request model/conversation changes also fail the comparison.

A crash or write failure after committed intent remains unknown. Missing/corrupt receipt, changed registration or profile never implies legacy fallback. Reconnect and collector reconstruction are read-only checks of the same request/attempt, not permission to resend. Concurrent/repeated starts remain limited by the original durable one-attempt path. Existing cancellation/deadline checks remain active.

## Collection, historical lookup and migration

`HostedPayloadContext.promptRendering` is now an explicit internal trusted-context discriminant: `legacy` or `bound-hosted-v1` with a registered policy handle. Existing custom collector callbacks must classify their historical policy explicitly; `createHostedPayloadContext` supplies this safely from its trusted policy resolver. Missing classification is unavailable, not a V2-to-legacy fallback. No field is accepted from responder JSON to choose the renderer.

`expectedHostedPrompt` uses the original factory for positively classified legacy policy. For V2 it reconstructs from original task/spec/output-contract bytes, the original attempt and the verified historical implementation. It compares exact and DOM-normalized prompt hashes with the existing `hosted-source-proof-2`. Frame/declaration parsing, exact source pairing, artifact completeness and archive evidence requirements remain in force. A remote receipt claim alone cannot authorize or prove this reconstruction.

The new host-owned receipt table is additive. Existing legacy rows have no new receipt and stay on their existing policy path. V2 rows require a matching receipt. The database still refuses a different configured policy digest; switching an active instance to V2 is not an in-place migration. Use a separately configured instance or a separately reviewed migration.

## What the tests establish

Synthetic suites cover canonical policy/profile/receipt grammar, both fixed models and all three kinds, text-only/artifact declaration grammar, exact old factory bytes, complete manifest mutations, opaque-handle forgery/revocation, wrong model/route/policy/contract, missing context/history, fixed-limit boundaries, receipt transaction order, concurrent starts, file failure, restart, cancellation, stale composer previews and final in-memory send checks. Compiled Node scenarios verify the built implementation rather than relying only on transpiled tests.

They do not establish live model availability, response quality, cache hits, billing savings, subscription quota savings or rendered-browser compatibility. The inherited 56 browser fixtures remain explicitly skipped after recorded environment/access denials. No alternate launch flags or sandbox workaround is used.
