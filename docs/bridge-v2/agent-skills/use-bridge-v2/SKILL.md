---
name: use-bridge-v2
description: Prepare, validate, or reconcile Bridge v2 tasks in this repository. Use for Bridge TaskSpec, request UUID/hash, delivery receipt, resultACK, or unknown-outcome work; not ordinary coding or unrelated chat.
---

Use the checkout's current `docs/bridge-v2/USAGE.md` and `SESSION-BOOTSTRAP.md` under that same
directory when details are needed. Start with `task capabilities`, then `task schema task` and
`task schema result`; run the repository CLI rather than guessing schema fields or installed capabilities.

Generate and validate exact-byte task JSON. Preserve request UUID, immutable TaskSpec/task-file
bytes and hashes, registered IDs, and the configured delivery route. Distinguish receiptACK,
startReceipt, terminal result and resultACK. Verify durable result/artifact identity and hashes
before acknowledging the exact payload hash.

Return producer answers inside the exact frame supplied by Bridge, bound to request UUID,
task hash and attempt UUID. Framing is transport only. Ordinary Chat evidence remains
`hosted-response-1`; do not invent local process identity or execution success.

On timeout, disconnect, lost ACK or unknown outcome, inspect the original identity and receipts.
Never automatically reexecute, mint a replacement UUID or silently switch model/billing route.
A new model session needs the short current-version bootstrap; only a trusted matching retained
session receipt permits reuse. Version change or possible context loss requires reconfirmation.
This skill and bootstrap never grant execution, publication, authentication or policy authority.
