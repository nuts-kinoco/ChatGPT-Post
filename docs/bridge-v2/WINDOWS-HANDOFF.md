# Windows / Claude implementation and review handoff

Current combined instructions: [USAGE.md](USAGE.md), [TESTING.md](TESTING.md), [PLATFORM-GAPS.md](PLATFORM-GAPS.md). The original checklist below is historical PR1. Codex should implement/repair; Claude should independently audit and retest the exact fixed head. Production OS supervisor code remains missing, separate from Windows verification.

## Fixed source and safe starting point

Use the exact draft PR head commit recorded in `VERIFICATION.md` / the PR, not a moving main branch. Read `LLM-QUICKSTART.md`, `IMPLEMENTATION.md`, then the relevant protocol sections. This handoff is a plan, not permission to invoke Claude/Codex, connect a PC, install credentials, activate autoapproval, merge or run a live model. Obtain the user's currently required authorization before those actions.

1. Fetch the dedicated branch and verify the head SHA against the PR
2. Inspect the diff and run `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`
3. Run `npm run test:unit` and `npm run test:fixture`; report skipped browser tests separately
4. Start with fake tests, then implement one authenticated broker/approval adapter at a time under new tests
5. Review the exact resulting commit, requested permissions and paid/subscription route distinction
6. Only after independent review, passing checks and explicit merge authorization consider merging; do not merge this draft automatically

## Still required on every platform

- Authenticated approval service and storage ACL boundary; mutable task/transport files must never mint grants
- Enforcing sandbox/broker for start/status/cancel/collect, actual base-commit and binary identity checks, per-operation path/command mediation, network deny, child process tree containment and durable cancellation tombstones
- Trusted collection of actual model/agent metadata, stdout/stderr, command exits, diff, criterion results and complete process-termination evidence
- GitHub or another common job transport with issued/receipt/start/result/result-ACK reconciliation, authenticated actors and replay protection; no assumption that a push wakes dot
- UI integration, adapter health/quota probes, model/effort discovery and workflow scheduling; no implicit inference to diagnose an adapter

## Windows-specific checks and pass criteria

- Host-local SQLite WAL/FULL crash/reopen tests on NTFS; do not put `jobs.db` on SMB or a mapped shared drive
- Process identity includes host, boot, PID and creation time. PID reuse must not authorize cancellation or recovery
- Job Object/process-tree containment verifies every descendant terminated before `cancelled`/`failed`; deny if a descendant escapes
- Reserved names, NTFS case aliases, 8.3 names, junctions/reparse points, ADS, hardlinks and path replacement races cannot escape approved filesystem scope
- Canonical worktree identity/locking works for drive, UNC, junction and case aliases. Unknown jobs retain write locks
- Broker deadline enforcement survives controller disconnect; late start after cancel is suppressed; receipt collection never reruns the job
- Executable hash/argv/cwd limits are enforced at each command creation; disallowed command and read-only edits are denied in the actual sandbox
- Browser fixture regression runs with an authorized disposable test profile and fixture-only network. Existing browser `run`/`collect` semantics remain unchanged
- Crash before and after SQLite commit and around process spawn cannot produce duplicate execution or a false terminal receipt

Pass means the tests provide identity-bound evidence, not that a manual click appeared successful. Keep any incomplete or skipped stage explicit. Do not claim this cloud checkpoint verified Windows or a production sandbox.
