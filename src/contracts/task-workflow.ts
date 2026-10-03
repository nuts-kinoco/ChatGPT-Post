/** Detached workflow authority extension v1; deliberately outside frozen TaskSpec v2.
 * Hash Tasks first, then this manifest; the policy snapshot MUST NOT include either digest.
 * The separately authenticated workflow grant binds the manifest and policy together.
 */
import { parseStrictJsonBytes, sha256Bytes } from "./task.js";

export interface WorkflowDependency {
  request_id: string;
  expected_commit: string | null;
  require_result_ack: boolean;
}
export interface WorkflowManifest {
  protocol_version: "workflow-1";
  workflow_id: string;
  jobs: { request_id: string; task_spec_sha256: string; depends_on: WorkflowDependency[] }[];
}
export interface WorkflowGrant {
  protocol_version: "workflow-grant-1";
  grant_id: string;
  nonce: string;
  max_starts: number;
  workflow_id: string;
  manifest_sha256: string;
  policy_snapshot_sha256: string;
  session_id: string;
  bridge_id: string;
  approver_id: string;
  decision: "approved" | "revoked";
  issued_at: string;
  expires_at: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const hash = /^[0-9a-f]{64}(?![\s\S])/;
const commit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\s\S])/;
const id = /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("invalid_workflow_structure");
  return value as Record<string, unknown>;
}
function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.test(value);
}
export function parseWorkflowManifest(raw: Uint8Array): {
  manifest: WorkflowManifest;
  hash: string;
} {
  if (raw.byteLength > 262144) throw new Error("workflow_too_large");
  const data = object(parseStrictJsonBytes(raw), ["protocol_version", "workflow_id", "jobs"]);
  if (
    data.protocol_version !== "workflow-1" ||
    !matches(data.workflow_id, uuid) ||
    !Array.isArray(data.jobs) ||
    !data.jobs.length ||
    data.jobs.length > 256
  )
    throw new Error("invalid_workflow_structure");
  const ids = new Set<string>();
  for (const entry of data.jobs) {
    const job = object(entry, ["request_id", "task_spec_sha256", "depends_on"]);
    if (
      !matches(job.request_id, uuid) ||
      !matches(job.task_spec_sha256, hash) ||
      !Array.isArray(job.depends_on) ||
      job.depends_on.length > 256 ||
      ids.has(job.request_id as string)
    )
      throw new Error("invalid_workflow_job");
    ids.add(job.request_id as string);
    const deps = new Set<string>();
    for (const item of job.depends_on) {
      const dep = object(item, ["request_id", "expected_commit", "require_result_ack"]);
      if (
        !matches(dep.request_id, uuid) ||
        (dep.expected_commit !== null && !matches(dep.expected_commit, commit)) ||
        typeof dep.require_result_ack !== "boolean" ||
        deps.has(dep.request_id as string)
      )
        throw new Error("invalid_workflow_dependency");
      deps.add(dep.request_id as string);
    }
  }
  const manifest = data as unknown as WorkflowManifest;
  const jobs = new Map(manifest.jobs.map((job) => [job.request_id, job]));
  const active = new Set<string>();
  const done = new Set<string>();
  function visit(requestId: string): void {
    if (active.has(requestId)) throw new Error("dependency_cycle");
    if (done.has(requestId)) return;
    const job = jobs.get(requestId);
    if (!job) throw new Error("workflow_missing_reference");
    active.add(requestId);
    for (const dep of job.depends_on) visit(dep.request_id);
    active.delete(requestId);
    done.add(requestId);
  }
  for (const requestId of ids) visit(requestId);
  return { manifest, hash: sha256Bytes(raw) };
}
export function checkWorkflowGrant(
  grant: WorkflowGrant,
  manifest: WorkflowManifest,
  manifestHash: string,
  now: Date,
): void {
  object(grant, [
    "protocol_version",
    "grant_id",
    "nonce",
    "max_starts",
    "workflow_id",
    "manifest_sha256",
    "policy_snapshot_sha256",
    "session_id",
    "bridge_id",
    "approver_id",
    "decision",
    "issued_at",
    "expires_at",
  ]);
  if (
    grant.protocol_version !== "workflow-grant-1" ||
    !matches(grant.grant_id, uuid) ||
    !matches(grant.nonce, uuid) ||
    !Number.isSafeInteger(grant.max_starts) ||
    grant.max_starts < 1 ||
    grant.max_starts > manifest.jobs.length ||
    grant.workflow_id !== manifest.workflow_id ||
    grant.manifest_sha256 !== manifestHash ||
    !matches(grant.policy_snapshot_sha256, hash) ||
    !matches(grant.session_id, uuid) ||
    !matches(grant.bridge_id, id) ||
    !matches(grant.approver_id, id) ||
    grant.decision !== "approved"
  )
    throw new Error("workflow_grant_mismatch");
  const timestamp =
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z(?![\s\S])/;
  if (!matches(grant.issued_at, timestamp) || !matches(grant.expires_at, timestamp))
    throw new Error("workflow_grant_expired");
  for (const value of [grant.issued_at, grant.expires_at]) {
    const day = value.slice(0, 10);
    const parsed = new Date(value);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 19) !== value.slice(0, 19) ||
      parsed.toISOString().slice(0, 10) !== day
    )
      throw new Error("workflow_grant_expired");
  }
  const issued = Date.parse(grant.issued_at);
  const expires = Date.parse(grant.expires_at);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > now.getTime() ||
    expires <= now.getTime() ||
    expires <= issued ||
    expires - issued > 86400000
  )
    throw new Error("workflow_grant_expired");
}
