# Explicit resident reconciliation worker

`BridgeResidentWorker` (`src/adapters/resident-worker.ts`) is a portable lifecycle
coordinator over existing hosts. It has no authority, model launcher, job ledger,
credential lookup, or automatic startup. Constructing it, reading `snapshot()`, or
using the catalogue/template CLI performs no ticks. Its trusted configuration
requires `enabled: true`; disabled is a supported no-op. No HTTP setting enables it.

## Trusted deployment composition

After constructing the existing configured host and browser delivery service,
return a lifecycle field from the trusted deployment module:

```js
import { BridgeResidentWorker } from '/absolute/bridge/dist/adapters/resident-worker.js';

const residentWorker = new BridgeResidentWorker({
  enabled: true, // explicit trusted deployment decision, not task/prompt data
  intervalMs: 30000,
  tickTimeoutMs: 30000,
  drainTimeoutMs: 5000,
  lanes: [
    { id: 'cli:product-a', tick: signal => runtime.host.tick(signal) },
    { id: 'chat:product-a', tick: signal =>
      signal.aborted ? Promise.resolve() : browser.tick() },
  ],
});
return { ...runtime, residentWorker };
```

This is a composition fragment, not a standalone credential/configuration file.
Only include configured, authorized lanes. A lane ID is an operational label,
never recipient identity or authorization. Distinct projects require their own
configured controllers and policies; the recipient pump checks repository and
policy identity before claiming. Within an intended shared session the existing
session limits and unknown-state pause remain authoritative. Existing repository
reader/writer locks and dependency gates remain in the core.

The companion product lifecycle calls `start()` once after successful loopback
listen/origin validation. It must call `close()` and wait for success before
closing runtime stores. Collapse, hide, or tray operations do not call close.
Manual HTTP approve/start entrypoints also need the companion shutdown fence;
`TaskController.start(requestId, approvalId, signal)` accepts that signal.
A standalone supervisor may use this same lifecycle, but must own the same drain
ordering. Do not start the worker in `openDeployment()`: read-only CLI consumers
also load that module.

## Timing, failure, and shutdown

Each lane has its own non-overlapping tick. A slow browser lane never holds up a
CLI lane. The next tick starts one interval after the previous tick settles.
A watchdog aborts the advisory signal and marks the lane timed out; it retains
ownership of the actual pending promise, so timeout never starts a replacement
concurrently. A settled error permits later reconciliation against the same
existing ledgers. No model retry or new request identity is synthesized.

`stop()` pauses scheduling, aborts new-work signals, and drains pending ticks.
After successful drain, `start()` explicitly resumes with fresh signals.
`close()` is terminal and retryable after a failed drain. A
`resident_worker_drain_pending` rejection means stores must remain open. It does
not prove a process/model request stopped. Existing admitted jobs are reconciled
using their saved identity, not rolled back, cancelled, or relaunched by shutdown.
The controller checks the abort signal again after asynchronous preflight and
inside the final atomic start-grant check. Thus an in-flight approval/preflight
cannot create a new durable dispatch intent after the stop fence.

Bounds: 16 lanes maximum; interval 1–300 seconds (default 30); tick timeout
1 ms–300 seconds (default 30 seconds); drain timeout 1 ms–30 seconds (default 5).
Snapshot counters and sanitized error codes are read-only process diagnostics,
not durable job evidence. Do not use them for success/termination/ACK decisions.

## Offline verification

```sh
npm run typecheck
npm run lint
npm run build
npx vitest run tests/unit/resident-worker.test.ts tests/unit/task-runtime.test.ts tests/unit/github-transport.test.ts
npm test
npm --prefix gui run typecheck
npm --prefix gui run lint
npm --prefix gui run build
npm --prefix gui test
```

Focused tests cover independent lanes, no overlap, watchdog ownership, bounded
close/retry, stop/resume, late rejection, exception sanitization, no work on
construction/disabled state, preflight/transaction aborts, admitted-run identity,
and same-recipient project/policy claim isolation. All provider/process/network
ports are synthetic. This does not verify native supervisor confinement, real
Windows IPC, real model/browser submission, credentials, or account quota.
