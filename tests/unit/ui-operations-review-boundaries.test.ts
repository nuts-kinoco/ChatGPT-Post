import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { sha256Bytes } from "../../src/contracts/task.js";
import type { TaskSpec } from "../../src/contracts/task-types.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";
import { manualTaskTemplate, UiComposer } from "../../src/ui/composer.js";
import { demoTask } from "../../src/ui/demo.js";
import {
  type OperationIdPage,
  UiOperationsService,
  type UiOperationsSources,
} from "../../src/ui/operations.js";

const unexpected = () => {
  throw new Error("Empty local page must not inspect any row");
};
const local: NonNullable<UiOperationsSources["local"]> = {
  list: () => ({ requestIds: [], next: null }),
  service: {
    task: unexpected,
    validate: unexpected,
    import: unexpected,
    approve: unexpected,
    start: unexpected,
    cancel: unexpected,
    reconcile: unexpected,
    acknowledge: unexpected,
  },
};
it.each(
  [null, {}, [], { requestIds: null, next: null }, { requestIds: ["bad"], next: null }].map(
    (value) => ({ value }),
  ),
)("isolates malformed hosted page $value", async ({ value: page }) => {
  const ops = new UiOperationsService({
    local,
    hosted: {
      list: () => page as unknown as OperationIdPage,
      get: () => null,
      policyHash: "a".repeat(64),
      conversationId: null,
      destinationId: null,
    },
  });
  const view = await ops.overview();
  expect(view.local.state).toBe("available");
  expect(view.hosted).toEqual({ state: "error", reason: "source_page_invalid" });
});
it.each([null, {}, [], { fanoutIds: null, next: null }].map((value) => ({ value })))(
  "does not turn malformed fanout page $value into empty success",
  async ({ value: page }) => {
    const ops = new UiOperationsService({
      local,
      fanout: {
        list: () => page as unknown as { fanoutIds: string[]; next: string | null },
        collect: () => {
          throw new Error("unused");
        },
      },
    });
    const view = await ops.overview();
    expect(view.local.state).toBe("available");
    expect(view.fanout.state).not.toBe("available");
  },
);
it("rechecks expiry after asynchronous catalogue validation, before issuing", async () => {
  const root = await mkdtemp(join(tmpdir(), "independent-preview-expiry-"));
  const registry = new ProjectRegistry(join(root, "registry.db"));
  let now = Date.parse("2026-10-03T08:00:00.000Z"),
    advance = false;
  const task = JSON.parse(demoTask({}).rawSpec) as TaskSpec;
  const project = {
    projectId: "12435678-1234-4234-8234-123456789abc",
    repoId: task.repo,
    storageSlug: "synthetic-project",
    displayName: "Synthetic project",
    githubDestination: null,
    outputRootOverride: null,
  };
  const destination = {
    destinationId: "synthetic-cli",
    route: "cli" as const,
    recipientActorId: "synthetic-recipient",
    providerId: task.agent,
    modelIds: [task.requested_model],
    capabilities: {},
    unavailableReason: null,
    policyHash: task.policy_snapshot_sha256,
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
  const ops = new UiOperationsService({
    registry,
    destinations: async () => {
      if (advance) now += 1001;
      return [destination];
    },
  });
  const issue = vi.fn(async () => ({ commit: "a".repeat(40) }));
  const composer = new UiComposer(
    ops,
    { prepare: manualTaskTemplate(task), issue },
    () => new Date(now),
  );
  try {
    const preview = await composer.preview({
      registryRevision: 1,
      projectId: project.projectId,
      destinations: [{ destinationId: destination.destinationId, modelId: task.requested_model }],
      title: "Synthetic",
      instruction: "No execution",
    });
    now = Date.parse(preview.expiresAt) - 1;
    advance = true;
    await expect(
      composer.issue({
        previewId: preview.previewId,
        previewSha256: sha256Bytes(Buffer.from(JSON.stringify(preview))),
      }),
    ).rejects.toMatchObject({ code: "composer_preview_expired" });
    expect(issue).not.toHaveBeenCalled();
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
