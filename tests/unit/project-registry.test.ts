import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProjectRegistrySnapshot,
  parseProjectRegistry,
  projectRegistryHash,
} from "../../src/contracts/project-registry.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";

const dirs: string[] = [];
function required<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("fixture_missing");
  return v;
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-registry-"));
  dirs.push(dir);
  const registry = new ProjectRegistry(join(dir, "registry.db"));
  const snapshot: ProjectRegistrySnapshot = {
    schema: "bridge-project-registry-1",
    revision: 1,
    defaultOutputRoot: "/output/a",
    projects: [
      {
        projectId: randomUUID(),
        repoId: "pixivvault",
        storageSlug: "PixivVault",
        displayName: "Pixiv Vault",
        githubDestination: {
          repositoryFullName: "owner/bus",
          branch: "main",
          namespace: "bridge-v2",
        },
        outputRootOverride: null,
      },
    ],
  };
  return { dir, registry, snapshot };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("historical project registry", () => {
  it("preserves old exact mapping and root while cosmetic/storage edits affect only next revision", () => {
    const { registry, snapshot } = fixture();
    try {
      const first = registry.configure(snapshot, 0);
      const second = structuredClone(snapshot);
      second.revision = 2;
      second.defaultOutputRoot = "/output/b";
      required(second.projects[0]).displayName = "New name";
      registry.configure(second, 1);
      expect(registry.snapshot(1)).toEqual(snapshot);
      expect(registry.snapshotHash(1)).toBe(first.sha256);
      expect(registry.defaultOutputRoot(1)).toBe("/output/a");
      expect(registry.defaultOutputRoot(2)).toBe("/output/b");
      expect(registry.resolve(1, "pixivvault").displayName).toBe("Pixiv Vault");
      const detached = registry.snapshot();
      required(detached.projects[0]).storageSlug = "mutated";
      expect(required(registry.snapshot().projects[0]).storageSlug).toBe("PixivVault");
    } finally {
      registry.close();
    }
  });
  it("uses CAS and never reassigns a removed historical identity, repo, or case-insensitive slug", () => {
    const { registry, snapshot } = fixture();
    try {
      registry.configure(snapshot, 0);
      expect(() => registry.configure({ ...snapshot, revision: 2 }, 0)).toThrow(
        "revision_conflict",
      );
      registry.configure({ ...snapshot, revision: 2, projects: [] }, 1);
      for (const change of [
        { projectId: randomUUID() },
        { repoId: "other" },
        { storageSlug: "pixivvault" },
      ]) {
        const next = {
          ...snapshot,
          revision: 3,
          projects: [{ ...required(snapshot.projects[0]), ...change }],
        };
        expect(() => registry.configure(next, 2)).toThrow("migration_required");
      }
      expect(registry.currentRevision()).toBe(2);
      expect(registry.resolve(1, "pixivvault").storageSlug).toBe("PixivVault");
    } finally {
      registry.close();
    }
  });
  it("reopens durable snapshots without importing current settings as old history", () => {
    const { dir, registry, snapshot } = fixture();
    registry.configure(snapshot, 0);
    registry.close();
    const reopened = new ProjectRegistry(join(dir, "registry.db"));
    try {
      expect(reopened.snapshotHash(1)).toBe(projectRegistryHash(snapshot));
      expect(() => reopened.snapshot(2)).toThrow("revision_missing");
      expect(() => reopened.resolve(1, "unknown")).toThrow("not_registered");
    } finally {
      reopened.close();
    }
  });
  it.each(["../bad", "a/b", "bad name", "CON:", "a\\b"])("rejects unsafe slug %s", (slug) => {
    const { registry, snapshot } = fixture();
    try {
      required(snapshot.projects[0]).storageSlug = slug;
      expect(() => registry.configure(snapshot, 0)).toThrow();
    } finally {
      registry.close();
    }
  });
  it.each(["/out/../secret", "relative", "/out\u0000bad"])("rejects invalid root %s", (root) => {
    const { registry, snapshot } = fixture();
    try {
      snapshot.defaultOutputRoot = root;
      expect(() => registry.configure(snapshot, 0)).toThrow();
    } finally {
      registry.close();
    }
  });
  it("rejects duplicate keys, identities and unknown fields", () => {
    const { registry, snapshot } = fixture();
    try {
      expect(() => parseProjectRegistry(Buffer.from('{"schema":"x","schema":"y"}'))).toThrow();
      expect(() =>
        parseProjectRegistry(Buffer.from(JSON.stringify({ ...snapshot, extra: true }))),
      ).toThrow();
      snapshot.projects.push({ ...required(snapshot.projects[0]) });
      expect(() => registry.configure(snapshot, 0)).toThrow();
    } finally {
      registry.close();
    }
  });
  it("rejects replaceable non-sticky ancestors even when the leaf is private", () => {
    const { dir, registry } = fixture();
    registry.close();
    const ancestor = join(dir, "public");
    mkdirSync(ancestor);
    chmodSync(ancestor, 0o777);
    const leaf = join(ancestor, "private");
    mkdirSync(leaf, { mode: 0o700 });
    expect(() => new ProjectRegistry(join(leaf, "db"))).toThrow("ancestor_untrusted");
  });
  it("rejects symlink metadata and broadly writable state directories", () => {
    const { dir, registry } = fixture();
    registry.close();
    symlinkSync(join(dir, "registry.db"), join(dir, "link.db"));
    expect(() => new ProjectRegistry(join(dir, "link.db"))).toThrow("file_untrusted");
    const child = join(dir, "shared");
    mkdirSync(child);
    chmodSync(child, 0o777);
    expect(() => new ProjectRegistry(join(child, "db"))).toThrow("untrusted");
  });
});
