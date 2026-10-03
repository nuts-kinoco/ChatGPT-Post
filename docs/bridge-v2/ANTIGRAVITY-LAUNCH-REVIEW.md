# Antigravity actual-launch follow-on: bounded design review

Status: candidate; implementation awaits the common-runtime/design review. Base is published PR5, commit `94e33acfbeb16e7e00c34767055a5ef413ee37f9`. Existing PR5 code remains preserved. No inference or authentication experiment is authorized in this work.

## Verified gap

PR5 constructs correct versioned launch arguments and one stdin NDJSON user event, but it never launches `agy` directly. CliBrokerService sends the plan to CliIsolationRuntime, whose installed-supervisor driver still requires a separately implemented enforcing executable. That is missing production code. It is not fixed by adding `--print`, because the documented streaming input already selects headless operation without that flag.

On 2026-10-03, the existing Linux binary returned version `1.2.15` and its help matched the checked-in fixture. Its SHA-256 is `5f9c16b286895f8f7fdecd423883ca256a85077b8acf9a6bc1111761d34df164`. Only version/help, filesystem identity and hashing were checked. There was no account, model list, prompt, permission setup or provider connection test.

## Official behavior versus assumptions

- [Headless mode](https://www.antigravity.google/docs/cli/headless/) documents stdin user events, stream-json output, closing stdin after one prompt, explicit model selection and cached authentication. A missing noninteractive login should produce an authentication-required error, not be solved by the launcher.
- [CLI reference](https://www.antigravity.google/docs/cli/reference/) and installed help support the existing flags. Installed help has no `--tools` or universal `--disable-hooks` switch. Do not borrow Claude flags.
- [Custom agents](https://www.antigravity.google/docs/subagents/) document selectable main agents with permitted tools, MCP/skills/plugins and command policy. This suggests a candidate empty-tool profile, but empty-list inheritance, full discovery precedence and startup behavior are not verified for this installed version.
- [Permissions](https://www.antigravity.google/docs/permissions/) document deny-all patterns for the supported action namespaces. Workspace reads/writes are otherwise auto-allowed. Permission metadata cannot prove zero tool registration or OS confinement.
- [Hooks](https://www.antigravity.google/docs/hooks/) and [plugins](https://www.antigravity.google/docs/cli/features/) can load automatic customizations. Disabling slash-command expansion is insufficient proof that none can run.

`--mode plan` is not a zero-tools mode. The ordinary confined TaskSpec route must keep its current enforcing-supervisor requirement. Real provider behavior, authentication and cancellation remain unverified.

## Proposed bounded implementation

### A. Real installation preflight, no inference

Add a provider-scoped probe used by a trusted common-runtime host. It accepts only an administratively registered canonical executable and expected digest, hashes a held descriptor, and executes the exact `--version` and `--help` operations with no prompt, inherited credentials, shell, stdin input or arbitrary arguments. Bound each process's duration and combined stdout/stderr bytes. Reject symlinks, non-regular binaries, multiple links, unexpected owner and group/other-writable file or parent directories. Hold an O_NOFOLLOW read descriptor, hash it, and on Linux pass it as child fd 3 and execute /proc/self/fd/3. Recheck fstat identity and digest to detect changes. Descriptor binding prevents pathname replacement, but it does not prevent the trusted owner from modifying the same inode between observations. The installed binary owner and same-user code are therefore explicitly in the probe TCB; no atomic hash-at-exec or adversarial same-user confinement is claimed. A sealed native copy would be a separate hardening implementation, not a property inferred from fstat. Other platforms require their existing native binding and remain unsupported here.

Return a versioned observation: binary digest/version/help digest, known argument/input/output support, process exit/probe errors, and explicit unknown authentication/model availability. The observation is not an authorization token or OS capability. A zero-tools capability remains unavailable, even when all ordinary launch flags are present.

### B. Shared text-inference route, pending common contract

Use the runtime owner's separately typed text-inference route, not TaskExecutor or HostedResponse. Reuse its signed request identity, grant, durable attempt, timeout, result and verified ACK ownership. No separate AGY ledger/framework.

An AGY provider may become eligible only after its exact version has a verified supported zero-tools profile and all hooks/MCP/skills/plugin/config escape surfaces are controlled. A custom-agent file with `tools: []` is a candidate, not sufficient evidence. Init metadata is diagnostic, not proof that startup hooks did not run. Until that capability is established, return a precise provider-unavailable result before starting inference. Never silently downgrade a confined task to text inference.

Once the common contract is approved and AGY eligibility is established, use the existing fixed single-user NDJSON plan/parser with a real bounded process host. Provider stdout/status is transport data; no local-execution receipt or descendant-termination claim is invented. Cached credential/account binding belongs to the common host, not task JSON, generated agent files or inherited environment. No API/subscription fallback.

## C. Dynamic discovery and low-frequency cache (new user requirement)

The provider identity is always `antigravity`; a returned model may have a Gemini or Claude name. Do not restrict the catalog to a hardcoded model family, infer new model capabilities from its name, or switch billing/provider routes. `agy help models` on 1.2.15 confirms `agy models` is a list command with only help flags; no JSON output option is documented. Do not invent `--json` or send `/model` as an inference prompt.

A bounded `agy models` metadata probe was attempted once with stdin closed, an empty private HOME, and no inherited authentication environment. It reached an authentication prompt without returning model rows, and was stopped immediately. No login or inference was sent. This says only that this isolated context could not list models; it does not establish the user's existing account status. Do not claim metadata is always zero-quota or automatically borrow credentials from another context.

Use a provider-neutral `bridge-provider-catalog-1` read-only view envelope, shared with ordinary-Chat discovery, not a second executable-model registry. It binds providerId, routeId, registered opaque contextId and binary revision (or reviewed DOM profile revision); source command/format, fetchedAt/expiresAt, refresh outcome, stale flag and unknown reason. Each row separates catalog-scoped observationKey, reported label, nullable providerModelId and identitySource. ProviderModelId stays null/unverified for label-only observations. No successful installed `agy models` row has been observed; implementation must keep AGY row parsing incomplete until an approved fixture/format establishes the text grammar and ID meaning. Only explicitly supplied provider metadata can establish per-model effort support. Global effort names observed in `--help` are separately labeled CLI-wide syntax, not advertised as support for every model. Account availability, cost and inference quota remain unknown when no authenticated provider evidence establishes them.

Refresh once at eligible initial startup, then only while the owning host is active when TTL expires, or on an explicit refresh. Cache/coalesce by provider + route + binary/DOM revision + registered context; default TTL 24 hours, minimum refresh interval 15 minutes, one in-flight request, bounded error backoff, no refresh-per-job or busy polling. A wall-clock timeout may return a bounded unknown result, but the cache retains ownership of the in-flight process/promise until it actually exits; no timeout may permit an overlapping replacement probe. Late success cannot replace the timeout observation. If exit cannot be observed, retain the blocked ownership state until trusted host recovery. Keep a last-good snapshot marked stale on failure; never relabel it latest or use it to authorize launch. A clock rollback is stale/unknown. Version, binary or execution-context change cannot reuse a prior context's availability claim.

The catalog is display/discovery data, not a grant or installed route capability. Launch still requires registered allowed model, current provider/version capability, exact requested selection and the appropriate reviewed route. Missing/stale/unknown metadata cannot pick a fallback model. No automatic auth, config update, install or model generation occurs during refresh. Existing frozen TaskSpec has no effort field; publishing an observed effort catalog does not silently extend execution semantics.

## Review and acceptance questions

1. Approve A as a no-inference actual binary probe, with Linux fd execution, trusted-owner/same-user TCB caveat, private minimal environment, strict bounds and explicit unknown account/model state?
2. Keep AGY blocked for B until exact-version zero-tools/discovery behavior is verified; permit only profile-planning/eligibility code under the common route, with no independent process framework?
3. Approve C as read-only discovery/cache infrastructure with strict provenance, bounded refresh and no inference/auth setup; identify the common catalog owner and UI contract so this does not create a competing registry?
4. Confirm how the common runtime represents unsupported provider capability separately from unconfigured authentication and absent OS confinement?

Tests for A: correct output, wrong version/hash/path identity, replaced/symlinked executable, nonzero exit, timeout, excessive output, malformed bytes, stderr-only help, no prompt/model/auth command, no inherited secrets, and no automatic retry. Catalog tests: Gemini/Claude-named rows without hardcoded family filters, absent per-model efforts, duplicate/malformed output, auth-needed with last-good stale state, TTL/coalescing/backoff, clock rollback, context/version isolation and no fallback selection. Existing TaskSpec/broker/frame/ACK tests must remain unchanged. Process fixtures may exercise the real host launcher, but they must be explicitly synthetic and never use an actual model.

B needs its own accepted common-contract fixtures and, later, separately authorized AGY provider validation. The existing user authorization for a Haiku inference test does not authorize an AGY call.
