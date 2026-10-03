# Deterministic offline prompt preview

Status: implemented offline phase 1. No existing request, model, launcher, policy, approval, issuer, UI or dispatch path imports these modules. This is an executable offline formatting mechanism, not measured inference optimization. The existing Haiku text trial remains a separate contract.

## One task, small format differences

The existing TaskSpec v2 and its exact `task_file_hash` remain the only task contract. A versioned brief is encoded **inside those task-file bytes**, before normal request hashing/approval. No semantic sidecar can replace the objective or task kind.

Use the exported functions in `src/prompt-rendering`:

1. `encodeTaskBrief(unknown)` creates the task file from a common objective, constraints, deliverables, acceptance criteria and context manifest
2. `createPromptProfileRegistry(definitions)` creates an **offline** candidate registry. Each record pins an exact agent, model, route, codec, format version and definition digest. It does not register a model for execution or authenticate policy
3. `prepareOfflinePromptPreview(input)` calls the existing `loadTaskSpec` and `verifyTaskFileBytes`, checks the caller's expected raw spec hash and exact profile/policy/model/route bindings, validates all materialized context, and snapshots the input in an opaque in-memory handle
4. `renderPromptPreview(handle)` is deterministic and performs no I/O, clock, entropy or inference operations

Preparation uses the existing TaskSpec validator, including its lazy local schema-file read. It is deliberately distinguished from the pure rendering step. Profile listing/creation and the codec are also offline. The profile definition digest covers the canonical static definition and generated core/guidance metadata; it is **not** a digest of compiled renderer code or an approval. Production renderer source pinning requires the next reviewed contract.

Provider formats share one core and three small `answer`, `review`, `change` deltas. Claude uses XML sections with escaped one-line JSON data; OpenAI and Google use Markdown sections with the same escaped JSON data. Provider selection never changes permissions. All three preserve the same semantic request. No examples are silently added, no source references are fetched, and no API roles are simulated as authority.

## Exact codec

The only accepted `bridge-task-brief-1` representation is:

- UTF-8 without BOM; no invalid sequences, NUL or unpaired surrogate values
- Literal `BRIDGE TASK BRIEF bridge-task-brief-1` followed by one LF
- One compact JSON object, with keys in this order: `taskKind`, `objective`, `constraints`, `deliverables`, `acceptance`, `context`
- One final LF, with no further bytes

The parser first rejects duplicate decoded keys using the existing strict JSON parser, validates exact keys and bounds, then requires byte equality with the canonical encoder. Reordered keys, outer whitespace, alternative Unicode escapes, CRLF syntax and trailing objects are rejected. CRLF **inside a string value** is retained exactly, never normalized. This new canonical encoding applies before approval; approved bytes are never silently rewritten.

`taskKind` is `answer`, `review` or `change`. It affects presentation only. `deliverables` and `acceptance` are semantic descriptions and cannot replace an authenticated output contract or host success criteria.

Each context entry has exactly these ordered keys: `id`, `revision`, `sha256`, `sizeBytes`, `mediaType`, `trust`, `placement`. IDs are unique ASCII identifiers; digest is lowercase SHA-256; media type is `text/plain`, `text/markdown` or `application/json`; trust is always `untrusted`; placement is `stable` or `variable`. Stable placement is only a cache-friendly location, never an upgrade in trust. The manifest itself is covered by the task-file hash.

The renderer accepts only supplied `{id, bytes}` entries. It rejects missing, duplicate, extra or changed content, including unapproved cache IDs. Source order follows the approved manifest, not caller order. Copied bytes are hash-checked before decoding, preventing later caller mutation from changing the prepared snapshot. JSON media type is descriptive; source bytes are preserved as data, not executed or semantically trusted.

Limits: brief 256 KiB; objective 64 KiB; each semantic list at most 32 entries, each 8 KiB; at most 32 context entries; each context 1 MiB, total 2 MiB; context ID 128 bytes and revision 256 bytes. Existing TaskSpec 256 KiB/task-file 1 MiB limits remain. Before rendering, an aggregate worst-case JSON-escaping bound plus 64 KiB section overhead must fit 20 MiB. The actual output size is checked again.

