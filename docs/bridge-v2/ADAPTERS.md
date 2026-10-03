# Bridge v2 adapter implementation checkpoint

This document supersedes the adapter-availability statements in the historical PR1 core report.
The code is in the existing ChatGPT-Post project. No new service/account/permission is activated
by installation or by the default UI. No live model, quota RPC or GitHub job was run during development.

## What is implemented

| File | Responsibility |
| --- | --- |
| `src/adapters/github-client.ts` | Real GitHub Git Database REST calls; injected existing credentials; fixed official origin; response bounds; verified Git blob bytes; blob/tree/commit/fast-forward-ref atomic append; conflict/lost-reply reconciliation |
| `src/adapters/github-transport.ts` | Ed25519 actor/role envelopes; atomic request+MD; durable per-ledger claim ownership; exact commit/hash admission; receipts/results/ACK; persistent retry and round-robin polling |
| `src/adapters/local-authority.ts` | Grants issued by authenticated local host identity, bound to exact task/policy/session/executor; bounded policy evaluation and detached workflow enrollment |
| `src/adapters/bridge-host.ts` | Bounded task reconciliation/dispatch over the existing controller; dependency gates stay in the core; no automatic replay of committed/unknown dispatch |
| `src/adapters/deployment.ts` | Shared composition root for worker/UI; unknown quota denies by default; explicitly selected provider bucket, bounded fallback, independent refresh deadline/generation fence |
| `src/adapters/deployment-loader.ts` | Explicit trusted executable host configuration; final file and all POSIX ancestors checked; Windows denied until a native ACL verifier exists |
| `src/adapters/codex-quota.ts` | Public JSONL app-server initialize/read-rate-limits client and explicit host launcher; no thread/turn, login, refresh, credits reset or private endpoint |
| `src/adapters/browser-delivery.ts` | Existing RunController as normal Chat transport; fixed conversation/model policy; one-send durable intent; cancel/deadline controls; distinct hosted result and exact requester ACK |
| `src/adapters/cli-launch.ts` | Fixed Claude/Codex argv and registered binary/model/cwd/environment |
| `src/adapters/cli-broker.ts` | Durable SQLite broker, fences, cancellation tombstones, deadline/restart reconciliation and evidence collection |
| `src/adapters/cli-rpc.ts` | Authenticated encrypted bounded Unix IPC client/server |
| `src/adapters/cli-isolation.ts` | Hash-pinned direct-argv installed-supervisor process driver; not the missing OS supervisor itself |
| `src/cli/bus.ts` | Explicit deployment/issue/tick/approve/result/ACK commands |
| `src/ui/server.ts`, `src/cli/ui.ts`, `gui/src/main/product-ui.ts` | Actual UI and desktop startup can load the same explicit host deployment |

## GitHub transport contract

The configured branch must already exist. The adapter never creates repository permissions or
credentials. `GitHubCredentialProvider.authorization()` is supplied by an already authorized host
provider; transport code never searches environment variables, keychains or CLI token files.
`MessageSigner.sign()` is an existing host Ed25519 signer; only public verification keys are in the
actor registry. Do not store signing keys, bearer tokens or runtime databases in GitHub.

The dedicated namespace contains immutable files:

- `bridge-v2/projects/<registered product slug>/requests/<request UUID>/task.json`, `task.md`, `issued.json`
- In that same request folder: `claim.json`, `receipt_ack.json`, `start_receipt.json`, `terminal_result.json`, `result.json`, `result_ack.json`
- Normal Chat keeps `hosted_result.json`, `response.json`, `hosted_ack.json` in the same request folder
- `bridge-v2/request-index/<UUID>.json` is a global signed copy of `issued.json`, committed atomically with the project files. It preserves cross-project UUID dedupe

The versioned immutable registry stores project UUID, TaskSpec repo ID and safe storage slug separately.
Historical revision/hash resolution preserves old pins across future root/display edits. For example
`{ "pixiv-vault": "PixivVault", "emakinoco-windows": "EMAKINOCO-Windows" }`. Display names/task text
cannot choose paths. Unregistered mappings, unsafe paths and case aliases are rejected. Existing
remote files are not moved or reinterpreted. ResultSpec contains its artifact references; raw broker
artifact bytes remain in protected broker storage unless separately authorized artifact delivery is implemented.

