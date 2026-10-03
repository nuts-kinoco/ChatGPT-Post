# R04 / R09: bounded closure assessment

Baseline: PR14 head `27aec64dc3200fe404bb96fdb4d8252cadd6ecd9`; implementation bytes were independently reviewed at parent `ccc8c08efc0691840cc4286c07044200f2b060c8`.
This is a proposal for design review, not new execution authority or a claim that the gaps are closed.
The fixed SDK no-tools trial and its exact echo/limits remain unchanged.

## Findings from the current source

1. `src/cli/bus.ts` already exposes configured catalogue/template/issue/fanout/result/ACK. Its deployment supplies the trusted signer and materializer. Raw task/model text cannot choose a signing key. So an external issuer can already use an explicitly configured local CLI route; a new agent framework is unnecessary.
2. `src/ui/issuer-read-port.ts`, `composer.ts` and `composer-transport.ts` share validated recipes, exact preview bytes, policy/model/registry/renderer drift checks and atomic bus issuance. They should remain the only recipe/issue implementation.
3. The catalogue is an authenticated local projection, not a signed receiver capability record. There is no actual agent-tool session wrapper or signed cross-provider capability discovery. Provider labels are not authenticated principals.
4. `src/adapters/cli-launch.ts` injects a reminder into Claude/Codex/AGY stdin and retains it in the launch plan. It calls the pure planner directly. `SessionBootstrapStore` has no production caller anywhere in src. No adapter automatically extracts or persists the advisory ACK.
5. Current CLI launchers are fresh-only with run-bound session UUID/contextEpoch1. There is no real resume/context-continuity detector. The helper's fake resume tests do not implement a live resume feature.
6. Ordinary Chat and SDK text are different contracts. Browser reminder integration would need an explicitly versioned prompt/renderer profile and durable dispatch binding. The fixed SDK echo has no room for arbitrary extra ACK text; do not retrofit it.

## Recommended small stages

### I1: signed capability and exact issuer facade (portable)

Use the existing trusted deployment as the host boundary. Add a narrow `IssuerSessionPort` wrapping the existing recipe, bus and materializer, with a host-created immutable binding:

- requesterActorId, opaque host session ID, provider label, allowed project/destination IDs, expiry
- fixed registered signer; providerId is descriptive and never an authority token
- caller cannot supply deployment path, keys, account/permission mode, arbitrary filesystem paths or replacement authority
- supported methods: catalogue, template, prepare exact bytes, issue exact prepared identity/hash, read original result, materialize/ACK exact terminal hash
- never expose approve, start, credential setup, policy mutation, plugin installation or bypass through this issuer role
- unknown issue outcome retains the same request/child IDs and is reconciled through existing immutable bus state; no new execution or duplicate journal

The local configured CLI can expose this facade first. An actual Claude/Codex/AGY tool transport requires an explicitly registered host channel and supported provider configuration; code must report unconfigured when that channel is absent. Do not claim that a CLI installed somewhere or an arbitrary model prompt establishes that connection. No new MCP server/plugin is required for the first slice; if later selected, its transport is an adapter over this same facade.

Add `route-capabilities-1` as a detached, strictly validated signed record from the registered recipient host. Bind recipient actor, provider, route family, allowed model IDs, policy hash, public project registration refs, observation/expiry timestamps, and explicit per-action availability/reasons. Keep process support, auth, quota and policy status distinct. Signature proves the registered origin, not OS enforcement or fresh account readiness. Revalidate the actual recipient policy/capability at admission/start as today.

Initially return signed records through the configured read-only issuer entrypoint, using the same closed codec/key registry and bounded signer timeout. If Git publication is desired, define immutable versioned snapshot paths and bounded freshness/selection rules before adding them; never overwrite a shared latest file or consume task UUIDs. Do not reuse a requester signature as recipient capability attestation. Old task pumps and frozen TaskSpec/ResultSpec remain unchanged.

Acceptance I1-01..08: wrong issuer/session/recipient role; spoofed provider; stale/expired signature; registry/policy drift across await; unknown model/unavailable action; mutation method denial; repeated/unknown issue uses exact IDs; no model/auth/policy start from discovery.

