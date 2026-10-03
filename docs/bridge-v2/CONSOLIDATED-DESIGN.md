# Consolidated Bridge v2 architecture and acceptance design

Status: **design-review candidate 2, 2026-10-03**. Preserve completed code. Do not expand implementation
until this design and compatibility map pass independent review. Passing design review permits
resuming the authorized cloud implementation, not live authentication, computer access, model
invocation, permission activation, merge or deployment. Starting an actual Codex task requires a
new explicit request/approval from the user. Bridge Codex CLI and a dot/Codex task are different routes.

## 1. Goal and scope

The same existing ChatGPT-Post Bridge must let Claude, Codex and eventually Antigravity issue and
receive bounded jobs through one GitHub bus. A requester may send a CLI child and a normal Chat
child concurrently, collect each independently, inspect complete durable results/artifacts, and
ACK exact payloads. Ordinary Chat remains supported; Work/dot events and APIs are separate routes.
A final PR milestone requires actual CLI **and** normal-Chat roundtrips at a reviewed fixed head.
Source/fake-test completion alone is an intermediate checkpoint.

Additional adopted requirements: product/request organization, generated validated JSON+MD,
versioned short agent bootstrap, stable result framing, explicit artifact selection after a chat
advances, configurable local archive roots, sanitized diagnostic export, compact resident UI,
optional per-user auth-block notifications, and a Bridge-observed normal-Chat Pro counter.
[Coverage](COVERAGE.md) tracks current implementation versus follow-ons.

## 2. Non-negotiable invariants

1. Model text, GitHub comments, task files, UI display values, framing and bootstrap ACKs never mint authority
2. Approval binds exact raw TaskSpec and MD hashes, registered policy/session/executor and bounded scope
3. A committed dispatch intent, timeout, disconnect or missing ACK never permits automatic execution replay
4. Result/receipt bytes are immutable; archive/notification/quota failures cannot change them or rerun a model
5. Same-repository exclusion, canonical worktree locks and fencing remain enforced even in fanout
6. Each boundary distinguishes success, failure, unknown, unsupported, synthetic and not-run
7. No fabricated PID, model, quota, cost, artifact, success criterion, receipt or live capability
8. Host credentials are injected through authorized providers, never task/config JSON payloads or diagnostic exports
9. Unsupported native isolation or ACL identity remains denied. CLI flags and capability declarations alone are not OS confinement
10. Setup/save/test-send/start/ACK/merge are separate actions. None silently grants the next action

## 3. Common identities and stable contracts

| Identity | Meaning and authority |
| --- | --- |
| request UUID + raw TaskSpec SHA-256 + raw MD SHA-256 | Immutable task identity; globally deduplicated across products |
| run UUID + fencing token + actual process creation identity | One local execution; controller/broker evidence only |
| attempt UUID | One hosted send or CLI run; carried by framing; not permission |
| transport actor ID | Registered signing identity with requester/recipient role; different from agent/provider ID |
| authenticated UI requester / approval actor | Trusted local principal; never copied from incoming JSON |
| policy/session IDs | Bounded execution authorization and budgets; different from model conversation/session memory |
| bootstrap model-session UUID + context epoch + version/hash/challenge | Advisory context receipt; never task approval |
| fanout parent UUID + child UUIDs/hashes/routes | Delivery grouping only; does not authorize child execution |
| detached workflow manifest/grant | Existing graph/dependency authorization; distinct from fanout grouping |
| project ID + registered repo ID + immutable storage slug | Project registry identity and storage mapping; display name is presentation only |
| artifact ID + content hash + logical path + completeness | Immutable stored artifact; never select by latest chat turn alone |

TaskSpec v2 and local ResultSpec v2 stay frozen. Extensions use separately versioned transport,
hosted-response, fanout, archive and bootstrap envelopes. Unknown extension/version fails closed.
Provider JSON may contain fractional numbers; its parser must be separate from the strict integer
TaskSpec/ResultSpec parser and retain duplicate-key/UTF-8/Unicode/size checks.

### D01: One project registry

Use one trusted `ProjectRegistration` view containing `projectId` (UUID), `repoId` (TaskSpec ID),
`storageSlug` (safe, case-unique ASCII), `displayName`, approved GitHub destination, and optional
local output-root override. Transport uses repoId→storageSlug; archive pins projectId+repoId+slug.
Do not independently derive paths from UI names or maintain unrelated registries.

GitHub layout: `<namespace>/projects/<storageSlug>/requests/<requestUUID>/...`.
A signed `<namespace>/request-index/<UUID>.json` preserves global UUID uniqueness. Fanout parents
live in `<namespace>/workflows/<parentUUID>.json`. The registered examples PixivVault and
EMAKINOCO-Windows are product slugs in the same bus repository, not new repositories.

