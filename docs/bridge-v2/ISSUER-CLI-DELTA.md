# Configured read-only issuer CLI follow-on

This delta stacks on PR3 `a1ed5427379b37167db839bbc1d19d52e22afafd` and the reviewed
operations/composer/IssuerReadPort implementation. It does not change the published PR3.

## Trusted host composition

Return `issuerReadPort: issuerReadPort(operations, composerPort)` from the same explicit
`openDeployment()` that already owns the registered operations sources and pure recipe.
Do not construct a second route/policy catalogue. `composerPort.prepare` must be pure;
these calls never import, approve, sign, issue or start a job.

## Short LLM bootstrap additions

1. Inspect offline `task capabilities`, `bus capabilities` and `bus help`
2. Read the explicitly configured catalogue; never infer a route/model/policy from a display name
3. Request the exact registered project/destination/model template
4. The response has `templateOnly:true` and `executable:false`. Supply one durable new request UUID,
   exact task Markdown and its SHA-256; generate JSON programmatically and validate exact bytes
5. Unknown/unavailable output policy, missing authority or unsupported capability stays blocked
6. For normal Chat, derive its detached output contract only from the returned trusted output policy
   and pinned registration; model output cannot expand that policy
7. Use the existing explicit issue/receipt/collect/materialize/ACK procedure after approval. Catalogue
   access and template generation are not execution or sharing authorization

```sh
node dist/cli/bus.js --deployment /trusted/requester.mjs catalogue
node dist/cli/bus.js --deployment /trusted/requester.mjs template PROJECT_UUID DESTINATION_ID MODEL_ID
node dist/cli/main.js task validate --request ./task.json --task-file ./task.md
```

Omit MODEL_ID only when exactly one model is registered; multiple models produce
`issuer_model_required`. An absent shared port produces `issuer_catalogue_unconfigured`.
The template deliberately omits request_id and task_file_hash; it cannot be submitted unchanged.

## Portable tests

```sh
npm run typecheck
npm test -- tests/unit/bus-issuer-cli.test.ts tests/unit/bus-cli.test.ts tests/unit/ui-composer.test.ts
```

Fixtures use fake host ports only. They verify exact argument forwarding, no issue calls, absent-port
and malformed-input rejection, preservation of host validation errors, async cleanup ordering,
and offline help/capabilities without deployment loading. No account, browser, model or socket runs.
