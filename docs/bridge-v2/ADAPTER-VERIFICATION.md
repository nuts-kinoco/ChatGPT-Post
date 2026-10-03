# Adapter verification evidence (intermediate)

This is portable implementation evidence, not a live model, Windows confinement, authentication,
or end-to-end delivery certification. The final milestone still requires real CLI **and** ordinary
Chat request/result/artifact/materialization/ACK evidence at one reviewed commit.

## Reproducible checkpoint

- Base stack: PR1 `b2ceb37ba15973b2ebaec39aa06dce6225677593`; PR2
  `a6a32027d8f6527e144c6902c3b23b9d1d5d3c56` in `nuts-kinoco/ChatGPT-Post`
- Linux, Node `v24.19.0`, npm `11.9.0`; no Windows or real model process invoked
- Command: `node scripts/verify-bridge-v2.mjs --output <NEW_DIRECTORY>`
- Started `2026-10-03T07:53:45.045Z`; finished `2026-10-03T07:54:06.083Z`
- Root and GUI: typecheck, lint and build all passed
- Root: 825 passed, 56 inherited browser-fixture skips; GUI: 51 passed, zero skips
- The skips are **not** successful tests: Chromium's fixture launch and Unix sockets are blocked by
  this cloud environment (`socket() EPERM`). No flags/security changes bypassed this restriction
- [Machine-readable report](evidence/pr3-portable-checkpoint-20261003.json) records each command,
  start/end, exit code and skip count. Its local git HEAD identifies the historical materialized
  checkout and is explicitly dirty, not the PR publication SHA
- Exact 241-file checkpoint manifest SHA-256:
  `faebf115376f024069385f1e4de35fc1b1873998ca16f5ec743eb9dc6531134d`

The subsequent registry-ancestor/listing hardening and output-contract integration require a new
final verification run. Do not use the earlier count as evidence for those later bytes.

## What is actually tested

Fake GitHub transport runs real production request/blob/tree/ref logic with fake network, exact
hashes, signatures, immutable paths, conflict/lost-response reconciliation and bounded queues.
Synthetic executor/browser ports cover duplicate ownership, one-start intent, cancellation,
timeout/unknown/crash, scope denial, out-of-order events, framing, independent fanout completion,
quota races, trusted deployment loading and lifecycle cleanup. Registry tests exercise immutable
historical revisions, CAS, durable reopen and identity-reassignment denial.

Receiver-proof tests reject absent manifest/proof, wrong actor/event/run/hash/manifest/artifact set,
synthetic-scope substitution and historical payload-only ACK. Proof and ACK publication is one
immutable Git batch. A test fixture signer/materializer is deliberately synthetic; it does not
claim real artifact availability or durable delivery on another computer.

Production requester materialization must use the concrete archive/CAS/source verifiers, not a
no-op acceptance callback. Missing required bytes remain delivery_pending. The local UI disables
real ACK when no trusted materializer is configured. Synthetic demo ACK remains explicitly
simulated and cannot satisfy a real workflow dependency.

## Unverified and missing components

See [PLATFORM-GAPS](PLATFORM-GAPS.md) for **missing native implementation** versus tests requiring
Windows. No enforcing OS supervisor is available; a fixed CLI argv or provider sandbox flag is
not an OS containment proof. Windows ACL/pipe/confinement, native broker binding and real process
lifecycle evidence remain gates. Provider auth and model inference, real GitHub job publication,
ordinary Chat source extraction and artifact access have not been exercised live.

The output-contract amendment, archive-2 requester materializer, unified operations UI and AGY
integration have separate implementation/review evidence. Do not imply the earlier checkpoint
already contains all follow-ons. Use [COVERAGE](COVERAGE.md) and [TESTING](TESTING.md) for acceptance
roles, bounded recovery and the required return report.

## Corrected receiver-proof and bounded output-policy checkpoint

- Started `2026-10-03T08:23:05.194Z`; finished `2026-10-03T08:23:25.840Z`
- Root **995 passed, 56 inherited browser skips**; GUI **51 passed, no skips**
- Both projects typecheck/lint/build passed; all 8 independent regression cases passed
- Exact 251-file source checkpoint manifest SHA-256: `774ac57870750f4518c1b6d874b7999eba42f3af8e5e32eb460a38c39121d8e9`
- [Machine-readable corrected checkpoint report](evidence/pr3-proof-policy-fixed-20261003.json)

The four independently reproduced findings were fixed and regression-tested: unrelated/wrong-task
pre-start events, historical ACK summary overstatement, loss of fan-in availability when only ACK
is insufficient, and a credential provider stalling before the HTTP timeout. Timeouts now encompass
credential acquisition, HTTP and body consumption and ignore late credentials without fetching.

The bounded output amendment in this checkpoint includes strict raw contract hashing/versioned
atomic issuance, recipient-owned preclaim/admission/start scope checks, fixed contract-aware prompt
and stale-preview/signing-race rejection. It does not yet include the archive2/source-proof2/actual
requester sink composition. Real materialization remains disabled unless the concrete trusted port
is supplied; no payload-only acceptance fallback exists. Independent fixed-tree review passed against that exact manifest: all 251 hashes were unchanged,
995 root tests plus 51 GUI tests passed with the disclosed 56 fixture skips, and the original
reviewer's 8 adversarial tests passed independently. The verdict covers these fixes and bounded
admission gate only; it does not certify the pending archive/source materializer composition.

## Final signer-bound correction

Injected signing callbacks now have a validated 1–30,000 ms deadline (default 5,000 ms). A timed-out encode rejects permanently; a later signature cannot trigger publication. Six regression cases cover timeout/late resolution and invalid limits.

Final aggregate run: root **1001 passed, 56 inherited browser skips**; GUI **51 passed, zero skips**; both typecheck/lint/build passed. [Final command report](evidence/pr3-signer-final-20261003.json) records exact start/end and exit codes. No model, account, Windows process or live job was invoked.
