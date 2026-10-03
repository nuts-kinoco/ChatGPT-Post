import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProjectRegistry } from "../../src/state/project-registry.js";
import { UiProjectSettings } from "../../src/ui/project-settings.js";

const resources: { path: string; registry: ProjectRegistry }[] = [];
afterEach(async () => {
  for (const r of resources.splice(0)) {
    r.registry.close();
    await rm(r.path, { recursive: true, force: true });
  }
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "bridge-project-ui-"));
  const registry = new ProjectRegistry(join(path, "registry.db"));
  resources.push({ path, registry });
  return { registry, ui: new UiProjectSettings(registry) };
}
const project = {
  projectId: "12435678-1234-4234-8234-123456789abc",
  repoId: "synthetic-project",
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
it("edits the same canonical registry with prospective immutable revision pins", async () => {
  const { registry, ui } = await fixture();
  expect(ui.view()).toMatchObject({
    revision: 0,
    snapshot: null,
    executionAuthority: false,
    pathVerification: "not_probed",
  });
  ui.update({ expectedRevision: 0, snapshot });
  const hash = registry.snapshotHash(1);
  ui.update({
    expectedRevision: 1,
    snapshot: {
      ...snapshot,
      revision: 2,
      defaultOutputRoot: "/synthetic/output",
      projects: [{ ...project, displayName: "Renamed" }],
    },
  });
  expect(registry.currentRevision()).toBe(2);
  expect(registry.snapshotHash(1)).toBe(hash);
  expect(registry.resolve(1, project.repoId).displayName).toBe("Synthetic project");
  expect(registry.resolve(2, project.repoId).displayName).toBe("Renamed");
});
it("rejects stale revisions, secret fields and identity reassignment without resetting settings", async () => {
  const { registry, ui } = await fixture();
  ui.update({ expectedRevision: 0, snapshot });
  for (const input of [
    { expectedRevision: 0, snapshot },
    { expectedRevision: 1, snapshot, token: "not-a-real-secret" },
    {
      expectedRevision: 1,
      snapshot: { ...snapshot, revision: 2, projects: [{ ...project, storageSlug: "changed" }] },
    },
  ])
    expect(() => ui.update(input)).toThrow();
  expect(registry.currentRevision()).toBe(1);
});
it("keeps unavailable and read-only registries disabled", async () => {
  expect(new UiProjectSettings(undefined).view()).toMatchObject({
    state: "unavailable",
    configurable: false,
  });
  expect(() => new UiProjectSettings(undefined).update({})).toThrow("not configured");
  const { registry } = await fixture();
  const readonly = {
    currentRevision: () => registry.currentRevision(),
    snapshot: registry.snapshot.bind(registry),
    snapshotHash: registry.snapshotHash.bind(registry),
    resolve: registry.resolve.bind(registry),
  };
  expect(new UiProjectSettings(readonly).view()).toMatchObject({ configurable: false });
});