`legacy-verbatim` must be selected explicitly in the exact profile. Its accepted UTF-8 text, including CRLF, is escaped losslessly as one data value; it is not parsed as a brief even if it begins with the new marker. BOM and malformed text reject. It has no implicit task kind and accepts no context sidecar.

## Honest preview bindings

The result always says `non-dispatch-preview`, `executionAuthorized: false`, `dispatchRenderer: unchanged-legacy` and `policyProfileBinding: unverified-offline-candidate`.

- `taskSpecSha256`: original raw TaskSpec bytes, not JSON reserialization
- `taskFileSha256`: original task bytes checked against TaskSpec
- `profile.profileSha256`: the static versioned candidate profile definition, without its own digest field
- `stablePrefix.sha256`: only the returned prefix text, excluding task-kind, variable context and all dynamic request bindings
- `preview.sha256`: only the returned comparison text, explicitly `preview-only-not-final-send`

Approval, attempt, session, bootstrap and output contract remain unresolved. No final prompt digest or rendered receipt is fabricated. Changing an objective/request/kind/variable context changes the comparison bytes but preserves the common prefix. Changing a model/profile/stable context changes the prefix. A matching prefix is not evidence of a cache hit.

Output-frame and declaration semantics remain owned by the existing host contracts. This preview describes their unresolved status; it does not generate a fake final frame or choose an output policy. It cannot accept a model's “done,” declarations, artifact hashes or cache claims as success evidence.

## Standalone local command

Build normally, then run:

```sh
npm run build
node scripts/preview-task-prompt.mjs SPEC_FILE TASK_FILE OFFLINE_CONFIG
```

This explicitly reads the named local files and writes the preview JSON to stdout. It never loads a provider adapter, issues a task, allocates an attempt, starts a model, accesses a URL or saves credentials. Its file reader rejects nonregular files and opens without following a final symlink; input sizes are bounded. Platforms lacking the required no-follow/nonblocking file flags fail closed; the command was exercised on Linux only. It is a local development utility, **not** a confined host materializer or a server endpoint. Do not expose its filesystem-path input to a network client. Diagnostics omit file contents and paths.

`OFFLINE_CONFIG` is strict JSON with exactly:

```json
{
  "profile": {
    "profileId": "review-format-candidate",
    "version": 1,
    "provider": "openai",
    "agentId": "EXACT_TASK_AGENT",
    "modelId": "EXACT_TASK_MODEL",
    "routeId": "EXACT_ROUTE",
    "codec": "bridge-task-brief-1"
  },
  "pin": {
    "profileId": "review-format-candidate",
    "version": 1,
    "profileSha256": "DIGEST_FROM_listPromptProfiles",
    "policySnapshotSha256": "EXACT_TASK_POLICY_HASH"
  },
  "expectedTaskSpecSha256": "EXACT_RAW_SPEC_HASH",
  "routeId": "EXACT_ROUTE",
  "context": [{"id": "MANIFEST_ID", "path": "EXPLICIT_LOCAL_FILE"}]
}
```

These are explanatory placeholders and fail actual validation. Obtain the candidate profile digest from `listPromptProfiles(createPromptProfileRegistry([definition]))`; no model runs. Use an empty context array when the brief has no context. Use the same existing registered agent/model for a real task's offline comparison, never infer availability from a provider/model name.

Cache output remains `unmeasured`, controls disabled, cost and quota effects unknown. No force-cache flags, cache objects, warming calls, model selection, billing-route changes or TTL behavior are implemented.

## Verification and next wire

Tests include exact codec round-trips, duplicate keys, Unicode/CRLF, malformed/oversized inputs, immutable snapshot mutation, stale pins, cross-model/route rejection, context injection, framing/section spoofing, provider golden snapshots, stable-prefix invariants, filesystem/process/network/clock/entropy spies, and the explicit local file utility.

`PROMPT-WIRING-PROPOSAL.md` defines the proposed first real dispatch integration. Its policy and receipt contracts require independent review before implementation. No existing dispatch import was changed in this phase.

Official guidance and caching differences were reviewed on 2026-10-03: [Anthropic prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning-best-practices), [Google prompting](https://ai.google.dev/gemini-api/docs/prompting-strategies). These informed initial format candidates; quality or token savings have not been measured.
