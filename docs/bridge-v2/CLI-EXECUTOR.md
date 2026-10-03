# CLI broker / executor adapter

## Delivery status and remaining code

This change supplies a functioning broker control plane, authenticated local IPC client/server,
durable lifecycle, and a concrete hash-pinned direct-process driver. It **does not supply the OS
isolation supervisor that the driver calls**. That supervisor is still unimplemented platform
code, not merely an installation task or a boolean that an administrator may safely set to true.
Consequently this is **not an end-to-end production-confined Claude/Codex executor**. Live CLI
execution remains unavailable until that component is implemented, independently reviewed,
installed, and tested. No CLI or provider is enabled by importing these modules.

A task path/command allowlist, a working directory, Claude permission flags, Codex's read-only
mode, and capability strings alone do not enforce the complete Bridge v2 contract. In particular,
read-only does not restrict which readable files can be accessed or provide exact argv/max-run
mediation. The broker never falls back to spawning either model CLI without its installed
isolation supervisor.

### Implemented files

- `src/adapters/cli-launch.ts`: administratively supplied provider/binary/model/repository registry;
  fixed direct argv; exact task-file byte validation and identity-bound response framing; task-owned environment rejection via the
  TaskSpec schema; fresh run-specific homes; piped stdin/stdout/stderr; explicit subscription/API
  routing metadata; bounded deadline and identity validation
- `src/adapters/cli-broker.ts`: `CliBrokerService` implements `TaskExecutor`, using a private SQLite
  WAL/FULL database. Start intent is committed before any external start. Start is never replayed,
  including after process crashes, timeout, disconnect, or service reopen. Durable cancellation
  tombstones suppress late starts. Repository plus registered-worktree exclusion and monotonic
  fencing are enforced. Status, cancellation, collection, and independent recovery are bounded
- `src/adapters/cli-isolation.ts`: `InstalledCliIsolationRuntime` invokes one installed ELF via
  `/proc/self/fd/3`, with a verified SHA-256, direct fixed argv, empty inherited environment, fixed
  cwd, and piped JSON. It checks parent-directory ownership/write permissions and binary ownership,
  no symlink, regular-file type, single link, executable mode, size, and digest before every call.
  This is a real subprocess driver; it is not the missing confinement implementation
- `src/adapters/cli-rpc.ts`: `CliBrokerExecutor` client and `listenCliBroker` service adapter. Local
  Unix IPC uses AES-256-GCM with direction-specific associated data, fresh nonces, correlation IDs,
  request freshness/replay limits, strict JSON parsing, bounded length-prefixed frames, bounded
  connections, timeouts, and private endpoint ownership/mode checks

## Trust and process boundaries

The controller is the approval authority. It must have already validated the exact raw TaskSpec
hash, detached approval, policy, and quota/session constraints. `TaskExecutor.start` supplies a
normalized TaskSpec plus a hash from that trusted controller; this port does not receive raw spec
bytes and cannot independently recompute their exact-byte hash. The broker independently checks
TaskSpec structure, task-file bytes, registered provider/model/repository, immutable identity,
resource locks, deadline, process identity, complete terminal result structure, and artifact bytes.

The socket's externally provisioned 32-byte key is control-plane authority. The broker/controller
must run under an account inaccessible to job children and transport writers. Key generation,
storage, credential enrollment, and permissions installation are explicitly outside automatic
startup. No task can choose an executable, socket, secret, home root, billing route, or registry.
Private directory mode 0700 and file/socket mode 0600 are required. Do not share the SQLite file
over a network filesystem or across hosts. Administratively registered worktree paths must be
canonical and immutable; the supervisor must verify their actual filesystem identity at launch.

The supplied IPC route is same-host Unix only. Windows returns
`sandbox_capability_unavailable: authenticated-windows-pipe-not-installed`; the installed-fd
driver also rejects non-Linux hosts precisely. There is no PID-only Windows cancellation,
`taskkill`, PowerShell, shell-string, or unconstrained fallback.

## Required isolation supervisor implementation

The trusted registry points `InstalledCliIsolationRuntime` at an administrator-reviewed immutable
native ELF. Its executable hash is a separate pin from the provider CLI hash. No executable for
this protocol currently ships in this repository, and ordinary `bwrap`, `systemd-run`, `codex`,
or `claude` binaries do not implement it. Do not point the driver at them or use a script that
merely echoes capabilities.

The fixed invocation is:

```
<verified supervisor fd> rpc --protocol bridge-cli-isolation/1 <operation>
```

The operation is one of `check`, `start`, `status`, `cancel`, `collect`, or `artifact`, selected
only by program code. Exactly one strict JSON request arrives on stdin and one strict JSON
response is returned on stdout. Supervisor stderr is bounded and never logged by this driver.
RPC failure/timeout never proves the job terminated. Only the short-lived RPC process group is
killed on timeout; the durable supervisor owns the actual job tree and deadline.

