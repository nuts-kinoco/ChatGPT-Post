/** Versioned route-neutral projection. This is not TaskSpec/ResultSpec or execution authority. */
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ProjectRegistrationReference } from "./project-registry.js";
import type { ResultSpec, TaskStatus } from "./task-types.js";
import { type UiCapability, UiError, type UiTaskDetail } from "./ui.js";

export const OPERATIONS_VERSION = "bridge-operations-1" as const;
export type OperationKind = "local_execution" | "hosted_delivery" | "fanout";
export type OperationRoute = "cli" | "ordinary_chat_browser";
export type OperationAction =
  | "validate"
  | "import"
  | "approve"
  | "start"
  | "cancel"
  | "reconcile"
  | "collect"
  | "ack"
  | "archive"
  | "export";
export type OperationCapabilities = Record<OperationAction, UiCapability>;
export type OperationSource<T> =
  | { state: "available"; value: T }
  | { state: "unavailable" | "error" | "timeout"; reason: string };
export interface OperationsPage<T> {
  items: OperationSource<T>[];
  next: string | null;
}
export interface LocalOperationBinding {
  kind: "local_execution";
  requestId: string;
  taskSpecHash: string;
  taskFileHash: string;
  sequence: number;
}
export interface HostedOperationBinding {
  kind: "hosted_delivery";
  requestId: string;
  taskSpecHash: string;
  attemptId: string | null;
  revision: number;
}
export type OperationBinding = LocalOperationBinding | HostedOperationBinding;
export interface OperationTerminalBinding {
  eventId: string;
  payloadSha256: string;
}
export type OperationsMutation =
  | {
      version: typeof OPERATIONS_VERSION;
      action: "approve" | "start" | "cancel" | "reconcile" | "archive";
      binding: OperationBinding;
    }
  | {
      version: typeof OPERATIONS_VERSION;
      action: "ack";
      binding: OperationBinding;
      terminal: OperationTerminalBinding;
    };
export interface RegisteredOperationDestination {
  destinationId: string;
  route: OperationRoute;
  recipientActorId: string;
  providerId: string;
  modelIds: readonly string[];
  capabilities: Partial<OperationCapabilities>;
  unavailableReason: string | null;
  policyHash: string;
}
export interface OperationProject {
  reference: ProjectRegistrationReference | null;
  repoId: string;
  state: "pinned" | "legacy_unpinned" | "unavailable" | "mismatch";
  displayName: string | null;
  storageSlug: string | null;
  reason: string | null;
}
export interface OperationDependency {
  requestId: string;
  taskSpecHash: string;
  requireAck: boolean;
  expectedCommit: string | null;
}
export interface OperationContext {
  requesterId: string | null;
  recipientActorId: string | null;
  destinationId: string | null;
  project: OperationProject;
  dependencies: OperationSource<OperationDependency[]>;
  sessionId: string | null;
}
export interface OperationArchive {
  state: "complete" | "pending" | "unavailable";
  manifestSha256: string | null;
  admissionSha256: string | null;
  reason: string | null;
}
export interface OperationDelivery {
  payloadAckObserved: boolean;
  materialization: "verified" | "pending" | "unavailable";
  fullDeliverySufficient: boolean;
  materializationReceiptSha256: string | null;
  reason: string;
}
export interface OperationPresentation {
  title: string;
  requestedProvider: string | null;
  requestedModel: string | null;
  actualProvider: string | null;
  actualModel: string | null;
  observedAt: string | null;
  /** This is an observation, never a liveness claim. */
  evidence: "last_observed";
}
export interface LocalOperation {
  version: typeof OPERATIONS_VERSION;
  kind: "local_execution";
  binding: LocalOperationBinding;
  presentation: OperationPresentation;
  context: OperationContext;
  /** Exact established PR2 contract, not a rewritten local result. */
  task: UiTaskDetail;
  delivery: OperationDelivery;
  archive: OperationSource<OperationArchive>;
  resources: OperationSource<OperationResources>;
  capabilities: OperationCapabilities;
}
export type HostedOperationState =
  | "awaiting_approval"
  | "approved"
  | "unknown"
  | "completed"
  | "blocked_auth"
  | "failed";
