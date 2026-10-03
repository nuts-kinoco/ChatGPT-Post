# PR8 + Antigravity portable integration candidate

This candidate composes existing reviewed drafts without merging their public branches. It is a fixed source/test integration milestone; live inference, authenticated account behavior and native confinement are not certified.

## Exact inputs

- PR8 cumulative browser/operations stack: `9a97659f9dadf0cfb93e8e5c9cc5bd1888df9554`, tree `039d79b151a8842402dca62d021261baafa538d7`
- PR5 Antigravity adapter: `94e33acfbeb16e7e00c34767055a5ef413ee37f9`
- PR9 metadata probe/cache: `37fa1d5ad8cf9bc6617ec1ee8d4bad2706585c3c`

All 365 files of the frozen PR8 source were checked against their published Git blob hashes before composition. This preserves the common project registry, archive/materialization gates, operations read model/composer/catalogue, recent browser selection hardening and registered provider boundaries.

The operations `src/ui/public/app.js` is unchanged: it already has the safe Antigravity labels and four use sites. The common `src/contracts/provider-catalog.ts` is also unchanged, SHA-256 `8c5be3bef8756ba093624c8d60e84265f66f6a99d875439c363263056e1141fa`. The newer bus CLI keeps its catalogue/template commands and receives only the Antigravity capability import and field. Other overlapping files were merged against the common PR3 source, with no conflict or wholesale overwrite.

## Additional integration correction

The actual PR8 model catalog builder accepts UTC observation timestamps with or without zero milliseconds. The metadata cache previously rejected the equivalent `...00Z` spelling. Two new cross-stack tests reproduced that incompatibility. The candidate now accepts only those equivalent UTC forms, while still rejecting impossible dates, unsupported spellings and future observations.

Cross-stack tests use the actual browser catalog builder and common cache for exact multiline labels and complete-but-ambiguous observations. They also verify that legacy execution selection still rejects ambiguity, provider IDs remain null when unverified, Antigravity diagnostics do not enable inference, and catalogue/template/fanout plus strict Bridge integer parsing remain available.

## Portable verification

- Root and GUI typecheck, lint and build passed
- Root: 1,713 passed, 56 inherited browser skips; GUI: 60 passed, zero skips
- Focused cross-stack + AGY metadata/cache: 55 passed
- No live browser, model generation, authentication setup, Windows action or merge was performed for this composition

Independent review of the final composed tree remains required. Earlier PR reports retain their original scope/counts; this candidate's manifest and verification report identify the combined source.

## Remaining boundaries

This composition does not activate the metadata refresh loop in a default host or add persistent cache storage. Those are explicit shared-host integration tasks. The model metadata source still has no verified successful account listing grammar. Catalog observations never grant execution or infer capabilities/cost/quota. CLI TaskSpec effort and dynamic browser execution migration remain separate reviewed contracts.

AGY's actual confined-task launcher still needs its genuine native supervisor. The proposed no-tools inference route must prove provider-supported zero tools and startup policy before becoming eligible. An ordinary CLI flag, metadata result, bootstrap ACK or catalog cache entry cannot supply those guarantees. All original one-attempt/no-reexecution, result/artifact materialization and exact ACK rules remain in force.
