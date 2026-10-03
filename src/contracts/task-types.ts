/** Bridge v2 wire types. Structural validity never authenticates execution evidence. */
export type TaskMode = "design_fixture" | "read_only" | "edit";
export type TaskStatus =
  | "received"
  | "awaiting_approval"
  | "approved"
  | "running"
  | "cancel_requested"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "unknown";
export type TerminalTaskStatus = "cancelled" | "succeeded" | "failed";
export interface ArtifactRef {
  artifact_id: string;
  sha256: string;
  size_bytes: number;
  media_type: "text/plain" | "text/x-diff" | "application/json" | "application/octet-stream";
}
export interface TaskPathRule {
  path: string;
  scope: "exact" | "subtree";
  permissions: ("read" | "write")[];
}
export interface TaskCommandRule {
  command_id: string;
  executable_id: string;
  executable_sha256: string;
  argv: string[];
  cwd: string;
  max_runs: number;
  accepted_exit_codes: number[];
}
export interface SuccessCriterion {
  criterion_id: string;
  description: string;
  evaluator_id: string;
}
export type ApprovalTier = "manual" | "automatic" | "bypass";
export interface PreauthorizationRef {
  policy_id: string;
  policy_version: number;
  policy_sha256: string;
  session_id: string;
}
export interface TaskSpec {
  protocol_version: "2.0";
  request_id: string;
  agent: string;
  requested_model: string;
  repo: string;
  base_commit: string;
  mode: TaskMode;
  policy_snapshot_sha256: string;
  allowed_paths: TaskPathRule[];
  allowed_commands: TaskCommandRule[];
  task_file: string;
  task_file_hash: string;
  approval: {
    tier: ApprovalTier;
    preauthorization: PreauthorizationRef | null;
    required: true;
    binding: "sha256-raw-task-spec";
    source: "detached-authoritative-record";
    max_age_seconds: number;
    max_starts: 1;
  };
  timeout: { run_seconds: number; cancel_grace_seconds: number };
  success_criteria: SuccessCriterion[];
  task_network: "deny";
  environment: Record<string, never>;
  retry_policy: "no-automatic-reexecution";
}
export interface ApprovalEnvelope {
  protocol_version: "2.0";
  tier: ApprovalTier;
  preauthorization: PreauthorizationRef | null;
  usage_reservation_id: string | null;
  approval_id: string;
  request_id: string;
  decision: "approved" | "denied" | "revoked";
  task_spec_sha256: string;
  task_file_sha256: string;
  policy_snapshot_sha256: string;
  bridge_id: string;
  executor_id: string;
  approver_id: string;
  issued_at: string;
  expires_at: string;
  nonce: string;
  max_starts: 0 | 1;
}
export interface ProcessIdentity {
  host_id: string;
  boot_id: string;
  pid: number;
  creation_time: string;
  executable_sha256: string;
  process_group_id: string;
}
export interface CommandRun {
  invocation_id: string;
  command_id: string;
  executable_id: string;
  resolved_binary_sha256: string;
  argv_sha256: string;
  cwd: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  termination: "running" | "exited" | "killed" | "unknown";
  stdout_ref: ArtifactRef | null;
  stderr_ref: ArtifactRef | null;
}
export interface TestResult {
  test_id: string;
  criterion_id: string;
  outcome: "passed" | "failed" | "skipped" | "unknown";
  command_invocation_ids: string[];
  evidence_ref: ArtifactRef | null;
}
export interface ChangedFile {
  path: string;
  change: "added" | "modified" | "deleted";
  before_sha256: string | null;
  after_sha256: string | null;
}
export interface TaskReceipt {
  receipt_id: string;
  request_id: string;
  task_spec_sha256: string;
  run_id: string | null;
  fencing_token: number;
  ledger_sequence: number;
  terminal_status: TerminalTaskStatus;
  process_state: "never_started" | "all_terminated";
  recorded_at: string;
  evidence_ref: ArtifactRef;
}
export interface TaskResult {
  protocol_version: "2.0";
  request_id: string;
  task_spec_hash: string;
  task_file_hash: string;
  synthetic: boolean;
  status: TaskStatus;
  last_confirmed_status: Exclude<TaskStatus, "unknown"> | null;
  observation_seq: number;
  observed_at: string;
  outcome_known: boolean;
  started_at: string | null;
  finished_at: string | null;
  actual_agent: string | null;
  actual_model: string | null;
  base_commit: string;
  resulting_commit: string | null;
  run_id: string | null;
  fencing_token: number;
  process_identity: ProcessIdentity | null;
  commands_run: CommandRun[];
  tests: TestResult[];
  exit_codes: { invocation_id: string; exit_code: number | null }[];
  changed_files: ChangedFile[];
  diff: { kind: "none" | "git_binary_patch"; complete: boolean; artifact_ref: ArtifactRef | null };
  stdout_ref: ArtifactRef | null;
  stderr_ref: ArtifactRef | null;
  error: { code: string; message: string; retryable: false } | null;
  receipt: TaskReceipt | null;
  verification: {
    state: "pending" | "verified" | "rejected" | "synthetic";
    checked_at: string | null;
    evidence_ref: ArtifactRef | null;
  };
}
export type ResultSpec = TaskResult;
