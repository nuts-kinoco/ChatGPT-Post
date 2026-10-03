# Requirement coverage at the issuer/bootstrap checkpoint

Code baseline: draft PR15 `275f7d5c25e69b6fa00305d4dba3c801e9514eb4`, cumulative on PR14 final `27aec64dc3200fe404bb96fdb4d8252cadd6ecd9`.
This candidate adds bounded R04/I1 configured issuer methods and R09/B1 fresh-run advisory extraction.
This matrix supersedes earlier stage descriptions in this file. It does not change the approved
[consolidated design](CONSOLIDATED-DESIGN.md), protocol bytes, permissions or acceptance conditions.
A final milestone still requires actual ordinary-Chat and actual CLI roundtrip evidence at a fixed
reviewed head. A merged source tree or a fake test pass cannot supply that evidence.

## Implemented, testable, and still missing

| ID / owner | Requirement | Implemented and verified offline | Remaining code or real-use gate |
| --- | --- | --- | --- |
| R01 / core | Exact TaskSpec JSON+MD, detached authority, workflow DAG, counters | Strict byte/hash validation, immutable grants/session bounds, mandatory confirmations; core regressions | Real registered policy/model/base and separately approved authority configuration |
| R02 / runtime | Locks, quotas, fairness, resident lanes | Same-repo exclusion, batch cursors, independent non-overlapping lanes, explicit resident opt-in, bounded drain/start fencing | Native lock/process integration and real concurrent routes; unknown never releases authority for reexecution |
| R03 / registry/transport | Product→request storage in one bus repo | Canonical UUID/repoId/slug, historical revision/hash, signed global UUID index, prospective root/display settings | Approved mapping/destination; no automatic external-file migration or reinterpretation of old pins |
| R04 / provider integration | Authenticated bidirectional issuer tools/capability discovery | Configured local CLI facade, scoped host session, recipient-role signed cached capability, shared recipe and immutable signed preparation, atomic publication binding, scoped result/materialize+ACK | Actual provider agent-tool connection/configuration and origin attestation remain separate; configured-local caller provider identity is explicitly unverified. Installed CLI or signed capability is not execution authority. See [issuer usage](ISSUER-USAGE.md) |
| R05 / transport | Concurrent CLI+Chat and durable partial fan-in | Atomic parent/child bindings, independent results/ACK, reverse-order/blocked/duplicate/save-failure regressions | Actual simultaneous provider execution; each route retains its own policy/capability gate |
| R06 / browser/archive | Full BEGIN/END framing and exact message/artifact selection | Exact request/hash/attempt frame; older source IDs, source proofs, strict output-contract and scoped completeness | Actual model adherence and site compatibility; missing required inventory/bytes remains delivery_pending |
| R07 / native platform | General CLI OS enforcement and Windows service/binding | Broker/launch-plan contracts and portable fake-process checks | Enforcing native supervisor, Windows IPC/ACL/containment and authoritative termination/evidence integration remain missing or uncertified code. The custom native candidate is not merge-ready security evidence |
| R08 / provider | Claude/Codex/AGY plans and exact model identity | Fixed launch argv/stdin, bounded provider parsers, no silent model/effort/API fallback; AGY version/help metadata host wiring | General live execution needs R07. Provider stdout/exit0 alone is not task completion. Effort is not a field in frozen TaskSpec |
| R09 / bootstrap | New/resumed/version/context reminders | Fresh-run broker-owned durable reminder store and exact saved plan; terminal-first extraction from selected cached/hash-verified response, strict advisory sidecar and local-only recovery | Real context-loss/resume detection and actual provider evidence remain unverified/missing; no arbitrary manual CLI hook. Advisory matching bytes never prove understanding, permission or artifact delivery |
| R10 / archive | Durable artifact manifest, output roots, safe diagnostics | Route-neutral archive-2, pinned historical roots, exact source resolvers, scoped CAS, concrete requester materialization and signed proof-before-ACK; real filesystem fake-network regressions | Approved content destinations/read grants and real artifact retrieval. Local sender archive alone never proves requester delivery |
| R11 / UI/API | Local/hosted/fanout monitor and explicit actions | Operations read models, registered secondary composer, shared LLM catalogue/template, concrete materialize+ACK port and trusted startup wiring | Real configured accounts/destinations; unconfigured actions stay unavailable. LLM-first automation still needs R04 where not wired |
| R12 / presentation | Compact A bar, explicit expansion, theme and window controls | Product UI/native-shell changes, draft/state preservation, no auto-expansion, graceful shutdown; root/GUI tests | Actual rendering, Windows/DPI/multi-monitor/native-window checks |
| R13 / quota | Pre-dispatch/post-ACK Codex observations | Public app-server narrow port, provider attribution, freshness/generation fences, unknown/manual-as-unverified and bounded explicit fallback | Actual authenticated RPC/schema/account/billing-route verification. No money guarantee and no reuse as Chat/Claude/AGY quota |
| R14 / operations | Bridge-only ordinary Chat Pro counter | Shared scoped direct/hosted durable submission identity and replay, real CLI/UI wiring, confirmed versus possible, coverage-gap suppression and configurable reference-window/red-warning UI | Actual observed model/site behavior and Windows storage verification remain live/native gates; never account-global quota |
| R15 / notifications | Optional per-user Email/Discord human-check alerts | Default-off registered destinations, durable source/outbox dedupe, atomic revision/generation/rate claim, bounded controlled transports, secure native interaction port, masked UI and separate Test Send/status | Actual native secret provider, recipient/recurring authority and configured sender binding are required; fake tests are not live-delivery proof. See [usage and alerts](USAGE-ALERTS.md) |
| R16 / browser | Reuse browser/profile, auth recovery without bypass | Existing dedicated browser/daemon preserved; reviewed selector ambiguity fixes and read-only visible-model catalogue; registered prompt policy/renderer receipts on PR13 | Actual DOM/login/challenge behavior; unknown model fails closed without downgrade. Keeping a browser open is not proof of avoiding Cloudflare |
| R17 / integration docs | LLM instructions, commands, role-specific test handoff | USAGE/TESTING, UI/ARCHIVE/SDK guides, capabilities/help, scripts and structured result reports | Actual Codex/Claude tasks only when individually authorized; task launcher is distinct from Bridge Codex CLI |
| R18 / integration acceptance | Final two-route milestone | Offline negative/recovery evidence and independent reviews | Actual Git→claim/approval→ordinary Chat→result/artifacts→save→ACK **and** actual CLI counterpart. Neither is established by this checkpoint |
| R19 / SDK trial owner | Small own-cloud Haiku text handshake | PR14 separate SDK schemas, official SDK composition, signed bus, private bounded evidence, immutable requester bundle/ACK, one-shot entrypoint; lifecycle/startup races fixed | Same-context cloud auth, billing/extra-usage confirmation, terms and temporary-key/trial approval, private connector destination, then one real call. Linux trusted-host/SDK controls, no native confinement/OS-exit proof |
| R20 / prompt/browser | Maintainable shared prompt and cache-aware formatting | PR12/13 deterministic shared brief, registered renderer/build/profile, final dispatch guard and historical collector validation | Live cache savings unmeasured; no API-cache control claim. SDK dependency changes require explicit new renderer build registration, never silent old-policy replacement |

