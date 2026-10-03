# Bridge v2: LLM quick start

Repository: https://github.com/nuts-kinoco/ChatGPT-Post

Entry document: `docs/bridge-v2/LLM-QUICKSTART.md` on the same revision as your checkout. Read this document first, then inspect `task capabilities` and the shipped schemas. An older checkout may not contain Bridge v2. Do not assume this implementation has been published to the repository URL until the owner has published its revision.

## What is usable now

- Offline TaskSpec and task-file validation, exact-byte SHA-256 binding, schema discovery, and read-only local ledger snapshots
- Library-level durable task state machine, detached approval interfaces, bounded policy checks, and fake-executor tests
- Existing schema 1.x ChatGPT/dot browser transport commands remain separate and unchanged

No production Claude/Codex execution adapter, approval authority, external delivery target, or notification adapter is configured by this CLI. `task receive`, `submit`, `approve`, `start`, `cancel`, and `reconcile` fail closed. Never use the old `submit` or `run` as a fallback for executing a Bridge v2 TaskSpec. A browser reply or transport success is not task completion.

## First trial, without an LLM call

Use Node.js 22.13 or newer and an authorized local or cloud checkout. These commands do not start a production executor or send a prompt:

```sh
npm ci
npm run build
node dist/cli/main.js task capabilities
node dist/cli/main.js task help
node dist/cli/main.js task schema task
node dist/cli/main.js task schema result
npm test -- tests/unit/task-contracts.test.ts tests/unit/task-runtime.test.ts tests/unit/task-cli.test.ts
```

The runtime test uses a fake executor. Its snapshots are `synthetic:true`, and its public execution receipt is null. Passing that test proves the tested offline behavior, not Windows isolation, process-tree termination, model availability, or live inference.

## Prepare and validate a task

1. Fetch the TaskSpec schema from the checked-out CLI. Do not guess fields
2. Write a local UTF-8 task file; hash its exact bytes into `task_file_hash`
3. Create a lowercase UUID `request_id` once. Set the registered `repo`, exact `base_commit`, `agent`, and `requested_model` IDs
4. Define conservative `allowed_paths`, exact command executable/hash/argv/cwd rules, timeouts, and explicit success criteria. Task network access is `deny`; caller-supplied environment variables are not accepted
5. Set the approval tier and detached-policy references required by the schema. Task JSON cannot create or activate its own approval or policy
6. Save TaskSpec as UTF-8 without a BOM. Duplicate decoded JSON keys, invalid UTF-8, unpaired Unicode surrogates, unknown fields, and unsafe integers are rejected. Hash these exact saved bytes; do not hash a reserialization
7. Validate:

```sh
node dist/cli/main.js task validate --request ./task.json --task-file ./task.md
```

A successful response has `schema_valid:true`, `task_file_hash_valid:true`, `approved:false`, and `executable:false`. `design_fixture` is always nonexecutable. Validation reads the supplied task-file path and verifies its bytes; it does not establish repository containment, resolve symlinks, approve commands, or execute anything.

## Model, effort, destination, and policy

- `agent` and `requested_model` are required registered IDs, not free-form shell commands. Availability must be verified by a trusted adapter. Silent fallback to another agent/model is forbidden
- Bridge v2 has no effort field. Do not invent `effort`, `reasoning_effort`, or a preset. `task capabilities` reports effort unsupported. Legacy schema 1.x model/preset fields apply only to that older browser route
- Inputs are local files. The task ledger is host-local `runtime/jobs.db`, or `CHATGPT_BRIDGE_RUNTIME_DIR/jobs.db`. The TaskSpec contains no external delivery destination. Do not add arbitrary Slack, email, webhook, project, upload, or notification fields
- `manual` needs a detached authoritative approval. `automatic` and `bypass` need a bounded preauthorization policy/session reference and an approved usage reservation. Neither tier bypasses allowlists, identity checks, budget/session limits, or the one-start rule
- A valid detached envelope is data, not proof of an authenticated approver. Only the trusted authority/runtime integration may install it. This CLI provides no approval import or activation command
- Health is `unconfigured`, model availability is `unverified`, and live usage/billing estimate and provenance are `unknown` until a trusted integration supplies evidence. Never convert unknown limits or prices to zero/unlimited