### B1: production fresh-session ownership + advisory ACK capture (portable hooks)

Use the existing SessionBootstrapStore, not another session database. Prepare before dispatch, persist the exact pending reminder/challenge, and pass that plan into launch construction so the same bytes appear in stdin and the durable launch record. Ensure restart/repeated start reuses the saved challenge for the original run rather than generating another one. Scope remains a fresh Bridge-owned run; no resume flags are added.

Add a bounded extractor receiving an already-selected, authenticated provider response source plus exact frame identity. It may produce an advisory receipt only after matching the saved session/provider/repo/context/version/challenge. It never reads latest reply opportunistically, upgrades task status, supplies ResultSpec/termination evidence, or replaces delivery ACK. Missing/malformed/duplicate/wrong-session ACK remains explicitly unconfirmed and never triggers another query.

Before implementation choose a versioned extraction format. The safest small option is a unique reserved ACK block inside the response frame. Preserve historical v1 reminder bytes/profile lookup; do not silently change COMMON text and then reinterpret old reminder hashes with the new generator. New format/profile bytes must be versioned and retained for historical parse/recovery. Raw provider/result bytes remain immutable; extraction stores a sidecar proof rather than rewriting them.

The source hook must identify request/run/fence, provider session where observed, exact output artifact/message ID and content hash. Never guess a stdout artifact by name or trust a model-supplied identity. The broker may consume the hook only from its trusted runtime port. Native CLI live source/evidence availability remains gated by R07. Fake ports can verify the complete host/store path now, but they cannot certify the absent supervisor.

For ordinary Chat, a separate registered renderer/profile revision can bind a prepared bootstrap plan to the existing attempt and exact source proof. That is an explicit follow-on, not an invisible addition to PR13's prompt bytes. SDK text keeps its separate fixed protocol.

Acceptance B1-01..10: prepare-before-send crash; same-run restart and duplicate calls; exact reminder/stdin hash; quoted/echoed/wrong/duplicate ACK; old profile bytes still parse; stale context/version/expiry; source identity tamper; no task status/authority upgrade; storage failure without query replay; cancellation/result race.

### B2: retained sessions (remain unavailable until evidence exists)

Do not invent a cross-provider compaction detector. Fresh-only execution already avoids pretending that installation or a previous process remembers instructions. For any future resume route, require a provider-specific supported continuity/compaction observation. Unknown/lost context invalidates advisory reuse and requires a short new confirmation at a safe next dispatch boundary. A context signal cannot authorize an extra model invocation by itself. UI/manual AGY control messages are currently unsupported in headless mode and cannot be used as a fallback handshake.

## Practical next outcome

A reviewed portable I1/B1 slice and exact tests are feasible without account/model/Windows calls. They improve issuer correctness and remove helper-only wiring gaps. They do not complete general safe TaskExecutor execution, Windows named pipes/ACLs, native containment, or live provider compatibility. Those remain separate implementation/real-host tasks. The morning handoff should name a fixed head and the remaining gates rather than a percentage or “nearly perfect” claim.

No external model call is useful for these TypeScript wiring tests. A paid native implementation task is valuable only after its concrete platform scope is approved. A cheap version/auth smoke is read-only and establishes no Bridge roundtrip; the single actual Haiku trial is reserved for its already-prepared auth/billing/terms/key gates.

## Review candidate: exact first-slice decisions

The first implementation is **configured-local-CLI issuer + fresh local-execution bootstrap** only.
It does not add a remote MCP transport, ordinary-Chat bootstrap profile, provider resume, native
supervisor, SDK echo fields, or persistent account configuration. These exclusions are explicit
capabilities, not fallback routes.

### R04 interfaces

