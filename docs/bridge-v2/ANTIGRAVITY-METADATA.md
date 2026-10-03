# Antigravity installed-CLI probe and read-only catalog

This follow-on implements the approved A/C boundary in ANTIGRAVITY-LAUNCH-REVIEW.md. It does not enable AGY inference, authenticate an account or replace the missing execution supervisor. Use the shared runtime for future provider execution; do not turn this metadata process host into a task runner.

## What now runs

`AntigravityMetadataProbe` launches the registered installed ELF through its held Linux descriptor, with only `--version`, `--help` or the documented `models` metadata command. It checks canonical path, file type/link count/owner/mode, trusted ancestors and SHA-256. Shell execution, arbitrary arguments, stdin prompts and inherited authentication/environment variables are absent. Temporary HOME/cwd is private and outside the repository. Both output channels share a byte cap; timeout, auth prompts, malformed bytes and nonzero exits fail closed. Error views omit raw provider diagnostics.

The owner and same-user code are trusted. A held descriptor prevents pathname replacement, not same-inode mutation by its trusted owner. This is not atomic hash-at-exec, descendant termination or OS confinement evidence.

The process lease has separate `result` and `exited` promises. A timed-out result can return promptly, but the runner and cache retain exclusive ownership until close/cleanup. A late result cannot overwrite timeout or start a replacement. Failure before the process is created never causes a retry.

`inspectInstalledAntigravity(probe)` issues only version/help, verifies the existing versioned CLI contract and returns authentication/model availability as unknown, zero-tools as unverified and OS confinement false. It preserves the raw selected help stream hash. Conflicting stdout and stderr metadata is rejected rather than combined with diagnostics.

## Dynamic catalog and refresh

The shared `ProviderCatalogSnapshot` in `src/contracts/provider-catalog.ts` is also used by ordinary-Chat discovery. It is a display/diagnostic view, not an executable-model registry. Provider stays `antigravity` even when a model label mentions Gemini or Claude. Observation keys and nullable provider model IDs are separate. Global CLI effort syntax is not per-model effort support. Cost, account availability and execution authorization remain unknown/false.

`AntigravityCatalogSource` calls only `models`, binds the exact registered context/binary/version, and returns auth-needed/errors without beginning login. No successful 1.2.15 listing has been captured in this isolated context. Consequently model rows remain incomplete with `format_unverified`; this code does not invent a parser, ID, model list or fallback. A supported listing fixture and reviewed grammar are required to enable row parsing. The official product models page documents multiple families, but it is not proof of this account's available CLI IDs.

`ProviderCatalogCache` provides:

- One coalesced in-flight lease per host-owned instance/context
- Default 24-hour TTL; minimum 15-minute refresh interval and bounded error backoff
- Last-good data retained as stale after failure; incomplete first observations remain unknown
- Nullable IDs, explicit source/time/revision provenance and no model-family filter
- Refusal to hydrate another context/binary/profile's data or future-dated observations
- Timeout ownership retained until actual exit, with late success ignored
- Clock rollback reported stale/unknown; no early refresh while time remains behind the previous observation
- Optional explicit active-host refresh loop, never a model request or a refresh on every UI read

The cache is host-lifetime memory with validated `initialSnapshot` hydration. The common host owns any persistent snapshot storage and the single instance for each registered scope. It must not create competing instances/processes for the same context. No global registry, daemon or scheduler is installed by this module.

## Host integration

A trusted deployment constructs the probe from its registered binary/digest/owner, inspects version/help, creates an `AntigravityCatalogSource` with the same revision and an opaque isolated-context ID, then supplies it to `ProviderCatalogCache`. Call `refreshIfDue()` at eligible startup, or explicitly `startRefreshLoop()` while the host is active; stop the loop on host shutdown. A recent persisted snapshot may be supplied via `initialSnapshot`, preserving its original observation time. All calls still obey the minimum metadata cadence.

Do not borrow another account's HOME, tokens, settings or keyring context after auth-needed. Account-specific discovery needs the shared host's separately verified authorized context. A CLI metadata query is distinct from a model-generation request, but this work does not claim every metadata query is free or consumes zero quota.

The existing full TaskSpec route still requires native confinement. The proposed narrow no-tools inference route remains unavailable for AGY until its separate capability review proves zero tools and controls startup hooks/MCP/skills/plugins. `tools: []` in a custom-agent document and `--mode plan` are not accepted proofs. No Claude-only flags are added to AGY.

## Verification scope

Focused tests use fake child processes plus real private fixture-file checks. They cover exact argv/env/fd, no inherited secrets, timeout and late output/ownership, auth prompt suppression, malformed/oversized output, wrong binary/owner/symlink/mode, strict cache scope and nullable IDs, coalescing, TTL/backoff, hydration cadence and explicit loop activation.

The implemented fd-bound host was also run against the existing real AGY 1.2.15 binary for `--version` and `--help` only. It verified the raw help digest and reported auth/model/zero-tools/OS limits honestly. A separate earlier `models` metadata attempt in a fresh empty HOME reached authentication-required and was stopped immediately; no model rows, login or inference were produced. No Windows, real model generation, new credentials or permission changes were performed.

Sources: [headless CLI](https://www.antigravity.google/docs/cli/headless/), [models](https://www.antigravity.google/docs/models/), [custom agents](https://www.antigravity.google/docs/subagents/), [permissions](https://www.antigravity.google/docs/permissions/), [hooks](https://www.antigravity.google/docs/hooks/).


## Running host integration

The follow-on [metadata host](ANTIGRAVITY-METADATA-HOST.md) now wires these libraries into explicit production CLI/deployment configuration, persistent storage, startup/background lifecycle and a protected UI panel. The original implementation boundary described above is historical; model-list grammar, ordinary-account availability and actual task execution remain unverified.
