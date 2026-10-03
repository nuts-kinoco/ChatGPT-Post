# Official SDK managed synthetic text route — design candidate 2

User requested trying the official SDK route. This proposal does not restart, review,
execute or replace certification of the stopped custom native R3 helper. It defines a
separate, lower-assurance provider-text adapter and does not activate a model call.
No OS confinement, sealed executable, pidfd, CREATED gate or observed process-exit
claim is available through this route. The general TaskExecutor remains unavailable.

## S01. Supported boundary, no custom process hook

Use the official `@anthropic-ai/claude-agent-sdk` query API with its default managed
local subprocess, pinned SDK0.3.287 and explicitly supplied installed CLI2.1.288 path.
No `spawnClaudeCodeProcess`, custom process implementation, helper executable,
container, native code, prewarm/startup/resume, shell wrapper or manual direct-call
fallback is used. Installation imports the SDK only; `query()` is the sole inference
entry and is called only by an explicit authorized dispatch after durable intent.

Primary evidence is the inert official npm sdk.d.ts, SHA
`e21c63715af18e383c817716d8cb4a68466ef1b8aff93fc5807c9fcaabbaf240`, and
https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.287.
The release describes parity with CLI2.1.287; compatibility with the installed2.1.288
pair is an explicitly reviewed compatibility candidate, not a tested pair. The authorized one-shot trial may establish end-to-end compatibility; no earlier live success is required. Any other unreviewed SDK/CLI pair is rejected before query. The type reference documents that a supplied env replaces
rather than merges the child environment, that tools:[] disables builtins, and that
AbortController/close() request cleanup. It does not expose authoritative default-
process exit evidence. https://code.claude.com/docs/en/cli-reference and
https://code.claude.com/docs/en/env-vars remain the installed-control references.

## S02. Trust and activation

Retain the V6 trusted host/installed official CLI/administrator assumption. Untrusted
request/model/Git data cannot select a binary, command, environment, SDK option,
account, destination or tool. Preflight checks the configured official file identity,
version/help and same-context `auth status` via documented read-only commands. It
requires the observed existing first-party `claude.ai` auth route and exact configured
configDirectory. It does not inspect, export, copy or create credentials.

A path hash before launch is only an installation observation, not a guarantee that
the same bytes execute. The trusted host/administrator owns that residual race. This
is an explicit assurance difference, not evidence that the R3 checks passed.
Current logged-out shell fails before query. No alternate API key/billing route is
selected. Ephemeral in-memory test actor key creation remains separately pending
user approval; no persistent signing credential or provider login is configured.

No SDK source or default process is invoked as part of fake tests. A real call still
requires reviewed implementation, supported existing auth in the exact host context,
confirmed private synthetic Git destination and the bounded trial/signing approval.

## S03. Fixed query options

The trusted profile builds options, never accepts options from a task:
- pathToClaudeCodeExecutable: exact registered installed binary; cwd: private empty dir
- model: claude-haiku-4-5-20251001; maxTurns:1; maxThinkingTokens:0
- tools:[]; allowedTools:[]; disallowedTools:["*"]; mcpServers:{}; strictMcpConfig:true
- permissionMode:dontAsk; permissionPrompts:none; canUseTool always returns deny
- settingSources:[]; plugins:[]; agents:{}; additionalDirectories:[]
- persistSession:false; enableFileCheckpointing:false; verbatimPrompts:true
- extraArgs contains only safe-mode, restricted, disable-slash-commands and no-chrome
- env: the reviewed fixed nonsecret profile plus explicit existing HOME/configDirectory;
  no process.env spread, credential env, API endpoint override, fallback or effort field
- 512 requested output tokens, thinking-off request, requested retries0, no title or
  prompt-suggestion generation; sixty-second host watchdog; bounded source/response IO
- no custom system-prompt replacement, hooks, background task, session resumption,
  model fallback, API max-budget assumption, permission bypass, credit purchase or login

The model input stays the exact synthetic UUID-bound echo challenge and framing.
One Bridge query() call is enforced. CLI invocation count and provider HTTP request
count are unobserved, not asserted one; SDK/internal request controls remain requests
plus reported usage checks. A failure never calls query() again for that request.

## S04. Separate versioned wire, compatible shared bus

Use the existing GitObjectStore, signer role registry, canonical project/history,
request UUID index, product/request folders and atomic append code. Add a distinct
outer version `bridge-text-inference-sdk-1` under kind:text_inference. It must never
be interpreted as native text version1, a TaskSpec ResultSpec or HostedResponse.

Strict inner schemas are sdk-text-request-1, sdk-text-approval-1, sdk-text-intent-1,
sdk-text-result-1 and sdk-text-acceptance-1. Reuse the existing fixed identity/challenge request fields, with executionProfile:official-sdk-managed and a distinct SDK-specific bounds object. Its limits are maxStarts:1, maxTurns:1, timeoutMs:60000, maxOutputTokens:512, maxResponseBytes:8192, maxSdkMessages:7, maxCanonicalMessageBytes:262144, maxCanonicalMessagesBytes:262144, maxSdkStderrObservedBytes:65536 and maxSdkStderrRetainedBytes:0. Do not carry native maxStdoutBytes/maxStderrBytes names into this request. Approval binds exact request,
MD, signed issuance, host policy/profile and runtime kind before one-use reservation.
Intent binds approval, candidate attempt/fence1, pinned SDK options/probe digest,
createdAt/deadlineAt. No future message/result digest appears in the request.