## Issuer/bootstrap extension evidence

I1 and B1 are independently reviewed bounded extensions. I1 tests cover scope/signature/async drift, exact preparation publication, conditional Git retry and historical receipt recovery. B1 tests cover persisted reminder ownership and terminal-first cached-artifact advisory projection, including interrupted Markdown containers and finite diagnostic codes. The compiled issuer CLI tests use inert host ports only; no provider, operational keys or live network. The author cumulative check passes 2,474 root tests with 56 inherited explicit skips, GUI60, 12 compiled issuer and six compiled SDK cases. Exact review/publication references are recorded at the final PR head and in [verification](ISSUER-VERIFICATION.md).

## Usage/alerts extension evidence

The portable extension passes root **2,348 tests with 56 inherited explicit browser skips**,
GUI **60 tests**, root/GUI typecheck/lint/build, and the inherited compiled SDK CLI lifecycle suite.
It adds real local persistence/loopback HTTP integration with fake browser/mail/HTTPS/native-provider
ports. No live notifications, account setup, credentials, model calls or Windows runs were performed.
Rendered Chromium verification was not run: browser launch was denied by the execution environment's
socket permission restriction. DOM state/HTML parity tests passed; this is not rendered-browser evidence.

## SDK baseline evidence and compatibility

For the PR14 code head: root **2,145 passed +56 inherited explicit browser skips**; GUI **60 passed**;
**6** compiled CLI lifecycle cases and **17** additional independent adversarial cases passed.
Root/GUI typecheck, lint and build passed. These are separate counts, not an inflated combined total.
The 56 skipped cases are rendered-browser fixture tests, not passed live evidence. No real SDK
inference, operational signing-key creation, cloud login, Windows execution or merge occurred in
this checkpoint. Remote status/check/workflow-run counts were zero; no workflow source exists at
this head. GitHub's empty aggregate status is not a queued or passing CI job.

The PR14 reviewed code tree has 538 files: 37 intended changes over PR13, including 29 additions; all 501
other inherited files were verified unchanged. Its final docs-only head adds a separate COVERAGE update. The SDK family preserves global request dedupe and
is skipped by unsupported legacy route pumps. Native/local ResultSpec, hosted response and SDK
iterator evidence remain different types. Historical payload-only ACK cannot satisfy full delivery.

The new browser renderer build digest is `feedc4b5b2f834dbd540a3d3d55b74a3becbeca148cd43e0ee8f8f443f0fdca6`.
Operators explicitly register it for new jobs. Old accepted jobs retain the original renderer/policy;
missing historical code remains unsupported/no-resend.

## Provider permission and account limits

General manual/bypass UI modes require provider-specific supported capabilities. Antigravity's
[headless protocol](https://antigravity.google/docs/cli/headless/#unsupported-messages) rejects
Claude-style control_request/control_response. Approval-needed tools can be soft-denied with exit0;
that is not proof the requested work ran. Interactive TUI approval is a different design. An unavailable
manual route never implies automatic bypass. The SDK trial is fixed no-tools and adds no such mode.

Version/help and an old auth-status summary cannot establish the current subscription/billing route.
Each host context is verified independently; no token copy or inherited API-key environment is used.
The cloud SDK candidate is SDK0.3.287/CLI2.1.288, and its compatibility remains live-unverified.
A different installed Windows version does not automatically satisfy that pin.

## Recovery and final acceptance

Keep the original IDs, exact bytes, signed provenance and pinned roots. Unknown is not retry permission.
Transport retries, result recovery and ACK retries do not re-run providers. A failed or inaccessible
artifact save remains pending. A one-shot key-intent marker is never deleted to regenerate identities
silently; losing the temporary signer may require leaving delivery pending and preserving evidence.

Use this matrix with [USAGE](USAGE.md), [TESTING](TESTING.md), [SDK usage](SDK-TEXT-USAGE.md),
[SDK testing](SDK-TEXT-TESTING.md), [platform gaps](PLATFORM-GAPS.md) and the exact PR parent/head.
Owners name responsibility, not permission to activate accounts, tasks, settings or services.
