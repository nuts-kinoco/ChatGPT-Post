# Local notification credentials

## What this implementation provides

The standard packaged GUI can compose a notification-only credential registry and a separate trusted local setup window. It stores encrypted records in the verified notification SQLite store and keeps usable credentials in a revocable, time-bounded main-process session. The ordinary product page and its cosmetic preload never receive a credential.

The implementation is verified with synthetic strings, an opaque non-cryptographic fake cipher, fake windows/IPC, and fake DNS/HTTPS/sender ports. Real Electron storage, OS prompts, packaged behavior, native credential entry and live delivery are separate approval/verification gates. No real native secret calls or deliveries were needed for the tests.

## First Discord setup

1. Open notification settings and select the empty Personal Discord slot
2. Choose secure local setup. The ordinary page immediately reports a pending action; entry occurs in a separate local window
3. Enter the webhook in that local window, verify the displayed numeric webhook ID and the fixed notification-data/storage disclosure, and explicitly consent to register the target
4. Register and save stores the credential only. Automatic notifications stay OFF. Preferences Save and one-time Test Send are separate explicit controls

A saved registration is pinned to its webhook ID. Replacing the token for that same ID creates a fresh generation and cancels queued work from the old one. A different webhook ID is rejected. Retargeting/deletion/migration needs a future separate reviewed flow and cannot inherit the old enabled preference or queued send authority.

Email requires a separately configured provider, credential validator and sender already bound to one approved recipient. The application does not invent an SMTP server, recipient, authentication scheme or Email transport. No default Email slot is created.

## Unlock, Lock and cancellation

Human entry has its own ten-minute deadline, so it does not inherit the five-second operation or fifteen-second HTTP timer. A lost response is reconciled through the durable action status/recent receipts; no form or send is automatically replayed. Cancel in settings or closing the native entry window cancels an uncommitted action. Closing the ordinary settings panel only hides that panel.

An explicit unlock re-seals the stored credential under a fresh generation. The native window displays the configured unlocked-session duration: eight hours by default, bounded by the host to one minute through twenty-four hours. There is no sliding renewal or background OS prompt. A changed configuration cannot extend a lease that was already issued.

The main tray/menu item **Lock notification credentials** drops current leases and revokes pending installers before cancelling work. Observed suspend/lock/session-inactive/shutdown events do the same. Restart always starts locked. Resume never unlocks automatically. Electron 39 does not supply a Linux lock-screen event here, so Linux desktop/keyring locking is not claimed to immediately clear a memory lease: use explicit Lock and the displayed finite duration.

Electron 39.8.10 storage APIs are synchronous. macOS/Linux OS prompts can block the main thread, including status/cancel/quit handling. A Promise timeout does not cancel such a native call. A completion returning after expiry is rejected; an event still queued while the main thread is blocked has not yet been acknowledged. Dropping JS references does not guarantee memory erasure. An already-started outbound request cannot be recalled with certainty.

## Host composition and platform limits

The standard GUI without a custom deployment supplies a lazy native fallback. Existing prebuilt notification runtime/catalogue/preferences ports retain their external path; the fallback is not called. Custom deployments without notification configuration stay disabled unless they explicitly choose native mode. Demo omits the native factory; CLI has no native setup window by default. Missing actors, unverified state, an unsupported backend or malformed records remain unavailable.

Linux requires a recognized secure backend; basic_text, unknown and unavailable storage are rejected. There is no plaintext fallback, credential environment import, keychain scan or automatic secret migration.

**Windows notification storage remains unavailable** because ownership/ACL/reparse/private-state verification is missing. Encryption/DPAPI and packaging do not supply that verifier. The monitor GUI and unrelated features can still start and show a notification-unavailable explanation. This implementation does not include Windows execution or native confinement work.

## Fake verification

Provider tests cover opaque ciphertext persistence, atomic generation/action CAS, first-target consent, target-pinned rotation, record substitution, private storage/sole ownership, no startup native calls, saved-response loss, restart locked, lease expiry, Lock during completion, and exceptions whose messages/getters contain synthetic secrets. Runtime/UI tests cover exact v2 protocol admission, zero legacy callback invocation, deferred native-window opening after HTTP admission, cancellation/recovery, and separate Save/Test controls. GUI tests use injected Electron-shaped ports, not Electron startup.

Secret-free outer prepared transports resolve their scoped lease only inside an admitted send. After asynchronous inner DNS/sender preparation, a synchronous final guard rechecks the exact claimed outbox owner/attempt/content, preference revision/digest, generation, target consent, lease epoch and original deadline immediately before effect. Lock revokes prepared/active handles. Temporary token-bearing strings inside an already-admitted inner operation may remain until settlement and garbage collection; no secure-erasure guarantee is made.
