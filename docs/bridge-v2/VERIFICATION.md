# Verification record — 2026-10-03 (historical PR1)

For the current combined checkpoint see [ADAPTER-VERIFICATION.md](ADAPTER-VERIFICATION.md) and the separate [TESTING.md](TESTING.md) handoff. The PR1 baseline failure and skips below are historical; they are not the combined result.

## Source and scope

- Upstream baseline: `611aa90c4f577bedd9f089d6f7a3d4df0d4eab2e`
- Dedicated branch: `bridge-v2/offline-core-20261003`
- Use the exact draft PR head SHA for handoff; do not substitute a moving main checkout
- Offline core, synthetic fake execution and contract tests only; production executor, approval service and delivery/quota adapters are unconfigured

## Executed checks

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/bridge-v2-npm-cache` | Passed after moving the cache from an unwritable default directory |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| `npx vitest run tests/unit/task-runtime.test.ts tests/unit/task-preflight.test.ts tests/unit/task-contracts.test.ts tests/unit/task-cli.test.ts` | 172 passed across 4 files |
| Independent second review | Independently repeated typecheck + 172 targeted tests; separate 27-case workflow parser/grant review suite passed |
| `npm run test:unit` | 599 passed, 1 failed across 36 files |
| Pinned baseline reproduction of that failure | Same `tests/unit/security.test.ts:175` failure, 8 passed/1 failed |
| `npm run test:fixture` | All 56 browser tests skipped; no browser regression pass claimed |
| Compiled CLI smoke checks | Help/capabilities, fixture validation, schema output and unavailable-action errors passed |
| Original blob hash comparison | Only README.md and src/cli/main.ts differ among pre-existing source files; the generated experimental extension is not part of this patch |
| Reviewed protocol/schema copies | Frozen six artifacts preserved; runtime schemas byte-identical to reviewed source |
| UI mock logic / independent artifact review | Author reported 20 logic tests and 34 independent checks passed; actual browser rendering unverified |

The pre-existing Linux failure assumes case-insensitive Windows-style browser-profile path matching, while `profile-guard.ts` normalizes case only on Windows. It was reproduced in a separate pinned-baseline workspace. The guard and legacy security test are unchanged in this PR. Do not describe the complete legacy suite as passing.

## New behavior exercised

- Exact raw TaskSpec/Markdown hashes; encoding/size/duplicate-key/Unicode/schema rejection
- Approval mutation/staleness/revocation/lifetime/policy/nonce and bounded automatic/bypass rules
- Same-ID duplicate and conflicting bytes; one start across two SQLite connections
- Atomic start-consumption rollback before commit; no restart after committed dispatch uncertainty
- Running disconnect, same-run reacquisition, unknown terminal/never-started recovery and persistent session pause until explicit resume
- Cancellation committed before success, timeout reason preservation, disconnected cancellation, late start and bounded emergency-stop fanout
- Request/run/process/fence mismatch; evidence byte hashes and Result consistency
- Atomic session start, cumulative runtime and reservation-unit ceilings; unknown quota fallback limits; strict monetary cost remains unestablished
- Same-repo/read-edit exclusion, canonical worktree aliases, monotonic durable fencing and stale observer rejection
- Detached non-circular workflow manifests/grants, exact-byte mutation, nonce/replay/start ceilings, missing/cyclic nodes, enrollment integrity, expected hash/commit/ACK conditions, expiry and revocation
- Terminal receipt/outbox atomicity, exact Result payload hash, repeated/wrong/stale ACK and pending delivery
- Separate pre-dispatch/post-ACK quota observations; post-ACK quota failure preserves the terminal Result bytes and acknowledged delivery
- CLI dispatch and default executor/delivery remain fail closed; fake executor is test-only

## Not executed or not implemented

- No connected-PC task, Windows operation, real Claude/Codex CLI, model inference, live ChatGPT request, quota management RPC, external notification or job execution
- No actual Windows sandbox/Job Object/NTFS/process-identity confinement test
- No production broker, authenticated approval server, executable/model registry or OS-enforced filesystem/command/network boundary
- No operational GitHub common job bus, ordinary-Chat app-event activation, Work/dot MCP Events subscription, result writeback or automatic wakeup
- No actual UI/runtime integration, live health/model/effort discovery, provider billing guarantee or automatic workflow scheduler
- No source-control merge or deployment

These platform-independent integration gaps are separate from Windows-only validation. Node/npm/git activity was code and artifact engineering, not a model CLI invocation. No account usage counters were queried, so total quota or cost impact cannot be proven from this work log.