export interface HostedOperation {
  rawSpec: string;
  taskMarkdown: string;
  responseMarkdown: string | null;
  version: typeof OPERATIONS_VERSION;
  kind: "hosted_delivery";
  binding: HostedOperationBinding;
  presentation: OperationPresentation;
  context: OperationContext;
  state: HostedOperationState;
  policyHash: string;
  conversationId: string | null;
  attempted: boolean;
  attemptedAt: string | null;
  cancelRequestedAt: string | null;
  deadlineAt: string | null;
  outcome: string | null;
  frame: { rawSha256: string; bodySha256: string } | null;
  source: OperationSource<{ conversationId: string; userTurnId: string; assistantTurnId: string }>;
  terminal: OperationTerminalBinding | null;
  delivery: OperationDelivery;
  archive: OperationSource<OperationArchive>;
  capabilities: OperationCapabilities;
}
export interface FanoutOperationChild {
  kind: "local_execution" | "hosted_delivery";
  requestId: string;
  taskSpecHash: string;
  route: OperationRoute;
  state: "pending" | "received" | "running" | "result_available" | "acknowledged" | "blocked";
  outcome: string | null;
  payloadSha256: string | null;
  payloadAckObserved: boolean;
  /** Transport ACK alone is not proof of materialized required artifacts. */
  fullDeliverySufficient: boolean;
  error: string | null;
  result: OperationSource<
    | { kind: "local_execution"; result: ResultSpec }
    | { kind: "hosted_delivery"; outcome: string; markdown: string | null }
  >;
  materialization: OperationDelivery["materialization"];
}
export interface FanoutOperation {
  version: typeof OPERATIONS_VERSION;
  kind: "fanout";
  fanoutId: string;
  commit: string;
  total: number;
  available: number;
  pending: number;
  payloadAcknowledged: number;
  fullDeliverySufficient: number;
  children: FanoutOperationChild[];
  capabilities: OperationCapabilities;
}
export type OperationDetail = LocalOperation | HostedOperation | FanoutOperation;
export type OperationSummary =
  | {
      kind: "local_execution";
      binding: LocalOperationBinding;
      presentation: OperationPresentation;
      status: TaskStatus;
      delivery: OperationDelivery;
    }
  | {
      kind: "hosted_delivery";
      binding: HostedOperationBinding;
      presentation: OperationPresentation;
      state: HostedOperationState;
      terminalAvailable: boolean;
      delivery: OperationDelivery;
    }
  | {
      kind: "fanout";
      fanoutId: string;
      total: number;
      available: number;
      pending: number;
      payloadAcknowledged: number;
      fullDeliverySufficient: number;
    };
export interface OperationResources {
  session: {
    sessionId: string;
    stopped: boolean;
    paused: boolean;
    starts: number;
    reserved: number;
    reservedSeconds: number;
  };
  limits: {
    maxStarts: number | null;
    deadlineAt: string | null;
    maxReservedSeconds: number | null;
  };
  locks: { resourceId: string; requestId: string; mode: "exclusive" }[];
  scope: "host_local";
}
export interface OperationQuota {
  providerId: string;
  source: "provider" | "user" | "unknown";
  observedAt: string | null;
  windowEndsAt: string | null;
  remainingPercent: number | null;
  freshness: "fresh" | "stale" | "unknown";
  verification: "provider_observed" | "manual_unverified" | "unknown";
  billingEstimate: null;
  boundedFallback: { preauthorized: boolean; maxStarts: number; maxRunSeconds: number } | null;
  strictMoneyBudget: boolean | null;
}
export interface OperationsSetup {
  version: typeof OPERATIONS_VERSION;
  registry: OperationSource<{
    revision: number;
    snapshotSha256: string;
    projects: { projectId: string; repoId: string; storageSlug: string; displayName: string }[];
  }>;
  destinations: OperationSource<RegisteredOperationDestination[]>;
  quotas: OperationSource<OperationQuota[]>;
}
export interface OperationsOverview {
  readStartedAt: string;
  version: typeof OPERATIONS_VERSION;
  local: OperationSource<OperationsPage<OperationSummary>>;
  hosted: OperationSource<OperationsPage<OperationSummary>>;
  fanout: OperationSource<OperationsPage<OperationSummary>>;
}

const hash = { type: "string", pattern: "^[a-f0-9]{64}(?![\\s\\S])" };
const uuid = {
  type: "string",
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\\s\\S])",
};
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const binding = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "requestId", "taskSpecHash", "taskFileHash", "sequence"],
      properties: {
        kind: { const: "local_execution" },
        requestId: uuid,
        taskSpecHash: hash,
        taskFileHash: hash,
        sequence: { ...integer, minimum: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "requestId", "taskSpecHash", "attemptId", "revision"],
      properties: {
        kind: { const: "hosted_delivery" },
        requestId: uuid,
        taskSpecHash: hash,
        attemptId: { anyOf: [uuid, { type: "null" }] },
        revision: integer,
      },
    },
  ],
};
/** Public schema is strict: authenticated actor, provider, paths and arbitrary actions are not request fields. */
export const OPERATIONS_MUTATION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://example.invalid/bridge-v2/operations-mutation.schema.json",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["version", "action", "binding"],
      properties: {
        version: { const: OPERATIONS_VERSION },
        action: { enum: ["approve", "start", "cancel", "reconcile", "archive"] },
        binding,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["version", "action", "binding", "terminal"],
      properties: {
        version: { const: OPERATIONS_VERSION },
        action: { const: "ack" },
        binding,
        terminal: {
          type: "object",
          additionalProperties: false,
          required: ["eventId", "payloadSha256"],
          properties: { eventId: uuid, payloadSha256: hash },
        },
      },
    },
  ],
};
const validateMutation = new Ajv2020({ strict: true, allErrors: true }).compile(
  OPERATIONS_MUTATION_SCHEMA,
);
export function validateOperationsMutation(value: unknown): asserts value is OperationsMutation {
  if (!validateMutation(value))
    throw new UiError("invalid_operations_request", "Request does not match bridge-operations-1");
}