- `IssuerSessionBindingV1`: schema, host-generated sessionId, requesterActorId, source=`configured_local_cli`, providerObservation=`unverified`, allowedProjectIds[], allowedDestinationIds[], expiresAt. It is supplied by the trusted deployment, never parsed from task/model input. It represents the existing host/OS-user configured CLI boundary, not proof of the caller's model vendor.
- `RecipientCapabilityV1`: schema=`bridge-recipient-capability-1`, recipientActorId, providerId, route=`cli|ordinary_chat_browser`, destinationId, modelIds[], policySha256, project registration refs, observedAt, expiresAt, actions with explicit availability/reason. A recipient-role signer wraps its strict canonical bytes using the existing identity/signature implementation and deadline. It contains no paths, secrets, raw auth telemetry or account-wide quota claims.
- A read-only capability source comes from the same registered operations/runtime policy sources, with cached observations only. No probe, auth, model call, account quota refresh or worker start occurs during catalogue reads. `available` is advisory discovery; current policy/capability checks still govern dispatch.
- The issuer facade accepts only already-generated exact TaskSpec/MD/output-contract bytes and the selected registered destination/capability digest. It validates its host session, current public registration, recipient signature/role, freshness, provider/model/policy/project scope and original UUID before calling existing `GitHubTaskBus.issue` (or the existing atomic fanout). It does not duplicate recipe/authority evaluation, create another job ledger, or generate a replacement request ID.
- Result/ACK methods resolve the original signed issuance and require its requester to equal the session's fixed signer, within the same scoped destination/project. ACK uses the existing concrete materializer and signed proof path. It cannot request another actor's execution/approval/policy/credential controls.
- CLI entrypoints are additive under the existing trusted `bus --deployment`: signed-catalogue, registered-issue, issuer-result and issuer-ack. The ordinary manual/operator commands stay unchanged; they are not exposed on the new issuer facade. Inputs use explicit fixed bytes/IDs/hashes. A model can invoke these CLI commands only through its separately permitted host tool; this work does not install such a tool or claim a remote agent is connected.
- Signature-only records are returned from the local configured read path in this slice. No new mutable Git catalogue/index or task UUID family is introduced. A future remote discovery transport is a separate adapter over the same strict record.

### R09 interfaces and compatibility

To avoid changing existing bootstrap/profile bytes, B1 will use **the existing v1 ACK JSON** and a
new extraction-proof sidecar, rather than introduce v2 reminder instructions in this slice.
The earlier reserved-block option is deferred. Existing reminder hashes and parse/golden fixtures
must remain byte-identical.

- The configured broker receives the existing `SessionBootstrapStore` and prepares a fresh run-bound reminder before dispatch. `createCliLaunchPlan` accepts that exact validated plan as an optional host argument; legacy callers retain their existing pure planner behavior. No new wire keys or task/schema changes are required.
- A trusted `BootstrapResponseSource` identifies the same request/run/fence and one exact result artifact reference containing the full selected response frame. This reference must be among the independently accepted result's artifacts and its bytes must already pass the broker's existing artifact hash/size verification. No filename/latest-output heuristic or model-supplied source identity is accepted. If the runtime has no such source port, report advisory evidence unavailable.
- The extractor first validates the full existing response frame against the saved request/task hash/run. It accepts one whole top-level JSON paragraph or top-level `json` fenced block whose strict object exactly equals the pending ACK. It does not recursively mine nested task/prompt metadata, blockquotes, arbitrary code languages, substrings, invalid JSON or multiple candidates. No matching ACK is `unconfirmed`, not execution failure and not permission to retry.
- A `bridge-bootstrap-extraction-1` sidecar records identity, exact artifact/frame digest and advisory receipt ID. It never changes raw response/result bytes, task status, execution receipts, delivery ACK or authorization. An ACK is proof that matching bytes returned on the bound channel, not proof of understanding.
- Current launch sessions remain fresh-only, with runId as sessionId/contextEpoch1. The helper's retained-session features are not advertised as production resume. A future supported compaction/resume signal must explicitly invalidate reuse; absence of such evidence never fabricates continuity.
- Native source availability still depends on the general runtime. The portable integration is real caller/store/launch/collector wiring tested through synthetic runtime ports; the absent enforcing runtime remains R07, not a hidden fake implementation.

