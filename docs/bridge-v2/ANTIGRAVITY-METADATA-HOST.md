# Antigravity metadata in the running Bridge UI

A production Bridge UI can now construct, schedule, persist and display the reviewed Antigravity metadata probe. This closes the previous gap where the probe and cache existed only as libraries. It does not implement authenticated model-list parsing or task execution.

## First startup

This host currently supports the reviewed Linux CLI 1.2.15 installation only. Windows cannot pass its Linux binary/private-storage checks and remains unavailable. A native Windows verifier and execution supervisor are separate work.

Create a trusted local JSON configuration, owned by the host user, beneath directories that other users cannot write. Replace every example installation value with the exact registered physical binary, SHA-256 and owner UID. The path must not be a symlink. There are no prompt, arbitrary argv, environment, credentials, login or alternate cache-path fields.

```json
{
  "version": "bridge-antigravity-metadata-config-1",
  "enabled": true,
  "backgroundRefresh": true,
  "contextId": "my-isolated-agy-metadata",
  "installation": {
    "executable": "/absolute/path/to/agy",
    "expectedSha256": "REPLACE_WITH_THE_REGISTERED_64_LOWERCASE_HEX_DIGEST",
    "ownerUid": 1000
  }
}
```

After building the project, start the existing product UI with this explicit option:

```sh
node dist/cli/main.js ui --antigravity-metadata /absolute/trusted/metadata.json
```

An already trusted deployment can instead export the same `antigravityMetadata` configuration. Supplying both is rejected. The config cannot be created or changed over HTTP. Missing/disabled configuration or demo mode launches no metadata process.

Open the printed private UI URL, then **接続・登録 → Antigravityのモデル確認**. Startup admits one discovery cycle. On a new registration that cycle can run the fixed version, help and models commands. All commands use the existing bounded fd-bound process host, stdin closed, a private empty HOME/cwd and a minimal environment. A warm verified cache reuses the saved version/help capability observation and does not probe again before it is due.

The empty-HOME context has no inherited user credentials. If it encounters authentication, the panel says this isolated environment could not list models. It does not say the user's ordinary Antigravity account is signed out. The UI neither logs in nor switches contexts. Account availability, price and per-model effort remain unknown. Successful models text is still an unverified format: no guessed labels or provider IDs become execution options.

## Read, refresh and shutdown

- **記録を再読込** reads cached state only. Page navigation and GET `/api/provider-catalog` do not launch a probe
- **メタデータを確認** requests one bounded metadata cycle through the protected POST endpoint. Cooldown, ownership and auth-latch checks still apply; repeated clicks coalesce
- Background refresh is an explicit configuration opt-in and runs only while the host is active. The default interval and TTL are 24 hours. These metadata calls are distinct from model inference; no absolute zero-quota promise is made
- An auth failure is durably latched. Startup, background checks and buttons do not repeat the prompt in that registered context
- On a timeout, the original process remains owned until its actual exit. A late successful result cannot replace timeout. Late auth evidence from that same owned context can add the durable latch while timeout remains in the catalog refresh record
- Ctrl+C fences new stages, cancels owned version/help/models leases, and waits a bounded interval for those exact leases and normalization to drain. An unresolved drain remains pending; the CLI keeps the same host alive, reports shutdown pending, and another explicit Ctrl+C retries that drain without relaunching anything

The view exposes the source, date, stale/unknown state, next allowed time and isolated-context explanation. It never modifies TaskSpec, policy registrations, composer model choices, approvals, claims or result ACKs.

## Durable storage and failures

The host uses one fixed private database at `stateDir/antigravity-metadata/production/catalog.db`, where `stateDir` is the UI's existing host-local runtime root. Its record binds the complete provider/route/context/binary scope and canonical configuration revision. The checksum detects corruption; it is not a signature or authorization grant.

Before any metadata stage, an owner marker and whole-attempt cooldown are durable. The cache checkpoint includes the prior snapshot, failures, error and next allowed time. Version/help capabilities and inspection failures are persisted too. Failed storage prevents later stages from starting.

Another host, a conflicting registration, corrupted state or a prior crash marker blocks further probes at that same location. The software does not choose a new database to bypass this marker. After an interrupted host, an operator must establish that its old process is stopped before repairing the registration; there is no automatic stale-lock removal or HTTP reset. A graceful shutdown removes the marker only after process exit, normalized cache bookkeeping and final persistence are all verified.

Raw CLI output and installation/configuration paths are not returned in the UI. Metadata-only registration grants no model inference or filesystem/command permissions. Same-user host code and file ownership remain trusted; this process host is not an OS confinement boundary.

## Verification scope

Tests use synthetic metadata leases and real local SQLite/HTTP lifecycle. They cover startup/warm restart, daily refresh, all-stage auth failures and shutdown, concurrent hosts, crash/corruption/configuration mismatch, pre-start/between-stage persistence failures, timeout/late result ordering, exact refresh bodies, HTTP capability/origin guards, duplicate clicks and plain-text rendering. No real Antigravity inference, new authentication, Windows validation or account-specific model-list success is claimed.