Local layout mirrors the project/request hierarchy under the pinned default or per-project root.
Display-name edits do not rename directories. Storage-slug changes require a migration design;
there is no automatic move/delete. Existing remote layouts/files are never silently reinterpreted.

Storage/config `registryRevision` is distinct from the execution policy snapshot hash. Changing a
label or output root creates a prospective storage revision; it does not reinterpret an old policy,
signed issuance or grant. Keep immutable revision history and bind accepted admissions to the exact
revision/mapping. Resolve old signed jobs through their bound historical mapping, not current-only
settings. Changing an approved bus destination, provider, authority or execution scope requires the
relevant new authorization/policy, not merely a display/storage revision. Historical revision
resolution and legacy-row refusal are required portable code, with no implicit migration.

### D01b: Policy/task/workflow hash DAG (no circular hash)

Hash the immutable MD bytes first. Hash the registered policy snapshot independently of task hashes,
workflow hashes and its own hash field. TaskSpec refers to those two digests; then hash exact raw
TaskSpec bytes. A workflow manifest refers to the completed task hashes; then hash the manifest.
The detached workflow grant binds manifest hash + existing policy hash + session/bridge/authority.
The separate task grant binds task hash + MD hash + policy/session/executor/nonce/expiry. Runtime
workflow links are detached bindings, not fields fed backward into the policy snapshot digest.
Any attempt to include the final workflow digest in a policy whose digest appears in its tasks is
rejected as circular design. Existing WORKFLOW-EXTENSION.md and core tests are the compatibility baseline.

### D01c: Signed route capability view

A future `route-capabilities-1` view must bind registry revision, transport actor, route ID, provider,
issuer/recipient roles, exact model IDs, supported extensions, billing class, observation time/expiry
and status (`unconfigured`, `implemented_unverified`, `blocked`, `verified`). It is published by the
trusted host authority, not the model. A signature authenticates its origin but does not prove OS
confinement; the broker still independently checks installed capabilities on every dispatch.
Current `task capabilities`/`bus capabilities` truthfully expose limited/unconfigured support; they
are not yet this signed remote discovery extension. Add the extension before claiming automatic
cross-provider negotiation; absence never permits guessing flags or a fallback model.

| Provider/surface | Issuer direction | Recipient direction | Current gate |
| --- | --- | --- | --- |
| Claude CLI | Generic host bus issue/fanout commands + issuer bootstrap contract | Fixed Claude plan, response frame, broker | Native supervisor/auth/live validation absent |
| Codex CLI | Generic host bus issue/fanout commands + issuer bootstrap contract | Fixed Codex plan, response frame, broker | Same; not a dot-created Codex task |
| Antigravity CLI | Follow-on same signed bus + provider-aware bootstrap | Follow-on one-turn NDJSON plan/parser | Versioned provider integration/design/native/live gates |
| Ordinary Chat | No automatic issuer/tool-signing route claimed today | Preserved browser hosted-response adapter | Same-conversation/model/auth/frame live proof absent |
| dot/Work events | Separate possible authorized event/tool route | Separate possible subscribed event route | No subscription or actual-roundtrip implementation claim |

The generic issuer API is implemented, but real Claude/Codex/AGY tool invocation of it is still a
live integration gate. Model-produced request data must reach the trusted issuer signer/validator;
models never get the signing credential or create grants merely by emitting JSON.

## 4. Trust-boundary architecture

- **Requester host:** validates/generates JSON+MD, resolves registered project/route, signs issuance,
  collects exact results/artifacts, makes explicit ACK decisions
- **GitHub storage:** immutable atomic commits and signed envelopes; Git author names/PR text are not approval
- **Recipient host:** authenticates sender and unique durable claimant, receives into local ledger,
  authenticates local approval, enforces policy/session/dependencies, reconciles identities
- **Execution broker:** private state and authenticated local channel; one-start/fences/cancel/deadline;
  native supervisor owns actual process/operation confinement and trusted evidence
- **Normal Chat adapter:** existing authorized browser route; separate hosted-response evidence;
  fixed conversation/model/policy, durable one-send intent, exact frame/prompt ownership
- **Archive:** publishes verified immutable materializations/manifests without changing execution truth
- **Notification/usage observers:** optional bounded side effects/observations; never execution authority
- **UI:** authenticated loopback product interface into these services; no arbitrary command/file/URL endpoint

Actual host deployments use a trusted explicit module at the documented CLI/desktop entrypoint.
All POSIX parents/file identity are checked; Windows requires a native ACL verifier. Imported
transitive code belongs to the same trusted deployment boundary. Default product startup has no
provider execution authority. Public distribution contains no user's destination, secret or account.

