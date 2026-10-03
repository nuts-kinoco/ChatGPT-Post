# Registered common-brief composer and issuer projection

This browser-first addition is a read-only format projection plus the existing manual composer and signed issue path. It does not add a TaskSpec, approval, executor, remote context reader, or model selector. Synthetic tests are the acceptance surface; there is no live-browser activation in this change.

## Trusted host port

`UiComposerPort.promptFormat(destination, modelId)` optionally resolves a `VerifiedHostedRenderer` from the recipient-owned registered policy. It receives only the destination/model already selected from the existing trusted catalogue. No HTTP/CLI request can supply the resolver, a profile, a build digest, or a verified handle.

A resolver returns `null` only for a positively recognized legacy destination. Unavailable or revoked V2 configuration must throw, never return `null` as a fallback. A non-null handle is checked through the opaque registry accessor and must agree with the exact destination policy digest, agent, route, and selected registered model. A forged handle rejects. Existing unconfigured ports retain the legacy behavior.

`GET /api/composer` retains its capability fields and adds `promptFormats`, a `bridge-composer-prompt-formats-1` projection with `formats: [{destinationId, modelId, promptFormat}]`. This reads only configuration. It does not invoke the task recipe, allocate a request/attempt, prepare dispatch bytes, or contact a provider. The form only enables common task kinds when every selected destination/model has a registered brief profile. Mixed legacy/brief fanouts cannot silently convert the task.

## Exact request grammar

The old `POST /api/composer/preview` body remains accepted with exactly these fields:

- `registryRevision`, `projectId`, `destinations: [{destinationId, modelId}]`
- `title`, `instruction`

It may explicitly add `mode: "legacy-verbatim"`; the task-file and TaskSpec bytes produced by the old manual recipe remain identical for the same recipe inputs. The task kind is never inferred from free text.

The common form instead adds exactly:

- `mode: "bridge-task-brief-1"`
- `taskKind: "answer" | "review" | "change"`
- `constraints: string[]`, `deliverables: string[]`, `acceptance: string[]`

Its objective is the exact string `# ${title}\n\n${instruction}`. This binds the existing title and body together inside the approved task file. The codec's existing text/list/aggregate limits apply. The composer supplies `context: []`; a public `context`, `taskMarkdown`, profile, provider override, renderer, or other extra field rejects. There is no source materialization.

Before invoking the existing trusted recipe, the composer canonically encodes that brief and supplies its exact task-file string as `ComposerRecipeInput.taskMarkdown`. `manualTaskTemplate` uses those bytes before calculating `task_file_hash`. Any recipe that ignores or changes the provided bytes rejects. The recipe runs once per requested child and creates the one original raw TaskSpec. Task kind changes formatting only; it adds no command, path, mode, budget, provider, or model authority.

## Versioned previews and issuer templates

Legacy composer responses remain `bridge-composer-preview-1`. Common-brief responses use `bridge-composer-preview-2`; each child includes:

- the exact existing `rawSpec`, `taskMarkdown`, UUID and both byte hashes
- `promptFormat`: `bridge-issuer-prompt-format-1` with renderer/build/profile/policy pins, provider/agent/model/route, codec, context mode, supported kinds and readiness
- `promptPreview`: a `bridge-hosted-prompt-preview-1` display-only rendering over those same exact raw spec/task-file bytes

The preview is labeled `non-dispatch-preview`, grants no execution authority and has no send receipt. Approval, attempt and output contract remain unresolved. Browser session/bootstrap are explicitly `null` (not applicable for this first route). Preview hashes have scope `preview-only-not-final-send`; they are never accepted as dispatch evidence.

The form disables repeated preview submission while the unchanged preview is present. Editing invalidates it; an explicit new preparation gets the normal new request identity. Issue uses the exact cached original bytes and IDs without another recipe or render call. Repeated successful issue returns the existing transport receipt.

Without a prompt resolver, issuer reads retain `bridge-issuer-template-1` exactly. A configured resolver exposes `bridge-issuer-template-2` with read-only `promptFormat`; strict V1 readers can reject that new version. The reserved template request marker is still removed, and the template is still `templateOnly: true, executable: false`. Template reads cannot issue or start work.

## Staleness and compatibility

The preview caches the exact destination and profile/build/policy fingerprints alongside the existing project registry revision/hash. Issue re-reads trusted registration and rejects drift or unavailable handles before the transport call. Profile changes while the recipe prepares also reject; the existing template read checks destination/registry/format drift before returning.

The new codec is required when the selected destination has a verified production brief binding; free text is not automatically promoted. Missing registration cannot authorize a common brief. Legacy endpoints, task hashing, signed transport, manual approval, AGY catalogue surfaces, and dispatch/collection authority remain unchanged. The standalone `offline-files` materializer is never imported by this UI/server path.
