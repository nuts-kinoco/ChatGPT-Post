# Bounded ordinary-Chat browser maintainability (A + B)

This change fixes selector uniqueness and adds read-only model discovery. It does **not** enable execution of arbitrary new models or widen historical request/result enums.

## Source and scope

The isolated base is the frozen cumulative operations source, copied with a 359-file SHA-256 manifest. Its published ancestor is archive PR6 commit `0f8549448230ff92d1a46fb8c883ad9578ae8646`; the approved cumulative overlay has SHA-256 `de1f98de75094a61fa961d785d9e3a1091ce2c9f464a33a08cd1e4bd1c3fc1e7`. The local operations Git HEAD was not used as the source identity.

`src/contracts/provider-catalog.ts` is the shared provider-neutral, read-only discovery envelope owned by the provider adapter work. The browser extends that envelope, rather than creating an execution registry or interpreting another provider's identity.

No changes to request/result schemas, TaskSpec/ResultSpec, signed approvals, provider routes, submit/marker logic or archive contracts are included. New observation context IDs identify one page object only; they never replace request/attempt UUIDs.

## A: complete selector observation

`scanVisible` returns absent, unique, ambiguous or incomplete, with attached/scanned/visible counts and fixed reasons. It checks at most 256 candidates. A larger population is incomplete before scanning, not a truncated apparent uniqueness result. Count/visibility failures and observable count/visibility changes stop resolution. Two visibility passes and intervening/final count reads detect drift during a scan; they are not a lock on a live DOM.

`resolve` and `probe` share this observation. A later fallback is eligible only after complete absence. Ambiguous/incomplete precise selectors cannot be erased by a broader fallback. The unique result retains the actually visible locator. Diagnostics use static reasons/counts, never raw errors or page text. `probe` also fails closed on an unreadable enabled state. Explicit inspect-ui selector rows now expose completeness rather than an unexplained 20-node partial visible count.

The legacy `exists` boolean-presence helper, `all` list helper, `countMatches`, `latest` and extraction-specific lookups remain unchanged. Their caller contracts do not represent unknown uniformly; A/B does not claim to fix their historical failure/truncation behavior. In particular the legacy presence helper must not be used to prove uniqueness or catalog completeness. Migrating those APIs is a separate reviewed task.

## B: visible model catalog

Explicit `inspect-ui` places a structured snapshot at `presetOptions.modelCatalog`, preserving the old flattened `modelOptions` output for compatibility. The catalog collector reads only the scoped picker. It does not open the picker itself, change effort or submit a prompt. The existing explicit inspect action opens/expands/closes the picker; effort walking is still opt-in and separate. No refresh endpoint, TTL, background browser action, inference/model call or UI polling was added.

The snapshot includes:

- Shared schema `bridge-provider-catalog-1` and browser version `chatgpt-visible-model-catalog-1`
- Provider `chatgpt`, route `ordinary_chat_browser`, per-page observation context, selector-profile revision, timestamp and historical/structural provenance
- Complete/incomplete status, distinct ambiguity, fixed issues and a SHA-256 catalog fingerprint
- Exact bounded visible label, nullable checked/enabled state, legacy alias when already recognized, nullable provider model ID, catalog-scoped observation key and explicit identity provenance
- Unknown cost/account availability/model effort; `executionAuthorized: false`

The current reviewed profile has no verified provider-ID attribute. Therefore every current providerModelId is null. A label-derived hash is only an observation key and is never a provider model ID. A future reviewed profile can specify a real provider-ID attribute; tests use a synthetic profile without claiming that attribute exists in production.

Hidden rows are excluded, disabled rows remain visible in discovery, and duplicate labels/IDs/legacy aliases remain separate ambiguous rows. Missing/invalid checked or enabled state and unreadable/oversized labels produce incomplete observations. A complete observation can still be ambiguous. Empty and invalid checked-cardinality catalogs cannot authorize a legacy selection.

The collector compares repeated bounded observations. Legacy selection additionally compares a fresh full catalog and checks the exact row before clicking. A changed catalog, disabled option, ambiguity, unknown state or unknown current model fails closed. Explicit effort selection also requires a complete enabled current model before mutation and an unchanged catalog after reopening. The collector re-expands to re-observe visible radios; the slider must then resolve visibly or the operation fails closed. If a DOM generation cannot expose the required controls together, that remains an unverified compatibility gate rather than permission to inspect hidden state or send blind keys. Explicit diagnostic walking remains separate. The existing exact closed legacy alias mapping is retained; no name-number heuristics or new aliases were added. Reordering rows or changing only the observation time does not change the fingerprint; material selection/enabled/identity/profile/context changes do.

The fingerprint is scoped observation evidence, not a provider guarantee or immutable binding across sessions. A live DOM can still change between the final check and a click; post-click observation remains mandatory. Strong dynamic execution binding is outside this patch.

## C: separately reviewed dynamic execution migration

Discovering a future model does not make it runnable. New-model execution needs versioned request/result contracts and trusted capability/policy approval, binding the exact catalog/profile/option to the immutable request. Re-observation before mutation/submission must fail closed on stale or ambiguous identity. An option without a provider ID must remain explicitly weaker attribution. Effort topology, capability, billing/account route and quota need separate evidence. Never infer equivalence from a label, version number, suffix, `latest`, or post-response slug. An uncertain submission must be reconciled under its existing request/attempt and durable marker, never resent with new IDs.

## Verification and honest limits

Offline locator doubles cover the 21st visible duplicate, >256 population, visibility/count errors and drift, precise ambiguity with a tempting fallback, legitimate complete absence, hidden rows, duplicate/disabled/unknown model state, exact closed legacy mapping, stale pre-click catalogs, unknown future labels, provider-ID provenance, fingerprint stability, and read-only diagnostics with an unreadable slider. One structural fixture read verifies that the captured 2026-09-24 model row provides no provider ID. That is not rendered-DOM evidence.

Run the normal root and GUI typecheck, lint, build and test aggregate with `BRIDGE_SKIP_BROWSER_TESTS=1`. Preserve the inherited 56 browser fixture skips as unrun. The prior cloud Chromium launch was denied with EPERM involving socket/process_singleton, and supported-browser localhost navigation returned ERR_BLOCKED_BY_CLIENT. This work does not retry those denied actions through alternate flags, sandbox overrides or a new route. No Windows, live browser/account, ordinary-Chat submission, model CLI, authentication or inference was run. Rendered fixtures and actual ordinary-Chat acceptance remain separate unverified gates.
