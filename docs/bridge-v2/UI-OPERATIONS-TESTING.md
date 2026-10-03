# Operations UI: reproducible test and handoff procedure

Use the exact reviewed draft-PR head recorded in the PR body/verification file. Verify `git rev-parse HEAD` before testing. Do not combine arbitrary branch tips and call that the reviewed build. PR2 is historical; PR3 is the core adapter base; PR4 is accepted A presentation; the archive and operations follow-ons depend on their explicit reviewed heads. Do not merge without user authorization.

## Allowed cloud checks (no credentials, model CLI or browser required)

1. Root: `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`
2. GUI: `cd gui`, `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`
3. Focused regression groups:
   - `npx vitest run tests/unit/ui-operations*.test.ts tests/unit/ui-hosted*.test.ts`
   - `npx vitest run tests/unit/ui-canonical-archive.test.ts tests/unit/ui-archive-api.test.ts tests/unit/archive-integration.test.ts`
   - `npx vitest run tests/unit/ui-composer.test.ts tests/unit/ui-recipe-deadline.test.ts tests/unit/bus-issuer-cli.test.ts`
   - `npx vitest run tests/unit/ui-quota-binding.test.ts tests/unit/quota-provider-review.test.ts`
   - `npx vitest run tests/unit/ui-pro-counter*.test.ts tests/unit/ui-notification*.test.ts tests/unit/ui-fast-notifications.test.ts tests/unit/ui-frontend.test.ts`
4. Keep browser fixture skips separate from passes. No rendered-browser, Windows, live provider/model or actual external Git round-trip evidence is implied by these Node/VM tests

The fixtures use temporary directories, real SQLite/controller/archive classes where applicable, in-memory signed Git, and explicitly fake runners. They never need production jobs or user conversation data.

## Expected properties

- Local/hosted/fanout are distinguishable; one malformed/timed-out lane cannot erase healthy lanes
- Restart/interruption retains the original UUID and attempt. Unknown never enables rerun
- A slow/hung hosted start does not block Stop. A late completion cannot create a new attempt
- Editing a preview, changing project revision/destination policy, or submitting a stale operation binding is rejected before dispatch
- A stalled pure recipe times out. Late settlement does not issue, cache, retry, or generate replacement IDs
- A historical payload-only ACK stays visible but is not full delivery. Stale equal-sequence UI snapshots cannot remove observed raw ACK evidence or downgrade valid proof
- Canonical project changes affect only future admissions. Archive/probe actions use the same registry; v1 writer routes are denied
- Explicit sanitized diagnostic export contains neither synthetic test prompt text nor private root paths. Manifest corruption, source mismatch and missing required artifacts remain blocked
- Codex quota is never used or displayed as another provider's quota. Missing metadata/configured percentages remain unknown. Snapshot reads make no provider RPC
- Pro count distinguishes confirmed/possible usage, stable attempt identity, unknown external usage and user-configured windows. OFF notification preferences emit nothing
- Collapse/expand and selecting another task preserve drafts and exact selected identity. No job completion expands/focuses the native window; stale native-state responses are ignored
- Fast jobs completed between polls can notify once after a fresh baseline; re-enable never replays older unseen results

## Windows/manual phase: only after explicit authorization and native gates

Do not launch Codex/Claude/Antigravity/model tasks merely to test the UI. First report missing native code/credentials. The steps below describe future manual checks; they were not executed by cloud tests.

1. Record exact Git head, Node/Electron/OS versions, display resolution and scale. Use a temporary synthetic runtime and no production data
2. Launch demo. Verify collapsed 440×46 and expanded overall 440×604 geometry within the work area; all pages retain a fixed common frame. Inspect 100%,125%,175% scales as applicable
3. Type into the secondary composer/import/settings fields, collapse, reopen from tray and change theme. Fields and pending state must survive; there must not be a second large detail window
4. With demo only, create two synthetic jobs. Complete the nonselected job. The resident notice updates without expansion/focus, and OFF immediately hides notices. Re-enable does not replay old results
5. Close/hide, reopen, restart. Durable task/setting state must persist while a lost synthetic executor observation remains unknown rather than restarting
6. Production unconfigured profile must disable approve/start/probe/materialization with specific reasons. Never replace missing native gates with permissive fakes
7. Only after an approved real deployment exists, run one bounded ordinary-chat request and one bounded CLI request at the same fixed head. Record exact request/attempt/run IDs, TaskSpec/Markdown/terminal/manifest/proof hashes, observed stage timestamps and final requester artifact completeness. Verify no model or account-route substitution
8. Audit/retest with an independent reviewer. A code/fake-only result remains intermediate; real round-trip evidence is the final functional gate

## Failure report for the implementing LLM

Provide: exact commit, command (remove bearer URL/token/credential values), profile, OS/runtime version, test name, expected versus actual result, request UUID and public hashes, and sanitized static error code. For UI include selected route/UUID, operation revision, sequence, last observed state/time, and screenshots only after removing private content. Use explicit diagnostic export and inspect it before sharing. Do not include runtime databases, browser profiles, conversation bodies, root paths, secrets or raw capability URLs.

If the state is unknown, keep the request identity and use reconcile/result inspection. If a setting save is uncertain, reread its revision before retrying. If a recipe times out, no request was issued by preview/template. If dispatch is uncertain, do not regenerate IDs. If native storage/confinement is unavailable, stop that route and report the missing provider; do not weaken the guard or skip its assertion.