## 5. Request, fanout and collection

### D02: Durable independent lanes

For a single request: issue → authenticated claim → receipt → approval → committed one-start intent
→ start observation → terminal result/receipt → result publication → explicit requester ACK.
Transport retries reuse exactly the same identities/bytes. Unknown retains locks and reconciliation.
A browser auth block cannot stop collection of an unrelated CLI result; same authorized policy-session
pauses and same-repo exclusion still apply where required for execution safety.

Fanout atomically commits one signed parent and 2–4 child request/MD/index sets. Each child has its
own route, approval, start, result and ACK. Fan-in reports total/available/pending/acknowledged and
individual outcomes. Available is not succeeded. Reverse order, simultaneous results, one block,
one timeout/unknown and storage failure must not lose the other result or create a second attempt.
Transport progress is last-observed evidence, not a fresh process liveness probe.
The host runs independent bounded workers/lanes: it must never await a browser generation before
polling/collecting the CLI lane. `tick` remains a bounded reconciliation operation; long browser
start/generation belongs to its own worker. Cross-lane scheduling tests hold one browser future
unresolved while proving CLI receive/result/ACK continue.

### D02b: Fairness, locks and bounded overnight sessions

All current read-only and edit local jobs acquire exclusive same-repo AND canonical-worktree locks.
There is no reader-sharing optimization or lock upgrade. Different registered repos/worktrees may
run independently within explicit host/session/provider limits. Lock acquisition uses stable order;
unknown retains locks. The current SQLite lock is host-local, not a distributed mutex. Never share
worktrees/SQLite across hosts or claim multi-host shared-filesystem safety. A project needing one
exclusive execution domain must route to one configured execution authority until a reviewed
cross-host resource-lease contract exists. Fanout does not override this restriction.

Inbox, outbox, execution reconciliation and hosted reconciliation each need persisted round-robin
cursors, bounded per-tick work, backoff and independent error records. Test more than one full batch,
including permanently blocked early rows, so later jobs still progress. A result awaiting ACK stays
available and does not trigger another execution. Provider/network backpressure cannot busy-loop.

An unattended/overnight session is a separately approved finite policy: max starts, deadline,
cumulative reserved run seconds, reservation budget and unknown-quota fallback bounds. Unknown
quota denies by default; explicit fallback may reduce starts/time only, never change model/billing,
drop mandatory approvals, increase spending or erase an unknown session pause. A day/reset-window
change does not reset execution counters or authorize a new session. Fresh source observations and
trusted explicit resume/new-policy actions remain required. A05/A13 cover these boundaries.

### D03: Response framing and exact selection

Plain-text first/last boundaries carry request UUID, raw task hash and attempt UUID. The plain
syntax survives the preserved DOM→Markdown conversion. Reject wrong IDs/hashes/attempts,
truncation, nested/duplicate/out-of-order boundaries, quoted/code-wrapped markers and echoed
instruction prompts. Framing is only completeness/correlation. Local ResultSpec remains authoritative.

A result must retain explicit conversation/user-turn/assistant-turn/artifact identities when the
source exposes them. Later archive/recovery retrieves those exact identities, never the newest
visible reply. If an older message cannot be identified reliably, return unavailable/ambiguous;
never substitute another turn. Current latest-reply ownership checks are useful but do not by
themselves satisfy durable older-message retrieval; that is a required archive/browser integration gate.

## 6. Provider and native execution

### D04: Shared broker, separate provider plans

Claude/Codex/Antigravity use one trusted installation registry, fixed direct argv, hash-pinned
binaries, controlled cwd/home/I/O, explicit model and billing-route identity. Provider output is
parsed and validated separately; SUCCESS text does not prove process-tree termination. No silent
model/effort/account/API fallback. Version/help observations bound supported flags; missing flags deny.
Antigravity is a follow-on registered agent `antigravity`, not an alias of Claude/Codex.

### D05: Native supervisor is implementation work, not only testing

The current broker/IPC/installed-process driver does not supply the enforcing supervisor. The
separate Windows candidate contains bounded primitives/mediator code but lacks a complete native
service/binding, authenticated pipes, exact filesystem isolation, provider-network separation,
agent-operation channel and full receipt assembly. Ordinary AppContainer/Job membership does not
prove exact path/argv scope. Child commands must be broker-mediated with approved IDs/argv/counts,
while built-in arbitrary tools/child creation remain disabled. Provider credentials/network stay
outside task commands. Windows SDK build and adversarial actual-host evidence are blocking gates.

## 7. Agent bootstrap and protocol adherence

### D06: Short versioned startup, on-demand details

