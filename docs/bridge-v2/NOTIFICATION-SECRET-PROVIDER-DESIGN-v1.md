# Notification credential provider: design v1

Date: 2026-10-03. Status: **DESIGN ONLY; implementation awaits independent PASS**.

## 1. Scope and evidence

Base: published PR [#16](https://github.com/nuts-kinoco/ChatGPT-Post/pull/16), head `2fb094088e5c31ff4b164903e1b560a1ed689572`. The 476-file immutable source inventory has SHA-256 `b25ec6391964c26a0a00242c24e5bf494600789aea1055537355fb43057b5253`; the publication inventory contains 569 files. Implementation will produce an allowlisted delta in this new checkout; publication must retain all remote-only assets and both packages/lockfiles byte-for-byte. The publisher owns remote integration. No native R3 artifact/code was inspected or executed.

Deliver a concrete host registry, encrypted-record repository, human-action coordinator, lazy Electron cipher, separate local credential window, and actual GUI/server composition. Verification is exclusively synthetic and injected: no native secret calls, credentials, keys, login, live delivery, paid/model tasks, OS permission changes, Windows execution, or R3 work.

Security assumptions: trusted main-process host and installed code, trusted actor assignment and registration policy, verified private POSIX storage, and eventually an approved OS secret store. This is local at-rest protection plus application authority checks; it is not a sandbox or protection from a compromised host/same-user malware. Whole-database malicious rollback is not solved by revision numbers or encryption. Clearing JS references is not secure erasure.

## 2. Verified existing seams and proposed files

| Existing seam | Change |
|---|---|
| `src/ui/notification-runtime.ts` interfaces at 22–54; actions 734–852; `status`, `close` | Replace human-wait use of `bounded()` with durable admission and an atomic completion session. Keep transport deadlines and final send-authority gates. Add cancel and owner-restart reconciliation. |
| `src/ui/notification-preferences.ts` `openNotificationPreferencesStore`, `withRuntimeTransaction` | Preserve the Windows rejection and verified opening path. Supply a host-private verified-storage capability and small transaction/read interface; never accept a renderer path. |
| `src/ui/notification-settings.ts` `credentials`, `actionStatus`, `safeControls` | Forward metadata-only admission/cancel/status; rebuild the expanded safe credential state. |
| `src/ui/server.ts` options 47–64, deployment 215–249, composition 366–415, routes 494–499/606–619, startup 806–810 | Accept a trusted native-provider factory; call it only after actor and verified store resolution; install the resulting runtime as the catalogue. Own one shutdown path. Add metadata-only cancel/recovery reads. |
| `src/ui/public/notification-view.js`, `index.html` | Pending-state polling, cancel, reopening/reload reconciliation; no credential input. Preserve separate preferences Save and Test Send. |
| `src/adapters/notification-transports.ts` `readWebhook`/`resolveSender` | Reuse existing transports through memory-only prepared leases. Never decrypt here. |
| `gui/src/main/product-ui.ts` `startProductUi`; `main.ts` `ensureProductServer` and shutdown | Pass an actual lazy native factory through `startUiServer`; bind lock/suspend/quit teardown. |
| `gui/src/main/product-preload.cts` | **Unchanged, secret-free, cosmetic-only.** |

New root modules: `src/ui/notification-secret-store.ts` (bounded encrypted repository and identities), `notification-credential-actions.ts` (admission/completion/recovery transaction coordinator), `notification-secret-provider.ts` (registry, consent, leases, composition contract), and `notification-private-state.ts` (small shared verifier/sole-writer helper, retaining unsupported Windows).

New GUI modules: `notification-safe-storage.ts` (injected synchronous cipher facade), `notification-credential-controller.ts` (pure lifecycle/IPC predicate logic), `notification-credential-window.ts` (Electron window adapter), `notification-credential-page.ts` (fixed packaged HTML/JS/CSS resources), and `notification-credential-preload.cts` (narrow IPC). Existing TS compilation can emit these; no dependency, build-script, package, or lock change is planned.

## 3. First registration, rotation, and send authority

The distributable GUI factory provides one **empty Discord destination slot** for the fixed authenticated local actor, with a host-owned ID and safe label. It contains no webhook or assumed recipient. Deployment configuration may provide a bounded explicit slot catalogue and stricter send policy; the HTTP client cannot create slots, actors, recipients, policies, paths, or sender callbacks. Demo never receives the real native factory. CLI has no native dialog factory by default.

First setup uses the trusted local window. The user pastes a webhook there, sees a separate confirmation of the canonical Discord webhook ID, the exact permitted notification data (fixed human-check text, request identifier, optional canonical ChatGPT conversation reference, and fixed test text), and the persistent local-storage purpose. An explicit unchecked consent control plus **Register and save** approves that target and these bounded use categories. An OS-store initialization/unlock warning is shown before submission. The first committed registration stores the target and consent receipt. No network lookup is needed or performed. The token-bearing URL is never displayed back or placed in diagnostics; the target ID is visible only in this trusted setup window.

This is first target approval, not automatic-send activation: preferences remain OFF; no test is scheduled; a later explicit preferences Save enables recurring human-check notifications, and Test Send independently authorizes one test. The concrete `authorizeSend` requires the current target/consent receipt and permitted category plus any stricter trusted deployment policy; the existing runtime still checks its exact preference revision/digest or one-shot action, immutable binding generation, rate/outbox state, and final synchronous authority before effect. Installing a factory or storing ciphertext alone grants no sending authority.

After first setup, replacement accepts only the exact canonical webhook ID already approved. A different URL token with that same ID is a credential rotation. A different ID is rejected with a fixed `notification_retarget_requires_registration` code and changes nothing. This slice does **not** implement retargeting or recipient deletion: a future separate native registration flow must obtain explicit new-target consent, allocate a new registration identity/destination ID, retire the former generation, cancel old queues, and require fresh OFF-to-ON preferences/test authority. A source edit or hardcoded webhook is not needed for first setup.

Email slots require a separately configured trusted sender factory already pinned to a recipient and a bounded credential schema/validator. This slice provides the generic opaque credential lease port and storage/controller plumbing; it supplies no SMTP implementation, server, auth scheme, recipient discovery, or default Email slot. Without that sender configuration, Email is unavailable and its credential-entry action is unavailable. A stored API key does not create an Email transport.

## 4. Identity and storage decision

Use a **separate logical provider repository in the same verified SQLite database** as notification preferences/runtime. This deliberate physical co-location makes ciphertext replacement, generation CAS, action receipt, and runtime binding transition one SQLite transaction. There is no cross-database two-phase protocol and no plaintext credential in any SQLite table, journal, WAL, preferences document, outbox, action view, or log. A separate physical secret database would require another reviewed crash-reconciliation protocol and is not this design.

New versioned tables hold:

- Provider identity: schema version, random store incarnation, verified runtime scope, profile, owner principal, and revision high-water mark
- Slots: actor, destination, channel, safe label, immutable registration ID, approved target digest/host-private target identity, consent receipt/version, generation, binding revision, activation time, and registration state
- Cipher record: fixed format `bridge-notification-secret-1`, cipher kind, ciphertext bytes, exact profile/scope/store/actor/destination/registration/generation/revision identities, and bounded checksum for accidental-corruption detection
- Human sessions: actor/action ID/fingerprint, exact slot/old generation+revision, preference revision+digest, owner incarnation, admission/deadline times, terminal state and committed new generation/revision receipt

The encrypted plaintext is a strict bounded object containing the same full identity tuple, channel, approved target identity, consent identity, and credential value. Following decryption, every inner field must match the outer row and current approved registration. This detects ciphertext substitution across records without pretending safeStorage supports caller-provided AAD. Hashes/checksums are not authentication against a malicious local writer. Ciphertext is at most 32 KiB; plaintext at most 8 KiB; strings and schemas reject duplicate/unknown keys, invalid UTF-8, unexpected controls, overflow and noncanonical identity fields. Up to 64 destinations per actor, 256 actors, and 5,000 durable action rows follow bounded fail-closed capacity behavior; no automatic pruning that allows old action-ID replay.

Fresh empty slots have generation UUID/revision 1 and no credential. Every successful register, replace, or explicit unlock produces a new UUID, strictly greater safe-integer revision, and nonregressing activation time. Unlock deliberately re-seals the same secret under the new inner identity; it therefore has the same durable rotation semantics as Save. Revisions are never inferred from client input. Exhaustion, unknown schema, bad record, incomplete migration, or time regression yields unavailable.

The opener, never a direct `NotificationPreferencesStore` constructor, supplies the private-state capability. Verify canonical directory, ownership/modes, non-symlink/non-hardlinked regular DB, and all existing SQLite sidecars before opening/using the provider. Newly created private files use existing 0700/0600 conventions; do not repair permissions on existing paths. Preserve fail-closed errors. On Windows reject before constructing any provider/runtime store; neither injected runtime nor the GUI factory bypasses this production gate.

A dedicated verified `notification-provider-owner.db` holds a lifetime SQLite `BEGIN EXCLUSIVE` lock in DELETE-journal mode with zero busy timeout, plus an in-process scope guard. It carries no secret and is separate from normal data transactions. A second provider for the same canonical store fails unavailable. SQLite/OS releases ownership after process death; no stale-lock unlink, PID guessing, lock stealing, or source fallback. Validate this lock/sidecars too. Keep the lock until all sessions, leases and runtime work are fenced. Existing preferences writers remain possible, but every credential commit rechecks their current preference revision/digest inside the common transaction.

## 5. Registry and asynchronous action contract

`isCurrent(actor,destination,generation,revision)` synchronously reads the verified authoritative row in the host transaction domain, not a refreshable metadata cache. It is false while retiring/pending/unavailable. `list` reads metadata and in-memory lease availability only. `prepare` only accesses an already-unlocked lease; it never calls native availability/decrypt/encrypt or opens a dialog. Both are safe for background execution.

The host-only credential port keeps the method name `beginCredentialInteraction`, but takes a v2 immutable session:

- actor/destination/action, expected registration+generation+revision, preference fence, owner, deadline, AbortSignal
- `isActive()` and `complete(outcome, preparedRotation?)` capabilities owned by the runtime/coordinator
- A prepared rotation is a trusted in-process opaque object containing validated identity, bounded ciphertext, approved target/consent proof, and a revocable post-commit lease installer. No DB handle or callback crosses IPC or HTTP

`complete` is synchronous and one-shot. The coordinator validates the prepared rotation and atomically persists it with the action receipt and runtime binding transition. The concrete provider owns its creation; unsupported legacy providers cannot report `saved` without a valid committed receipt. Fakes implement the same v2 protocol. The runtime remains the durable action owner; native dialog code has no independent persistence or transport authority.

Credential POST still accepts exactly `{actionId,destinationId,expectedRevision}`. The runtime verifies actor/slot/current binding/preferences, persists the admitted session, marks the binding credential-pending, clears its prior lease/epoch, and cancels queued sends in one bounded admission sequence. Existing already-started external sends cannot be recalled and retain truthful uncertain/delivery tracking. The HTTP response returns `sending` promptly (202); the native window is opened in a later scheduled host turn, after HTTP admission response completion. OS calls never happen during admission or HTTP status. Same action/fingerprint returns the recorded state; conflicting ID reuse fails; another action for the pending slot fails without opening a second window.

There is a 10-minute human session limit, independent of the 5-second operation/transport deadline and 15-second HTTP client timer. The host uses monotonic elapsed time plus persisted wall-clock deadline and rejects clock regression. GET `/api/settings/notifications/actions/:uuid` remains a nonprompting status read. Add POST `/api/settings/notifications/credentials/cancel` with exact action ID only, scoped to authenticated actor, and GET `/api/settings/notifications/credentials/pending` returning a bounded list of public action views for reload recovery. Cancel has no recipient/credential fields and cannot cancel someone else's action.

## 6. Commit, failure, cancellation and crash ordering

1. Admission commits before any dialog. Mark pending and advance the in-memory lease epoch synchronously; old prepared closures are invalidated before native interaction.
2. The dedicated window collects consent/entry. A single verified Submit/Unlock may invoke the native cipher. No persistence transaction is held while waiting for the person or OS.
3. After each native call returns, recheck shutdown, owner/session identity, current deadline, abort/close, exact registration target, and preference fence. Never treat a JavaScript timer as native cancellation.
4. `complete(saved,candidate)` opens one `BEGIN IMMEDIATE` transaction. Recheck all guards and old generation/revision, strictly validate the candidate, replace ciphertext/metadata with CAS, record the terminal receipt, set the runtime binding to the new generation, and mark the public action saved. Commit all or roll back all. There is no await or native call inside this transaction.
5. Only after durable commit may a new memory lease be installed, provided the same session/host is still live. Read the committed receipt before publishing `saved`. If lease installation is unavailable, saved still accurately means encrypted data was stored, and controls show locked/unavailable. No send is scheduled by this path.
6. Cancel/close/expiry before the linearized commit marks terminal cancelled, aborts the session, destroys the window, drops entered values and leases, and makes later completion capabilities inert. Restore verified old metadata to a locked state; old queues stay cancelled. Invalid input/native denial is rejected with fixed codes; ambiguous persistence outcome is uncertain and unavailable. Do not reopen automatically.
7. Commit winning a cancel race remains saved; cancel returns that recorded terminal receipt. Cancel never claims to undo a committed save. A status read after a lost response reconciles to saved from the receipt and never resubmits.
8. Crash before commit leaves no replacement. At verified startup, foreign-owner pending sessions are changed to uncertain, pending bindings are reconciled to the still-verified stored identity but locked, and abandoned UI sessions are not resumed. Exact committed receipts remain saved. Old/unknown-schema legacy pending actions remain uncertain with unavailable bindings; no fabricated success or replay.
9. Shutdown first fences new admission and all lease epochs, aborts human sessions, detaches IPC handlers/windows, and persists cancellation/uncertainty where possible. Runtime shutdown finishes before its store and ownership lock close. Repeat close is idempotent. A late callback may neither write a closed store nor restore a lease.

The deadline is checked after synchronous native work returns. While Electron is blocked in an OS prompt, JS cannot process a timer, HTTP cancel, window event, or quit request. We must state this limitation in the local dialog. Only cancellation already observed by the host can win before commit; an unprocessed close/cancel event is not magically acknowledged. Native completion after expiry is rejected even if its timeout callback has not run. The OS prompt itself may have created/accessed a platform key before cancellation; this does not create a committed application credential.

## 7. Native storage and memory lease policy

The adapter accepts an injected `getSafeStorage()` and `isReady()` rather than importing/calling Electron during module evaluation. Its only operation that touches native APIs is explicit local register/replace/unlock after the trusted Submit action. It checks readiness, platform, encryption availability, and on Linux a secure backend allowlist: `gnome_libsecret`, `kwallet`, `kwallet5`, `kwallet6`. Reject `basic_text`, `unknown`, unrecognized or unavailable. Never call `setUsePlainTextEncryption`. No env-token import, keychain enumeration, file picker, migration scan or automatic secret import.

The Electron 39.8.10 API is synchronous. Promise wrappers only adapt the controller interface; they do not supply cancellation or keep the main thread responsive. There is no async-safeStorage/dependency upgrade in this slice.

A lease stores the current synthetic/real value only in host-private memory, bound to store/actor/destination/registration/generation/revision and a unique lease epoch. Maximum lifetime is 10 minutes from explicit unlock; both monotonic and wall checks apply, and ordinary list/prepare calls never renew it. The send wrapper rechecks exact lease epoch, expiry, registry identity and shutdown immediately before invoking the already-bound transport. Prepared closures do not retain an independent secret copy after the shared lease is cleared. Existing transport internals that already consumed a secret cannot be retroactively erased or recalled.

Restart always starts locked. Explicit Lock, rotation admission, suspend, host close, and supported lock-screen/session-inactive events clear leases. Electron 39 lock-screen events are macOS/Windows-only; Linux OS-store/screen locking is **not automatically observable here**, so there is no claim that locking the Linux desktop/keyring immediately clears memory. Linux uses manual Lock, suspend where delivered, and the 10-minute expiry; an OS-store relock is not probed in background. Resume/unlock-screen never auto-unlocks. UI wording states this bounded-session behavior. JS strings cannot promise secure erasure.

## 8. Trusted local window and narrow IPC

Use a distinct `bridge-notification-credential://dialog/index.html` packaged resource origin in a new nonpersistent per-session partition. Register its scheme before app-ready. Serve exactly the three fixed page/script/style resources from compiled local constants; no arbitrary pathname resolution, dev server, remote resource, query, or fragment. The page's safe text is populated via textContent. It never receives an existing credential. The product's loopback origin cannot access this partition or its API.

Window configuration explicitly sets contextIsolation/sandbox/webSecurity true; nodeIntegration/nodeIntegrationInWorker false; devTools/spellcheck false. Deny permissions, downloads, popups, external requests, navigation/redirects/subframes and webviews; close on renderer crash or unexpected committed/in-page navigation. CSP permits only the fixed local script/style, with connect/form/frame/object/base sources disabled. There is no generic `ipcRenderer`, shell, file, clipboard, URL-fetch or decrypt bridge.

The dedicated preload exposes only `view()`, one `submit({mode,secret?,consent?})`, and `cancel()`. Main binds exact WebContents object + mainFrame object + exact packaged URL + live session. The renderer cannot select actor/action/destination/path; main resolves them from the live window map. Reject extra keys, oversized values, wrong channel/frame/sender, replay, expired sessions, and invalid mode transitions. Repeated submit is inert after its first accepted attempt; failed validation returns a fixed generic rejection and never echoes input. Cancel/close clear the input and destroy the renderer. First registration, same-target replacement and existing-secret unlock have separate explicit controls; existing secrets are never read back into the form.

The window is a packaged trusted application form rather than Electron's `dialog` API, which has no generic password-input control. OS prompts and the user-operated real entry are separate live approval gates, not exercised by this implementation task.

## 9. GUI composition and ownership

Add a host-only `notificationProviderFactory` option to `UiServerOptions` and the structural `ProductUiOptions` interface. It receives the already-verified preferences capability, fixed authenticated actor, profile, and bounded trusted slot/send configuration after `openUiService` and preferences opening. It returns `{runtime, close, lock}` using that exact store. Conflicting prebuilt runtime/catalogue/provider configuration fails closed; no silent precedence or duplicate ownership.

`startProductUi` forwards a factory built by main from the new window/cipher adapters. The factory lazily imports only the selected checkout's `dist/ui/notification-secret-provider.js`; root modules never import Electron. `startUiServer` installs its returned runtime into `UiNotificationSettings`, attaches existing lifecycle sources, and starts only after successful reconciliation. Default production can expose an empty slot/metadata with zero native calls; registration, save and unlock remain explicit and notifications stay OFF. Demo omits the native factory entirely. Unsupported storage leaves the existing explanatory settings view; no direct-store fallback.

The server owns provider shutdown before preferences close and returns a narrow host-only lock method for main's explicit lock/OS lifecycle hooks. `createProductShutdown` remains the sole app-quit coordinator. Factory failure, listen failure, repeated start/close, host quit and partial construction dispose only resources they own. Prebuilt deployment runtimes continue their existing path but cannot be combined with this factory.

## 10. Product UI reconciliation

The normal renderer shows missing/locked/configured/unavailable metadata; extend safe controls with a bounded `locked` credential state and fixed reason codes, rather than exposing provider errors. Only configured active leases enable Test Send. Save preferences does not open local setup, unlock, test or send.

After 202 admission, poll the same action every second while the settings panel is open; only safe GETs repeat. A 15-second HTTP failure changes the display to unknown without resubmission. Cancel uses the action's immutable ID. Closing the ordinary settings panel pauses polling but does not cancel the separate native session; explicit Cancel or closing the native window does. Reopening first reads pending/terminal state before enabling another action. On renderer reload query the actor-scoped pending/recent credential-action read; never reopen the native window automatically. Terminal state stops polling. Delayed responses are fenced by view epoch and action identity; navigating/reopening cannot replace a newer action's result.

## 11. Migration

Use additive v1 provider/session tables with an explicit schema-version row. Existing preferences and action IDs remain unchanged, including OFF defaults. Never infer saved credentials or consent from old `notification_bindings` rows. Existing external registries do not become native stored destinations automatically. Unknown provider schemas or mismatched profile/scope/incarnation fail unavailable; no import or destructive repair.

For legacy pending credential actions lacking v1 session proof, retain an uncertain terminal result and mark the associated binding unavailable. New explicitly configured slots must not reuse an existing conflicting slot ID/registration or silently adopt its enabled preference. If a collision exists, fail closed and require a future explicit migration/registration operation. No retargeting, account migration, store relocation, backup restoration or deletion workflow is delivered by this slice.

## 12. Fake verification matrix and pass criteria

Tests import pure modules and use synthetic strings and an opaque **non-cryptographic fake cipher**. Do not import Electron's runtime or call real safeStorage; the adapter is tested against a method-counting fake. Fake transforms are test fixtures only and cannot be selected by production config. Network/sender/clock/window/IPC/lifecycle ports are injected fakes.

- Import/default production metadata/demo/CLI/status/list/prepare: zero native calls and no dialogs. Windows rejection precedes provider construction even when cipher fake reports available
- Readiness/backend denial, basic_text/unknown/unsupported platform, cipher throws/oversized/malformed results, wrong profile/store/actor/slot/registration/generation/revision, ciphertext swap, corrupt DB/sidecar/private path, unknown schema: unavailable without secret echo
- First empty-slot registration requires explicit target/storage/data consent; no source edits; same-ID token rotation passes; different-ID replacement rejects; empty/unbound Email stays unavailable
- Two owners, two concurrent actions, same-ID dedupe/conflict, stale preferences, current-generation CAS, activation regression, lease epoch invalidation, timeout before callback, cancellation at every await: no stale commit/send
- Atomic transaction fault injection at each statement/commit; restart before/after durable commit; reply loss; unknown commit result; malformed recovery receipt; foreign owner: only confirmed receipts produce saved, and no dialog/send is replayed
- Human pause beyond 5 and 15 seconds remains pending; 10-minute expiry, native-return-after-expiry, cancel-before-native, cancel-after-commit, queued cancellation during blocked fake native return, repeated close/quit: truthful terminal outcomes
- Wrong WebContents/frame/URL/mode/action/lifetime, extra/oversized IPC keys, double submit, remote navigation/download/popup/permission, renderer crash: denied and callback revoked
- End-to-end injected `startProductUi -> startUiServer -> factory -> settings/runtime`, same-store ownership, deployment conflict, missing sender, startup failure and idempotent shutdown: actual composition verified
- UI repeated-click/delayed POST/GET, reload/reopen recovery, hidden-panel polling pause, explicit Cancel, unchanged preference Save, Test Send still separate; raw synthetic secret absent from HTTP bodies/views/errors, renderer model, diagnostics and durable plaintext
- Lease expiry/restart/lock/suspend invalidates prepared fake sends; no background decrypt; no revival on resume; already-started send remains honestly accounted for

Planned checks after approved implementation: focused provider/controller/runtime/settings/view/GUI tests; root typecheck/build/lint and permitted offline test suites; GUI compile/typecheck/tests with Electron/window fakes; immutable package/lock comparisons and allowlisted delta inventory. The permitted suite must exclude native R3/live paths rather than running unreviewed aggregate launchers. No test is claimed run in this design phase.

## 13. Explicit remaining gates

Even after fake PASS: Windows private-state/ACL/reparse verifier remains missing code and keeps CLI and packaged GUI unavailable; no PC/Windows workaround. Retargeting/migration remains missing code. A concrete Email sender/provider configuration remains a separate implementation/configuration gate. Native packaged UI, signing/app identity, POSIX sidecar/ownership behavior in shipped environments, real OS encryption/restart/keychain denial, real secret entry, persistent native access consent, target/data authorization and one exact live test delivery remain unverified/approval-gated. R3 remains security-blocked and untouched.

Completion label: **concrete portable notification credential provider and GUI wiring complete against fakes; native activation/live delivery unverified; Windows storage unavailable**. Do not claim public notification delivery is ready merely because the provider was authored.

## Sources consulted

- Existing assessed source and notification-specific files listed above; [PR #16](https://github.com/nuts-kinoco/ChatGPT-Post/pull/16)
- [Electron 39.8.10 safeStorage](https://raw.githubusercontent.com/electron/electron/v39.8.10/docs/api/safe-storage.md): main-process synchronous operations, prompt blocking, availability and Linux backend values
- [Microsoft CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata): user/machine scope and local threat limitations
- [Electron 39.8.10 dialog](https://raw.githubusercontent.com/electron/electron/v39.8.10/docs/api/dialog.md) and [webContents](https://raw.githubusercontent.com/electron/electron/v39.8.10/docs/api/web-contents.md): native-dialog scope and frame/navigation boundaries
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security): isolation, sandboxing, origin/IPC validation, permissions, CSP
- [Electron 39.8.10 powerMonitor](https://raw.githubusercontent.com/electron/electron/v39.8.10/docs/api/power-monitor.md): suspend and platform-limited lock/session events
- [Apple Keychain access](https://support.apple.com/en-ae/guide/keychain-access/kyca1243/mac) and [Secret Service locking](https://specifications.freedesktop.org/secret-service/latest/unlocking.html): user-controlled access/unlock behavior

The Electron IPC tutorial endpoint failed to fetch; the design uses the retrieved official security/frame documentation and will verify the exact 39.8.10 type declarations during fake-only implementation review. No newer asynchronous safeStorage API is assumed.
