# Issuer/bootstrap cumulative verification

Baseline: PR15 `275f7d5c25e69b6fa00305d4dba3c801e9514eb4`. The exact reviewed candidate and published head are pinned in the draft PR description; this document does not self-reference its own commit.

Environment: Linux 6.18.44, Node v24.19.0, npm 11.9.0. Final author aggregate ran on 2026-10-03 at 17:52 UTC. All commands below used synthetic network/provider/process ports. No actual model inference, production key generation, authentication, Windows execution, native R3 run, notifications or merge.

| Check | Result |
| --- | --- |
| Root `npm run typecheck`, `npm run lint`, `npm run build` | pass |
| Root `npm test` | 2,474 passed, 56 inherited explicit browser skips, 0 failed |
| GUI typecheck, lint, build, test | pass; 60 tests, 0 skipped |
| `node scripts/test-issuer-cli.mjs` | 12 compiled CLI cases passed, inert ports |
| `npm run test:sdk-cli-lifecycle` | 6 compiled lifecycle cases passed, fake deployment |
| Standalone strict TypeScript on all six issuer/conditional/composition test files | pass |

Root totals include the adopted boundary regressions. Independent reruns are evidence from another check, not extra cases to add to these totals. The skipped browser tests are not live/Windows proof.

## Composition and review corrections

- Six B1 code/test files preserve the separately reviewed fresh-bootstrap v2 bytes. Its guide has one grammar clarification only
- The PR15 usage/controller/browser/UI/notification code is unchanged except the intentional `cli/bus.ts` overlap
- That overlap preserves counter attachment/refresh and closes the owned counter before the same deployment. Nested `finally` attempts deployment cleanup even when counter cleanup fails
- The entire registered issuer CLI boundary, including loader, input and cleanup errors, applies a finite diagnostic allowlist. Diagnostic accessors are captured once inside a catch guard
- Strict signed metadata requires actual string enum values; array-to-string coercion is rejected
- Atomic preparation/history checks run again on every Git CAS retry snapshot. A legacy request or a different preparation cannot be retrofitted to an existing UUID
- No TaskSpec, ResultSpec, issued-message, response-frame, SDK family, package or lockfile bytes were changed by this extension

The browser renderer build pin remains `feedc4b5b2f834dbd540a3d3d55b74a3becbeca148cd43e0ee8f8f443f0fdca6`. It is not automatically registered or enabled by these tests.

## Boundaries still requiring work/evidence

I1 provides the configured local CLI facade and host-scoped signing integration. Actual provider tool registration/connection and provider-session origin attestation are not supplied by an installed CLI. B1 provides fresh-run advisory extraction; actual resumed-session/context-loss detection remains separate.

General native enforcement, Windows ACL/IPC and native credential-provider wiring remain missing or uncertified. Actual ordinary-Chat and actual CLI end-to-end roundtrips remain required for the final milestone. See [coverage](COVERAGE.md), [issuer test procedure](ISSUER-TESTING.md) and [platform gaps](PLATFORM-GAPS.md).