Deliver a short common+role reminder only to a Bridge-launched model session using a documented
startup mechanism. New sessions require it; a genuine resumed session may reuse only a matching
unexpired trusted version/context receipt. Version change or context/compaction loss reconfirms.
Installation is not model memory. Do not hook arbitrary manually launched CLIs or overwrite global
CLAUDE.md/AGENTS.md. An optional repo skill is uninstalled documentation until explicitly installed.

Current CLI plans create fresh sessions per run (including Claude no-session-persistence), so each
gets a new bootstrap session binding. The helper's resume receipt machinery does not claim an
actual resume detector/ACK extractor exists. Bootstrap ACK is advisory and stays inside framed
content if requested. Host validators/authorization enforce safety even when an LLM ignores text.

## 8. Archive, roots and diagnostics

### D07: Pin the archive before admitting an accepted job

For this design, a job begins when its immutable request is accepted, not when a model eventually
starts. Select and durably pin registry revision, project identity/slug and canonical output root
before returning acceptance; later settings apply only to newly accepted jobs. Never recalculate
an old job's path from current configuration. This definition must be visible in settings/help.

A same-authoritative-transaction pin is preferred. A separate archive DB is permitted only with
explicit write-ahead ordering: immutable pin committed first, then task admission; a crash leaves
an inert orphan pin, never an accepted task without a pin. Retry with the same UUID/hash reuses the
pin; conflicting input rejects. No task is automatically repinned to a newer root. Existing tasks
without pins need a separately approved migration policy, not silent backfill.

Archive writes bounded private staging files, fsyncs them and atomically renames on the same
filesystem. Manifest contains version/request/task/run/project/root pin, artifact IDs/logical paths,
hashes/sizes/completeness and synthetic/evidence status. Verify every entry before reporting complete.
No overwrite/move/delete of prior evidence. A configured archive may gate result publication and
ACK for newly pinned tasks; it never gates or rewrites already established execution truth or reruns
execution. Missing/corrupt/incomplete archive remains a separate actionable delivery condition.

Local storage roots are separate from the actual work repository, may use approved S:/M: roots,
and require native canonical identity/ACL/reparse safety on Windows. A caller-supplied boolean is
not a native attestation. Raw artifacts remain private unless their exact authorized destination
and sharing scope are configured. GitHub result references alone do not prove artifact delivery.

Diagnostic export is an explicit action producing a versioned, minimal allowlisted report. Exclude
prompts, absolute private paths, cookies/tokens/signing keys, raw provider logs and arbitrary model
text by default. Include error codes, verified IDs/hashes, check results and synthetic/unknown labels.
One-file export must retain enough provenance for an LLM to diagnose without guessing a latest reply.

### Archive candidate review blockers (verified by its owner)

- The candidate correctly commits the archive pin before TaskStore admission, leaving an inert
  orphan on an intervening crash. However, an old accepted unpinned row could currently be silently
  pinned by retransmitted receive. Add an explicit legacy-row guard before reservation; migration
  remains a separate authorized operation. A failed gate must not pick the current root for that row
- The pin stores resolved values but not registry revision/storage slug yet. Align D01 and persist
  the exact registration revision before integrating local/GitHub layouts
- Cancel-before-start evidence may be stored by TaskStore.localEvidence rather than the executor.
  Archive collection must resolve trusted local ledger evidence as well as executor evidence, with
  identity/hash/access validation; calling executor.readArtifact for every reference is insufficient
- Per-file fsync and same-parent rename exist, but directory fsync/power-loss guarantees and
  same-user path replacement assumptions need explicit platform review. Do not claim durable complete
  until the required filesystem operations are verified on that platform; Windows needs native support

### D07b: Route-neutral admission and artifact source (required portable integration)

Do not force HostedResponse into TaskRecord/ResultSpec. Define an immutable pre-admission
`JobAdmissionV1` with request/task/MD/project/registry/storage identity, requester/recipient and one of:

- `kind:local_execution`: registered policy-session/executor identity and a future TaskRecord reference;
  no run, fence or actual process identity exists yet
- `kind:hosted_delivery`: registered hosted policy hash and configured conversation/destination;
  no actual attempt, user/assistant turn, attachment or response identity exists yet

`ArchiveAdmissionPort.reserve(admission)` returns an immutable pin binding only the identities
known at acceptance. Both TaskController.receive and BrowserDeliveryService.receive must use it
when configured. Never invent a future run/attempt/message ID or mutate the pin after start.
Append a separate `JobProvenanceEventV1` when run/fence/process, attempt, source messages/artifacts,
response/frame hashes, materialization or ACK are actually observed. It binds the original admission
ID/hash and source revision. Unobserved fields stay explicitly absent/unknown. Local execution
provenance references the existing authoritative TaskStore events; it is not a second writable
execution state machine. Hosted provenance needs durable monotonic revisions/CAS updates.