Commit author/committer display names and PR comments are not authority. The signed envelope
binds a registered actor and role to exact payload hashes. Every event is also bound to the exact
issued recipient/requester, route and task hash; start events need full non-null process identity. Two independent ledgers with the same
recipient key cannot both own the same claim. A claim is permanent: an unknown owner is reconciled,
not automatically stolen. Separate hosts must not share SQLite. A host's transport journal must
survive restart; losing it requires recovery, not issuing another claimant against an unknown job.

`GitHubGitStore.append()` creates a single-parent commit and advances the ref with `force:false`.
Every requested file must be absent or the complete batch must already match. It rejects partial
batches, conflicting immutable bytes, incomplete trees, links, traversal, oversize replies and
unverified blobs. An uncertain ref response is checked against exact current blobs. A GitHub
permission failure retains the local result and retries delivery; it never restarts the LLM.

The recipient pump publishes only tasks admitted from a verified signed inbox with stored
fixed-commit transport provenance. Local UI imports do not silently acquire a GitHub destination.
A push is storage, a receipt is receipt, and an ACK requires requester verification and durable
saving of the exact result, receipt/source proof and required artifact bytes. The CLI `ack` requires
the displayed payload hash AND a configured materializer. `delivery_manifest.json` is recipient-signed;
`materialization.json` is requester-signed and committed atomically with ACK. Its manifest digest is
SHA-256 of the canonical manifest BODY, while signed-envelope CAS bytes have a separate content hash.
Historical payload-only ACKs are visible but cannot satisfy real delivery/workflow gates. An invalid
ACK cannot hide an already available result in fan-in. None means review acceptance or Git merge.

## Ordinary Chat scope

This is the existing browser route, not a private ChatGPT API, Work/dot event, subscription API
substitute or fabricated local-executor receipt. It requires an existing configured Chat URL.
The request must use agent `chatgpt-browser`, the exact configured model, read-only mode, no
allowed commands, at least 10 seconds, and the exact `BrowserDeliveryService.policyHash`.
New hosted issuance uses `bridge-issued-2` with exact raw output-contract body hash, signed detached
contract and atomic task/MD/index publication. Legacy unversioned issuance cannot claim or acquire
a post-result contract. The recipient independently checks its trusted expected-output scope before
claim/admission/start and sends contract-aware declaration instructions. Missing scope fails closed.
Concrete exact-source-proof/requester materialization is the archive follow-on and must be configured
before live full-delivery acceptance. See the independently approved
[output-contract amendment](OUTPUT-CONTRACT-AMENDMENT.md).

The policy fixes recipient/requesters, conversation URL, model, preset, starts, deadline and
response size. That policy and the profile/runtime configuration are immutably bound in the local
database; changing them cannot silently consume an old approval. Input policy/config objects are
cloned/frozen. Manual approval binds the exact TaskSpec hash and is capped by task approval age.

The hosted contract is explicitly `hosted-response-1`, `evidence:ordinary-chat-browser-dom`,
`localExecution:false`. It does not certify TaskSpec filesystem/command scopes, Git edits,
local process identity, evaluator success or v2 execution completion. Allowed paths describe the
request; they are not an enforced hosted filesystem sandbox. No PID is invented. `current` model
has the existing browser adapter's observational limitations and must not be called a pinned model.

A committed send intent is never resent, including browser crash, lost response or login block.
The preserved RunController verifies route/prompt ownership and extracts the response. A durable
cancel flag is checked through an AbortSignal, ledger polling and a dispatch guard; absolute
hosted deadlines interrupt the browser controller. Closing a page cannot prove server-side
ChatGPT generation stopped, so ambiguous generation remains unknown. There is no automatic paid
API/model/chat fallback. Receipt capture uses a transaction so concurrent start/reconcile retain
one immutable event. Reconciliation uses a cursor so unknown rows do not starve later requests.

Ordinary Chat app-event tasks remain a separately unverified official candidate in
[DELIVERY-ADDENDUM.md](DELIVERY-ADDENDUM.md). No subscription was created. Work/dot MCP Events
remain a different surface. Polling the GitHub bus works without either event integration.

## Quota and approvals

The configured core observes quota immediately before dispatch and after first result ACK in
separate rows. It never rewrites result bytes or retries a completed job to obtain a quota reading.
The composition root requires explicit bucket selection when a provider port is present. Unknown,
expired or exhausted quota denies by default. An explicit preauthorized fallback can lower starts
and seconds; percentages never establish a strict monetary bound. Refresh has its own <=4-second
timeout below the core's 5-second RPC bound, plus a generation fence; late timed-out replies cannot
restore a newer unknown observation. Only the documented management method is used.

