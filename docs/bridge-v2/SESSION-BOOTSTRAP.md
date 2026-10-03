# Bridge v2 model-session bootstrap

## Scope and current boundary

The configured CLI broker now owns fresh-run reminder preparation and advisory ACK collection.
Each run is a new Bridge-owned model session: `sessionId = runId`, the registered provider,
`role = response_producer`, the exact task repo, and `contextEpoch = 1`. There are no resume flags,
no live context/compaction detector, and no claim that installing Bridge makes other sessions
remember instructions. The helper's retained-session API remains a separate, synthetic-tested
facility; it is not a production resume route.

This integration does not invoke a CLI/model, install a provider tool, configure authentication,
change authority or implement the missing native enforcing supervisor. Real source availability
still depends on a separately installed, trusted runtime. Synthetic tests prove the portable
broker/store/launch/collector wiring only. Ordinary Chat's browser renderer and the SDK fixed-echo
protocol are unchanged.

## Required broker configuration and lifecycle

`CliBrokerOptions.bootstrap` is required. Existing broker compositions must provide a separate,
explicit private `dbPath`; there is no production `:memory:` fallback:

```ts
const broker = new CliBrokerService({
  executorId,
  dbPath: "/private/bridge/broker.db",
  bootstrap: {
    dbPath: "/private/bridge/bootstrap.db",
    maxSessions: 1024,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
  },
  installations,
  runtime,
  // Optional trusted synchronous function over already observed provenance:
  selectBootstrapResponseSource: (acceptedTerminal) =>
    registeredResponseSources.get(acceptedTerminal.identity.runId) ?? null,
});
// The service owner closes both broker and advisory handles through broker.close().
```

The source map above is illustrative host-owned provenance, not a new model-populated database.
A missing/identical bootstrap path fails with `cli_broker_bootstrap_private_db_path_required`;
an insecure path fails the store's private-path checks. The broker explicitly opens/closes the
existing `SessionBootstrapStore`, closes it on constructor failure, and never substitutes another
session store. Defaults remain 1,024 sessions and seven days; configured bounds are 1–10,000
sessions and 1 ms–30 days. Limits bound rows/messages, not disk usage. The SQLite file and its
parent must be private, owned, regular/non-symlink paths (0600 file, 0700 parent). This POSIX
validation is not a Windows ACL implementation.

Before first dispatch, `prepare` durably saves the exact v1 pending reminder/challenge. The broker
passes that plan into `createCliLaunchPlan` as its optional final host-only argument. The planner
validates the complete plan, exact fresh identity, fixed guidance/docs, v1 version, challenge,
ACK, hashes and exact JSON bytes before including it in stdin. It cannot fall back to a new plan
if supplied validation fails. The durable launch record holds the same bytes dispatched to the
runtime. Legacy callers that omit the argument retain the pure planner behavior and historical
v1 bytes. Profile and reminder golden hashes are covered for Claude, Codex, Antigravity and ChatGPT.

Preparation may leave an orphan pending reminder if later admission fails. That grants no
execution authority. A persisted broker run is checked before preparation: restart, duplicate
start, cancellation tombstones, expired/evicted/missing advisory state and uncertain dispatch
never generate a replacement reminder, challenge, run, prompt send or start RPC. The persisted
launch plan records what was dispatched even when advisory state is no longer available.

## Exact trusted source and versioned extraction

The optional synchronous `selectBootstrapResponseSource` is a trusted host adapter. It must only
read previously authenticated provenance for the newly accepted terminal observation. It must
not perform a provider RPC, probe, query or start. It is never called during recovery. An absent,
null or invalid source produces explicit advisory `unavailable`; there is no stdout filename,
latest-message, arbitrary path or model-supplied-identity fallback.

The strict `bridge-bootstrap-response-source-1` descriptor binds request ID, raw task-spec hash,
run ID, fencing token, provider, host session ID and an exact artifact ID/hash/size/reference.
A provider session ID is optional and may only be supplied when actually observed on the trusted
channel; the broker never invents it from the run ID. The descriptor's full artifact reference
must be among the independently accepted terminal result's artifacts.

The broker first commits the independently valid terminal observation and its verified artifact
set. Only then does it select and persist a source descriptor. Extraction reads the immutable,
already hash/size-verified broker cache, with another exact byte check; it never calls runtime
artifact lookup during local projection/recovery. A crash before descriptor persistence leaves
`source_not_captured`, which recovery cannot repair by choosing a different output.

`bootstrap-extraction.ts` first validates the FULL existing response frame against the saved
request/task hash/run. Inside its body it accepts exactly one whole root JSON paragraph or a
root `json` fence. An accepted JSON fence must have blank separators from surrounding prose; a whole root JSON paragraph may end before a later non-JSON fence. The parsed strict object must
exactly equal the saved v1 ACK. It rejects duplicate keys/candidates, malformed JSON candidates,
wrong version/context/session/challenge/hash, extra fields and oversize ACKs. Quoted/indented
blocks, nested echoed reminders/templates, substrings, other code languages and HTML containers
are never mined for an ACK. Container openers are recognized even when they interrupt prose
without a blank line. The conservative scanner may leave complicated Markdown unconfirmed;
that is preferable to interpreting a quoted example as acknowledgement. No new reminder format
or reserved v2 block is introduced, and raw provider/result bytes are never rewritten.