A route-neutral `ArchiveSourceV1` resolves `local_ledger_evidence`, `executor_artifact`,
`hosted_response` and `hosted_message_artifact` through typed, identity-checked readers. It never
resolves an arbitrary supplied filesystem path.

Use **`artifact-archive-2`** for the new route-neutral manifest: route discriminant, admission/pin,
append-only observed provenance, raw hashes, required/optional artifact set, per-item completeness
or unavailable reason, and registry revision. Existing `artifact-archive-1` bytes are complete-only
local evidence and retain that exact meaning. Keep a strict v1 reader; do not add hosted/unavailable
fields under v1 or rewrite existing manifests. A v1-to-v2 projection may reference the verified v1
hash but cannot invent absent message/route provenance. Migration is explicit and non-destructive.

Hosted manifests never contain fabricated process identity. Exact older-message/artifact retrieval
is mandatory when the source supports it; unsupported retrieval is an explicit incomplete item.
Publication/ACK gating uses the matching route's immutable payload, not an execution success claim.

**Current portable gap:** the archive candidate only accepts TaskRecord/ArtifactRef and is wired
through TaskController. Hosted delivery bypasses that path and is not archived by that implementation.
The route-neutral port plus hosted reserve/provenance/collect/publish/ACK hooks and older-message
resolver must be implemented and tested after this design passes. They are not Windows-only tests.

### D07c: Requester materialization and ACK ownership

Sender-local archive success is not end-to-end artifact delivery. A route-neutral requester
`DeliveryMaterializerV1` must fetch the exact signed delivery manifest and required artifact bytes
through approved content-addressed destinations/readers, verify identity/hash/size/completeness,
and durably save them under the requester's own pinned output root before declaring complete.
A filename, inaccessible local path, remote reference, newest chat reply, or sender manifest alone
cannot satisfy this. Missing/unreachable/withheld artifacts remain `delivery_pending`, even when
result JSON is available. Raw-artifact destination/data scope requires explicit configured sharing
authority; no new cloud bucket, upload or private-artifact disclosure is implied by the bus.

Frozen protocol §10 already requires the requester to verify/save the Result **and artifact/receipt
evidence before resultACK**. The candidate's payload-hash-only ACK path is insufficient implementation,
not a weaker valid interpretation of v2. Preserve any such historical bytes for audit, but label them
insufficient/payload-only observations: they cannot satisfy artifact-required delivery or workflow ACK
gates. Do not grandfather `require_result_ack` from those records without the required verification proof.

Add a supplemental versioned, signed `materialization-receipt-1` bound to requester actor,
request/task/run-or-attempt, terminal event/payload hash, delivery-manifest digest and the complete
verified artifact set. It is a backward-compatible proof of the original intended receiver verification,
not a relaxation of ResultSpec/ACK semantics. For new full-delivery jobs, publish it atomically with
resultACK only after durable materialization. The recipient delivery/dependency gate checks the
required proof before accepting the ACK as sufficient. Until the verifier/materializer is wired,
production ACK paths must fail closed or remain explicitly incomplete, not advertise full delivery.

No-artifact jobs still require Result/receipt validation and a verified empty required-artifact set
(or an explicit no-required-artifact proof); absence of references alone is not a shortcut around
receipt validation. The materialization receipt attests the trusted receiver's save, not execution
success or human review approval. Notification success cannot replace it. Archive or ACK-send failure
retries only materialization/transport, retaining exact bytes and IDs. Both local and hosted routes
need their appropriate verification gates. Current PR3 result/ack commands and PR5 sender-only hooks
lack full requester artifact materialization; this is an explicit portable integration gap to fix.

## 9. Quota, Pro counter and notifications

### D08: Three different measurements

1. Codex app-server account/rateLimits/read: public narrow management observation, explicit bucket,
   separate pre-dispatch/post-ACK rows, unknown-deny/default, bounded fallback, refresh generation/time fences
2. Ordinary Chat Pro counter: Bridge-observed submissions only, deduped by immutable attempt identity;
   confirmed observed-Pro submission versus possible/unknown usage are separate. Not whole-account quota.
   The key is stable request + actual submission/execution attempt identity. Job creation, transport
   retry and ACK never increment it; a genuinely new intentional generation uses a new protocol
   request/attempt and counts separately
3. Provider cost: unknown unless a supported observation proves it. Percentages/counts are not a strict cost bound

