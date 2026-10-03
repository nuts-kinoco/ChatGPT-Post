# Detached workflow authority extension v1

This is a separate, versioned outer contract implemented in `src/contracts/task-workflow.ts` and `TaskStore.configureWorkflow`. It does not change the six frozen v2 artifacts or silently add fields to TaskSpec. The older `configureDependencies` test scaffold stays synthetic-only. No CLI exposes either grant ingestion or workflow execution.

## Non-circular construction

1. Fix the registry/ACL policy snapshot first. It contains no TaskSpec hashes, manifest hash or workflow graph digest
2. Produce each immutable TaskSpec and Markdown body and compute their exact raw-byte hashes
3. Produce a UTF-8/no-BOM `workflow-1` manifest containing the workflow UUID and all job UUIDs/TaskSpec hashes/edges/expected result commit/explicit result-ACK condition
4. Hash the exact manifest bytes, including whitespace
5. A separately authenticated authority issues a `workflow-grant-1` grant binding that manifest hash to the existing policy snapshot, session, bridge and approver, with unique grant UUID/nonce, expiry and start ceiling
6. Enroll all nodes atomically before any task approval. Independently approve each TaskSpec through the existing detached task-grant path

This avoids a circular hash: neither the policy nor Tasks refer to the later manifest digest. The manifest refers to Tasks; the separate grant authorizes the pair (manifest, policy). The authoritative ledger enrollment prevents moving a request to another workflow after task approval. A workflow grant never creates task approval, expands a task's permissions, starts a process, or implies user acceptance of results.

## Manifest shape

`protocol_version` is `workflow-1`; `workflow_id` is a UUID. `jobs` contains 1–256 entries with `request_id`, `task_spec_sha256`, and `depends_on`. Each dependency has `request_id`, `expected_commit` (full commit hash or null), and `require_result_ack` (boolean). A non-null expected commit must match the prerequisite's verified resulting commit. With `require_result_ack=true`, successful execution alone does not release the dependent node.

Unknown fields, duplicate JSON keys, BOM, invalid UTF-8, oversized input, duplicate nodes/edges, missing references, self-dependency and cycles are rejected. The manifest is capped at 256 KiB. All tasks must already be durably received and unapproved, with matching stored task hashes and authority context.

## Grant shape and transaction

The detached grant requires `protocol_version: workflow-grant-1`, `grant_id`, `nonce`, `max_starts`, `workflow_id`, `manifest_sha256`, `policy_snapshot_sha256`, `session_id`, `bridge_id`, `approver_id`, `decision`, `issued_at`, and `expires_at`. A grant is usable only when approved, unexpired, issued no later than now, and with at most 24 hours between issue and expiry. `max_starts` is a positive safe integer no larger than the manifest's job count.

The authority must authenticate/authorize the approver and snapshot outside these library functions. `configureWorkflow` is an authority-only integration boundary, not an API for task-produced text. The PR does not deploy that authentication service. It does support nonsynthetic enrollment under this detached contract; real executor dispatch remains unavailable until an enforcing broker is implemented.

The same SQLite start transaction checks immutable manifest bytes/hash, current workflow grant/revocation/expiry, workflow start count, node TaskSpec hash, bridge/session/policy, prerequisite receipts/commit/ACK, the independent task grant, session budgets, repository exclusion, fencing and start intent. Failed admission rolls back every reservation. Unique grant IDs and nonces prevent reuse across workflows. Identical enrollment replay is a no-op; changed manifest/grant/enrollment is a conflict. Each TaskSpec still starts at most once.

## Stop and delivery semantics

`TaskController.revokeWorkflow` validates the controller's authority context, revokes the workflow, and records/initiates cancellation for its nodes. Direct authority-store revocation also blocks new nodes immediately; status/collect check revocation or expiry and cancel active work on their next reconciliation. A future broker must receive revocation independently of a disconnected controller. Lack of termination evidence remains unknown; it never frees a retry.

Result ACKs only acknowledge a specific immutable terminal payload. They never allocate another task start. Job termination, successful workflow outcomes, result delivery, human acceptance, source-control review and merge remain separate. There is no automatic next-node scheduling, workflow-completion notification, hosted-chat executor, GitHub event subscription, or merge in this extension.
