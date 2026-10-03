/** Immutable historical project snapshots. Saving config does not activate a route, policy,
 * permission, credential, notification or filesystem write outside this private metadata DB. */
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ProjectRegistration,
  type ProjectRegistryPort,
  type ProjectRegistrySnapshot,
  parseProjectRegistry,
  projectRegistryHash,
  serializeProjectRegistry,
} from "../contracts/project-registry.js";
export class ProjectRegistry implements ProjectRegistryPort {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (process.platform === "win32") throw new Error("registry_windows_acl_verifier_unavailable");
    const parent = dirname(path);
    // A private leaf inside an attacker-replaceable ancestor is not a trusted registry.
    // Sticky system temporary parents protect an already-owned child against other users;
    // a non-sticky group/world-writable parent never does.
    for (let ancestor = parent; ; ancestor = dirname(ancestor)) {
      const stat = lstatSync(ancestor);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        realpathSync(ancestor) !== ancestor ||
        (stat.uid !== process.getuid?.() && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
      )
        throw new Error("registry_state_ancestor_untrusted");
      if (dirname(ancestor) === ancestor) break;
    }
    const directory = lstatSync(parent);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      realpathSync(parent) !== parent ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o077) !== 0
    )
      throw new Error("registry_state_directory_untrusted");
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const file = lstatSync(path);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.nlink !== 1 ||
      file.uid !== process.getuid?.() ||
      (file.mode & 0o077) !== 0
    )
      throw new Error("registry_state_file_untrusted");
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS project_registry_history (revision INTEGER PRIMARY KEY, snapshot_hash TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS project_registry_identities (project_id TEXT PRIMARY KEY, repo_id TEXT UNIQUE NOT NULL, slug_key TEXT UNIQUE NOT NULL, slug TEXT NOT NULL);",
    );
  }
  currentRevision(): number {
    return Number(
      this.db.prepare("SELECT MAX(revision) AS revision FROM project_registry_history").get()
        ?.revision ?? 0,
    );
  }
  snapshot(revision = this.currentRevision()): ProjectRegistrySnapshot {
    const row = this.db
      .prepare("SELECT body,snapshot_hash FROM project_registry_history WHERE revision=?")
      .get(revision) as { body: string; snapshot_hash: string } | undefined;
    if (!row) throw new Error("project_registry_revision_missing");
    const value = parseProjectRegistry(Buffer.from(row.body));
    if (value.revision !== revision || projectRegistryHash(value) !== row.snapshot_hash)
      throw new Error("project_registry_corrupt");
    return value;
  }
  snapshotHash(revision: number): string {
    return projectRegistryHash(this.snapshot(revision));
  }
  defaultOutputRoot(revision: number): string | null {
    return this.snapshot(revision).defaultOutputRoot;
  }
  resolve(revision: number, repoId: string): ProjectRegistration {
    const project = this.snapshot(revision).projects.find((row) => row.repoId === repoId);
    if (!project) throw new Error("project_not_registered_at_revision");
    return project;
  }
  /** Trusted local settings endpoint only. Route changes remain unconfigured until a separately
   * approved host route/policy with matching destination is supplied. Existing jobs keep old pins. */
  configure(
    snapshot: ProjectRegistrySnapshot,
    expectedRevision: number,
  ): { revision: number; sha256: string } {
    const bytes = serializeProjectRegistry(snapshot);
    const value = parseProjectRegistry(Buffer.from(bytes));
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      value.revision !== expectedRevision + 1
    )
      throw new Error("project_registry_revision_conflict");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.currentRevision() !== expectedRevision)
        throw new Error("project_registry_revision_conflict");
      if (expectedRevision >= 10000) throw new Error("project_registry_history_limit");
      for (const project of value.projects) {
        const known = this.db
          .prepare(
            "SELECT project_id,repo_id,slug FROM project_registry_identities WHERE project_id=? OR repo_id=? OR slug_key=?",
          )
          .all(project.projectId, project.repoId, project.storageSlug.toLowerCase()) as {
          project_id: string;
          repo_id: string;
          slug: string;
        }[];
        if (
          known.some(
            (row) =>
              row.project_id !== project.projectId ||
              row.repo_id !== project.repoId ||
              row.slug !== project.storageSlug,
          )
        )
          throw new Error("project_identity_migration_required");
        this.db
          .prepare("INSERT OR IGNORE INTO project_registry_identities VALUES (?,?,?,?)")
          .run(
            project.projectId,
            project.repoId,
            project.storageSlug.toLowerCase(),
            project.storageSlug,
          );
      }
      const sha256 = projectRegistryHash(value);
      this.db
        .prepare("INSERT INTO project_registry_history VALUES (?,?,?)")
        .run(value.revision, sha256, bytes);
      this.db.exec("COMMIT");
      return { revision: value.revision, sha256 };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
}
