# Bridge v2 implementation checkpoint (historical PR1 core)

Current adapters/startup and remaining code are documented in [ADAPTERS.md](ADAPTERS.md). This file records the PR1-only checkpoint; its statements that adapters do not exist are historical, not the current combined availability.

This is an offline core implementation in the existing `nuts-kinoco/ChatGPT-Post` project. It is not a working GitHub-to-LLM bus or a production sandbox. `UnavailableTaskExecutor` is the only production implementation. The fake lives under `tests/helpers` and is not available as a CLI execution option.

## Code and purposes

| File | Purpose |
| --- | --- |
| `schemas/task.schema.json`, `schemas/task-result.schema.json` | Reviewed v2 wire contracts; legacy request/result schemas are preserved |
| `src/contracts/task-workflow.ts` | Separate non-circular detached workflow manifest/grant parser and validation |
| `src/contracts/task-types.ts`, `task.ts` | Strict UTF-8/JSON parser, exact-byte SHA-256 binding, schema/types, relational result checks, serialization |
| `src/state/task-machine.ts` | Checked lifecycle transitions; unknown is nonterminal and never requeues |
| `src/state/task-store.ts` | Host-local SQLite v2 tables inside existing `jobs.db`; atomic CAS snapshots, events, detached grant consumption, session reservations, receipts, handshakes, dependency gates and write locks |
| `src/state/task-controller.ts` | Receive/approval/start/status/cancel/collect/emergency-stop library; bounded broker RPCs, identity-bound reconciliation, evidence-byte verification |
| `src/state/task-policy.ts` | Trusted bounded policy evaluator; manual/automatic/bypass retain scope/hash/expiry/mandatory-confirmation checks; preflight filesystem checks |
| `src/state/task-executor.ts` | Broker port and fail-closed unavailable implementation, no process or shell fallback |
| `src/state/task-delivery.ts` | Unconfigured future delivery port; transport submission never synthesizes result ACK |
| `src/state/task-quota.ts` | Host-side rate-limit observation port; captures are separate from immutable Result/ACK bytes |
| `src/state/task-preflight.ts` | Advisory adapter health/model/effort/quota/billing observations; explicit unknown quota fallback rules |
| `src/cli/task.ts`, `src/cli/main.ts` | Existing executable's v2 help, capabilities, schemas, validation, read-only status/result; unconfigured mutations fail closed |
| `tests/helpers/fake-task-executor.ts`, `tests/unit/task-*.test.ts` | Synthetic executor, contract/CLI/runtime/preflight regression tests |
| `docs/bridge-v2/protocol/` | Six reviewed design artifacts copied byte-for-byte |
| `docs/bridge-v2/mock/` | Synthetic standalone mock and UI requirements; not connected to runtime |

## Authority and persistence

The SQLite database is authoritative and must be host-local, under a trusted broker/service account with ACLs that deny job children and transport writers. The current PR does not deploy that service account or authentication boundary. Task input and browser text cannot create grants. `approve`/`recordApproval` are library integration boundaries for a future authenticated approval authority; no CLI accepts an approval JSON file as authority.

A start transaction rechecks the stored grant and policy, consumes a single start, reserves session use/budget units, checks dependencies, acquires same-repo and canonical worktree exclusion locks and commits an unknown dispatch intent before contacting the executor. A crash before commit rolls back. A crash after commit never causes another `start`; only status/collect/cancel of the same run is permitted. Fencing tokens increase durably across starts sharing a registered repo or canonical worktree. The current run token is checked on every persisted update; snapshot revisions also fence late controller replies. Local SQLite serialization protects two connections, not distributed hosts.

Cancellation intent is durable before broker calls. A timeout is a stop request, not proof that a process stopped. Bounded RPC failures become unknown. Emergency stop blocks future session starts and initiates cancellation of every current run. Cancellation is reissued idempotently until a matching terminal/never-started proof can be verified. A committed cancel wins a later successful executor observation; timeouts finalize as failed/run_timeout only after termination proof. Unknown pauses are latched until an explicit trusted resume. The future broker must honor deadlines without an attached controller and persist cancel tombstones that defeat late starts.

Terminal evidence joins request/spec/run/fence/process identity, actual agent/model, command argv/binary hashes, exits, changed files/diff, criteria and artifact hashes. Hash consistency does not authenticate an agent's claims: only a trusted executor channel can supply these observations. Public synthetic results remain `synthetic: true`, `receipt: null`; their internal test snapshots cannot unlock a nonsynthetic dependency.

## Scope and approvals

`manual`, `automatic` (internally `autoapprove`) and `bypass` are confirmation tiers. Bypass only removes repetitive UI confirmation in an already authorized bounded policy; it does not bypass mandatory action confirmation, task bytes, path/command limits, dedupe or evidence checks. No persistent policy is activated by this PR.

An executable/model registry, actual base-commit inspection and race-safe per-operation confinement must be supplied by a production broker. The path checks reject traversal, reserved names, case aliases, symlinks and hardlinks at preflight; they are not an OS sandbox and cannot eliminate TOCTOU. Worktree write locks use canonical filesystem device/inode identity; Windows identity/alias behavior needs a platform adapter. Unknown jobs retain locks. No arbitrary shell strings are executed.

