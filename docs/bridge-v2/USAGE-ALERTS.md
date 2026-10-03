# Ordinary-Chat usage and optional human-check alerts

This portable implementation extends the existing counter/settings. It activates no account,
recipient, credential provider, email sender or Discord webhook by itself. Fake transport tests
are not proof of live delivery. Windows private-storage verification and native secret capture
remain host deployment prerequisites.

## Usage counter

The default local UI opens the same OS-principal/runtime-root/browser-profile scoped observation
store as ordinary direct `run`, detached `submit`, `collect`, and the configured hosted browser.
An explicitly injected runtime must share that store. Custom hosts can use `openBridgeProCounter`
and attach their `BrowserDeliveryService`; the bus CLI does this for configured browser deployments.
Changing the browser profile cannot silently reinterpret an existing scoped store.

Only confirmed ordinary-Chat Pro submissions increment confirmed usage. A durable submit marker
carries an immutable attempt identity; a hosted inner browser uses its outer attempt. Creation,
Git transport retries, result replay, notification retry and ACK do not allocate counts. Direct
pre-submit authentication blocks have a separate run identity and do not count as submissions.
Replacing a counter store allocates a new projection generation and replays its exact durable
sources. Target-side projected sequence receipts detect older same-generation backups and keep
remaining unknown. Every proven-not-sent marker deletion persists the resolution first. Bounded
strict evidence readers preserve unknown when recovery evidence is missing, oversized or invalid;
recovery never re-submits a model request. These are process-crash checks, not power-loss proof.

Unknown accepted sends remain possible. Confirmed qualification requires explicit observed Pro
and a supported concrete observed model without a contradictory model/slug. A requested preset,
unknown/latest alias, historical unbound marker or incomplete scan cannot prove confirmed usage.

The UI exposes confirmed/possible counts, coverage gaps, observation scope and manual reference
settings. Cap, warning threshold and start/end are unset until configured. Asia/Tokyo is a draft
presentation default; no weekly cap or reset instant is inferred. Configure explicit UTC bounds
and an IANA timezone. A red warning means the conservative remaining reference reaches the chosen
threshold; it is never an account-global or authenticated provider quota. An expired window,
coverage gap or pending source scan suppresses remaining estimates. Window changes do not move
historical observations. Other-device/manual usage is outside observation coverage.

## Notification behavior

Each authenticated actor starts OFF with no selected destination. Settings list only registered
email/Discord destinations authorized for that actor. Saving preferences does not send a test.
The explicit Test Send action sends fixed test copy even while automatic alerts are OFF, without
enabling automatic alerts. A secure setup action opens the registered native credential provider;
that provider owns confirmation, direct secret entry and save. The web UI accepts no address,
webhook URL or credential and displays only fixed masked status.

Automatic alerts consume durable ordinary-Chat AUTH_REQUIRED/CAPTCHA_OR_CHALLENGE observations.
They contain fixed human-check copy, a bounded request identifier, and optionally a canonical
`https://chatgpt.com/c/<id>` reference. Task/output text and provider error bodies are excluded.
A project-style or otherwise unsupported link is omitted. The alert does not grant an execution
permission, retry a model request or acknowledge any result.

The request identity and immutable attempt/run category dedupe survive restart, including replacement
of a source-journal identity. An alert source event must
have occurred strictly after the current preference-save time, and not in the future; replay never
substitutes a new timestamp. The event must also be newer than the immutable activation time of the selected
binding version. Events seen while OFF are suppressed durably. Re-enabling does not
flush prior events. Any preference revision, recipient change or credential rotation cancels old
queued work. An in-flight send may have an uncertain outcome and cannot be unsent.

Default limits are one attempt per actor/destination per minute and three per hour, including tests
and uncertain effects. A verified-not-sent retryable result allows at most three total attempts
(initial plus two retries). Throws, timeout, cancellation, redirects and ambiguous acceptance are
uncertain and never automatically retried. The exact binding generation and monotonic registration
revision are pinned on each queue row and checked after preparation in the same SQLite transaction as preference/rate/owner
claim, immediately before invoking the bound transport. Concurrent processes cannot reclaim a
sending row. Preference enables and send claims share one persisted clock high-water gate; rollback fails
closed before enabling can commit. Turning OFF preserves the high-water boundary and remains possible. Bounded outbox/dedupe storage fails closed when full;
there is no automatic pruning that could permit replay duplicates.