Manual quota/cap/reset values always remain labeled user-reported/unverified, even when recent;
they cannot be displayed as authenticated provider measurements or overwrite that provenance.
Automated quota selection must bind the correct provider/account/bucket to the requested route.
A Codex account observation cannot serve as Claude/AGY/ordinary-Chat quota. Current single-provider
controller composition must be configured accordingly; multi-provider selection is an explicit
integration contract, not an inferred model-name fallback.

Do not hardcode “40/week” or a reset anchor. Counter ceiling/warning threshold/window/IANA timezone
are unknown or explicitly user-configured with provenance. Window changes do not silently move old
observations. Manual/other-device use is outside coverage. No extra LLM query is needed to count local
observations. Unknown accepted sends are not free; keep them visibly possible rather than counting zero.

### D09: Optional per-user notification sinks

Email/Discord destinations are configured per user, default off. Secure local provider/keychain
stores hold credentials behind secret references; UI masks them and diagnostics exclude them.
Saving configuration never sends a test. Explicit test-send is a separate action to the verified
destination. No address/webhook/token is hardcoded in published source or copied from task text.

Notify only approved categories such as auth/human-check blocks, with dedupe ID, bounded retry/rate,
clear delivery status and sanitized references. Notification failure preserves the job and creates
its own retry record. No repeated model submission, permission broadening or deletion follows.
Disabling a sink prevents new sends and pauses/cancels its queued retries without changing jobs,
artifacts or ACKs. An already in-flight send may have an unknown delivery outcome and cannot be
unsent; record it and never retry it while disabled. Re-enabling does not silently flush an old
backlog unless that bounded replay was explicitly selected. A notification is not a result ACK. Actual destination/data/recurring authority must be approved
before live messages; this implementation/design has sent none.

## 10. Browser continuity and UI

The existing persistent profile remains on disk after ordinary close. A healthy same-host daemon
is reused and client close disconnects it without killing the retained browser. Do not claim
closure deletes cookies or causes Cloudflare. A reuse-only test disables optional keepalive;
no stealth/fingerprint/proxy/cookie import/security bypass or speculative refresh prevention.
Auth challenges block the browser lane and need a visible human step; resume by exact-ID reconciliation.

UI follow-on: guided setup → registered product/destination → purpose/prompt → generated validated
JSON/MD; clear operations overview; dock/detail plus a tiny collapsed resident bar. State changes
must not auto-expand it. Preserve selection and drafts across hide/reopen/navigation. Configuration,
approval, test-send and execution are distinct controls. Unavailable/unknown capabilities remain
explicit. The revised mock is a nonexecuting proposal until reviewed and implemented.

### D10: Versioned unified operations read models and actions

The existing PR2 UiTaskDetail/UiBootstrap expose local TaskController tasks only. Preserve their
contract for existing clients. Add an explicit `bridge-operations-1` endpoint/read model with:

- `kind:local_execution`, wrapping the existing local task/result/receipt/evidence without changing v2
- `kind:hosted_delivery`, carrying monotonic hosted revision, policy/conversation/attempt/source IDs,
  last observed hosted status, frame/hash/ACK/archive state and route-specific capabilities
- `kind:fanout`, carrying immutable parent/child identity mapping and independent partial collection

Common presentation is project, issuer identity, requested provider/model, actual observed provider,
purpose, destination and evidence freshness. Show **who → what → where**, requested versus actual,
and transport receipt versus execution/hosted outcome. A stale response cannot overwrite a newer
revision or acknowledged flag. Hosted mutation bindings use request/hash/attempt/revision; local
mutations retain current TaskSpec hashes/observation sequence. Fanout bulk actions must enumerate
exact child IDs/hashes and cannot grant authority by parent display selection. No union may treat
hosted `completed` as local `succeeded` or invent a merged status for partially available children.

Required actions are route-discriminated: validate/import/approve/start/cancel/reconcile/collect/ACK,
archive/export, plus explicit configuration/probe/test-notification. Capability descriptors and
errors identify the unsupported route. Current local-only UI cannot show hosted/fanout simply by
passing a new executor; implementing the versioned adapters/endpoints/frontend is a portable gap.

### D11: UI acceptance details

- Preserve the reviewed 280×380 vertical dock, balanced card/button grid and progressively revealed details
- Initial compact resident bar; expand only by explicit action; collapse/hide/tray states retain drafts,
  selected request and unsent form values. Job completion/alerts must not auto-expand it
- Light/dark themes apply to dock/detail/forms/state colors, with readable contrast; theme alone may be
  persisted in the browser. Secrets/tasks/output roots/authority remain host-managed, not localStorage
- Test normal/small displays, 100/125/150/200% scaling and multi-monitor placement. Keep a visible return
  path from hidden/tray mode, and never leak private launch-token fragments through new-window navigation
