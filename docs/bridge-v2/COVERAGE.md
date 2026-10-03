# Requirement coverage and remaining gates

This is an intermediate checkpoint. A final delivery milestone requires actual normal Chat and
actual CLI roundtrip evidence, not just merged source or fake tests. No row below authorizes a
live account, model, Windows computer, credential, permission, subscription, merge or deployment.

| Requirement | Current code / evidence | Remaining gate |
| --- | --- | --- |
| Extend existing ChatGPT-Post, preserve normal Chat | Existing legacy route remains; BrowserDeliveryService composes RunController | Live same-conversation/model roundtrip remains unverified |
| Task JSON + MD exact-byte contract | Frozen TaskSpec, strict parser and file hashes | Configure real registered policy/base/model before live issue |
| Product → request folders in the same GitHub repo | Immutable project UUID/repo/slug registry with historical revision/hash, signed global UUID index and exact registered destination binding | Configure approved repo/branch/project mapping; root/display edits are prospective; no existing external files moved |
| Receipt / approval / start / result / ACK | Core ledger + signed manifest and requester materialization proof; atomic proof/ACK; historical payload-only ACK insufficient | Concrete requester artifact/source materializer integration and real GitHub trial pending; missing bytes remain delivery_pending |
| Concurrent Claude issuer → CLI and normal Chat | Atomic signed fanout parent + independent child IDs/routes; partial fan-in counts and per-child ACK | Actual simultaneous live routes remain unverified; each child still needs its own approval/capability |
| Reverse order / duplicate / one blocked / timeout / unknown / save failure | Fake-network/process fanout and individual-route regressions | Native and live provider variants remain unverified |
| BEGIN/END complete-response correlation | Shared frame parser binds UUID/raw task hash/attempt; echo/quote/code/truncation/duplicate tests and DOM extraction check | Actual model adherence unverified; framing never authorizes or proves success |
| Claude/Codex fixed CLI launch, process lifecycle | Real launch plans, SQLite broker, authenticated Unix IPC, pinned supervisor driver | Enforcing supervisor missing code; Windows pipe/ACL/containment missing; no live CLI trial |
| Windows native safety follow-on | Separate bounded native candidate, portable argv and mediator tests | Native SDK build, exact isolation, service binding, provider separation, full receipt integration and adversarial Windows test |
| Local manual / automatic / bypass constraints | Exact detached grants, immutable policy/session, core counters/locks/expiry/mandatory confirmation | No production policy or persistent authority activated |
| Model/effort/capability clarity | Exact registered model, explicit capability errors; frozen TaskSpec has no effort field | Do not invent effort support; inspect a separately reviewed adapter extension before adding it |
| Codex quota before dispatch / after ACK | Public app-server narrow read; unknown-deny/default; bounded fallback; generation/time fences; immutable result tests | Actual authenticated management RPC/schema/version not tested; not a monetary guarantee |
| Ordinary Chat Pro observed-use counter | Existing local browser observations/budget exist; further counter is separate | Follow-on: deduped confirmed Pro submissions, uncertain outcomes, configurable threshold/window/timezone, Bridge-only coverage; no hardcoded account cap |
| Real dock/detail UI | PR2 product Electron/default UI and loopback core integration, root/GUI tests | Cloud rendering and Windows/DPI/monitor behavior unverified |
| Configured product startup | UI --deployment and desktop deployment env load the same trusted host module | Windows ACL verifier absent; actual providers/native engine must exist |
| New/resumed model-session bootstrap | Versioned planner/receipt helper and optional repo skill documented separately | No arbitrary manual-CLI hooks; each new model session must receive instructions, installed files alone do not prove context |
| Durable artifact archive and diagnostics | Task/artifact refs and immutable results exist | Separate PR5: actual artifact bytes/manifest completeness, explicit message/artifact ID lookup, sanitized export, configurable per-product local roots, old roots remain valid |
| Collapsed resident tiny bar / setup wizard / operations overview | Separate updated nonexecuting UI proposal | Follow-on implementation/review, no claim the current dock already implements new proposal |
| Antigravity bidirectional same-bus integration | Same wire contracts are extensible | Separate follow-on: official supported flags/status/cancel/output/model/effort, bootstrap/fake tests; installed CLI does not establish auth or adapter support |
| Codex task surface vs Bridge Codex CLI | Documented as different execution routes | Do not substitute a dot Codex task for a configured Bridge CLI job |
| Auth/human-check notification via email or Discord | Follow-on only; no destination or secret configured | Optional disabled-by-default sink, event dedupe/rate limiting, retained-job delivery-failure logs; explicit recipient/channel and authority required before live outreach |
| LLM-executable usage and test handoff | USAGE.md, TESTING.md, LLM quickstart, fixed offline verification script and structured report | Codex implements/fixes; Claude independently audits; user intervenes only where identity/permission requires it |

## No lost work on recovery

Keep original IDs and exact bytes. Job unknown is not retry permission. A failed publication is a
transport retry; a saved immutable result is retained. Fan-in reports partial counts and does not
wait for one route before exposing another result. Same-repo locks and session pauses are retained
where the authorized execution policy requires them; unrelated route storage remains independent.

## Intermediate versus final PR

PR1, PR2 and PR3 may be reviewed as incremental work. The native candidate is explicitly incomplete
and is not implicitly part of a secure-execution merge chain. The final PR label is reserved for
actual request→claim/approval→CLI **and** normal-Chat→result→ACK evidence at a fixed reviewed head,
plus the relevant negative/recovery checks. Until then, report precisely `implemented`, `fake tested`,
`blocked`, `missing code`, or `live unverified` for each route.

## Approved integration contract

[CONSOLIDATED-DESIGN](CONSOLIDATED-DESIGN.md) is the implementation authority for cross-route records, historical registration, sender and requester archives, full ACK proof, UI projection and ownership/acceptance IDs. Output-contract-1 is an independently reviewed normal-Chat-only amendment; unknown required inventory remains blocked. New integration evidence must identify its exact reviewed source checkpoint.
