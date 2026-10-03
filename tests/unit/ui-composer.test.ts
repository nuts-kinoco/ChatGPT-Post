import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegisteredOperationDestination } from "../../src/contracts/operations.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";
import { manualTaskTemplate, UiComposer, type UiComposerPort } from "../../src/ui/composer.js";
import { demoTask } from "../../src/ui/demo.js";
import { issuerReadPort } from "../../src/ui/issuer-read-port.js";
import { UiOperationsService } from "../../src/ui/operations.js";

const resources: { path: string; registry: ProjectRegistry }[] = [];
afterEach(async () => {
  for (const r of resources.splice(0)) {
    r.registry.close();
    await rm(r.path, { recursive: true, force: true });
  }
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "bridge-composer-")),
    registry = new ProjectRegistry(join(path, "registry.db"));
  resources.push({ path, registry });
  const task = JSON.parse(demoTask({}).rawSpec);
  const project = {
    projectId: "12435678-1234-4234-8234-123456789abc",
    repoId: task.repo,
    storageSlug: "synthetic-project",
    displayName: "Synthetic project",
    githubDestination: null,
    outputRootOverride: null,
  };
  registry.configure(
    {
      schema: "bridge-project-registry-1",
      revision: 1,
      defaultOutputRoot: null,
      projects: [project],
    },
    0,
  );
  const destination: RegisteredOperationDestination = {
    destinationId: "synthetic-cli",
    route: "cli",
    recipientActorId: "synthetic-recipient",
    providerId: "synthetic-agent",
    modelIds: [task.requested_model],
    capabilities: {},
    unavailableReason: null,
    policyHash: task.policy_snapshot_sha256,
  };
  const operations = new UiOperationsService({ registry, destinations: () => [destination] });
  const issue = vi.fn(async () => ({ commit: "a".repeat(40) }));
  const port: UiComposerPort = { prepare: manualTaskTemplate(task), issue };
  const composer = new UiComposer(operations, port);
  const input = {
    registryRevision: 1,
    projectId: project.projectId,
    destinations: [{ destinationId: destination.destinationId, modelId: task.requested_model }],
    title: "Synthetic task",
    instruction: "No model or process is invoked by this test",
  };
  return { registry, project, destination, operations, port, composer, input, issue };
}
function binding(preview: unknown) {
  return {
    previewId: (preview as { previewId: string }).previewId,
    previewSha256: sha256Bytes(Buffer.from(JSON.stringify(preview))),
  };
}
describe("registered manual preview and shared LLM read port", () => {
  it("generates exact JSON/MD without issuing; explicit issue reuses UUIDs and cached transport receipt", async () => {
    const f = await fixture(),
      preview = await f.composer.preview(f.input);
    expect(f.issue).not.toHaveBeenCalled();
    const child = preview.children[0];
    if (!child) throw new Error("Expected synthetic preview child");
    expect(sha256Bytes(Buffer.from(child.taskMarkdown))).toBe(child.taskFileHash);
    expect(JSON.parse(child.rawSpec).task_file_hash).toBe(child.taskFileHash);
    expect(JSON.parse(child.rawSpec).approval.tier).toBe("manual");
    const first = await f.composer.issue(binding(preview));
    expect(await f.composer.issue(binding(preview))).toEqual(first);
    expect(f.issue).toHaveBeenCalledTimes(1);
    expect(f.issue.mock.calls[0]?.[0]).toMatchObject({
      children: [{ requestId: child.requestId, rawSpec: child.rawSpec }],
    });
  });
  it("rejects stale registration, policy/model drift, raw secret fields and changed preview digest", async () => {
    const f = await fixture(),
      preview = await f.composer.preview(f.input);
    await expect(f.composer.preview({ ...f.input, token: "fake" })).rejects.toThrow();
    await expect(
      f.composer.issue({ ...binding(preview), previewSha256: "b".repeat(64) }),
    ).rejects.toThrow();
    f.destination.policyHash = "b".repeat(64);
    await expect(f.composer.issue(binding(preview))).rejects.toThrow("changed after preview");
    expect(f.issue).not.toHaveBeenCalled();
  });
  it("fences concurrent issue after the async catalogue read", async () => {
    const f = await fixture();
    let release!: (value: { commit: string }) => void;
    f.port.issue = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const preview = await f.composer.preview(f.input);
    const first = f.composer.issue(binding(preview));
    await vi.waitFor(() => expect(f.port.issue).toHaveBeenCalledTimes(1));
    await expect(f.composer.issue(binding(preview))).rejects.toThrow("already being issued");
    release({ commit: "a".repeat(40) });
    await first;
    expect(f.port.issue).toHaveBeenCalledTimes(1);
  });
  it("retains exact IDs after uncertain issue and never automatically retries", async () => {
    const f = await fixture();
    f.port.issue = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValue({ commit: "a".repeat(40) });
    const preview = await f.composer.preview(f.input);
    await expect(f.composer.issue(binding(preview))).rejects.toThrow("original request UUIDs");
    expect(f.port.issue).toHaveBeenCalledTimes(1);
    await f.composer.issue(binding(preview));
    expect(f.port.issue).toHaveBeenNthCalledWith(1, preview);
    expect(f.port.issue).toHaveBeenNthCalledWith(2, preview);
  });
  it("requires explicit model when multiple are registered and returns non-executable scoped templates", async () => {
    const f = await fixture();
    const reads = issuerReadPort(f.operations, f.port);
    const template = await reads.template(f.project.projectId, f.destination.destinationId);
    expect(template).toMatchObject({
      templateOnly: true,
      executable: false,
      modelId: "synthetic-model",
      missingInputs: ["request_id", "task_markdown", "task_file_hash"],
    });
    expect(template.taskSpecTemplate).not.toHaveProperty("request_id");
    expect(template.taskSpecTemplate).not.toHaveProperty("task_file_hash");
    f.destination.modelIds = ["synthetic-model", "second-model"];
    await expect(reads.template(f.project.projectId, f.destination.destinationId)).rejects.toThrow(
      "explicit registered model",
    );
    expect(f.issue).not.toHaveBeenCalled();
  });
  it("keeps unconfigured recipe disabled", async () => {
    const f = await fixture();
    expect(new UiComposer(f.operations, undefined).capability().enabled).toBe(false);
    await expect(
      issuerReadPort(f.operations, undefined).template(
        f.project.projectId,
        f.destination.destinationId,
      ),
    ).rejects.toThrow("unconfigured");
  });
});
