# Antigravity issuer and recipient checkpoint

## Current scope

This follow-on uses the existing Bridge v2 protocol, transport, broker and product UI. It does not create another Bridge. This is a portable integration checkpoint after the consolidated design review, not a live-ready release. Nothing in this change authenticates an account or starts a provider.

- Provider ID: `antigravity`; human label: **Antigravity**
- CLI contract checked: installed `agy` 1.2.15 `--help`, plus official documentation listed below
- Issuer: the existing requester/signing identity can issue verified task files to a configured recipient; provider identity is separate from the signer actor ID
- Recipient: the existing `CliBrokerService` accepts an explicitly registered Antigravity installation and model, then requires the same enforcing supervisor as Claude/Codex
- The canonical, revisioned ProjectRegistryPort selects repository/project folders and preserves historical mappings. Neither model output nor a provider label chooses a filesystem path
- UUID, exact TaskSpec/task-file hashes, response frame, result/artifact hashes, receiptACK, startReceipt, resultACK and fan-out child boundaries are unchanged

**Live execution remains blocked.** The native OS isolation supervisor is not implemented. Windows IPC, Job Objects, identity-safe cancellation and filesystem/network mediation remain separate platform requirements. `--sandbox`, a working directory or permission settings cannot substitute for them.

## First-time steps, without inference

Use the reviewed checkout/revision containing this file. Existing CLI installations do not need reinstalling. In a separately authorized environment with dependencies available:

```sh
npm run build
node dist/cli/main.js task capabilities
node dist/cli/main.js bus capabilities
npm test -- tests/unit/antigravity.test.ts tests/unit/cli-broker.test.ts tests/unit/task-contracts.test.ts
```

Expected: task execution is unavailable; bus capabilities describe the Antigravity planner/parser and explicitly report `productionExecution:false`. Tests use synthetic provider output and a fake supervisor. They do not verify a subscription, model availability, actual commands, a live agent or native containment.

A trusted host registers `agent: "antigravity"`, the absolute executable path and SHA-256, version `1.2.15`, permitted model IDs, repository ID/root, private home root, explicit subscription/API route, and the result of `inspectAntigravityHelp(helpText, version)`. This helper only inspects supplied text. It neither executes `agy` nor certifies OS security. The supervisor must independently bind actual binary/version/config and selected model at launch. Unknown versions or missing required flags fail closed.

Task authors use the existing schemas and `task validate`. `requested_model` must be a registered model ID. TaskSpec has no effort field; do not add one. Installed help lists CLI effort support, but that is not Bridge task-level support. Do not silently switch model, subscription/API billing route or task UUID after an error.

No credential setup is included. Keep credentials outside task JSON, task files, the GitHub bus, process arguments and model-visible environment. A production integration must mediate its separately authorized provider connection without exposing it to task operations.

## Recipient wire plan and parser

The fixed plan uses stdin NDJSON and streaming NDJSON output. It sends one `user` event containing the task text wrapped by existing request/hash/attempt response framing, then closes stdin. Arguments include an explicit model and timeout, slash-command expansion disabled and the CLI sandbox flag. The plan never selects a custom agent, resumes a conversation, enables remote control or bypasses permissions.

`AntigravityOutputParser` accepts bounded byte chunks, validates strict UTF-8 and duplicate JSON keys, expects one init/session/model/cwd followed by progress and one final result, and only extracts the terminal response. Fractional provider durations use a separate strict provider JSON reader; Bridge protocol JSON still rejects fractional numbers. Provider text, tool logs and model claims are not host execution evidence.

A provider SUCCESS requires clean exit, one turn and a matching complete frame before it is returned as parsed transport data. Its `authoritativeExecutionEvidence` is still false. The broker only accepts independent, identity-bound supervisor evidence for actual agent/model, command outcomes, complete diffs/logs, process-tree termination and durable receipts. Provider ERROR, CANCELED, INTERRUPTED, INVALID, WAITING or RUNNING cannot manufacture a terminal Bridge receipt.

Conversation IDs are retained as diagnostics. There is no provider status/cancel RPC in this adapter. Poll status, request cancellation and collect through the existing broker using the same request/run/fence identity. Lost output or timeout is uncertainty, never permission to rerun.

## Issuer/session reminder

The existing versioned session-bootstrap helper supports Antigravity in both `issuer` and `response_producer` roles, with startup ID `antigravity-stream-stdin`. It adds a link to this file on demand. The reminder keeps task-schema discovery, framing and ACK rules short. Its ACK proves only receipt of the reminder, not approval or task completion.

The CLI launch plan injects the short versioned reminder before the framing instructions inside the same single stdin user event. It binds the new bootstrap session to the run UUID and context epoch 1, and retains the exact reminder/hash in the plan. It does not modify the hashed task file or install global rules. Any requested advisory ACK belongs inside the final response frame. A trusted launcher may pass explicitly extracted matching ACK bytes to SessionBootstrapStore after authenticating its session/channel; the output parser never mints that receipt. Automatic ACK extraction and actual resume/context-loss detection are not implemented. Do not prepend a second turn to the one-task recipient plan: its parser intentionally rejects multiple turns. The helper tests retained-session/version/context bookkeeping, but task execution remains fresh-only without resume flags.