## Advisory sidecar and local recovery

`broker.bootstrapStatus(identity)` returns `confirmed`, `unconfirmed`, `unavailable` or `pending`
local projection. Diagnostic reasons use a finite, state-specific code allowlist; corrupted or
unknown stored text is reported as `projection_invalid` and is never echoed. A confirmed `bridge-bootstrap-extraction-1` sidecar contains the exact source,
accepted terminal payload SHA-256 (over `JSON.stringify` of the stored accepted ResultSpec), full
raw-frame and normalized frame-body digests, and the advisory receipt. The receipt binds the
host session/provider/role/repo/context, saved v1 version, reminder/profile hashes, challenge,
receipt UUID and acknowledgement/expiry times. Sidecar reads strictly revalidate their full
shape and digests against the original cached frame and saved launch plan.

The advisory store acknowledges idempotently. If receipt storage or sidecar persistence fails,
the terminal result has already committed. A saved pending descriptor can be projected again
locally over its immutable cached bytes, retaining the same already-written receipt UUID. No
selector, runtime, model query, reminder, challenge or task execution is replayed. If its advisory
row has expired, been evicted, changed or gone missing, it stays explicitly unavailable rather
than being rebuilt. A previously confirmed sidecar is historical evidence only; its existence
does not grant retained-session reuse. A missing descriptor remains unavailable across restarts.

Missing, malformed or duplicated ACK is `unconfirmed`, never task failure. Store/source/sidecar
failure never downgrades a terminal observation, changes execution receipts, grants authority,
replaces delivery `resultACK`, or changes the cancellation/result winner. An exact matching ACK
only proves that matching reminder bytes came back on the selected bound channel. It does not
prove understanding or permission to skip result/evidence validation.

## Standalone helper

`createSessionBootstrap` remains a pure JSON planner; `parseSessionBootstrap` checks historical
exact reminder bytes and generated shape. `SessionBootstrapStore()` without a path remains
available only for helpers/tests. Its trusted retained-context APIs require exact matching
provider/role/repo/session/context/version/hash and a live receipt; possible context loss requires
a higher context epoch. None of those helper APIs adds an actual provider continuity detector.

## Official discovery, verified without invoking Claude or Codex

Documentation checked 2026-10-03; capability/version checks are still required for any actual
installed CLI. No live model, `--help`, authentication or provider command was run for this check.

- Claude reads project `CLAUDE.md` and supports project skills at
  `.claude/skills/<name>/SKILL.md`. Skill metadata enables discovery; it does not prove the
  body has been read or a version confirmed. [Memory](https://code.claude.com/docs/en/memory),
  [skills](https://code.claude.com/docs/en/skills)
- Claude's official CLI supports print mode, text stdin and appended per-invocation prompt
  instructions. Bridge can use its controlled print/stdin plan. No global hook is needed;
  `--no-session-persistence` does not support resume. [CLI reference](https://code.claude.com/docs/en/cli-reference)
- Codex discovers `AGENTS.md` on startup along its documented project directory chain. Its
  repo skills are under `.agents/skills`; discovery is not a per-session acknowledgement.
  [AGENTS.md](https://developers.openai.com/codex/guides/agents-md),
  [skills](https://developers.openai.com/codex/skills)
- Codex supports `codex exec -` for initial instructions on stdin and an explicit exec-resume
  interface. Bridge's current launch path uses the former; the latter's existence does not mean
  Bridge has implemented it. [CLI reference](https://developers.openai.com/codex/cli/reference)

An optional short [repo skill template](agent-skills/use-bridge-v2/SKILL.md) is included as
reviewable documentation. It is **not installed or auto-discovered at this documentation path**.
An owner may later copy it to one of the supported repo-scoped skill paths after review; this
change does not write either path or modify an entry file. Skills complement explicit Bridge
startup delivery. They are not a substitute for it and do not load into ordinary Chat merely
because a repository contains them.

## Synthetic verification

```sh
npm test -- tests/unit/session-bootstrap.test.ts tests/unit/cli-broker.test.ts
npm run typecheck
npm run lint
```

All provider/process/network observations in these tests are fake. Coverage includes exact v1
golden bytes, durable preparation before dispatch, full supplied-plan validation, restart and
same-run dedupe, expired/missing/evicted state without replacement, source identity/artifact
tampering, strict extraction negatives, terminal-before-advisory ordering, local storage faults,
receipt/sidecar replay idempotence without runtime calls, missing-source crash recovery and the
cancellation/result race. No model CLI, account/authentication command, Windows task, native
helper or live resume/compaction test is run by this slice.