Session start limits, deadline, cumulative reserved run seconds and integer reservation units are enforced in the local start transaction. Reservation units are not measured provider spending. Quota observations retain source, observation time, window and freshness. Unknown quota defaults to no continuation; an explicitly preauthorized fallback can reduce actual start/time ceilings. A strict monetary budget remains denied because percentages do not prove a cost bound. An optional host-side `account/rateLimits/read` port records pre-dispatch and post-result-ACK observations in separate append-only rows, including limit IDs/windows/timing/source/version. Provider reads are not LLM `/status` prompts. Failure records unknown and never rewrites a terminal Result or its ACK. No live port is implemented or registered. No account quota was queried, no paid route was selected, no provider window was reset, and no usage percentage was guessed. Preflight is advisory and does not authorize execution.

## Workflow, handshake and transport limits

The original graph test scaffold remains synthetic-only. A separate [detached workflow authority v1 extension](WORKFLOW-EXTENSION.md) now supports nonsynthetic enrollment without a circular policy hash: hash Tasks first, then the immutable manifest; a separate workflow grant binds manifest, task identities, existing policy, session and bridge. No production approval service is activated. Enrollment is atomic before task approval, and each start separately rechecks both grants, nonce/start limits, expiry/revocation, node identity, expected result commits and explicit result-ACK conditions. Missing nodes/cycles and postapproval enrollment changes are rejected. The implementation does not automatically launch the next job. Read-only and edit jobs both acquire same-repo plus canonical worktree exclusion locks; different repos remain independent.

Admission stores a `receipt_ack`; first observed start stores `start_receipt`; verified termination stores `terminal_result` and an outbox item in the same transaction. Requester `result_ack` must match the terminal event ID, request ID, raw task hash, run ID, revision, exact serialized Result payload SHA-256 (the same pretty JSON plus final LF emitted by `serializeTaskResult`/`deliveryPayload`) and requester identity. Identical ACKs are idempotent; stale, wrong-actor and mismatched ACKs are rejected. Missing ACK retains the same pending delivery event. This is delivery acceptance, not review approval or merge. External `issued` delivery, broker authentication, retries/backoff of transport and dot wakeup are adapter work, not implemented effects.

Existing GitHub connectors were used to publish this source change. That does not make Git commits an accepted job, an execution receipt or a notification mechanism. A future GitHub inbox/outbox must authenticate actors, bind immutable commit/blob identities, deduplicate and reconcile these handshakes, and must not use a shared SQLite database across hosts. Ordinary ChatGPT conversation remains the existing browser `chat` destination. Supported app-event tasks in ordinary Chat and Work/dot MCP Events are separate research candidates in `DELIVERY-ADDENDUM.md`; neither is deployed or proved end to end here. Hosted chat cannot fabricate process identity to satisfy the present local-execution ResultSpec. Browser-subscription, CLI-subscription and API-billed destinations remain different adapters; API billing is not treated as subscription chat. A blocked browser login must not launch an alternate paid route or silently retry submission.

## Preserve / extend / replace

| Existing component | Decision and migration |
| --- | --- |
| Legacy browser `run`, `submit`, `wait`, `status`, `result`, `collect`, `worker` | Preserve. No semantic changes or v2 auto-routing. Existing browser research remains available with existing constraints |
| Existing SQLite / WAL / FULL persistence style | Reuse `jobs.db` with new `task_*` tables; legacy rows and keys remain untouched |
| Legacy SHA-1 content dedupe | Preserve for legacy. v2 uses independent exact-byte SHA-256, not a reinterpretation of legacy IDs |
| Legacy browser completion / submit marker | Preserve as transport extraction/correlation only. Never promote to v2 success or authorization |
| Legacy orphan and browser-crash retry | Preserve in legacy path. Prohibited for v2, which uses persisted intent and reconciliation |
| Existing CLI parser | Extend through an early `task` route; SQLite imports stay dynamic |
| Existing GUI | Preserve. New mock is a standalone demonstration, not a replacement or a shipped UI |

## Verification and environment

Source was fetched through the authorized GitHub connector at main commit `611aa90c4f577bedd9f089d6f7a3d4df0d4eab2e`. After materialization, original blob hashes were checked; all unchanged originals match upstream bytes. Work and tests ran in dot's Linux cloud filesystem at `/workspace/shared/bridge-v2-implementation`, Node v24.19.0, npm 11.9.0, TypeScript/Vitest/Biome from the repository lockfile. `npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/bridge-v2-npm-cache` installed project dependencies. An initial install failed because the default cache directory was not writable; the bounded cache retry succeeded.

No connected-PC Codex task, Windows operation, Claude CLI, Codex CLI, model inference, real agent job or live ChatGPT request was launched. Node/npm/git commands used here are artifact engineering/test tools, not model calls. This statement does not establish total account quota consumption from dot's orchestration; account billing/usage was not available or measured.

Detailed final check results are recorded in `VERIFICATION.md`. Windows-only verification is separate from the still-unimplemented platform-independent production adapters listed above.