Local approval sessions come from the authenticated host boundary, never task JSON. Manual
approval and bounded automatic/bypass remain subject to the original hash, policy, expiry,
mandatory-action confirmation, workflow, session and one-start rules. Imports are not approval.
A local UI cannot ACK a foreign requester. Same-session UI ACK uses the controller quota hook;
old-session local-ledger ACK can only acknowledge existing verified bytes, without pretending to
probe the old execution account.

## What is still missing

The OS confinement supervisor is missing production code, not a checkbox or installation-only
step. Windows authenticated pipe/ACL verification and native containment are unavailable. Thus the
CLI route is not yet a fully confined end-to-end executable stack. See [CLI-EXECUTOR.md](CLI-EXECUTOR.md)
and [PLATFORM-GAPS.md](PLATFORM-GAPS.md). Do not point the installed-supervisor driver at an ordinary
`claude`, `codex`, `bwrap` or script that merely claims capabilities.

Live GitHub permissions/credentials, ordinary Chat login/model behavior, actual app-server schema
compatibility and Windows/Electron/native behavior remain deployment tests. Those are separate
from missing implementation. Fake tests are not evidence that Windows or a provider works.

## Primary protocol references

- [GitHub Git references](https://docs.github.com/en/rest/git/refs)
- [GitHub Git trees](https://docs.github.com/en/rest/git/trees)
- [Public Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Codex noninteractive CLI](https://developers.openai.com/codex/noninteractive)

Verified against public documentation on 2026-10-03; no provider CLI was invoked for discovery.

## Identity-bound response framing

`src/contracts/response-frame.ts` wraps model-facing task content with separate transport metadata.
TaskSpec and original MD bytes/hashes are unchanged. Replies use exactly one first-line BEGIN and
last-line END carrying the same request UUID, raw TaskSpec SHA-256 and durable attempt UUID. Hosted
delivery verifies the entire reply and stores separate raw/body hashes. It rejects wrong request/hash/
attempt, partial/out-of-order/duplicate boundaries, quoted/code-fenced markers, nested markers and
echoed instruction prompts. A bare completion phrase cannot close the response.

CLI launch plans carry the same responseFrame identity (attempt = run ID); the eventual supervisor
must validate the final provider message with the shared parser before accepting text transport.
Frame validation itself is never authorization, successful execution, termination or a trusted
ResultSpec. The frozen structured result/receipt remains the local execution authority.

## Concurrent fanout and partial fan-in

`src/adapters/fanout.ts` groups 2–4 independent requests under a signed global parent UUID.
The parent manifest and all child JSON/MD/index files are published atomically. Each issued child
binds the parent ID, while retaining its distinct route, request hash, recipient, approval and run.
`collect` verifies each branch independently and returns available/pending/acknowledged counts,
per-child outcomes and exact payload hashes. It never performs an implicit ACK or treats available
as succeeded. Requests can use different registered products and recipients; same-repo execution
locks and policy-session safety still apply. Unrelated browser and CLI observations do not share
an execution ledger. `fanout-issue` / `fanout-result` are documented bus CLI entry points.

## Dedicated retained browser: existing behavior

`BrowserDeliveryService.productionBrowserRun` uses the existing `buildPorts` route.
`playwrightBrowser` checks the healthy same-host daemon and attaches through its local CDP endpoint
instead of launching Chrome again. `BrowserSession.close` on that attached route disconnects the
client; the daemon browser remains running. Without a daemon, it closes the persistent context.
Neither path deletes the dedicated profile directory; closure is not proof that cookies were erased.

The existing daemon can therefore support a retained dedicated browser. Its optional keepalive is
not a proven Cloudflare-prevention mechanism; leave it disabled for a reuse-only trial. Do not enable
stealth/fingerprint/proxy/cookie-import tricks or bypass challenges. A challenge blocks the browser
lane, retains exact task/attempt identity and needs a human-visible authentication step. Independent
CLI results remain collectible. Resume by reconciliation, not a second send. Actual minimized-window
behavior and authentication/challenge recovery are live-test gates, not findings from these unit tests.

Fan-in states summarize stored transport evidence. `running` means a matching start receipt was
observed, not a fresh process liveness probe; `pending` means no verified result is available. Use
the recipient's same-ID status/reconciliation for current execution uncertainty. The collector
never invents a terminal outcome from lack of a new event.
