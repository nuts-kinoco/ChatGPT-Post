# Bridge operations UI: usage and trusted composition

This is an intermediate implementation. It adds an LLM-first monitor and explicit controls to the accepted A presentation. A passed cloud suite is not evidence of real ordinary Chat, model CLI, or Windows execution. See `UI-OPERATIONS-TESTING.md` and the platform gates below.

## Start

Use Node >=22.13.0. In the repository run `npm ci`, `npm run build`, then one of:

- `npm run ui` — production profile with unavailable adapters clearly disabled
- `npm run ui:demo` — explicitly synthetic local jobs, isolated under the demo runtime directory
- `node dist/cli/main.js ui --deployment /absolute/trusted/deployment.mjs` — an already authorized host module exporting `openDeployment()`
- Desktop: build the root and `gui` packages; set `CHATGPT_BRIDGE_DEPLOYMENT_MODULE` to that same trusted absolute module before starting the desktop app. Demo and configured production are mutually exclusive

`CHATGPT_BRIDGE_RUNTIME_DIR` selects the local private runtime directory. Do not put that directory, browser profiles, keys, bearer URLs, conversation content, or diagnostic exports in Git. The printed localhost URL contains a per-launch capability: open it locally, do not share it or include it in reports.

## Normal workflow: the LLM issues, the UI monitors

1. Read `node dist/cli/bus.js --deployment /absolute/trusted/deployment.mjs catalogue`
2. Read `node dist/cli/bus.js --deployment /absolute/trusted/deployment.mjs template PROJECT_UUID DESTINATION_ID MODEL_ID`. Model is required when the registration offers more than one. The output is deliberately non-executable: provide the request UUID, exact task Markdown and its SHA-256. It grants no authority
3. Follow the existing configured bus `issue`, `approve`, `tick`, `browser-start`, `result`, and explicit `ack` commands described by `node dist/cli/bus.js help`. Never create a replacement UUID or issue again to resolve an `unknown` outcome
4. Watch the UI's local / ordinary-chat / fanout lists. They read authoritative persisted state; no manual form is needed to discover a new CLI-created job. New rows do not replace the detail you are inspecting
5. Inspect who requested the work, which registered project and route are pinned, the requested versus actually observed provider/model, exact hashes, timestamps, and terminal evidence. Ordinary-chat response availability is distinct from local process success
6. Use only enabled, explicit actions. Approval/start bind the inspected immutable hashes and revision. Stop remains independent of a slow start. Reconcile asks the existing adapter to recover the same attempt, never reruns it
7. A terminal response, sender archive, raw payload ACK, and verified requester materialization are separate observations. Full delivery is shown only with matching proof. Required missing artifacts remain visible; optional artifacts do not silently become required

Raw nonsynthetic JSON/Markdown imports without a verified historical project registration remain inspection-only for approval/start/ACK. They are never silently repinned from current settings. Read/cancel/reconcile remain available under their existing adapter gates.

A manual composer remains available as a secondary control. Choose registered project, one to four registered destinations and explicit models. Preview exact JSON and Markdown before issuing. Any edit invalidates the preview. Registry/policy drift or expired preview is rejected. A timed-out pure recipe does not issue or generate replacement IDs. After an uncertain transport response, retain the original preview and IDs; do not create another request as a retry.

## Presentation

The resident bar is 440×46 CSS pixels; explicit expansion opens downward to an overall 440×604 frame, clamped to the available work area. Every page/dialog shares that frame and scrolls internally. Long text does not enlarge it. Collapse retains fields and pending work. Completion never expands or focuses the window. Windows placement/rendering still needs real-machine verification.

Light/dark is persisted across views. Desktop settings provide always-on-top, hide when inactive, and tray reopening. Browser mode clearly disables native-only settings. In-app completion notices have an easy OFF control. Re-enabling establishes a fresh read baseline so old results are not replayed. Fast jobs that first appear terminal after that baseline can notify without opening the window.

## Project roots and archives

Project settings edit the same canonical `ProjectRegistry` used by issue/admission/archive. Save uses an expected revision. Project ID, repo ID and storage slug cannot be reassigned. Display/root changes are prospective: old jobs retain historical project/root pins. Changing settings does not authorize execution, sharing, credentials, or routes.

Root probing is an explicit user action. Merely viewing settings does not create probe files. Archive inspection shows the bound manifest, required/optional items, completeness/unavailable reasons, and the local pinned root. Collect never restarts a task. Export downloads one sanitized diagnostic JSON bundle; it excludes prompts, response bodies, root paths and credentials. Inspect the bundle before independently choosing to share it. There is no arbitrary artifact-path API.

