/** Local UI contract. Request bodies are validated with the checked-in JSON Schema. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { taskPreflight } from "../state/task-preflight.js";
import type { TaskHandshake, TaskRecord } from "../state/task-store.js";
import { REPO_ROOT } from "./schema.js";
import type { ApprovalEnvelope, ResultSpec, TaskSpec, TaskStatus } from "./task-types.js";

export type UiProfile = "production" | "demo";
export type UiAction =
  | "validate"
  | "import"
  | "approve"
  | "start"
  | "cancel"
  | "reconcile"
  | "ack"
  | "demo";
export interface UiCapability {
  enabled: boolean;
  reason: string;
}
export type UiCapabilities = Record<UiAction, UiCapability>;
export interface UiMetadata {
  profile: UiProfile;
  synthetic: boolean;
  label: string;
}
export interface UiTaskSummary {
  requestId: string;
  title: string;
  status: TaskStatus;
  sequence: number;
  synthetic: boolean;
  updatedAt: string;
  runId: string | null;
  outcomeKnown: boolean;
  deliveryAcknowledged: boolean;
}
export interface UiDiagnostics {
  checks: { id: string; status: "ok" | "blocked" | "unknown"; message: string }[];
  executionEnabled: boolean;
  approvalConfigured: boolean;
  quota: { state: "unknown"; source: "unknown"; billingEstimate: null };
  automaticReexecution: false;
}
export interface UiTaskDetail {
  summary: UiTaskSummary;
  spec: TaskSpec;
  rawSpec: string;
  taskMarkdown: string;
  result: ResultSpec;
  intent: TaskRecord["intent"];
  events: ResultSpec[];
  approvals: { envelope: ApprovalEnvelope; consumed: boolean }[];
  handshakes: Record<TaskHandshake["stage"], TaskHandshake | null>;
  delivery: {
    acknowledged: boolean;
    payloadSha256: string | null;
    materialization?: "verified" | "pending" | "synthetic_demo";
    materializationSha256?: string | null;
    payloadAckObserved?: boolean;
  };
  preflight: ReturnType<typeof taskPreflight>;
  capabilities: UiCapabilities;
}
export interface UiBootstrap extends UiMetadata {
  capabilities: UiCapabilities;
  tasks: UiTaskSummary[];
  diagnostics: UiDiagnostics;
}
export interface UiTaskResponse extends UiMetadata {
  task: UiTaskDetail;
}
export interface UiValidation extends UiMetadata {
  valid: boolean;
  errors: string[];
  taskSpecHash: string | null;
  taskFileHash: string;
  requestId: string | null;
}
export interface UiImport {
  rawSpec: string;
  taskMarkdown: string;
}
export interface UiBinding {
  taskSpecHash: string;
  taskFileHash: string;
  sequence: number;
}
export interface UiAck {
  eventId: string;
  payloadSha256: string;
  sequence: number;
}
export interface UiDemoTask {
  title?: string;
  taskMarkdown?: string;
}
export type UiDemoOutcome = "succeeded" | "failed" | "unknown";
export class UiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export interface UiErrorEnvelope {
  error: { code: string; message: string; retryable: false; reexecute: false };
}
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(ajv);
ajv.addSchema(
  JSON.parse(readFileSync(join(REPO_ROOT, "schemas/ui-request.schema.json"), "utf8")) as object,
);
const validators = new Map<string, ValidateFunction>();
export function validateUiBody(
  kind:
    | "import"
    | "empty"
    | "bound"
    | "ack"
    | "demo"
    | "observation"
    | "archive-settings"
    | "archive-probe",
  value: unknown,
): void {
  let validator = validators.get(kind);
  if (!validator) {
    validator = ajv.compile({
      $ref: `https://example.invalid/bridge-v2/ui-request.schema.json#/$defs/${kind}`,
    });
    validators.set(kind, validator);
  }
  if (!validator(value))
    throw new UiError("invalid_request", "Request body does not match the UI contract");
}
