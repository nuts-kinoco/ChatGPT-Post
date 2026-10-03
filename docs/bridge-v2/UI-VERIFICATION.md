# PR2 product UI verification

This checkpoint covers the wired product UI on top of PR1 `b2ceb37ba15973b2ebaec39aa06dce6225677593`.
The exact published/tested head is recorded as **Verified head** in the PR description. It is a draft,
unmerged checkpoint, not a certification of real Windows execution or model-provider integration.

## Product entrypoints

- Root `npm run ui`: authenticated HTTP service on 127.0.0.1, production profile by default
- Root `npm run ui:demo`: explicitly synthetic profile in separate `runtime/ui-demo/jobs.db`
- Existing `gui/ npm start` and newly rebuilt portable GUI: v2 280×380 status dock and detail window
- Existing browser-chat GUI remains an explicit tray item; existing `run/submit/status/wait/result`
  CLI routes are preserved
- Unchanged GUI files were materialized from PR1 by verified upstream blob hashes; only the main
  startup wiring, a new product helper/tests, and GUI README change

## Checked commands

Linux cloud environment, Node v24.19.0, npm 11.9.0, repository lockfile dependencies.

| Scope | Check | Result |
|---|---|---|
| Root | `npm run typecheck` | Pass |
| Root | `npm run lint` | Pass |
| Root | `npm run build` | Pass; includes copied public UI assets |
| Root | `npm test` | 650 passed, 56 browser fixtures skipped, 0 failed |
| GUI | `npm run typecheck` | Pass |
| GUI | `npm run lint` | Pass |
| GUI | `npm run build` | Pass |
| GUI | `npm test` | 50 passed, 0 skipped, 0 failed |

The pre-existing Linux profile-guard failure was reproduced before editing. The fix preserves
case-insensitive deny rules for Windows profile families identified by LOCALAPPDATA/APPDATA,
independent of the host performing an offline validation. Native HOME roots retain their host
comparison behavior. Existing assertions were not relaxed; additional Windows-family and native-root
cases pass. No security guard, test, or assertion was removed to obtain a green run.

## Exercised behavior

- Real loopback HTTP requests: bearer authentication on reads and mutations, exact Host/Origin,
  cross-site rejection, no CORS, duplicate header checks, body size/content type/strict UTF-8 JSON,
  duplicate-key rejection, request schema, exact asset/query allowlist, CSP/security headers
- Real SQLite/controller: immutable raw payload validation/import, same-ID dedupe/conflict,
  exact inspected-hash/sequence approval and start, one-start behavior, persisted receipts,
  terminal payload-bound ACK, requester-identity binding, restart retention, unknown without rerun
- Terminal row/immutable-receipt consistency, including fail-closed schema-valid stored-row corruption
- Prompt cancellation while approval or executor.start is unresolved, bounded authority calls,
  late-grant rejection after cancellation, late response sequence fencing and monotonic ACK preservation at equal Result revision
- Frontend DOM behavior with a test harness and live local core: disconnected ambiguous mutations
  are never retried, newer selection wins, drafts survive refresh, CRLF input preservation,
  cancellation stays available during a pending start/approval, dock navigation does not leak tokens
- Electron helper tests: selected-checkout service loading, explicit profile selection, safe
  navigation, private token fragments, repeated Details/Close-hide reopening without draft loss,
  and native load errors never exposing token URLs

## Not verified

- Rendered visual layout: the supported cloud-browser navigation to the actual loopback product
  service was blocked with `net::ERR_BLOCKED_BY_CLIENT`. No alternate route was used to bypass it.
  DOM/source checks are not a browser screenshot or visual-layout pass
- 56 browser fixture tests were skipped by the existing environment guard. They are not counted
  as browser regression successes
- Windows Electron/portable executable launch, DPI and monitor behavior, Windows process identity,
  junction/NTFS ACLs, process-tree termination, and OS confinement
- Real Claude/Codex/model execution, external provider authentication, live quota or billing reads,
  GitHub task delivery or external notifications. PR2 defaults remain explicitly unconfigured

No connected-PC task, Windows operation, model CLI or live model request was run for this checkpoint.
Only synthetic fixtures, source, schemas, tests and documentation are published; runtime databases,
launch tokens and local installation/build outputs are excluded.

Use [UI-USAGE.md](UI-USAGE.md) and [UI-TESTING.md](UI-TESTING.md) for the separate user/LLM procedures.
