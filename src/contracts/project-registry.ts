/** Storage/routing configuration identity, separate from execution-policy authority. */
import { isAbsolute } from "node:path";
import { checkRelativePath } from "../state/task-policy.js";
import { parseStrictJsonBytes, sha256Bytes } from "./task.js";
export interface GitHubProjectDestination {
  repositoryFullName: string;
  branch: string;
  namespace: string;
}
export interface ProjectRegistration {
  projectId: string;
  repoId: string;
  storageSlug: string;
  displayName: string;
  githubDestination: GitHubProjectDestination | null;
  outputRootOverride: string | null;
}
export interface ProjectRegistrySnapshot {
  schema: "bridge-project-registry-1";
  revision: number;
  defaultOutputRoot: string | null;
  projects: ProjectRegistration[];
}
export interface ProjectRegistrationReference {
  projectId: string;
  registryRevision: number;
  snapshotSha256: string;
}
export interface ProjectRegistryPort {
  currentRevision(): number;
  snapshot(revision?: number): ProjectRegistrySnapshot;
  resolve(revision: number, repoId: string): ProjectRegistration;
  defaultOutputRoot(revision: number): string | null;
  snapshotHash(revision: number): string;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new Error("project_registry_invalid");
  return value as Record<string, unknown>;
}
function root(value: unknown): void {
  if (value === null) return;
  // Validate portable absolute configuration syntax only. Native identity/ACL/reparse checks are
  // mandatory at pin/probe/write; a syntactically valid Windows path is not a granted capability.
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\0\r\n]/.test(value) ||
    !(isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) ||
    value.split(/[\\/]/).some((part) => part === ".." || part === ".")
  )
    throw new Error("project_output_root_invalid");
}
export function parseProjectRegistry(bytes: Uint8Array): ProjectRegistrySnapshot {
  if (bytes.length > 1024 * 1024) throw new Error("project_registry_too_large");
  const value = object(parseStrictJsonBytes(bytes), [
    "schema",
    "revision",
    "defaultOutputRoot",
    "projects",
  ]);
  if (
    value.schema !== "bridge-project-registry-1" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !Array.isArray(value.projects) ||
    value.projects.length > 256
  )
    throw new Error("project_registry_invalid");
  root(value.defaultOutputRoot);
  const ids = new Set<string>();
  const repos = new Set<string>();
  const slugs = new Set<string>();
  for (const row of value.projects) {
    const project = object(row, [
      "projectId",
      "repoId",
      "storageSlug",
      "displayName",
      "githubDestination",
      "outputRootOverride",
    ]);
    if (
      typeof project.projectId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(project.projectId) ||
      ids.has(project.projectId) ||
      typeof project.repoId !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(project.repoId) ||
      repos.has(project.repoId) ||
      typeof project.storageSlug !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(project.storageSlug) ||
      slugs.has(project.storageSlug.toLowerCase()) ||
      typeof project.displayName !== "string" ||
      !project.displayName.trim() ||
      project.displayName.length > 128 ||
      /[\0\r\n]/.test(project.displayName)
    )
      throw new Error("project_registration_invalid");
    checkRelativePath(project.storageSlug);
    root(project.outputRootOverride);
    if (project.githubDestination !== null) {
      const destination = object(project.githubDestination, [
        "repositoryFullName",
        "branch",
        "namespace",
      ]);
      if (
        typeof destination.repositoryFullName !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(destination.repositoryFullName) ||
        typeof destination.branch !== "string" ||
        !/^[A-Za-z0-9_/-]{1,200}$/.test(destination.branch) ||
        destination.branch.includes("//") ||
        typeof destination.namespace !== "string" ||
        !/^[a-z0-9-]{1,64}$/.test(destination.namespace)
      )
        throw new Error("project_destination_invalid");
    }
    ids.add(project.projectId);
    repos.add(project.repoId);
    slugs.add(project.storageSlug.toLowerCase());
  }
  return value as unknown as ProjectRegistrySnapshot;
}
export function serializeProjectRegistry(snapshot: ProjectRegistrySnapshot): string {
  const bytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
  parseProjectRegistry(bytes);
  return bytes.toString();
}
export function projectRegistryHash(snapshot: ProjectRegistrySnapshot): string {
  return sha256Bytes(Buffer.from(serializeProjectRegistry(snapshot)));
}
