/** Plain Node synthetic tests of the exact installed compiled host/UI modules. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { projectRegistryHash } from "../../dist/contracts/project-registry.js";
import { loadTaskSpec, sha256Bytes } from "../../dist/contracts/task.js";
import { decodeTaskBrief } from "../../dist/prompt-rendering/brief.js";
import {
  revokeHostedRenderer,
  verifyInstalledHostedRenderer,
} from "../../dist/prompt-rendering/hosted-registry.js";
import { prepareHostedPromptPreview } from "../../dist/prompt-rendering/hosted-renderer.js";
import {
  createProductionPromptProfile,
  encodeProductionPromptProfile,
} from "../../dist/prompt-rendering/production-profile.js";
import { manualTaskTemplate, UiComposer } from "../../dist/ui/composer.js";
import { issuerReadPort } from "../../dist/ui/issuer-read-port.js";
import { UiOperationsService } from "../../dist/ui/operations.js";

const buildSha256 = sha256Bytes(
  readFileSync(new URL("../../dist/prompt-rendering/hosted-build-manifest.json", import.meta.url)),
);
const policySha256 = "c".repeat(64);
const project = {
  projectId: "e4541d37-c43c-4c7e-924a-3a6602b71d68",
  repoId: "fixture-repo",
  storageSlug: "synthetic-project",
  displayName: "Synthetic project",
  githubDestination: null,
  outputRootOverride: null,
};
const snapshot = {
  schema: "bridge-project-registry-1",
  revision: 1,
  defaultOutputRoot: null,
  projects: [project],
};
const spy = (fn) => {
  const calls = [];
  const tracked = (...args) => {
    calls.push(args);
    return fn(...args);
  };
  tracked.calls = calls;
  return tracked;
};
function registered(modelId = "gpt-5.6-sol", profileId = "fixture-hosted", policy = policySha256) {
  const profileRaw = encodeProductionPromptProfile(
    createProductionPromptProfile({ profileId, profileVersion: 1, modelId }),
  );
  return verifyInstalledHostedRenderer({
    profileRaw,
    profileSha256: sha256Bytes(profileRaw),
    rendererArtifactSha256: buildSha256,
    policySnapshotSha256: policy,
  });
}
function fixture(modelId = "gpt-5.6-sol") {
  const task = {
    protocol_version: "2.0",
    request_id: "a2345678-1234-4234-8234-123456789abc",
    agent: "chatgpt-browser",
    requested_model: modelId,
    repo: project.repoId,
    base_commit: "b".repeat(40),
    mode: "read_only",
    policy_snapshot_sha256: policySha256,
    allowed_paths: [{ path: "src", scope: "subtree", permissions: ["read"] }],
    allowed_commands: [],
    task_file: "task.md",
    task_file_hash: "0".repeat(64),
    approval: {
      required: true,
      binding: "sha256-raw-task-spec",
      source: "detached-authoritative-record",
      max_age_seconds: 60,
      max_starts: 1,
      tier: "manual",
      preauthorization: null,
    },
    timeout: { run_seconds: 10, cancel_grace_seconds: 1 },
    success_criteria: [
      { criterion_id: "inspect", description: "Synthetic inspection", evaluator_id: "fake-check" },
    ],
    task_network: "deny",
    environment: {},
    retry_policy: "no-automatic-reexecution",
  };
  const destination = {
    destinationId: "registered-hosted",
    route: "ordinary_chat_browser",
    recipientActorId: "recipient",
    providerId: task.agent,
    modelIds: [modelId],
    capabilities: {},
    unavailableReason: null,
    policyHash: policySha256,
  };
  const registry = {
    currentRevision: () => 1,
    snapshot: () => structuredClone(snapshot),
    snapshotHash: () => projectRegistryHash(snapshot),
    resolve: () => structuredClone(project),
  };
  const operations = new UiOperationsService({ registry, destinations: () => [destination] });
  const basePrepare = manualTaskTemplate(task),
    prepare = spy((input) => {
      const raw = basePrepare(input);
      const loaded = loadTaskSpec(Buffer.from(raw.rawSpec));
      assert.equal(loaded.valid, true, JSON.stringify(loaded));
      return raw;
    }),
    issue = spy(async () => ({ commit: "a".repeat(40) }));
  let renderer = registered(modelId);
  const port = { prepare, issue, promptFormat: () => renderer };
  const composer = new UiComposer(operations, port);
  const input = {
    registryRevision: 1,
    projectId: project.projectId,
    destinations: [{ destinationId: destination.destinationId, modelId }],
    title: "Synthetic task",
    instruction: "No model call. Preserve \\n and Unicode 読み取り.",
    mode: "bridge-task-brief-1",
    taskKind: "answer",
    constraints: ["Do not expand execution scope"],
    deliverables: ["Evidence summary"],
    acceptance: ["Distinguish unknowns"],
  };
  return {
    task,
    destination,
    registry,
    operations,
    basePrepare,
    prepare,
    issue,
    port,
    composer,
    input,
    renderer: () => renderer,
    setRenderer: (value) => {
      renderer = value;
    },
  };
}
function binding(preview) {
  return {
    previewId: preview.previewId,
    previewSha256: sha256Bytes(Buffer.from(JSON.stringify(preview))),
  };
}

for (const model of ["gpt-5.6-sol", "gpt-5.5"])
  for (const taskKind of ["answer", "review", "change"])
    test(`one exact task/spec for ${model} ${taskKind}`, async () => {
      const f = fixture(model),
        preview = await f.composer.preview({ ...f.input, taskKind }),
        child = preview.children[0];
      assert.equal(preview.version, "bridge-composer-preview-2");
      assert.equal(f.prepare.calls.length, 1);
      assert.equal(f.issue.calls.length, 0);
      assert.deepEqual(decodeTaskBrief(Buffer.from(child.taskMarkdown)), {
        taskKind,
        objective: `# ${f.input.title}\n\n${f.input.instruction}`,
        constraints: f.input.constraints,
        deliverables: f.input.deliverables,
        acceptance: f.input.acceptance,
        context: [],
      });
      const parsed = JSON.parse(child.rawSpec);
      for (const field of [
        "mode",
        "allowed_paths",
        "allowed_commands",
        "task_network",
        "timeout",
        "approval",
        "requested_model",
        "policy_snapshot_sha256",
      ])
        assert.deepEqual(parsed[field], f.task[field]);
      assert.equal(parsed.request_id, child.requestId);
      assert.equal(parsed.task_file_hash, sha256Bytes(Buffer.from(child.taskMarkdown)));
      assert.equal(child.promptFormat.readiness, "registered-pre-approval");
      assert.equal(child.promptFormat.modelId, model);
      assert.equal(child.promptFormat.codec, "bridge-task-brief-1");
      assert.equal(child.promptPreview.status, "non-dispatch-preview");
      assert.equal(child.promptPreview.executionAuthorized, false);
      assert.equal(child.promptPreview.taskSpecSha256, child.taskSpecHash);
      assert.equal(child.promptPreview.taskFileSha256, child.taskFileHash);
      assert.deepEqual(child.promptPreview.unresolved, ["approval", "attempt", "output-contract"]);
      assert.equal(child.promptPreview.session, null);
      assert.equal(child.promptPreview.bootstrap, null);
      assert.equal(child.promptPreview.preview.digestScope, "preview-only-not-final-send");
      assert.deepEqual(
        prepareHostedPromptPreview({
          renderer: f.renderer(),
          rawTaskSpec: Buffer.from(child.rawSpec),
          taskFileBytes: Buffer.from(child.taskMarkdown),
          policySnapshotSha256: policySha256,
        }),
        child.promptPreview,
      );
      const issued = await f.composer.issue(binding(preview));
      assert.deepEqual(await f.composer.issue(binding(preview)), issued);
      assert.equal(f.prepare.calls.length, 1);
      assert.equal(f.issue.calls.length, 1);
      assert.deepEqual(f.issue.calls[0][0], preview);
    });

test("metadata/template reads have no inference or issue effects", async () => {
  const f = fixture(),
    first = await f.composer.promptFormats();
  assert.deepEqual(await f.composer.promptFormats(), first);
  assert.equal(first.version, "bridge-composer-prompt-formats-1");
  assert.equal(first.formats[0].promptFormat.profileId, "fixture-hosted");
  assert.equal(f.prepare.calls.length, 0);
  assert.equal(f.issue.calls.length, 0);
  const template = await issuerReadPort(f.operations, f.port).template(
    project.projectId,
    f.destination.destinationId,
  );
  assert.equal(template.version, "bridge-issuer-template-2");
  assert.equal(template.templateOnly, true);
  assert.equal(template.executable, false);
  assert.deepEqual(template.promptFormat, first.formats[0].promptFormat);
  assert.equal(Object.hasOwn(template.taskSpecTemplate, "request_id"), false);
  assert.equal(Object.hasOwn(template.taskSpecTemplate, "task_file_hash"), false);
  assert.equal(f.prepare.calls.length, 1);
  assert.equal(f.issue.calls.length, 0);
});

for (const drift of ["profile", "policy", "model", "registry", "unavailable", "revoked"])
  test(`stale ${drift} rejects before issue`, async () => {
    const f = fixture(),
      preview = await f.composer.preview(f.input);
    if (drift === "profile") f.setRenderer(registered("gpt-5.6-sol", "replacement-profile"));
    if (drift === "policy") f.destination.policyHash = "d".repeat(64);
    if (drift === "model") f.destination.modelIds = ["gpt-5.5"];
    if (drift === "registry") f.registry.currentRevision = () => 2;
    if (drift === "unavailable")
      f.port.promptFormat = () => {
        throw new Error("hosted_registration_unavailable");
      };
    if (drift === "revoked") revokeHostedRenderer(f.renderer());
    await assert.rejects(f.composer.issue(binding(preview)));
    assert.equal(f.issue.calls.length, 0);
    assert.equal(f.prepare.calls.length, 1);
  });

test("profile drift during recipe preparation and template reads rejects", async () => {
  for (const route of ["preview", "template"]) {
    const f = fixture();
    f.port.prepare = (input) => {
      f.setRenderer(registered("gpt-5.6-sol", "changed-profile"));
      return f.basePrepare(input);
    };
    await assert.rejects(
      route === "preview"
        ? f.composer.preview(f.input)
        : issuerReadPort(f.operations, f.port).template(
            project.projectId,
            f.destination.destinationId,
          ),
      { code: route === "preview" ? "composer_prompt_format_stale" : "issuer_prompt_format_stale" },
    );
    assert.equal(f.issue.calls.length, 0);
  }
});
for (const mutation of ["ignore", "rewrite"])
  test(`recipe cannot ${mutation} encoded bytes`, async () => {
    const f = fixture();
    f.port.prepare = (input) => {
      const copy = { ...input };
      if (mutation === "ignore") delete copy.taskMarkdown;
      else copy.taskMarkdown += "\n";
      return f.basePrepare(copy);
    };
    await assert.rejects(f.composer.preview(f.input), { code: "composer_recipe_invalid" });
    assert.equal(f.issue.calls.length, 0);
  });

test("forged handles and model/policy mismatches deny without inference", async () => {
  for (const renderer of [
    null,
    {},
    registered("gpt-5.5"),
    registered("gpt-5.6-sol", "different-policy", "d".repeat(64)),
  ]) {
    const f = fixture();
    f.setRenderer(renderer);
    await assert.rejects(f.composer.preview(f.input));
    assert.equal(f.prepare.calls.length, 0);
    assert.equal(f.issue.calls.length, 0);
  }
});
for (const field of [
  "context",
  "taskMarkdown",
  "profile",
  "renderer",
  "providerId",
  "promptFormat",
])
  test(`public ${field} sidecar rejects`, async () => {
    const f = fixture();
    await assert.rejects(f.composer.preview({ ...f.input, [field]: [] }), {
      code: "composer_input_invalid",
    });
    assert.equal(f.prepare.calls.length, 0);
    assert.equal(f.issue.calls.length, 0);
  });

test("legacy free text remains byte-compatible without inferred task kind", async () => {
  const f = fixture();
  delete f.port.promptFormat;
  const { mode, taskKind, constraints, deliverables, acceptance, ...legacy } = f.input;
  const preview = await f.composer.preview({
      ...legacy,
      mode: "legacy-verbatim",
      instruction: "review this\r\nchange that\r\nanswer without inference",
    }),
    child = preview.children[0];
  assert.equal(preview.version, "bridge-composer-preview-1");
  assert.equal(
    child.taskMarkdown,
    `# ${legacy.title}\n\nreview this\r\nchange that\r\nanswer without inference`,
  );
  assert.equal(Object.hasOwn(child, "promptPreview"), false);
  assert.equal(Object.hasOwn(child, "promptFormat"), false);
  const template = await issuerReadPort(f.operations, f.port).template(
    project.projectId,
    f.destination.destinationId,
  );
  assert.equal(template.version, "bridge-issuer-template-1");
  assert.equal(Object.hasOwn(template, "promptFormat"), false);
  assert.equal(f.issue.calls.length, 0);
});

test("common grammar and explicit mode reject invalid input before preparation", async () => {
  const f = fixture();
  for (const patch of [
    { taskKind: "invented-kind" },
    { constraints: "not-an-array" },
    { acceptance: [""] },
    { mode: "inferred" },
    { instruction: "x".repeat(65536) },
  ])
    await assert.rejects(f.composer.preview({ ...f.input, ...patch }));
  const { mode, taskKind, constraints, deliverables, acceptance, ...legacy } = f.input;
  await assert.rejects(f.composer.preview(legacy), { code: "composer_prompt_format_unsupported" });
  assert.equal(f.prepare.calls.length, 0);
  assert.equal(f.issue.calls.length, 0);
});

test("registered profile cannot be reused for another route or agent", async () => {
  for (const field of ["route", "providerId"]) {
    const f = fixture();
    f.destination[field] = field === "route" ? "cli" : "another-agent";
    await assert.rejects(f.composer.preview(f.input), {
      code: "composer_prompt_format_binding_invalid",
    });
    assert.equal(f.prepare.calls.length, 0);
    assert.equal(f.issue.calls.length, 0);
  }
});

for (const [label, invalid] of [
  ["undefined", undefined],
  ["false", false],
  ["zero", 0],
  ["empty-string", ""],
]) {
  test(`configured resolver ${label} is unavailable, never legacy`, async () => {
    const f = fixture(),
      preview = await f.composer.preview(f.input);
    f.port.promptFormat = () => invalid;
    await assert.rejects(f.composer.promptFormats(), {
      code: "composer_prompt_format_unavailable",
    });
    await assert.rejects(
      issuerReadPort(f.operations, f.port).template(
        project.projectId,
        f.destination.destinationId,
        f.task.requested_model,
      ),
      { code: "composer_prompt_format_unavailable" },
    );
    await assert.rejects(
      f.composer.preview({
        registryRevision: 1,
        projectId: project.projectId,
        destinations: f.input.destinations,
        title: "Legacy-shaped task",
        instruction: "No fallback",
      }),
      { code: "composer_prompt_format_unavailable" },
    );
    await assert.rejects(f.composer.issue(binding(preview)), {
      code: "composer_prompt_format_unavailable",
    });
    assert.equal(f.issue.calls.length, 0);
  });
}