## Read a task already present in a configured ledger

```sh
node dist/cli/main.js task status 00000000-0000-4000-8000-000000000001 --json
node dist/cli/main.js task result 00000000-0000-4000-8000-000000000001 --json
```

These commands open the existing SQLite database read-only. They never create a ledger, approve a task, start a process, acknowledge delivery, or replay an execution. Outputs wrap the snapshot in `result` and identify `source:"local-ledger"`. The CLI checks raw task/file binding, result consistency, row sequence, and matching terminal receipt storage. It explicitly reports `evidence_authentication:"not_performed_by_cli"`; the trusted runtime/caller must authenticate receipts and verify artifact bytes, hashes, size, access, and content.

`task result` returns a terminal snapshot only when its durable receipt row matches. A synthetic terminal snapshot remains synthetic. Exit 0 means retrieval/validation worked; inspect `result.status` to learn the task outcome.

## Unknown outcomes and actionable errors

Do not automatically reexecute, create a replacement UUID, change model, or launch a second process after a timeout, transport failure, lost acknowledgement, or `unknown` state. Preserve the original UUID and immutable bytes. Pause and reconcile against the original executor identity, process creation identity, fencing token, artifacts, and durable receipt through a trusted integration. This CLI cannot perform that reconciliation yet.

| Code | Meaning and next step |
| --- | --- |
| `invalid_arguments` / `invalid_request_id` | Read `task help`; use the original canonical UUID and supported options |
| `invalid_task` | Fix encoding/schema/duplicate-key errors before seeking approval |
| `task_file_hash_mismatch` | Recompute the exact task-file hash; changed task bytes invalidate earlier approval |
| `capability_unavailable` | Configure a trusted production integration; no fallback execution |
| `ledger_not_initialized` / `request_not_found` | Check the original runtime directory and UUID; validation does not create a job |
| `ledger_invalid` / `terminal_receipt_missing_or_mismatched` | Preserve evidence and investigate; do not report completion or rerun |
| `result_not_terminal` | Poll `task status` for the same UUID |
| `outcome_unknown` | Pause and reconcile; never treat this as safe-to-retry failure |
| `ledger_unreadable` | Check Node version, host-local path, access, and integrity; preserve the request |

All CLI errors include `retryable:false`, `reexecute:false`, and an actionable `next_action`. Exit codes: 0 command succeeded, 2 invalid input, 4 unavailable/untrusted ledger or runtime capability, 6 no terminal outcome; schema-read failure uses 1. The legacy CLI retains its existing exit-code meanings.

## Minimal handoff to another LLM

> Use repository nuts-kinoco/ChatGPT-Post at the published revision supplied by its owner. Read docs/bridge-v2/LLM-QUICKSTART.md first, run task capabilities, and inspect task schema task/result. Validate only unless a trusted production integration and exact authority are actually configured. Preserve request UUID/raw bytes, request the exact registered agent/model, do not invent effort support or delivery targets, and never reexecute an unknown outcome. Report synthetic evidence as synthetic.

## Product UI entrypoint (PR2)

`npm run build` then `npm run ui` starts the authenticated loopback product UI.
The existing Electron GUI opens the same UI as a 280×380 dock with progressive details.
Use [UI-USAGE.md](UI-USAGE.md) for exact launch/profile/button steps and [UI-TESTING.md](UI-TESTING.md)
for the fixed-commit test procedure. `npm run ui:demo` is an explicitly synthetic isolated profile,
not a production executor. Legacy browser commands and the offline `task` CLI remain separate.