### Request/response contract

| Operation | Input | Output |
| --- | --- | --- |
| check | `CliCapabilityRequest`: task, registered executable/hash/version | `CliIsolationCapabilities` with actual base commit, binary/version identity, implementation ID and every enforced requirement |
| start | `CliLaunchPlan` | Identity-bound `ExecutorObservation` |
| status | `{identity}` | Same run's `ExecutorObservation`; never another execution |
| cancel | `{identity, reason, graceSeconds}` | Persist tombstone before response, enforce it against concurrent/late start, then report observation |
| collect | `{identity}` | Existing observation and evidence only |
| artifact | `{ref}` | `{base64}` containing exact bytes from protected evidence storage |

An executable/model mismatch or actual repository base mismatch is a denial. `check` may inspect
binary, Git objects, installation and kernel features; it must not authenticate, start a model,
contact a provider, run task commands, or consume inference quota. Checks must be repeated
atomically at actual execution to prevent a check/use race.

`CliLaunchPlan` supplies full validated TaskSpec, fixed binary/argv hash, stdin bytes, controlled
environment, registered cwd, exact deadline, process I/O requirements, and billing-route metadata.
The supervisor must reconstruct/validate this plan against its own installed registry and confine
all CLI filesystem operations, built-in tools, hooks, plugins, MCP servers, child processes and
commands. It may not treat the CLI's own stdout as authoritative host telemetry.

The implementation must enforce all values in `CLI_ISOLATION_REQUIREMENTS`, including:

1. Open/fd-bound provider binary identity, exact argv/cwd/environment at every process creation
2. Per-operation approved paths, exact/subtree semantics, read-only rules, link/alias/race rejection
3. Exact command executable hash/argv/cwd and durable maximum invocation counts; rejection of all
   other commands even if the agent requests a shell or approved binary with other arguments
4. Task network denial, separately constrained provider control-plane networking, and protection
   of provider credentials from task children. A shared unrestricted network namespace is invalid
5. Process-tree containment, durable deadlines and cancellation tombstones, run deduplication,
   fencing, and identity-bound restart recovery. PID reuse cannot authorize cancellation
6. Actual base-commit verification, actual selected agent/model/version, complete command exits,
   stdout/stderr, changed files/binary diff, criteria evidence, termination proof, and protected
   artifact storage. A zero CLI exit or a model saying "done" is insufficient

A concrete Linux implementation should use a dedicated service account, a protected supervisor
ledger, mount/user/PID/network isolation and cgroup-v2 descendant containment, plus a race-safe
operation/exec mediator for the task's exact rules. Namespace or container isolation alone does
not enforce argv/max_runs. Provider traffic must be mediated separately from the task network.
Windows requires a native service with authenticated pipe ACLs, Job Objects, restricted token /
filesystem/network mediation, NTFS identity handling and descendant termination tests. Those
components must be implemented, not claimed by configuration.

## Durable behavior and evidence

An admitted start reserves resource locks and records dispatch intent in one SQLite transaction.
Concurrent duplicate start calls and reopen never issue a second start. A crash between commit
and dispatch can leave a never-executed job unknown; there is deliberately no "helpful" replay.
An unseen status remains unknown. A cancellation registered before the task is known remains an
identity-bound tombstone; without enough authenticated task/termination evidence, it stays unknown
rather than manufacturing a never-started Result. This is conservative and can retain locks until
trusted reconciliation supplies complete evidence.

The host calls `startRecoveryLoop()` after service binding. `recover()` rechecks nonterminal runs
and reissues durable cancellation on elapsed deadlines; this is supplementary to the supervisor's
independent deadline. A disconnect must not extend a run. Stop intent wins terminal observations
that arrive later. Unknown jobs retain locks. Only an identity- and process-bound verified terminal
Result with all descendants terminated releases the resource.

The broker validates ResultSpec against the task, run, fence, and previously observed process,
checks real agent/model and provider binary identity, reads every referenced artifact from the
supervisor, verifies exact lengths and SHA-256, and persists those bytes before committing the
terminal snapshot. `readArtifact` exposes only already-collected refs, not arbitrary paths or URLs.
No stdout/JSONL event is accepted directly as a terminal receipt. Log/artifact limits deny oversized
results; they are never silently truncated while claiming complete evidence.

## Provider flags checked against official documentation

Checked read-only on 2026-10-03; no `claude --help`, `codex --help`, authentication, provider query,
or live CLI was run. Installed provider versions and hashes must still be pinned and integration
checked by the supervisor. Documentation can change independently of the deployed version.