The old `/api/archive/settings` writer and `/api/tasks/:id/archive` mutation are not product routes. `/api/legacy/archive/:id` is explicit read-only compatibility inspection for an injected legacy archive. No silent v1-to-v2 migration occurs.

## Usage, limits and notifications

- Provider quota is a dated, provider-bound observation. The current concrete account-management port is Codex only. It must never be presented as Claude, Antigravity or ChatGPT quota. Unknown/manual values are not provider evidence; configured fallback caps are finite and separately authorized. A provider ID alone does not prove the user's billing/account route
- The Pro counter records only this Bridge's actual hosted observations. Requested model/preset is not observed Pro use. Confirmed and possible counts are separate; other-account activity remains unknown. The user configures limit, warning threshold, UTC window endpoints and IANA time zone. There is no hardcoded 40 or inferred account balance
- Auth-block Email/Discord preferences are per authenticated actor, default OFF, and use opaque registered destination IDs. This slice stores preferences only; `sendingImplemented:false`. No test-send or real notification is emitted

## Trusted module composition

The UI CLI and desktop both call the module's `openDeployment()`. Build one canonical registry and the existing local/hosted/fanout services. Do not construct parallel task or project ledgers.

The returned object may contain:

- `uiRuntime`: the existing `createBridgeDeployment(...).uiRuntime`
- `uiOperationsSources(service)`: `buildUiOperationsSources(service, ports)` with the same registry, explicit host-approved destination catalogue, `hostedOperationsPort(...).source`, existing `GitHubFanout.list/collect`, and `deploymentQuotaPort(deployment.quotaSnapshot)`
- `uiComposer`: `composerTransportPort(bus, trustedPureRecipe)`; recipe validation is shared with `issuerReadPort`
- `issuerReadPort`: `issuerReadPort(operations, uiComposer)` for the read-only bus CLI. The operations object must use the same source builder/catalogue as the UI
- `materialization` inside the operations sources: `requesterMaterializationPort({bus, currentBinding: currentOperationBindingReader(service, browser), materialize})`. Wrap the existing `createRequesterMaterialization` callback as `context => requesterMaterialize(context.payloadBytes, context.terminalEvent, context)`. The authenticated UI requester must equal the bus signer and immutable job requester. Only the explicit “verify artifacts and accept” action materializes, durably persists, then publishes signed proof+ACK; reads never download/persist artifacts. The next signed bus read can show verified delivery while the recipient ledger waits for its ordinary host tick
- `archiveOperations`: `createArchiveOperations({archive: routeArchive, local: controller, hosted: browserService})`, shared with archive CLI. Configure `LocalRouteArchive` on the local controller before admission
- `proCounter`: a bounded `ProObservationStore` of the matching synthetic/production profile. Use `createHostedProObserver` with `browser.latestObservation(id)`. Feed `observeHostedStartIntent` only from `hostedOperationsPort`'s `onDurableStart`; normal reads/cancel must not synthesize submission evidence
- `notificationPreferences` / `notificationCatalogue`: optional already-authorized per-actor preference store and registered opaque destinations
- `residentWorker`: an explicitly enabled trusted lifecycle object. The UI starts it only after the loopback server successfully binds. No UI preference, API read, or CLI catalogue/template command starts it. Without this opt-in, run the existing explicit bus `tick` command to receive/reconcile work
- `close()`: first await `hostedOperationsPort.close()`; only then close hosted/local/archive/registry stores. A pending hosted shutdown is an explicit error, not permission to close its database. The desktop waits for successful drain before quitting; a failed drain retains the process/stores for an explicit retry. Collapsing/hiding the UI never calls shutdown

Absent adapters return specific unavailable reasons. Catalogue entries are choices, not grants. No credential text is entered through the product UI. The module loader is an explicit trusted-host code boundary, not an arbitrary HTTP execution endpoint.

## Remaining production gates

Real credentials/signers, registered routes, strict host policies, a verified account/billing route, browser login, requester artifact materialization and destination sharing grants must be provided by an authorized deployment. Enforcing native supervisor / Windows authenticated IPC, ACL and confinement providers remain missing code where explicitly reported. Canonical registry and archive Windows storage verification currently fail closed. Do not describe these as merely tests waiting to be run. The original browser-chat CLI path remains available independently; ordinary Chat is not an MCP event stream.