- Setup distinguishes configured versus live-verified. Composer picks registered project and multiple
  destinations, then purpose/prompt, then generated JSON+MD/validation. Unsupported candidates remain disabled
- Operations show dependencies, exclusive locks, partial fanout results, source/time/freshness for quota,
  bounded overnight limits, pinned archive/manifest, safe diagnostics and notification-off default
- Actual OS tray/minimized/always-on-top behavior needs explicit native implementation and verification;
  the current standalone mock is a proposal, not a live system state or permission request

### D12: Antigravity one-turn bootstrap decision

The AGY follow-on currently has helper-only bootstrap, so it does not yet share completed startup
integration. The reviewed target is one controlled stdin user event containing the short versioned
bootstrap plus the framed task, retaining the original MD hash independently. It must not launch a
second model turn only to obtain bootstrap ACK. If its documented parser/version cannot support
that single-event composition, fail the bootstrap capability rather than silently omit it.

Bootstrap ACK may be extracted from the validated frame body only, bound to exact model session,
context epoch/version/hash/challenge. It is advisory; absent ACK means no trusted receipt/reuse.
Current fresh AGY sessions need bootstrap each run. Implement the one-event injection and parser
compatibility test before advertising shared D06 support. An installed skill does not close this gap.

## 11. Compatibility and staged work

| Stage | Current state | Required compatibility review before continuing |
| --- | --- | --- |
| PR1 core | Published draft, frozen TaskSpec/ResultSpec and durable ledger | No weakening of exact bytes, grants, locks, cancellation, receipts |
| PR2 UI | Published draft on PR1 | Preserve legacy route and authenticated UI semantics |
| PR3 transport/integration | Implemented candidate, bounded tests/review finishing | Product registry, framing, fanout/bootstrap, configured startup and immutable state contracts |
| Native candidate (PR4) | Separate incomplete experimental source | Real OS enforcement/service/evidence design and Windows build gates; not merge-ready secure execution |
| Archive (PR5) | Separate implemented draft/tests | Reconcile project registry/slug and pin ordering; older-message IDs; archive/ACK gates only for configured pinned tasks |
| Antigravity follow-on | Separate provider candidate/tests | Supported versioned flags, strict fractional provider parser separate from TaskSpec, no native-success claims |
| UI proposal | Separate nonexecuting mock | Approved behavior/empty/error/blocked states; no unsupported controls represented as live |
| Pro counter / notifications | Adopted, follow-on design | Local-only provenance/windows, per-user secrets/destinations, explicit send, no account-quota invention |

The archive candidate currently uses UUID-based project paths; align it with the common registered
slug view or document a reviewed backward-compatible mapping before integration. Do not create a
second independent registry. No candidate workspace overwrites another; rebase/cherry-pick only
against verified immutable parents, then retest the complete combined tree.

## 12. Acceptance map

| ID | Required evidence |
| --- | --- |
| A01 portable | Root + GUI typecheck/lint/build/tests; failed and skipped separated; exact file/head hashes |
| A02 transport | Exact JSON/MD commits, actor signatures, product mapping, global dedupe, one owner across independent ledgers, bounded retry/permission failure |
| A03 authorization | Manual/automatic/bypass bounds, stale/hash/nonce/session/workflow/mandatory-confirmation rejection; no task-minted grant |
| A04 lifecycle | Normal/failure/timeout/cancel/crash/unknown, before/after-spawn races, one start, identity/fence/evidence verification |
| A05 fanout | CLI+Chat reverse/simultaneous completion, one auth block/unknown/timeout/save failure, partial counts, per-child exact ACK |
| A06 framing/bootstrap | Wrong/quoted/echoed/partial/duplicate frame rejection, DOM extraction, new/resume/version/lost-context receipt cases; no authority from either marker |
| A07 native | Windows SDK build and actual malicious fixtures, exact path/argv/count/network denial, process creation identity, descendants terminated, pipe/ACL isolation |
| A08 archive | Original message/artifact IDs survive newer chat turns; bytes/hash/manifest completeness; pinned roots survive config changes; atomic failure recovery; no overwrite/rerun |
| A09 usage/alerts | Duplicate/unknown/window/timezone counter cases; no whole-account assertion; disabled sinks/save-without-send/explicit test/dedupe/rate/failure recovery; zero secret export |
| A10 UI | Actual rendered mock/implementation review; tiny collapsed state stays collapsed; drafts/selection survive; auth/unknown/partial views remain honest |
| A11 actual roundtrip | Fixed reviewed head with real approved CLI and same ordinary Chat request→claim/approval→result→ACK, matching IDs/hashes/evidence and negative/recovery checks |

