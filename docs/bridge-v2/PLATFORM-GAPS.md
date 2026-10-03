# Native platform: implementation gaps versus verification gaps

The final PR3 checkpoint does not ship a complete enforcing OS supervisor. Merge order alone
cannot remove this gap. The following is an implementation handoff, not a request to activate
credentials, edit ACLs, install a service, connect a computer or run a model.

## In PR3, exact missing boundaries

1. `InstalledCliIsolationRuntime` in `src/adapters/cli-isolation.ts` invokes a hash-pinned installed
   supervisor protocol. The **supervisor executable is not present**. Its check/start/status/cancel/
   collect/artifact methods must implement genuine filesystem/command/network/process isolation
   and verify actual base commit, CLI binary identity and complete termination/evidence
2. `CliBrokerExecutor` / `listenCliBroker` in `src/adapters/cli-rpc.ts` support Unix sockets only.
   Implement the Windows authenticated named-pipe transport, ACL/impersonation checks and secure
   local state access. Do not replace this with a TCP socket or unauthenticated pipe
3. `openTrustedDeployment` in `src/adapters/deployment-loader.ts` rejects Windows because NTFS
   owner/inherited ACL verification is absent. Add native validation of the file and all ancestors,
   with race-safe code loading and trusted transitive import policy
4. The actual CLI must not get uncontrolled task filesystem access, arbitrary child argv or task
   network just because its binary is allowlisted. Separate provider control-plane credentials/
   network from task operations, and mediate every allowed operation through the broker
5. CLI receipt assembly must collect trusted process/command identity, exit/stdout/stderr,
   changes/diff and registered evaluator output. Model text and capability strings cannot attest
   those facts. No user-supplied PID, success JSON or fake receipt may substitute

## Separate experimental follow-on

A bounded native candidate was developed separately and is not part of the PR3 activation path.
It is not ready to merge as a secure executor. Its candidate files are:

- `native/windows/containment.hpp`, `containment.cpp`: AppContainer/Job/child-restriction/locked-file primitives
- `native/windows/command_line.hpp`, `command_line_test.cpp`: portable argv quoting
- `native/windows/adversarial_fixture.cpp`, `CMakeLists.txt`: Windows build/probe harness
- `src/platform/mediated-operations.ts`: durable broker-only file/command operation policy and one-use evidence ledger
- `src/platform/tool-free-agent.ts`: tool-free Claude plan and an always-denied Windows readiness gate

These filenames describe the separate candidate, not files available in every PR3 checkout.
The candidate still lacks a native Node/service binding, authenticated pipe service, exact least-
privilege filesystem profile, provider-network separation, agent structured-operation integration
and full ResultSpec/receipt assembly. Codex built-in-tool disabling has not been verified and is
rejected by the candidate. Job Objects/AppContainer alone do not prove exact per-task path scope.

## Build and evidence gates

The cloud environment has Linux GCC but no Windows SDK/MSVC/MinGW or Windows runtime. Native
Windows compilation and adversarial runtime tests are a real blocking prerequisite. Portable
quoting and fake capsule tests passing does not establish API compatibility or security.

The Windows implementer must first build with warnings-as-errors on a disposable, authorized
host, then prove denial for unapproved read/write/argv/child/network, NTFS aliases/reparse/hardlink/
ADS/path replacement, durable cancellation before/after spawn, kill-on-broker-crash, monotonic
fencing, process creation identity/PID reuse, authenticated pipe impersonation and complete evidence.
Only then can supervisor capabilities report support. Any missing guarantee keeps activation denied.

## Recommended responsibilities

- Codex: implement/repair the remaining native integration and add regression tests on the exact
  reviewed branch. Do not merge or enable live credentials merely because compilation succeeds
- Claude: independent diff/security review and rerun the fixed-commit tests; report P0/P1/P2 with
  a reproducible path and required evidence. Avoid parallel duplicate implementation or speculative
  repeated model runs
- User: approve the chosen real host/account/route/setup only when the bounded test plan and
  permission scope are known; return the requested sanitized logs and exact commit identifiers

Actual provider/Windows tests remain unrun. Unknown or unsupported must remain visibly unavailable.
