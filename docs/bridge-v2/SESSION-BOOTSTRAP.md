# Bridge v2 model-session bootstrap

## Scope and current boundary

Machine installation, model-session memory, and host approval policy are separate.
Every **new Bridge-launched model session** needs a short versioned reminder. A genuinely
resumed session may reuse its matching trusted receipt while its context is retained.
A version change, missing receipt, expired receipt or possible compaction/context loss
requires a short reconfirmation. There is no promise that arbitrary manually started
Claude/Codex sessions receive Bridge instructions.

`src/adapters/session-bootstrap.ts` implements pure JSON generation/validation and an
optional bounded acknowledgement ledger. It invokes no CLI, model, browser, authentication
or installation. It does not change TaskSpec, global settings, `CLAUDE.md` or `AGENTS.md`.
The existing CLI launch adapter starts fresh per-run homes, Claude print mode with no
session persistence, and Codex exec without resume. Treat every such run as a new model
session. Native enforcing CLI supervision remains incomplete; a bootstrap never enables it.

## Pure launch-plan helper

```ts
const bootstrap = createSessionBootstrap({
  sessionId: runId, // trusted host-generated model-session UUID
  provider: "codex", // claude | codex | chatgpt
  role: "issuer", // issuer | response_producer; Chat is response_producer only
  repoId: "registered-repo",
  contextEpoch: 1,
});
// bootstrap.reminderJson is bounded strict JSON; preserve its exact bytes/hash.
parseSessionBootstrap(Buffer.from(bootstrap.reminderJson), bootstrap.reminderSha256);
```

Use the short `reminderJson` in the Bridge-owned startup prompt, keeping the existing
verified task bytes and response-frame identity separate. A Claude/Codex executing a
received task uses `response_producer`; one preparing a task for another endpoint uses
`issuer`. Chat is the ordinary hosted response producer, not an invented local CLI.
The helper only creates data. The host owns delivery, authenticated channel/session binding,
and any extraction of an ACK from the response body.

Current version: `bridge-v2-session/1`. `bootstrapSha256` binds the version, fixed role-specific
guidance and documentation paths. `reminderSha256` binds all exact generated reminder bytes,
including session/context/challenge. Documentation paths point to the same trusted checkout;
the hash is **not** a hash of entire documents or proof of an installed CLI's capabilities.
Bump the bootstrap version when its protocol guidance changes; do not silently reuse an old
version after a meaningful deployment change. Changed guidance also changes its hash.

The reminder covers only this sequence:

1. Discover current capabilities, then shipped TaskSpec/result schemas
2. Generate and validate JSON; preserve exact UUID, raw bytes and hashes
3. Use only registered routes and configured authority
4. Distinguish receiptACK, startReceipt, terminal result and resultACK
5. Verify result/artifact binding, then acknowledge the exact result payload hash
6. Reconcile unknown outcomes against the original identity; never automatically reexecute

Long documents remain on demand. Frame strings come from
`src/contracts/response-frame.ts`; do not handwrite or memorize delimiters.
The frame binds request UUID/task hash/attempt UUID and is transport evidence only.
Ordinary Chat retains the separate `hosted-response-1` contract.

## Optional receipt ledger

`new SessionBootstrapStore()` uses process-local memory. Pass a private host-local SQLite
`dbPath` for restart durability. This is a small advisory ledger, not the task execution
ledger or host approval-session policy. Never infer authority, success, model identity or
process termination from a bootstrap receipt.

Call `prepare` with the trusted model-session identity, `bridgeLaunched:true`, matching
startup mechanism (`claude-print-stdin`, `codex-exec-stdin`, or `ordinary-chat-prompt`),
`mode:new|resume`, and `context:retained|lost`. `resume` also supplies the opaque `receiptId`
previously returned by this store. Merely supplying a receipt-shaped object is insufficient.

- `confirm`: deliver the generated short reminder through the approved session channel
- `alreadyPending:true`: the same challenge was already prepared; do not blindly inject it
  again after an uncertain delivery. Inspect the original delivery/response first
- `reuse`: the exact unexpired session/provider/role/repo/context/version/hash receipt matches
- Before reporting context loss, increment `contextEpoch`; the old ACK then cannot acknowledge
  the new context. Retain that epoch for subsequent calls. Missing reliable continuity evidence
  means context must be considered lost

When confirmation is requested, extract the exact `plan.ack` JSON object from **inside** the
response-frame body and call `acknowledge(session, ackBytes)` on the authenticated session
channel. Never ask for extra text outside the frame. No ACK extractor or model-resume detector
is implied by this helper. If the current launcher does not collect bootstrap ACKs, it must not
claim an acknowledged receipt or skip a future session's reminder.

An ACK's exact version, bootstrap hash, challenge, session UUID and context epoch must match.
Unknown fields, duplicate JSON keys, malformed/oversized input, cross-session reuse, stale
ACKs, and changed hashes are rejected. Repeated matching ACKs return the same receipt.
ACK is advisory evidence of confirmation only; a model echo does not prove understanding.
The state is saved before delivery and before returning a receipt. An uncertain send remains
pending; it never creates permission to resend a task or execute another attempt.

Default limits: 8 KiB reminder, 2 KiB ACK, 1,024 sessions, seven-day retention. Configurable
store bounds are 1–10,000 sessions and at most 30 days. The ledger retains only each session's
current pending reminder/receipt; eviction or expiry requires confirmation again. These are
logical row/message limits, not a disk quota. The SQLite file and its parent must be private,
owned, regular/non-symlink paths (0600 file, 0700 parent). Keep the state inaccessible to model
output and untrusted processes. This POSIX path validation is not a Windows ACL implementation.
The launcher must generate fresh session UUIDs and maintain a reliable monotonic context epoch.

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
npm test -- tests/unit/session-bootstrap.test.ts
npm run typecheck
```

Tests cover fresh sessions, trusted resume, restart persistence, version changes, lost context,
stale/invalid ACKs, exact hashes, strict generated JSON, expiry/eviction, and private state paths.
They prove helper behavior only, not real model compliance, live CLI integration, hosted Chat
compaction detection, Windows isolation, authentication or result delivery.