Additional acceptance: I1 covers expired scopes, wrong roles/provider/model/hash, async registry or
capability drift, another requester's result/ACK, unknown publication without new IDs, and no hidden
execution from discovery. B1 covers authenticated-source selection, exact saved challenge, legacy
hash preservation, duplicate/malformed/nested/quoted ACK rejection, absent source, restart after
prepare, and proof that advisory confirmation cannot change terminal/delivery/authority state.

### R09 durable ownership / replay clarification

- A configured broker composition owns a **private file-backed** SessionBootstrapStore: explicit dbPath, bounded options, opening/closing/failure cleanup with the broker. The helper's default in-memory constructor is only a helper/test facility and cannot be the production configuration.
- A run with a persisted launch plan never calls `prepare` again to replace an expired/evicted/missing bootstrap row. The persisted plan is the authoritative record of the reminder actually dispatched. Missing advisory state is reported unavailable/unconfirmed, with no new challenge, prompt send or run.
- The optional supplied plan is validated in full: exact runId/provider/response_producer/repo/contextEpoch1, v1 reminder shape, all generated guidance/docs/version/challenge/hash fields and exact reminder/stdin binding. Failure in validation or durable storage never falls back to generating a different pure plan.
- Preparation before the first dispatch may durably leave an orphan pending reminder if later admission fails; it conveys no authority. Restart/repeated calls for the same broker run use its saved plan and existing no-reexecution logic. Advisory expiry/eviction does not change task, execution or delivery state.

### Advisory capture commit ordering

The broker first commits its independently valid terminal observation and hash-verified artifact
set. A configured trusted adapter supplies a read-only exact response-artifact descriptor for that
accepted observation (no new provider RPC or inference). Validate and persist the descriptor against
the accepted artifact set; missing/invalid descriptors affect only advisory availability. Extraction
then reads the broker's cached verified bytes, not a new runtime/file lookup or a latest-output name.

Persist `bridge-bootstrap-extraction-1` idempotently with exact request/task/run/fence, provider,
host session identity (and provider session ID only when actually observed), accepted terminal
payload digest, artifact ID/hash/size, frame digest and saved reminder/version/hash/challenge.
The terminal ledger is already committed, so an advisory store/sidecar error cannot downgrade or
replace it. Recovery retries only that local projection over immutable cached evidence; it never
calls runtime.start, sends a reminder, generates a challenge or starts a query. If expiry/eviction
makes acknowledgement unavailable, retain that fact instead of rebuilding the advisory row.

“Echo rejection” means refusing a nested echoed reminder/template or a quoted/unselected block.
Exactly matching ACK bytes on the bound response channel are only advisory confirmation, never
proof the model understood the instructions or permission to skip core validation.

### R04 authenticated preparation and final guard (required refinement)

Registered issue must resolve a host-owned prepared object or a signed immutable
`bridge-issuer-preparation-1` receipt produced by the existing recipe/preview path. Caller-supplied
hashes alone are not a preparation proof. The receipt binds the fixed requester/signer and issuer
session, prepare UUID, every request/fanout UUID, exact spec/MD/output-contract bytes or their
unambiguous hashes, project revision/hash, destination IDs and fingerprints, recipient/provider/
model/route/policy, capability digest and prompt-format/profile/build fingerprints. It is preparation
metadata, not approval or a second task/job ledger. Receipts may be retained as immutable caller
files; no credential or mutable latest-job record is created.

Use a shared extraction of the existing composer's prepare/validation logic rather than copying
its checks into another serializer. Its host-only identity source can accept explicit stable
prepare/request/fanout UUIDs for the CLI; default UI random-UUID behavior remains unchanged. The
exact returned preview/receipt is retained across unknown publication, not regenerated. UI request
bodies cannot select the host-only identity source or a deployment/signing provider.

Add an optional host-only **synchronous final append guard** to existing single/fanout issuance.
Run it after all asynchronous signing and immediately before the existing atomic append call.
The facade captures an opaque prepared-binding fingerprint and compares current session expiry,
current trusted registration/policy/capability selection and the full preparation binding at that
point. Failure performs zero append. A guard cannot await, start a provider, mutate authority or
be supplied by task JSON. The receiver still revalidates execution authority independently.
Unknown Git outcome retains the same signed issuance/IDs; it is not a retry of the provider.