Existing native family bytes and tests remain historical independent code. Legacy
pumps recognize a valid new family index as unsupported and advance without claiming
it. Global UUID collisions across every family fail before any overwrite. Shared bus
logic may be factored into a typed fixed-text strategy to avoid copying signature,
path/claim/atomicity/materialization logic; each version keeps strict own validation.

## S05. SDK message evidence, honest lifecycle semantics

Validate the SDK's yielded structured messages, not an invented raw wire stream.
Apply the separately reviewed provider-stream amendment's exact primary-message,
model/session/frame/one-turn/tool/thinking/usage checks and bounded private telemetry.
Canonical NDJSON is made from validated plain JSON SDK messages and hashed as
sourceSdkMessagesSha256. This is not provider-network bytes or raw CLI stdout;
duplicate-key handling inside the SDK parser is trusted vendor behavior.

After exactly one successful result, consume the iterator to its natural end. Success
requires the complete bounded iterator, no error/cancellation/deadline, exact identity
and aggregate reported usage. Then request SDK close. The result explicitly states:
- assurance: trusted-host-official-sdk-controls
- completion: sdk_iterator_completed
- osProcessExit: unobserved; descendantTermination: unverified
- serverCancellation: unverified; executableByteBinding: trusted-host-path
- bridgeSdkQueryInvocations:1; cliInvocations:unobserved; providerHttpRequests:unknown
- no local execution or OS confinement proof; liveProviderCallObserved true only from
  the actual SDK adapter, false from injected fake SDK tests

Do not call the native parser's finish(exitCode:0) to fabricate an exit. Factor its
pure content validation separately, then construct version-specific observations.
Report observed actual model and tokens, effort unsupported and thinking-off requested;
do not equate SDK estimated usage/cost with billing or complete internal HTTP telemetry.

### SDK-specific observation bounds and hidden buffering

The limits apply at the SDK message iterator and stderr callback boundary only.
Bridge does not claim to cap the SDK's hidden buffering, raw subprocess IO, internal
allocations, CPU or all child processes. stderr strings are counted and discarded;
none are retained or uploaded. An over-limit callback requests abort/close immediately.
The SDK may have already allocated a large value before yielding/calling back.

Before canonical serialization, validate a bounded JSON tree without invoking getters:
plain JSON objects/arrays only, no cycles/accessors/prototype instances, depth <=32,
<=16384 total nodes/keys, bounded array lengths and string/key UTF-16 length first,
then UTF-8 byte count within262144. Reject nonfinite numbers and unsupported values.
Copy into inert plain JSON values while enforcing an incremental canonical byte budget,
then serialize only that bounded validated copy. Count at most seven yielded messages
and262144 canonical bytes total, with the strict three-primary/four-telemetry policy.
Failure cancels; it cannot certify that upstream memory never exceeded the same limits.

## S06. Cancellation, unknown and recovery

Persist intent before query(). Request abort and SDK close on timeout, cancellation,
protocol/output limit, or host failure, once; do not rediscover or signal a PID. If
iterator shutdown does not settle within a bounded six-second cleanup wait, keep the
job unknown and retain in-process ownership until settlement or process loss. The
absence of a process handle forbids claiming termination. No SDK query is retried,
including after crash, timeout, auth failure, lost publication or missing ACK.

Persist private canonical SDK message bytes, validated completion observation and
result using existing archive/durable.ts fsync/readback barriers before publishing.
A recovered complete bundle is revalidated without query(); incomplete evidence stays
unknown. Failure observations are local durable diagnostics, never invented success.
The requester root pin is durable before remote issue; an old unpinned issuance cannot
be retroactively adopted. Exact fixed public bytes and recipient-signed result are
saved/read back before atomic signed materialization acceptance+ACK. Raw messages,
paths/auth diagnostics and private SDK telemetry never go to Git.

## S07. Acceptance tests and stop conditions

S-T01 strict version/runtime/actor/task/grant binding; cross-family UUID collision
S-T02 intent committed before sole query call, including synchronous query throw
S-T03 fake options capture proves fixed model/env/tools and no native/custom-spawn path
S-T04 iterator complete vs extra/missing/wrong-model/result/usage/identity observations
S-T05 timeout/cancel/overrun calls SDK cancellation, never a second query or PID signal
S-T06 pending cleanup ownership/late completion, no false process-exit claim
S-T07 restart with complete private evidence publishes without query; incomplete stays unknown
S-T08 Git write failure/lost reply/ACK retry/durable root and fsync failure never rerun inference
S-T09 public extract has only fixed response, provenance and usage; no private SDK messages
S-T10 auth unavailable/profile drift or an unreviewed SDK/CLI pair means zero query calls; the exact reviewed0.3.287/2.1.288 pair is a compatibility candidate whose authorized first trial can establish observed interoperability
S-T11 actual SDK path can be enabled only from the explicit trusted host composition;
       catalogue/read/status/template and ordinary UI monitor actions never invoke it
S-T12 boundary cases include oversized/deep/cyclic/accessor SDK values before serialization, total-message limits and stderr overflow with zero raw retention
S-T13 actual private Git→SDK Haiku→signed result→durable requester→ACK remains pending
       until implementation review, auth and one-shot signing approval are all satisfied

No native R3 review or execution is part of this design's acceptance evidence. No
real-PC merge, Codex task, API billing change or live model call is authorized here.