Delivery status `delivered` means the configured transport reported acceptance. It does not prove
that a person read the message, that an email reached the inbox, or that task delivery/ACK completed.
Lost action responses can be checked with the same action ID; changed inputs with that ID reject.
Unknown credential interactions are never reopened automatically.

## Trusted deployment composition

The host supplies a `NotificationRuntime` alongside the UI deployment. Use a private
`NotificationPreferencesStore` from `openNotificationPreferencesStore`, the same instance passed
to the runtime and UI. `notificationRuntime` supplies its own read-only destination catalogue.
The UI server attaches its shared direct usage journal and configured hosted browser journal,
then ticks the optional runtime. With no runtime, preference storage remains available but sending,
native setup and Test Send remain unavailable. Merely importing modules performs no network I/O.

`SecureNotificationRegistry.list(actor, signal)` returns only that actor's registered bindings:
- destination ID, safe label, channel and fixed credential state
- immutable generation, monotonically increasing revision and original activatedAt for the recipient/credential pair
- asynchronous prepare returning the generation/revision of the SAME secret lease and a prepared
  one-shot transport; a changed/stale lease is rejected before effect

`SecureNotificationRegistry.isCurrent(actor, destination, generation, revision)` is a required
synchronous authoritative gate. It must turn false before that binding is retired. The runtime
re-reads registration after asynchronous preparation, then calls this gate after all other host
checks in the final transaction. A host unable to establish exact current binding cannot enable
sending. Native cancellation/rejection reconciliation never restores a lower binding revision.

No HTTP body may supply a registry, actor, recipient, generation, secret reference or transport.
`beginCredentialInteraction` receives only the bound actor/destination/action ID and abort signal;
it returns a bounded status. `authorizeSend` is a synchronous host gate representing already
approved destination/data category and recurring or explicit-test authority. It has no permissive
default. Credential save invalidates pending work before native interaction and never enables alerts.
Actual account or recurring-message authorization must exist before configuring these host ports.

The Discord adapter accepts only exact HTTPS discord.com webhook routes, uses a dedicated
proxy-free HTTPS agent, validates public DNS answers and pins them into the connection, keeps
normal TLS hostname/certificate validation, rejects redirects and bounds total time/output. It
emits fixed text with mentions disabled. The email adapter wraps a prebound approved sender,
without accepting a raw recipient or arbitrary SMTP/HTTP host. Both helpers retain one total
monotonic deadline across preparation and send and have no automatic transport retries.

Each lifecycle source durably seals its notification namespace to one target store and direct-actor
mapping before consumption. The target identity includes its canonical local path/principal/profile
and a persistent random generation. Another store, copied path, profile or actor cannot steal the
cursor; a replaced store and an already-consumed legacy cursor without a seal fail closed. Reopening
the same sealed store resumes. Preserve the matched source and notification records. These checks
and tests cover process crashes/restart/replacement; they do not certify arbitrary whole-database
backup rollback or power-loss recovery of historical delivery status.

Shutdown first stops/fences notification effects and drains owned source consumers, then closes
counter/browser sources and preference storage. Unsettled effects are durably uncertain and late
callbacks cannot write into a released store. Hiding the UI does not change this host lifecycle.

## Offline verification

Run root build/typecheck/lint/tests and the GUI equivalents. Focused files include
`notification-transports.test.ts`, `notification-runtime.test.ts`,
`ui-usage-alert-integration.test.ts`, `ui-notification-controls.test.ts`,
`ui-pro-counter-runtime.test.ts`, direct controller and browser-delivery tests. They use fake
browser/email/HTTPS/native providers with real local persistence and loopback HTTP where applicable.
Live notification delivery, native keychain capture and Windows behavior are separate gates.
