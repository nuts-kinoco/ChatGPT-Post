import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Bytes } from "../../src/contracts/task.js";
import { encodeTaskBrief } from "../../src/prompt-rendering/brief.js";
import { offlinePreviewErrorCode, previewFiles } from "../../src/prompt-rendering/offline-files.js";
import {
  createPromptProfileRegistry,
  listPromptProfiles,
  type PromptProfileDefinition,
} from "../../src/prompt-rendering/profiles.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "bridge-offline-preview-"));
  directories.push(root);
  const taskFile = encodeTaskBrief({
    taskKind: "answer",
    objective: "Answer this offline fixture",
    constraints: [],
    deliverables: [],
    acceptance: [],
    context: [],
  });
  const policyHash = "a".repeat(64);
  const spec = Buffer.from(
    JSON.stringify({
      protocol_version: "2.0",
      request_id: "00000000-0000-4000-8000-000000000001",
      agent: "fixture",
      requested_model: "fixture",
      repo: "fixture",
      base_commit: "a".repeat(40),
      mode: "design_fixture",
      policy_snapshot_sha256: policyHash,
      allowed_paths: [],
      allowed_commands: [],
      task_file: "task.md",
      task_file_hash: sha256Bytes(taskFile),
      approval: {
        tier: "manual",
        preauthorization: null,
        required: true,
        binding: "sha256-raw-task-spec",
        source: "detached-authoritative-record",
        max_age_seconds: 60,
        max_starts: 1,
      },
      timeout: { run_seconds: 60, cancel_grace_seconds: 5 },
      success_criteria: [
        { criterion_id: "fixture", description: "Synthetic result", evaluator_id: "fixture" },
      ],
      task_network: "deny",
      environment: {},
      retry_policy: "no-automatic-reexecution",
    }),
  );
  const definition: PromptProfileDefinition = {
    profileId: "offline-fixture",
    version: 1,
    provider: "openai",
    agentId: "fixture",
    modelId: "fixture",
    routeId: "fixture",
    codec: "bridge-task-brief-1",
  };
  const profile = listPromptProfiles(createPromptProfileRegistry([definition]))[0];
  if (!profile) throw new Error("fixture_profile_missing");
  const config = {
    profile: definition,
    pin: {
      profileId: profile.profileId,
      version: 1,
      profileSha256: profile.profileSha256,
      policySnapshotSha256: policyHash,
    },
    expectedTaskSpecSha256: sha256Bytes(spec),
    routeId: "fixture",
    context: [] as { id: string; path: string }[],
  };
  const specPath = join(root, "spec.json"),
    taskPath = join(root, "task.md"),
    configPath = join(root, "offline.json");
  writeFileSync(specPath, spec);
  writeFileSync(taskPath, taskFile);
  writeFileSync(configPath, JSON.stringify(config));
  return { root, specPath, taskPath, configPath, config };
}
describe("standalone offline file materializer", () => {
  it("returns a non-dispatch preview from explicit local inputs without writing results", () => {
    const fixture = setup();
    const preview = previewFiles(fixture.specPath, fixture.taskPath, fixture.configPath);
    expect(preview.status).toBe("non-dispatch-preview");
    expect(preview.taskKind).toBe("answer");
    expect(preview.preview.text).toContain("Answer this offline fixture");
  });
  it("rejects duplicate/extra config keys and oversized input files before parsing", () => {
    const f = setup();
    writeFileSync(f.configPath, `${JSON.stringify(f.config).slice(0, -1)},"context":[]}`);
    expect(() => previewFiles(f.specPath, f.taskPath, f.configPath)).toThrow();
    writeFileSync(f.configPath, JSON.stringify({ ...f.config, start: true }));
    expect(() => previewFiles(f.specPath, f.taskPath, f.configPath)).toThrow();
    writeFileSync(f.configPath, JSON.stringify(f.config));
    writeFileSync(f.specPath, Buffer.alloc(256 * 1024 + 1));
    expect(() => previewFiles(f.specPath, f.taskPath, f.configPath)).toThrow(
      "offline_input_file_invalid",
    );
  });
  it("rejects directories, missing files, and unexpected context", () => {
    const f = setup();
    expect(() => previewFiles(f.root, f.taskPath, f.configPath)).toThrow(
      "offline_input_file_invalid",
    );
    expect(() => previewFiles(join(f.root, "missing"), f.taskPath, f.configPath)).toThrow();
    f.config.context = [{ id: "unbound", path: f.taskPath }];
    writeFileSync(f.configPath, JSON.stringify(f.config));
    expect(() => previewFiles(f.specPath, f.taskPath, f.configPath)).toThrow(
      "prompt_context_set_mismatch",
    );
  });
});

describe("offline command diagnostic boundary", () => {
  it.each([
    "provider_session_secret",
    "private_token_value",
    "secret",
    "prompt_unknown_private_reason",
    "prompt_task_spec_invalid\n",
    "C:\\private\\secret",
  ])("does not forward arbitrary error text %s", (message) => {
    expect(offlinePreviewErrorCode(new Error(message))).toBe("offline_preview_failed");
  });
  it("allows only known finite error codes and ignores arbitrary objects", () => {
    expect(offlinePreviewErrorCode(new Error("prompt_task_spec_invalid"))).toBe(
      "prompt_task_spec_invalid",
    );
    expect(offlinePreviewErrorCode(new Error("offline_arguments_invalid"))).toBe(
      "offline_arguments_invalid",
    );
    expect(offlinePreviewErrorCode({ message: "prompt_task_spec_invalid" })).toBe(
      "offline_preview_failed",
    );
  });
  it("cannot throw or forward a second value from an adversarial message getter", () => {
    const error = new Error();
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("private_token_value");
      },
    });
    expect(offlinePreviewErrorCode(error)).toBe("offline_preview_failed");
    let reads = 0;
    const changing = new Error();
    Object.defineProperty(changing, "message", {
      get() {
        return ++reads === 1 ? "prompt_task_spec_invalid" : "private_token_value";
      },
    });
    expect(offlinePreviewErrorCode(changing)).toBe("prompt_task_spec_invalid");
    expect(reads).toBe(1);
  });
});