Capability observation age and signed-record TTL are bounded by the configured host limit (default
30 seconds, maximum60 seconds). Reject future observedAt, expiry before observation, age beyond the
limit or expired records. Re-signing cached data preserves its original observedAt; it never makes
old provider evidence fresh. A capability snapshot is an observation, not an execution lease.

Historical result/ACK resolves the **original** authenticated preparation receipt and exact signed
issuance, plus a currently valid same-requester scoped session. The receipt retains destinationId
and capability digest because the old IssuedMessage cannot reconstruct those uniquely when two
destinations share recipient/route/model/policy. Never guess between such destinations. An expired
old discovery capability does not require reissue or permanently prevent original-result recovery.
The new issuer-result checks requester/scope before returning payload data; the broader operator
result command remains a different surface. A missing preparation receipt is explicit unavailable
for the new scoped facade, not permission to adopt an unrelated historical task.

Additional negatives: record re-sign without observation refresh; future timestamps; scope expiry
or policy/registry change during signer wait; two otherwise-identical destinations; substituted raw
bytes/UUID/prompt profile; wrong-requester reads before any payload return; lost-append reply followed
by historical result/ACK using the original receipt and a renewed valid scoped session.

### Issuer input boundary

Registered issuer commands consume bounded strict JSON/byte payloads on stdin, opaque prepared IDs,
or explicitly host-registered staging references. They do not accept arbitrary caller filesystem
paths, URLs, executable names or deployment replacement. The enclosing operator chooses the trusted
deployment once; an agent tool registration fixes that host context and exposes only the finite
issuer methods. No task/tool JSON can choose it. Existing operator `bus issue <file...>` remains
outside the new scoped facade and is not silently exposed as an issuer-tool method.

A renewed valid host session may recover an original preparation signed by the same requester and
within its allowed historical project/destination scope. That is continuity of owned request data,
not a claim that the new caller is the same live model session or still remembers the reminder.

### R04 exact publication binding / conditional receipt amendment

A caller's valid signed preparation alone does not prove it was the preparation used for the
original issuance. Two logical destinations may share all old IssuedMessage fields. Therefore the
**exact signed preparation bytes** must be stored alongside each child in the SAME atomic
single/fanout publication. Keep old TaskSpec and IssuedMessage bytes unchanged.

The registered issuer uses a supported conditional Git-store append. Against each attempt's exact
snapshot: if any child request index already exists, its previously stored preparation blob must
already be byte-identical to this preparation; missing or conflicting historical binding denies
publication. A pre-existing fanout group likewise requires the matching preparation binding for all
its children. The condition is evaluated before no-op success and on EVERY CAS/non-fast-forward retry.
Retries remain bounded and use original bytes/UUIDs. Git ref CAS linearizes the condition; no mutable
latest pointer or parallel job ledger is introduced. Ordinary operator append behavior is unchanged.
A store without the conditional operation refuses registered-issuer publication; it cannot approximate
this with a read-then-unconditional-write or a callback checked only once.

Historical issuer-result/ACK retrieves the original published preparation and verifies exact bytes,
signature and its task/project/destination bindings before returning data or accepting artifacts.
A different valid preparation for identical old task fields cannot relabel history. Legacy jobs
without this binding remain unavailable to the new scoped facade; no retroactive adoption.

The same optional synchronous host final guard also runs after proof/ACK signing and immediately
before atomic ACK append. It checks current same-requester historical scope, not stale discovery
freshness. Denial may leave a valid local materialization but publishes no ACK, creates no new request
and starts no provider.

Tests: two otherwise-identical logical destinations, legacy unbound index, conflicting preparation,
atomic fanout rollback, same-preparation lost-response retry, competing commit/CAS retry, condition
before idempotent success, unsupported store, and scope expiry/revocation during ACK signing.