Actual testing is delegated to Codex (implementation/fixes) and Claude (independent audit/retest)
when explicitly authorized. The user should only perform identity/permission steps that require
them, not be handed an unexplained manual test suite. The ready-to-paste prompts and structured
report are in [TESTING.md](TESTING.md). All installed CLIs must be capability/auth-checked before use;
do not give redundant installation instructions or assume installation means authentication.

## 13. Ownership, stage and requirement acceptance index

Owners are functional implementation/review roles, not automatic permission to run a real agent.
Codex is the intended implementation/fix executor and Claude the independent audit/retest role only
when the user explicitly authorizes an actual task/model invocation.

| Requirement ID | Scope | Implementation owner / stage | Acceptance IDs |
| --- | --- | --- | --- |
| R01 | Strict core, grants, non-circular workflow, counters | Core maintainer / PR1 compatibility; security reviewer | A01,A03,A04,A13 |
| R02 | Same-repo read/edit exclusion, local lock domain, fairness | Runtime/transport maintainer / PR3 and integration | A02,A04,A05,A13 |
| R03 | Product registry and signed global dedupe | Registry + transport maintainer / PR3→PR5 alignment | A02,A08,A12 |
| R04 | Bidirectional provider capability discovery and signatures | Provider/transport maintainer / PR3 follow-on + AGY | A02,A11,A12 |
| R05 | Concurrent CLI + Chat, partial fan-in, independent ACK | Transport maintainer / PR3 | A05,A11 |
| R06 | Complete frames and exact older message/artifact selection | Browser/transport + archive maintainer / PR3→PR5 | A06,A08,A11 |
| R07 | Native confinement and Windows service/binding | Native platform maintainer / separate incomplete candidate | A04,A07,A11 |
| R08 | Claude/Codex/AGY plans/parser, exact model/billing | Provider maintainer / PR3 + AGY follow-on | A03,A06,A07,A11,A12 |
| R09 | Versioned new/resume/lost-context bootstrap | Bootstrap/provider maintainer / PR3 + AGY alignment | A06,A12 |
| R10 | Route-neutral pinned archive, manifest and diagnostics | Archive maintainer / PR5; cross-contract reviewer | A08,A14 |
| R11 | Local/hosted/fanout UI read models and actions | UI/API maintainer / post-mock implementation | A10,A14 |
| R12 | Tiny resident bar, theme, sizing, who→what→where | UI maintainer / reviewed mock follow-on | A10 |
| R13 | Codex quota and bounded unattended fallback | Runtime/quota maintainer / PR3 | A03,A09,A13 |
| R14 | Bridge-only normal Chat Pro measurement | Operations maintainer / planned follow-on | A09 |
| R15 | Optional per-user email/Discord alerts and secrets | Operations/notification maintainer / planned follow-on | A09,A14 |
| R16 | Dedicated browser reuse/auth recovery without bypass | Browser maintainer / existing daemon + bounded follow-on | A04,A10,A11 |
| R17 | Scripted checks, ready prompts, structured result handoff | Integration maintainer / current docs and runner | A01,A11,A14 |
| R18 | Actual two-route final milestone and no unapproved Codex task | Integration lead + independent reviewer / final gate | A07,A11 |

Additional cross-contract acceptance gates:

- **A12 compatibility:** golden fixtures roundtrip each version/discriminant; signed roles/models are
  explicit; strict provider decimals do not relax task parsing; one shared project registry feeds
  transport/archive/UI; old clients reject unsupported extensions without migration or execution
- **A13 bounded scheduling:** >batch permanently blocked rows do not starve later rows; read/read and
  read/write same-repo jobs remain serialized today; different safe domains progress; unknown keeps
  locks/session pause; overnight limits/quota failure/staleness/window rollover cannot reset authority
- **A14 route-neutral operations:** both local and hosted admissions pin roots atomically; both archive
  exact source artifacts and gate their own ACK; the unified UI cannot cast hosted to local success;
  configured old unpinned rows explicitly block; requester materialization verifies/saves all required
  bytes and binds a signed receipt before full-delivery ACK; inaccessible raw refs stay delivery_pending;
  export includes a self-contained sanitized timeline,
  provenance and ACK/manifest status or marks each unavailable field, never inventing them

## 14. Review exit criteria

Independent review must accept identity/authority separation, extension compatibility, D01 registry,
D07 pin ordering, native missing-code honesty, archive/message selection, usage provenance and
notification consent. Every adopted requirement must have an owner, stage and acceptance ID.
After review passes, resume implementation by bounded stages and repeat affected plus aggregate
checks. Do not remain indefinitely in design, but do not label an intermediate fake-tested stack final.