- Claude uses print mode, text input on stdin, streaming JSON output with verbose mode, an explicit
  model, `dontAsk`, no session persistence, strict empty MCP configuration, and empty optional
  setting-source selection. These flags are defensive defaults; they are not Bridge v2 confinement
  or authority to activate bypass permissions. [Official Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
- Codex uses global approval `never`, `exec --json`, explicit sandbox mode/model/cwd, and `-` for
  stdin. Read-only is selected for read-only tasks; workspace-write is merely a defensive default
  for edit tasks, still requiring the external exact-scope supervisor.
  [Official command reference](https://developers.openai.com/codex/cli/reference/),
  [official non-interactive mode](https://developers.openai.com/codex/noninteractive/)

Neither plan uses model aliases outside the installed allowlist, an API fallback, resume, automatic
reexecution, a shell string, or a task-provided environment. Provider authorization and successful
configuration are not established by this source change.

## Validation and command record

Work started 2026-10-03 05:12 UTC in `/workspace/shared/bridge-v2-adapters`, the assigned shared
Linux cloud checkout. Node `v24.19.0`, npm `11.9.0`; existing repository dependencies were used.
No package install, Git commit/push, real model CLI, Windows operation, credential provisioning,
live provider traffic, quota probe, or authentication activation was performed.

Commands executed during this adapter work (repeated reads/edits consolidated):

- `pwd`, `ls`, `find . -name AGENTS.md -not -path './node_modules/*'`
- `cat package.json`, `cat tsconfig.json`, `cat biome.json`, and `sed`/`grep` reads of task executor,
  contracts, controller, policy, store, schema, implementation and Windows handoff files
- `mkdir -p src/adapters`; `cat > ...`, `python3` and `sed -i` only to author the owned
  `src/adapters/cli-*`, `tests/unit/cli-*`, and this document
- `node --version`, `npm --version`, `date -u +%FT%TZ`, `git status --short`
- `npx tsc -p tsconfig.json --noEmit` (repeated; latest scoped checkpoint passed)
- `npx biome check --write src/adapters/cli-*.ts tests/unit/cli-*.ts`, followed by
  `npx biome check --write --unsafe ...` for reviewed optional-chain style fixes, and final
  `npx biome check src/adapters/cli-*.ts tests/unit/cli-*.ts` (passed)
- `npx vitest run tests/unit/cli-broker.test.ts` during development; initial failures exposed a
  test fixture's invalid boot UUID and the runtime's Unix-socket prohibition; UUID fixed
- `npx vitest run tests/unit/cli-broker.test.ts -t 'collects verified success'` while diagnosing
  the test fixture, then the full focused suite after fixes
- One authorized elevated retry of the original fake-process/local-IPC tests also returned
  `listen EPERM`. No external networking or CLI launch was attempted by this retry
- Final default adapter suite:
  `npx vitest run tests/unit/cli-broker.test.ts tests/unit/cli-isolation.test.ts tests/unit/cli-rpc.test.ts`
  **32 passed, zero skipped**, three files (final rerun 2026-10-03 05:39 UTC)
- Explicit platform suite:
  `npx vitest run --config tests/unit/cli-ipc.vitest.ts`
  **1 failed at socket bind: `listen EPERM`** (2026-10-03 05:34:23 UTC). This is a separately
  reported platform/environment blocker, not a passing check. Its assertions have not run on a
  permissive host. The suite is deliberately explicit opt-in; no environment-dependent skips are
  present in the default tests

Implementation/review finished 2026-10-03 05:39 UTC.

The default suite exercises the full authenticated protocol over fragmented in-memory duplex
sockets, wrong-key/executor denial, connection timeout, permission denial, every RPC method,
AES-GCM tampering/reflection, fixed provider argv, immutable inputs, hash-bound mocked process
invocation, installation permission/symlink/hash denial, process stdout/stderr bounds, timeout,
success/failure, corrupt artifacts, PID reuse, unproved descendant termination, duplicate start,
crash/reopen, cancellation, cancel-before-start, stale fences and deadline recovery. Every process
response is fake; passing these tests is not validation of OS confinement or a provider account.

Remaining validation: audited isolation supervisor implementation/tests; actual Unix IPC on a
permitted Linux host; provider-version integration tests only with explicit authorization; native
Windows service/pipe/Job Object/NTFS tests; full application wiring and end-to-end approval,
transport, execution, evidence and result-ACK test. Parent integration records aggregate repository
checks separately.

### Framing addition

CLI plans now wrap verified task-file text with `createFramedPrompt` and include `responseFrame`
(request UUID, raw TaskSpec hash, run UUID). The task file itself is unchanged and independently
hashed. The missing supervisor must parse the final provider text with `parseResponseFrame`; a
valid BEGIN/END frame is a completeness/correlation signal only, not proof of execution success.