For an external issuer session, an administrator may explicitly install a small skill/rule pointer after reviewing its scope. This change does not write `.agents`, `AGENTS.md`, `GEMINI.md`, global rules, hooks or plugins. Those discovery surfaces must be confined/sanitized by the enforcing supervisor before recipient execution. A skill is guidance, not authority.

## Failure handling

| Failure | Meaning / action |
| --- | --- |
| `antigravity_version_unsupported` | Keep the request unchanged; review the newly installed CLI contract before registering it |
| `antigravity_capability_unavailable` | Required observed help features are absent; do not substitute flags or another provider |
| `cli_agent_model_repo_denied` | Correct the trusted registry or approved request before admission; never guess an ID |
| `antigravity_init_mismatch` | Actual stream configuration did not match the plan; preserve evidence and reconcile |
| `antigravity_stream_truncated` / `antigravity_result_missing` | No complete output; status remains subject to supervisor reconciliation |
| `antigravity_conversation_mismatch` / `antigravity_event_after_result` | Wrong session, extra turn or corrupt stream; no result acceptance |
| response frame error | Wrong/partial/duplicated answer; no response acceptance or ACK |
| `sandbox_capability_unavailable` | Missing real OS enforcement; no direct-process fallback |

## Verification checkpoint

Linux cloud only, 2026-10-03. The 10-file AGY delta was reapplied by three-way comparison onto verified PR3 checkpoint `20261003T0823` (source manifest SHA-256 `774ac57870750f4518c1b6d874b7999eba42f3af8e5e32eb460a38c39121d8e9`). Canonical registry/history, receiver materialization-proof ACK gates and the hosted output-contract amendment remain unchanged.

Root and GUI typecheck, lint and build passed. Root tests: **1,054 passed, 56 inherited browser skips**; GUI: **51 passed, zero skipped**. The earlier focused AGY/broker/contract run passed 151 tests. Browser skips are not passing browser or live-provider evidence. The snapshot omitted the generated `experimental/stealth-extension` output directory; recreating that empty directory allowed the existing build script to generate its output. No source workaround was used. The exact imported source manifest is retained separately from project source so it is not mistaken for a new application file.

Independent review identified a progress-state type-coercion bug: JSON arrays such as ["DONE"] were accepted as strings. The parser now requires an actual string before enum matching, with positive and negative regression cases. Independent recheck passed: all 16 unchanged reviewer regressions and full aggregate checks passed for the corrected adapter. The published PR3 signer deadline was then inherited without changing the reviewed AGY implementation and the complete root/GUI checks passed again. This evidence does not establish live behavior.

Test coverage includes fixed argv/stdin framing, missing flags/version/model denial, strict malformed/truncated/duplicated/oversized output, fragmented UTF-8, provider status handling, no promotion of provider text to execution receipts, shared broker deduplication/reopen/collection and pre-start cancellation, plus issuer/recipient bootstrap ACK and UI labels. No authentication, inference, provider network call, Windows test, security permission change or user-computer operation was performed.

### Stacked publication base

The dedicated Antigravity branch is based on PR3 commit `a1ed5427379b37167db839bbc1d19d52e22afafd` (`bridge-v2/delivery-adapters-20261003`). It preserves PR3's independently reviewed bounded signer timeout and receiver-proof gates. The final [command report](evidence/antigravity-publication-checks-20261003.json) records the Linux-only test run; its sourceHead is a local test snapshot, not the remote publication identity. The [source manifest](evidence/antigravity-source-manifest.json) binds the exact delta to the remote PR3 base. GitHub CI is reported separately from these local checks.

## Remaining integration gates

- Native confinement/service, independently bound agent/model/process telemetry and actual provider integration remain unimplemented or unverified as described in CLI-EXECUTOR.md
- Actual authenticated issuer tool calls and signed cross-provider route-capability discovery are not implemented by this adapter
- Automatic bootstrap ACK extraction and real resume/context-loss detection remain explicit launcher gaps; task sessions are fresh-only
- The hosted `output-contract-1` amendment applies only to ordinary Chat. CLI issuance, including Antigravity, retains a null output-contract digest until local-route support is separately designed
- Result ACK remains subject to the existing receiver artifact/materialization-proof gates. A provider SUCCESS, valid frame or bootstrap ACK cannot satisfy those gates

## Sources and version caveats

- [Official CLI reference](https://www.antigravity.google/docs/cli/reference/)
- [Official headless protocol](https://www.antigravity.google/docs/cli/headless/)
- [Official installation and auth](https://www.antigravity.google/docs/cli/install/)
- [Official skills](https://www.antigravity.google/docs/skills/) and [rules](https://www.antigravity.google/docs/rules/)

The installed help snapshot is `tests/fixtures/antigravity/help-1.2.15.txt`. Documentation and installed help differ on available effort levels and timeout defaults; this adapter does not rely on either default. It pins the observed version, sets an explicit timeout and leaves task-level effort unsupported. Live model/account behavior remains unverified.
