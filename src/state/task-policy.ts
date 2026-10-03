/** Trusted deployment policy. No mode disables integrity checks or mandatory approvals. */
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { hashArgv, sha256Bytes } from "../contracts/task.js";
import type { TaskSpec } from "../contracts/task-types.js";

export interface TaskPolicy {
  bridgeId: string;
  executorId: string;
  repoId: string;
  repoRoot: string;
  baseCommit: string;
  policyHash: string;
  policyId: string;
  policyVersion: number;
  workflowHash?: string;
  revoked: boolean;
  expiresAt: string;
  sessionId: string;
  confirmation: "manual" | "autoapprove" | "bypass";
  agents: Record<string, readonly string[]>;
  modes: readonly ("read_only" | "edit")[];
  paths: TaskSpec["allowed_paths"];
  commands: TaskSpec["allowed_commands"];
  evaluators: readonly string[];
  maxStarts: number;
  maxTotalRunSeconds?: number;
  sessionDeadline: string;
  /** Explicit reservation units, not a claim about provider billing. Unknown estimates deny. */
  budget: { limit: number; perStartReservation: number | null } | null;
  /** Mandatory high-impact actions are never inferred from task prose. */
  requiresActionConfirmation: boolean;
}
export function checkRelativePath(path: string): void {
  if (
    !/^[A-Za-z0-9_-](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?(?:\/[A-Za-z0-9_-](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?)*(?![\s\S])/.test(
      path,
    )
  )
    throw new Error("path_denied");
  for (const segment of path.split("/")) {
    if (
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) ||
      segment.toLowerCase() === ".git"
    )
      throw new Error("path_denied");
  }
}
export function pathPermitted(
  task: Pick<TaskSpec, "allowed_paths" | "mode">,
  path: string,
  permission: "read" | "write",
): boolean {
  try {
    checkRelativePath(path);
  } catch {
    return false;
  }
  if (permission === "write" && task.mode !== "edit") return false;
  return task.allowed_paths.some(
    (rule) =>
      rule.permissions.includes(permission) &&
      (path === rule.path || (rule.scope === "subtree" && path.startsWith(`${rule.path}/`))),
  );
}
/** Preflight only. Real adapters must enforce race-safe confinement at each actual operation. */
export async function checkFilesystemPath(root: string, path: string): Promise<void> {
  checkRelativePath(path);
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const part of path.split("/")) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("path_link_denied");
      const canonical = await realpath(current);
      const rel = relative(canonicalRoot, canonical);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
        throw new Error("path_escape_denied");
      // Hardlinks can alias protected files. Do not grant read/write through these entries.
      if (info.isFile() && info.nlink > 1) throw new Error("path_hardlink_denied");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}
export function checkTaskPolicy(task: TaskSpec, policy: TaskPolicy, now: Date): void {
  if (task.mode === "design_fixture") throw new Error("fixture_not_executable");
  if (
    policy.revoked ||
    !Number.isFinite(Date.parse(policy.expiresAt)) ||
    Date.parse(policy.expiresAt) <= now.getTime()
  )
    throw new Error("policy_expired_or_revoked");
  if (task.repo !== policy.repoId || task.policy_snapshot_sha256 !== policy.policyHash)
    throw new Error("repo_or_policy_denied");
  if (task.base_commit !== policy.baseCommit) throw new Error("base_commit_mismatch");
  if (!policy.agents[task.agent]?.includes(task.requested_model))
    throw new Error("agent_model_denied");
  if (!policy.modes.includes(task.mode)) throw new Error("mode_denied");
  const folded = new Set<string>();
  for (const path of task.allowed_paths) {
    checkRelativePath(path.path);
    const key = path.path.toLowerCase();
    if (folded.has(key)) throw new Error("path_case_alias_denied");
    folded.add(key);
    for (const permission of path.permissions) {
      const covers = policy.paths.some(
        (allow) =>
          allow.permissions.includes(permission) &&
          (path.path === allow.path
            ? path.scope === "exact" || allow.scope === "subtree"
            : allow.scope === "subtree" && path.path.startsWith(`${allow.path}/`)),
      );
      if (!covers || (permission === "write" && task.mode !== "edit"))
        throw new Error("path_scope_denied");
    }
  }
  const ids = new Set<string>();
  for (const cmd of task.allowed_commands) {
    if (ids.has(cmd.command_id)) throw new Error("duplicate_command_id");
    ids.add(cmd.command_id);
    const allowed = policy.commands.find((c) => c.command_id === cmd.command_id);
    if (
      !allowed ||
      cmd.executable_id !== allowed.executable_id ||
      cmd.executable_sha256 !== allowed.executable_sha256 ||
      hashArgv(cmd.argv) !== hashArgv(allowed.argv) ||
      cmd.cwd !== allowed.cwd ||
      cmd.max_runs > allowed.max_runs ||
      cmd.accepted_exit_codes.some((code) => !allowed.accepted_exit_codes.includes(code))
    )
      throw new Error("command_denied");
    if (cmd.cwd !== ".") checkRelativePath(cmd.cwd);
  }
  if (task.success_criteria.some((c) => !policy.evaluators.includes(c.evaluator_id)))
    throw new Error("evaluator_denied");
  if (
    !Number.isSafeInteger(policy.maxStarts) ||
    policy.maxStarts < 1 ||
    !Number.isFinite(Date.parse(policy.sessionDeadline)) ||
    Date.parse(policy.sessionDeadline) <= now.getTime()
  )
    throw new Error("session_limit");
  if (
    policy.maxTotalRunSeconds !== undefined &&
    (!Number.isSafeInteger(policy.maxTotalRunSeconds) || policy.maxTotalRunSeconds < 1)
  )
    throw new Error("session_time_budget_invalid");
  if (
    policy.budget &&
    (policy.budget.perStartReservation === null ||
      !Number.isSafeInteger(policy.budget.limit) ||
      !Number.isSafeInteger(policy.budget.perStartReservation) ||
      policy.budget.perStartReservation < 0 ||
      policy.budget.limit < 0)
  )
    throw new Error("budget_unknown_or_invalid");
}
/** Binds deployment policy bytes for callers that keep policy as an immutable file. */
export function policyHash(raw: Uint8Array): string {
  return sha256Bytes(raw);
}
