/** Read-only composition over authoritative services. No mirrored ledger, route guessing or replay. */
import { createHash } from "node:crypto";
import {
  type FanoutOperation,
  type FanoutOperationChild,
  type HostedOperation,
  type HostedOperationBinding,
  type HostedOperationState,
  type LocalOperation,
  type LocalOperationBinding,
  OPERATIONS_VERSION,
  type OperationAction,
  type OperationArchive,
  type OperationBinding,
  type OperationCapabilities,
  type OperationContext,
  type OperationDelivery,
  type OperationDependency,
  type OperationDetail,
  type OperationKind,
  type OperationProject,
  type OperationQuota,
  type OperationResources,
  type OperationRoute,
  type OperationSource,
  type OperationSummary,
  type OperationsOverview,
  type OperationsPage,
  type OperationsSetup,
  type OperationTerminalBinding,
  type RegisteredOperationDestination,
  validateOperationsMutation,
} from "../contracts/operations.js";
import type {
  ProjectRegistrationReference,
  ProjectRegistryPort,
  ProjectRegistrySnapshot,
} from "../contracts/project-registry.js";
import { loadTaskSpec, validateTaskResult, verifyTaskFileBytes } from "../contracts/task.js";
import type { ResultSpec } from "../contracts/task-types.js";
import type { BridgeResult } from "../contracts/types.js";
import { type UiCapability, UiError, type UiImport, type UiTaskDetail } from "../contracts/ui.js";
import type { TaskUiService } from "./service.js";

type Read<T> = T | Promise<T>;
export interface OperationIdPage {
  requestIds: string[];
  next: string | null;
  blocked?: { requestId: string; reason: string }[];
}
export interface LocalOperationContext {
  requesterId: string;
  recipientActorId: string | null;
  destinationId: string | null;
  /** Read from the immutable accepted admission, never inferred from current settings. */
  projectRegistration: ProjectRegistrationReference | null;
  sessionId: string | null;
  dependencies: OperationDependency[] | null;
}
/** Structural subset of authoritative HostedJobRecord; source bytes, private paths and prompts are not projected. */
export interface HostedOperationsRecord {
  revision: number;
  issued: {
    requestId: string;
    taskSpecHash: string;
    taskFileHash: string;
    requesterId: string;
    recipientId: string;
    repoId: string;
    route: OperationRoute;
    projectRegistration: ProjectRegistrationReference | null;
  };
  raw: string;
  taskBytesBase64: string;
  state: HostedOperationState;
  attempted: boolean;
  attemptId: string | null;
  attemptedAt: string | null;
  cancelRequestedAt: string | null;
  deadlineAt: string | null;
  acknowledged: boolean;
  payloadAcknowledged?: boolean;
  response: {
    version: "hosted-response-1";
    requestId: string;
    taskSpecHash: string;
    attemptId: string;
    localExecution: false;
    result: BridgeResult;
    markdown?: string;
    framing: {
      identity: { requestId: string; taskSpecHash: string; attemptId: string };
      rawSha256: string;
      bodySha256: string;
    } | null;
  } | null;
  source:
    | { state: "unavailable"; reason: string }
    | {
        state: "available";
        provenance: {
          identity: { conversationId: string; userTurnId: string; assistantTurnId: string };
          frame: {
            identity: { requestId: string; taskSpecHash: string; attemptId: string };
            rawSha256: string;
            bodySha256: string;
          };
        };
      }
    | null;
  event: { requestId: string; taskSpecHash: string; eventId: string; payloadSha256: string } | null;
}
export interface OperationsFanoutCollection {
  fanoutId: string;
  commit: string;
  total: number;
  available: number;
  acknowledged: number;
  pending: number;
  children: {
    requestId: string;
    route: OperationRoute;
    taskSpecHash: string;
    state: "pending" | "received" | "running" | "result_available" | "acknowledged" | "blocked";
    payloadSha256: string | null;
    outcome: string | null;
    result: unknown;
    error: string | null;
  }[];
}
export interface OperationDeliveryIdentity {
  requesterActorId: string;
  recipientActorId: string;
  requestId: string;
  taskSpecHash: string;
  execution:
    | { kind: "local_execution"; runId: string | null }
    | { kind: "hosted_delivery"; attemptId: string };
  terminalEventId: string;
  payloadSha256: string;
}
/** Returned only after the host verifier checks the signed receipt and durable materialization.
 * Request JSON cannot provide proof, actor identity, or these booleans. */
export interface OperationMaterializationProof {
  binding: OperationDeliveryIdentity;
  receiptSha256: string;
  deliveryManifestSha256: string;
  requiredArtifactsVerified: true;
  payloadVerified: true;
  synthetic: false;
  /** Optional authenticated bus ACK, independently checked against this exact proof identity. */
  signedAcknowledgementVerified?: true;
}
export interface UiOperationsSources {
  local?: {
    service: Pick<
      TaskUiService,
      "task" | "validate" | "import" | "approve" | "start" | "cancel" | "reconcile" | "acknowledge"
    >;
    /** Host adapter must perform a bounded authoritative read, not listAll(). */
    list(after: string, limit: number): Read<OperationIdPage>;
    context?(requestId: string): Read<LocalOperationContext | null>;
  };
  registry?: Pick<
    ProjectRegistryPort,
    "currentRevision" | "snapshot" | "snapshotHash" | "resolve"
  > & {
    /** Optional trusted settings authority on the same registry; never invoked by operations reads. */
    configure?(snapshot: ProjectRegistrySnapshot, expectedRevision: number): unknown;
  };
  /** Explicit host registrations. TaskSpec.agent/model never registers a destination. */
  destinations?: () => Read<readonly RegisteredOperationDestination[]>;
  hosted?: {
    get(requestId: string): Read<HostedOperationsRecord | null>;
    list(after: string, limit: number): Read<OperationIdPage>;
    policyHash: string;
    conversationId: string | null;
    destinationId: string | null;
    capabilities?(record: HostedOperationsRecord): Partial<OperationCapabilities>;
    /** Each action adapter must atomically recheck the exact binding in its authority boundary. */
    approve?(binding: HostedOperationBinding, actorId: string): Read<void>;
    /** Returns only after durable intent is owned by a bounded host worker. Never return a generation future. */
    scheduleStart?(binding: HostedOperationBinding): Read<{ accepted: true }>;
    cancel?(binding: HostedOperationBinding): Read<void>;
    reconcile?(binding: HostedOperationBinding): Read<void>;
  };
  /** Fixed trusted host identity; never copied from an operations request. */
  authenticatedActorId?: string;
  fanout?: {
    list(
      after: string,
      limit: number,
    ): Read<{
      fanoutIds: string[];
      next: string | null;
      blocked?: { fanoutId: string; reason: string }[];
    }>;
    collect(fanoutId: string): Read<OperationsFanoutCollection>;
    /** Resolves authenticated issuance/terminal identity, never a client-supplied result claim. */
    deliveryIdentity?(fanoutId: string, requestId: string): Read<OperationDeliveryIdentity | null>;
  };
  resources?: {
    read(sessionId: string): Read<{
      session: OperationResources["session"];
      limits: OperationResources["limits"];
      locks: { resourceKey: string; requestId: string }[];
    }>;
  };
  quota?: {
    read(): Read<
      {
        providerId: string;
        source: OperationQuota["source"];
        observedAt: string | null;
        windowEndsAt: string | null;
        remainingPercent: number | null;
        maxAgeSeconds: number;
        boundedFallback?: {
          preauthorized: boolean;
          maxStarts: number;
          maxRunSeconds: number;
        } | null;
        strictMoneyBudget?: boolean;
      }[]
    >;
  };
  archive?: {
    read(binding: OperationBinding): Read<OperationArchive>;
    /** Must recheck the bound authoritative revision/hash; archive work does not change outcome. */
    collect?(binding: OperationBinding): Read<void>;
  };
  materialization?: {
    verified(identity: OperationDeliveryIdentity): Read<OperationMaterializationProof | null>;
    /** Verifies exact proof again at the action boundary; publishes the route's ACK and proof. */
    acknowledge?(binding: OperationBinding, terminal: OperationTerminalBinding): Read<void>;
    /** Explicit requester action: verifies/downloads/persists first, then publishes signed proof + ACK.
     * Never invoked by overview/detail reads. Identity comes from the trusted host signer. */
    requesterActorId?: string;
    materializeAndAcknowledge?(
      binding: OperationBinding,
      terminal: OperationTerminalBinding,
    ): Read<void>;
  };
}
const ACTIONS: OperationAction[] = [
  "validate",
  "import",
  "approve",
  "start",
  "cancel",
  "reconcile",
  "collect",
  "ack",
  "archive",
  "export",
];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const available = <T>(value: T): OperationSource<T> => ({ state: "available", value });
const unavailable = <T>(reason: string): OperationSource<T> => ({ state: "unavailable", reason });
const cap = (enabled: boolean, reason: string): UiCapability => ({ enabled, reason });
const disabled = (): OperationCapabilities =>
  Object.fromEntries(
    ACTIONS.map((action) => [action, cap(false, `${action}_adapter_unavailable`)]),
  ) as OperationCapabilities;
const code = (value: string | null, fallback: string) =>
  value && /^[a-z][a-z0-9_]{0,95}$/.test(value) ? value : fallback;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const id = (value: string) => {
  if (!UUID.test(value))
    throw new UiError("invalid_operation_id", "A canonical operation UUID is required");
};
function sameIdentity(a: OperationDeliveryIdentity, b: OperationDeliveryIdentity): boolean {
  return (
    a.requestId === b.requestId &&
    a.taskSpecHash === b.taskSpecHash &&
    a.requesterActorId === b.requesterActorId &&
    a.recipientActorId === b.recipientActorId &&
    a.terminalEventId === b.terminalEventId &&
    a.payloadSha256 === b.payloadSha256 &&
    a.execution.kind === b.execution.kind &&
    (a.execution.kind === "local_execution" && b.execution.kind === "local_execution"
      ? a.execution.runId === b.execution.runId
      : a.execution.kind === "hosted_delivery" &&
        b.execution.kind === "hosted_delivery" &&
        a.execution.attemptId === b.execution.attemptId)
  );
}
function destination(value: RegisteredOperationDestination): RegisteredOperationDestination {
  const actor = /^[a-z][a-z0-9_-]{0,63}$/;
  const text = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\0\r\n]/.test(value);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !==
      [
        "destinationId",
        "route",
        "recipientActorId",
        "providerId",
        "modelIds",
        "capabilities",
        "unavailableReason",
        "policyHash",
      ]
        .sort()
        .join() ||
    !actor.test(value.destinationId) ||
    !actor.test(value.recipientActorId) ||
    !actor.test(value.providerId) ||
    !["cli", "ordinary_chat_browser"].includes(value.route) ||
    !HASH.test(value.policyHash) ||
    !Array.isArray(value.modelIds) ||
    value.modelIds.length > 64 ||
    new Set(value.modelIds).size !== value.modelIds.length ||
    value.modelIds.some(
      (model) => typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model),
    ) ||
    (value.unavailableReason !== null && !text(value.unavailableReason)) ||
    !value.capabilities ||
    typeof value.capabilities !== "object" ||
    Array.isArray(value.capabilities)
  )
    throw new Error("destination_catalogue_invalid");
  const capabilities: Partial<OperationCapabilities> = {};
  for (const [action, capability] of Object.entries(value.capabilities)) {
    if (
      !ACTIONS.includes(action as OperationAction) ||
      !capability ||
      Object.keys(capability).sort().join() !== "enabled,reason" ||
      typeof capability.enabled !== "boolean" ||
      !text(capability.reason)
    )
      throw new Error("destination_capability_invalid");
    capabilities[action as OperationAction] =
      value.unavailableReason !== null ? cap(false, value.unavailableReason) : { ...capability };
  }
  return {
    destinationId: value.destinationId,
    route: value.route,
    recipientActorId: value.recipientActorId,
    providerId: value.providerId,
    modelIds: [...value.modelIds],
    capabilities,
    unavailableReason: value.unavailableReason,
    policyHash: value.policyHash,
  };
}
export class UiOperationsService {
  private readonly timeoutMs: number;
  private stopping = false;
  beginShutdown(): void {
    this.stopping = true;
  }
  private readonly now: () => Date;
  constructor(
    readonly sources: UiOperationsSources,
    options: { readTimeoutMs?: number; now?: () => Date } = {},
  ) {
    this.timeoutMs = options.readTimeoutMs ?? 1000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 5000)
      throw new UiError(
        "invalid_operations_timeout",
        "Read timeout must be between 1 and 5000 ms",
        500,
      );
  }
  /** Independent read deadlines isolate unavailable sources. Timed-out work has no mutation authority. */
  private async read<T>(
    reader: (() => Read<T>) | undefined,
    reason = "source_unconfigured",
    timeoutMs = this.timeoutMs,
  ): Promise<OperationSource<T>> {
    if (!reader) return unavailable(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(reader)
          .then(available)
          .catch((): OperationSource<T> => ({ state: "error", reason: "source_read_failed" })),
        new Promise<OperationSource<T>>((resolve) => {
          timer = setTimeout(
            () => resolve({ state: "timeout", reason: "source_read_timeout" }),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private project(
    repoId: string,
    reference: ProjectRegistrationReference | null,
  ): OperationProject {
    const base = { reference, repoId, displayName: null, storageSlug: null };
    if (!reference)
      return { ...base, state: "legacy_unpinned", reason: "immutable_project_reference_missing" };
    const registry = this.sources.registry;
    if (!registry)
      return { ...base, state: "unavailable", reason: "project_registry_unconfigured" };
    try {
      if (registry.snapshotHash(reference.registryRevision) !== reference.snapshotSha256)
        return { ...base, state: "mismatch", reason: "project_snapshot_hash_mismatch" };
      const project = registry.resolve(reference.registryRevision, repoId);
      if (project.projectId !== reference.projectId)
        return { ...base, state: "mismatch", reason: "project_identity_mismatch" };
      return {
        ...base,
        state: "pinned",
        displayName: project.displayName,
        storageSlug: project.storageSlug,
        reason: null,
      };
    } catch {
      return { ...base, state: "unavailable", reason: "project_history_unavailable" };
    }
  }
  private async context(
    repo: string,
    read?: () => Read<LocalOperationContext | null>,
  ): Promise<OperationContext> {
    const result = await this.read(read, "operation_context_unconfigured");
    const context = result.state === "available" ? result.value : null;
    return {
      requesterId: context?.requesterId ?? null,
      recipientActorId: context?.recipientActorId ?? null,
      destinationId: context?.destinationId ?? null,
      project: this.project(repo, context?.projectRegistration ?? null),
      sessionId: context?.sessionId ?? null,
      dependencies: context?.dependencies
        ? available(structuredClone(context.dependencies))
        : unavailable(
            result.state === "available" ? "dependency_observation_unavailable" : result.reason,
          ),
    };
  }
  private async delivery(
    identity: OperationDeliveryIdentity | null,
    payloadAckObserved: boolean,
  ): Promise<OperationDelivery> {
    const base = {
      payloadAckObserved,
      fullDeliverySufficient: false,
      materializationReceiptSha256: null,
    };
    if (!identity)
      return { ...base, materialization: "unavailable", reason: "delivery_identity_unavailable" };
    const source = this.sources.materialization;
    const proof = await this.read(
      source ? () => source.verified(identity) : undefined,
      "materialization_verifier_unconfigured",
    );
    if (proof.state !== "available")
      return { ...base, materialization: "unavailable", reason: proof.reason };
    const value = proof.value;
    if (!value)
      return { ...base, materialization: "pending", reason: "required_artifacts_not_materialized" };
    if (
      !sameIdentity(value.binding, identity) ||
      !HASH.test(value.receiptSha256) ||
      !HASH.test(value.deliveryManifestSha256) ||
      value.requiredArtifactsVerified !== true ||
      value.payloadVerified !== true ||
      value.synthetic !== false
    )
      return { ...base, materialization: "pending", reason: "materialization_proof_mismatch" };
    const acknowledged = payloadAckObserved || value.signedAcknowledgementVerified === true;
    return {
      payloadAckObserved: acknowledged,
      materialization: "verified",
      fullDeliverySufficient: acknowledged,
      materializationReceiptSha256: value.receiptSha256,
      reason: acknowledged
        ? "verified_materialization_and_ack"
        : "verified_materialization_ack_pending",
    };
  }
  private archive(binding: OperationBinding): Promise<OperationSource<OperationArchive>> {
    const source = this.sources.archive;
    return this.read(
      source
        ? async () => {
            const value = await source.read(binding);
            if (
              (value.manifestSha256 !== null && !HASH.test(value.manifestSha256)) ||
              (value.admissionSha256 !== null && !HASH.test(value.admissionSha256))
            )
              throw new Error("invalid_archive_projection");
            return {
              state: value.state,
              manifestSha256: value.manifestSha256,
              admissionSha256: value.admissionSha256,
              reason: value.reason === null ? null : code(value.reason, "archive_unavailable"),
            };
          }
        : undefined,
      "archive_adapter_unconfigured",
    );
  }
  private resources(sessionId: string | null): Promise<OperationSource<OperationResources>> {
    const source = this.sources.resources;
    return this.read(
      sessionId && source
        ? async () => {
            const value = await source.read(sessionId);
            if (value.session.sessionId !== sessionId || value.locks.length > 256)
              throw new Error("resource_projection_invalid");
            return {
              session: {
                sessionId,
                stopped: value.session.stopped,
                paused: value.session.paused,
                starts: value.session.starts,
                reserved: value.session.reserved,
                reservedSeconds: value.session.reservedSeconds,
              },
              limits: {
                maxStarts: value.limits.maxStarts,
                deadlineAt: value.limits.deadlineAt,
                maxReservedSeconds: value.limits.maxReservedSeconds,
              },
              locks: value.locks.map((lock) => ({
                resourceId: `resource:${digest(lock.resourceKey)}`,
                requestId: lock.requestId,
                mode: "exclusive" as const,
              })),
              scope: "host_local" as const,
            };
          }
        : undefined,
      sessionId ? "resource_adapter_unconfigured" : "session_identity_unavailable",
    );
  }
  private localBinding(task: UiTaskDetail): LocalOperationBinding {
    return {
      kind: "local_execution",
      requestId: task.summary.requestId,
      taskSpecHash: task.result.task_spec_hash,
      taskFileHash: task.result.task_file_hash,
      sequence: task.result.observation_seq,
    };
  }
  private localIdentity(
    task: UiTaskDetail,
    context: OperationContext,
  ): OperationDeliveryIdentity | null {
    const event = task.handshakes.terminal_result;
    if (!event || !context.requesterId || !context.recipientActorId) return null;
    return {
      requesterActorId: context.requesterId,
      recipientActorId: context.recipientActorId,
      requestId: task.summary.requestId,
      taskSpecHash: task.result.task_spec_hash,
      execution: { kind: "local_execution", runId: task.result.run_id },
      terminalEventId: event.eventId,
      payloadSha256: event.payloadSha256,
    };
  }
  private canMaterialize(identity: OperationDeliveryIdentity | null): boolean {
    const port = this.sources.materialization;
    return (
      !!identity &&
      !!port?.materializeAndAcknowledge &&
      port.requesterActorId === identity.requesterActorId &&
      this.sources.authenticatedActorId === identity.requesterActorId
    );
  }
  private gateProject(capabilities: OperationCapabilities, project: OperationProject): void {
    if (project.state === "pinned") return;
    for (const action of ["approve", "start", "ack", "archive"] as const)
      capabilities[action] = cap(false, project.reason ?? "immutable_project_pin_required");
  }
  private async local(requestId: string): Promise<LocalOperation> {
    const source = this.sources.local;
    if (!source)
      throw new UiError(
        "local_execution_unavailable",
        "Local execution adapter is unavailable",
        409,
      );
    const task = source.service.task(requestId).task;
    const binding = this.localBinding(task);
    const context = await this.context(
      task.spec.repo,
      source.context ? () => source.context?.(requestId) ?? null : undefined,
    );
    const identity = this.localIdentity(task, context);
    const [delivery, archive, resources] = await Promise.all([
      this.delivery(identity, !!task.handshakes.result_ack),
      this.archive(binding),
      this.resources(context.sessionId),
    ]);
    const capabilities = disabled();
    for (const action of ["validate", "import", "approve", "start", "cancel", "reconcile"] as const)
      capabilities[action] = { ...task.capabilities[action] };
    capabilities.archive = cap(
      !!this.sources.archive?.collect,
      this.sources.archive?.collect
        ? "collect_bound_local_archive"
        : "archive_adapter_unconfigured",
    );
    capabilities.ack = task.result.synthetic
      ? { ...task.capabilities.ack }
      : this.canMaterialize(identity) && !delivery.fullDeliverySufficient
        ? cap(true, "verify_materialize_then_ack_exact_delivery")
        : cap(
            task.capabilities.ack.enabled &&
              delivery.materialization === "verified" &&
              !!this.sources.materialization?.acknowledge,
            delivery.materialization !== "verified"
              ? delivery.reason
              : !this.sources.materialization?.acknowledge
                ? "materialization_ack_adapter_unconfigured"
                : task.capabilities.ack.reason,
          );
    if (!task.result.synthetic) this.gateProject(capabilities, context.project);
    return {
      version: OPERATIONS_VERSION,
      kind: "local_execution",
      binding,
      context,
      task,
      delivery,
      archive,
      resources,
      capabilities,
      presentation: {
        title: task.summary.title,
        requestedProvider: task.spec.agent,
        requestedModel: task.spec.requested_model,
        actualProvider: task.result.actual_agent,
        actualModel: task.result.actual_model,
        observedAt: task.result.observed_at,
        evidence: "last_observed",
      },
    };
  }
  private async hosted(requestId: string): Promise<HostedOperation> {
    const source = this.sources.hosted;
    if (!source)
      throw new UiError(
        "hosted_delivery_unavailable",
        "Hosted delivery adapter is unavailable",
        409,
      );
    const job = await source.get(requestId);
    if (!job) throw new UiError("hosted_delivery_not_found", "Hosted delivery was not found", 404);
    const parsed = loadTaskSpec(Buffer.from(job.raw), job.issued.taskSpecHash);
    if (
      !parsed.valid ||
      !verifyTaskFileBytes(parsed.task, Buffer.from(job.taskBytesBase64, "base64")).valid ||
      parsed.task.request_id !== requestId ||
      job.issued.requestId !== requestId ||
      parsed.task.task_file_hash !== job.issued.taskFileHash ||
      parsed.task.repo !== job.issued.repoId ||
      job.issued.route !== "ordinary_chat_browser" ||
      !Number.isSafeInteger(job.revision) ||
      job.revision < 0
    )
      throw new UiError("hosted_projection_invalid", "Hosted record integrity failed", 409);
    const binding: HostedOperationBinding = {
      kind: "hosted_delivery",
      requestId,
      taskSpecHash: job.issued.taskSpecHash,
      attemptId: job.attemptId,
      revision: job.revision,
    };
    if (
      job.response &&
      (job.response.version !== "hosted-response-1" ||
        job.response.localExecution !== false ||
        job.response.requestId !== requestId ||
        job.response.taskSpecHash !== binding.taskSpecHash ||
        job.response.attemptId !== binding.attemptId)
    )
      throw new UiError("hosted_response_mismatch", "Hosted response identity failed", 409);
    const frame = job.response?.framing;
    if (
      frame &&
      (frame.identity.requestId !== requestId ||
        frame.identity.taskSpecHash !== binding.taskSpecHash ||
        frame.identity.attemptId !== binding.attemptId ||
        !HASH.test(frame.rawSha256) ||
        !HASH.test(frame.bodySha256))
    )
      throw new UiError("hosted_frame_mismatch", "Hosted frame identity failed", 409);
    if (
      job.event &&
      (job.event.requestId !== requestId || job.event.taskSpecHash !== binding.taskSpecHash)
    )
      throw new UiError("hosted_event_mismatch", "Hosted event identity failed", 409);
    const context = await this.context(parsed.task.repo, () => ({
      requesterId: job.issued.requesterId,
      recipientActorId: job.issued.recipientId,
      destinationId: source.destinationId,
      projectRegistration: job.issued.projectRegistration,
      sessionId: null,
      dependencies: null,
    }));
    const terminal = job.event
      ? { eventId: job.event.eventId, payloadSha256: job.event.payloadSha256 }
      : null;
    const identity: OperationDeliveryIdentity | null =
      terminal && job.attemptId
        ? {
            requesterActorId: job.issued.requesterId,
            recipientActorId: job.issued.recipientId,
            requestId,
            taskSpecHash: binding.taskSpecHash,
            execution: { kind: "hosted_delivery", attemptId: job.attemptId },
            terminalEventId: terminal.eventId,
            payloadSha256: terminal.payloadSha256,
          }
        : null;
    const [delivery, archive] = await Promise.all([
      this.delivery(identity, job.payloadAcknowledged ?? job.acknowledged),
      this.archive(binding),
    ]);
    const capabilities = disabled();
    const advertised = source.capabilities?.(job) ?? {};
    const actions = {
      approve: source.approve,
      start: source.scheduleStart,
      cancel: source.cancel,
      reconcile: source.reconcile,
    };
    for (const action of ["approve", "start", "cancel", "reconcile"] as const)
      capabilities[action] = cap(
        !!actions[action] &&
          advertised[action]?.enabled === true &&
          (action !== "approve" || !!this.sources.authenticatedActorId),
        !actions[action]
          ? `hosted_${action}_adapter_unconfigured`
          : action === "approve" && !this.sources.authenticatedActorId
            ? "trusted_approval_actor_unconfigured"
            : (advertised[action]?.reason ?? `hosted_${action}_not_enabled`),
      );
    capabilities.archive = cap(
      !!this.sources.archive?.collect && advertised.archive?.enabled === true,
      advertised.archive?.reason ?? "hosted_archive_not_enabled",
    );
    capabilities.ack =
      this.canMaterialize(identity) &&
      !delivery.fullDeliverySufficient &&
      advertised.ack?.enabled === true
        ? cap(true, "verify_materialize_then_ack_exact_delivery")
        : cap(
            advertised.ack?.enabled === true &&
              delivery.materialization === "verified" &&
              !!this.sources.materialization?.acknowledge,
            delivery.materialization !== "verified"
              ? delivery.reason
              : !this.sources.materialization?.acknowledge
                ? "materialization_ack_adapter_unconfigured"
                : (advertised.ack?.reason ?? "hosted_ack_not_enabled"),
          );
    this.gateProject(capabilities, context.project);
    let observedSource: HostedOperation["source"] = unavailable("hosted_source_unavailable");
    if (job.source?.state === "available") {
      const p = job.source.provenance;
      if (
        p.frame.identity.requestId === requestId &&
        p.frame.identity.taskSpecHash === binding.taskSpecHash &&
        p.frame.identity.attemptId === binding.attemptId &&
        p.identity.conversationId === source.conversationId &&
        (!frame ||
          (frame.rawSha256 === p.frame.rawSha256 && frame.bodySha256 === p.frame.bodySha256))
      )
        observedSource = available({
          conversationId: p.identity.conversationId,
          userTurnId: p.identity.userTurnId,
          assistantTurnId: p.identity.assistantTurnId,
        });
      else observedSource = unavailable("hosted_source_identity_mismatch");
    } else if (job.source)
      observedSource = unavailable(code(job.source.reason, "hosted_source_unavailable"));
    return {
      version: OPERATIONS_VERSION,
      kind: "hosted_delivery",
      binding,
      rawSpec: job.raw,
      taskMarkdown: new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(job.taskBytesBase64, "base64"),
      ),
      responseMarkdown:
        typeof job.response?.markdown === "string" &&
        Buffer.byteLength(job.response.markdown) <= 1024 * 1024
          ? job.response.markdown
          : null,
      context,
      state: job.state,
      policyHash: source.policyHash,
      conversationId: source.conversationId,
      attempted: job.attempted,
      attemptedAt: job.attemptedAt,
      cancelRequestedAt: job.cancelRequestedAt,
      deadlineAt: job.deadlineAt,
      outcome: job.response?.result.status ?? null,
      presentation: {
        title:
          Buffer.from(job.taskBytesBase64, "base64")
            .toString("utf8")
            .split(/\r?\n/)
            .find((line) => line.trim())
            ?.replace(/^#+\s*/, "")
            .slice(0, 120) ?? "Hosted delivery",
        requestedProvider: parsed.task.agent,
        requestedModel: parsed.task.requested_model,
        actualProvider: null,
        actualModel:
          job.response?.result.observedModelSlug ?? job.response?.result.observedModel ?? null,
        observedAt: job.response?.result.completedAt ?? job.attemptedAt,
        evidence: "last_observed",
      },
      frame: job.response?.framing
        ? { rawSha256: job.response.framing.rawSha256, bodySha256: job.response.framing.bodySha256 }
        : null,
      source: observedSource,
      terminal,
      delivery,
      archive,
      capabilities,
    };
  }
  private async fanout(fanoutId: string): Promise<FanoutOperation> {
    const source = this.sources.fanout;
    if (!source) throw new UiError("fanout_unavailable", "Fanout adapter is unavailable", 409);
    const group = await source.collect(fanoutId);
    if (
      group.fanoutId !== fanoutId ||
      group.children.length < 2 ||
      group.children.length > 4 ||
      new Set(group.children.map((child) => child.requestId)).size !== group.children.length
    )
      throw new UiError("fanout_projection_invalid", "Fanout identity or child count failed", 409);
    const children = await Promise.all(
      group.children.map(async (child): Promise<FanoutOperationChild> => {
        id(child.requestId);
        if (
          !HASH.test(child.taskSpecHash) ||
          !["cli", "ordinary_chat_browser"].includes(child.route)
        )
          throw new Error("fanout_child_identity_invalid");
        const kind =
          child.route === "cli" ? ("local_execution" as const) : ("hosted_delivery" as const);
        const payloadAckObserved = child.state === "acknowledged";
        const binding = await this.read(
          source.deliveryIdentity
            ? () => source.deliveryIdentity?.(fanoutId, child.requestId) ?? null
            : undefined,
        );
        const identity = binding.state === "available" ? binding.value : null;
        const boundIdentity =
          identity?.requestId === child.requestId &&
          identity.taskSpecHash === child.taskSpecHash &&
          identity.payloadSha256 === child.payloadSha256 &&
          identity.execution.kind === kind
            ? identity
            : null;
        const delivery = await this.delivery(boundIdentity, payloadAckObserved);
        let result: FanoutOperationChild["result"] = unavailable("child_result_unavailable");
        if (child.result !== null && child.payloadSha256) {
          if (kind === "local_execution") {
            const parsed = validateTaskResult(child.result);
            const payload = child.result as ResultSpec;
            if (
              parsed.valid &&
              payload.request_id === child.requestId &&
              payload.task_spec_hash === child.taskSpecHash
            )
              result = available({ kind, result: payload });
            else result = unavailable("child_result_invalid");
          } else {
            const payload = child.result as {
              version?: unknown;
              requestId?: unknown;
              taskSpecHash?: unknown;
              localExecution?: unknown;
              result?: { status?: unknown };
              markdown?: unknown;
            };
            if (
              payload.version === "hosted-response-1" &&
              payload.requestId === child.requestId &&
              payload.taskSpecHash === child.taskSpecHash &&
              payload.localExecution === false &&
              typeof payload.result?.status === "string" &&
              (payload.markdown === null || typeof payload.markdown === "string")
            )
              result = available({
                kind,
                outcome: payload.result.status,
                markdown: payload.markdown,
              });
            else result = unavailable("child_result_invalid");
          }
        }
        return {
          kind,
          requestId: child.requestId,
          taskSpecHash: child.taskSpecHash,
          route: child.route,
          state: child.state,
          outcome: child.outcome,
          payloadSha256: child.payloadSha256,
          payloadAckObserved,
          fullDeliverySufficient: delivery.fullDeliverySufficient,
          materialization: delivery.materialization,
          result,
          error: child.error === null ? null : code(child.error, "fanout_child_unavailable"),
        };
      }),
    );
    const count = children.filter(
      (child) => child.state === "result_available" || child.state === "acknowledged",
    ).length;
    const capabilities = disabled();
    capabilities.collect = cap(true, "collect_each_child_independently_without_execution");
    return {
      version: OPERATIONS_VERSION,
      kind: "fanout",
      fanoutId,
      commit: group.commit,
      total: children.length,
      available: count,
      pending: children.length - count,
      payloadAcknowledged: children.filter((child) => child.payloadAckObserved).length,
      fullDeliverySufficient: children.filter((child) => child.fullDeliverySufficient).length,
      children,
      capabilities,
    };
  }
  async detail(kind: OperationKind, requestId: string): Promise<OperationSource<OperationDetail>> {
    id(requestId);
    if (kind === "local_execution")
      return this.read(
        this.sources.local ? () => this.local(requestId) : undefined,
        "local_execution_adapter_unconfigured",
        this.timeoutMs * 3,
      );
    if (kind === "hosted_delivery")
      return this.read(
        this.sources.hosted ? () => this.hosted(requestId) : undefined,
        "hosted_delivery_adapter_unconfigured",
        this.timeoutMs * 3,
      );
    if (kind === "fanout")
      return this.read(
        this.sources.fanout ? () => this.fanout(requestId) : undefined,
        "fanout_adapter_unconfigured",
        this.timeoutMs * 3,
      );
    throw new UiError("unsupported_operation_kind", "Unsupported operations route");
  }
  private summary(operation: OperationDetail): OperationSummary {
    if (operation.kind === "fanout")
      return {
        kind: operation.kind,
        fanoutId: operation.fanoutId,
        total: operation.total,
        available: operation.available,
        pending: operation.pending,
        payloadAcknowledged: operation.payloadAcknowledged,
        fullDeliverySufficient: operation.fullDeliverySufficient,
      };
    return operation.kind === "local_execution"
      ? {
          kind: operation.kind,
          binding: operation.binding,
          presentation: operation.presentation,
          status: operation.task.result.status,
          delivery: operation.delivery,
        }
      : {
          kind: operation.kind,
          binding: operation.binding,
          presentation: operation.presentation,
          state: operation.state,
          terminalAvailable: operation.terminal !== null,
          delivery: operation.delivery,
        };
  }
  private async page(
    kind: OperationKind,
    after: string,
    limit: number,
  ): Promise<OperationSource<OperationsPage<OperationSummary>>> {
    const listing =
      kind === "local_execution"
        ? this.sources.local?.list.bind(this.sources.local)
        : kind === "hosted_delivery"
          ? this.sources.hosted?.list.bind(this.sources.hosted)
          : this.sources.fanout
            ? async (cursor: string, size: number) => {
                const group = await this.sources.fanout?.list(cursor, size);
                if (
                  !group ||
                  typeof group !== "object" ||
                  !Array.isArray(group.fanoutIds) ||
                  !Object.hasOwn(group, "next") ||
                  (group.blocked !== undefined && !Array.isArray(group.blocked))
                )
                  throw new Error("fanout_page_invalid");
                return {
                  requestIds: group.fanoutIds,
                  next: group.next,
                  blocked: (group.blocked ?? []).map((row) => ({
                    requestId: row.fanoutId,
                    reason: code(row.reason, "fanout_read_failed"),
                  })),
                };
              }
            : undefined;
    const result = await this.read(
      listing ? () => listing(after, limit) : undefined,
      `${kind}_adapter_unconfigured`,
    );
    if (result.state !== "available") return result;
    let page: OperationIdPage;
    try {
      const candidate: unknown = structuredClone(result.value);
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        !["next,requestIds", "blocked,next,requestIds"].includes(
          Object.keys(candidate).sort().join(),
        )
      )
        throw new Error("invalid_page");
      page = candidate as OperationIdPage;
      if (
        !Array.isArray(page.requestIds) ||
        page.requestIds.length > limit ||
        new Set(page.requestIds).size !== page.requestIds.length ||
        page.requestIds.some(
          (item) => typeof item !== "string" || !UUID.test(item) || item === after,
        ) ||
        (page.next !== null &&
          (typeof page.next !== "string" || !UUID.test(page.next) || page.next === after))
      )
        throw new Error("invalid_page");
      if (
        page.blocked !== undefined &&
        (!Array.isArray(page.blocked) ||
          page.blocked.length + page.requestIds.length > limit ||
          page.blocked.some(
            (row) =>
              !row ||
              typeof row.requestId !== "string" ||
              !UUID.test(row.requestId) ||
              typeof row.reason !== "string",
          ))
      )
        throw new Error("invalid_page");
    } catch {
      return { state: "error", reason: "source_page_invalid" };
    }
    const items = await Promise.all(
      page.requestIds.map(async (requestId) => {
        const value = await this.detail(kind, requestId);
        return value.state === "available" ? available(this.summary(value.value)) : value;
      }),
    );
    for (const row of page.blocked ?? [])
      items.push({
        state: "error",
        reason: `fanout_blocked / ${row.requestId} / ${code(row.reason, "fanout_read_failed")}`,
      });
    return available({ items, next: page.next });
  }
  async overview(
    options: {
      limit?: number;
      localAfter?: string;
      hostedAfter?: string;
      fanoutAfter?: string;
    } = {},
  ): Promise<OperationsOverview> {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (key) => !["limit", "localAfter", "hostedAfter", "fanoutAfter"].includes(key),
      )
    )
      throw new UiError("invalid_operations_query", "Unsupported operations query");
    const limit = options.limit === undefined ? 32 : options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
      throw new UiError("invalid_operations_limit", "Page size must be between 1 and 64");
    for (const cursor of [options.localAfter, options.hostedAfter, options.fanoutAfter])
      if (
        cursor !== undefined &&
        (typeof cursor !== "string" || (cursor !== "" && !UUID.test(cursor)))
      )
        throw new UiError(
          "invalid_operations_cursor",
          "Cursor must be empty or a canonical operation UUID",
        );
    const readStartedAt = this.now().toISOString();
    const [local, hosted, fanout] = await Promise.all([
      this.page("local_execution", options.localAfter ?? "", limit),
      this.page("hosted_delivery", options.hostedAfter ?? "", limit),
      this.page("fanout", options.fanoutAfter ?? "", limit),
    ]);
    return { version: OPERATIONS_VERSION, readStartedAt, local, hosted, fanout };
  }
  async setup(): Promise<OperationsSetup> {
    const registrySource = this.sources.registry;
    const [registry, destinations, quotas] = await Promise.all([
      this.read(
        registrySource
          ? () => {
              const revision = registrySource.currentRevision();
              const snapshot = registrySource.snapshot(revision);
              return {
                revision,
                snapshotSha256: registrySource.snapshotHash(revision),
                projects: snapshot.projects.map(
                  ({ projectId, repoId, storageSlug, displayName }) => ({
                    projectId,
                    repoId,
                    storageSlug,
                    displayName,
                  }),
                ),
              };
            }
          : undefined,
        "project_registry_unconfigured",
      ),
      this.read(
        this.sources.destinations
          ? async () => {
              const values = (await this.sources.destinations?.()) ?? [];
              if (
                values.length > 256 ||
                new Set(values.map((value) => value.destinationId)).size !== values.length
              )
                throw new Error("destination_catalogue_invalid");
              return values.map(destination);
            }
          : undefined,
        "destination_catalogue_unconfigured",
      ),
      this.read(
        this.sources.quota
          ? async () => {
              const values = (await this.sources.quota?.read()) ?? [];
              if (values.length > 256) throw new Error("quota_observation_limit");
              return values.map((value): OperationQuota => {
                const boundSource =
                  value.source === "provider" && value.providerId !== "codex"
                    ? "unknown"
                    : value.source;
                const now = this.now().getTime();
                const observed = value.observedAt === null ? NaN : Date.parse(value.observedAt);
                const end = value.windowEndsAt === null ? NaN : Date.parse(value.windowEndsAt);
                const known =
                  boundSource !== "unknown" &&
                  Number.isFinite(observed) &&
                  observed <= now &&
                  Number.isFinite(end) &&
                  value.remainingPercent !== null &&
                  Number.isFinite(value.remainingPercent) &&
                  value.remainingPercent >= 0 &&
                  value.remainingPercent <= 100 &&
                  Number.isFinite(value.maxAgeSeconds) &&
                  value.maxAgeSeconds > 0;
                return {
                  providerId: value.providerId,
                  source: boundSource,
                  observedAt: boundSource === "unknown" ? null : value.observedAt,
                  windowEndsAt: boundSource === "unknown" ? null : value.windowEndsAt,
                  remainingPercent: known ? value.remainingPercent : null,
                  freshness: !known
                    ? "unknown"
                    : now - observed <= value.maxAgeSeconds * 1000 && end > now
                      ? "fresh"
                      : "stale",
                  verification:
                    boundSource === "user"
                      ? "manual_unverified"
                      : known && boundSource === "provider"
                        ? "provider_observed"
                        : "unknown",
                  billingEstimate: null,
                  boundedFallback:
                    value.boundedFallback &&
                    typeof value.boundedFallback.preauthorized === "boolean" &&
                    Number.isSafeInteger(value.boundedFallback.maxStarts) &&
                    value.boundedFallback.maxStarts > 0 &&
                    Number.isSafeInteger(value.boundedFallback.maxRunSeconds) &&
                    value.boundedFallback.maxRunSeconds > 0
                      ? structuredClone(value.boundedFallback)
                      : null,
                  strictMoneyBudget:
                    typeof value.strictMoneyBudget === "boolean" ? value.strictMoneyBudget : null,
                };
              });
            }
          : undefined,
        "quota_observer_unconfigured",
      ),
    ]);
    return { version: OPERATIONS_VERSION, registry, destinations, quotas };
  }
  validateLocal(input: UiImport) {
    if (!this.sources.local)
      throw new UiError(
        "local_execution_unavailable",
        "Local validation adapter is unavailable",
        409,
      );
    return this.sources.local.service.validate(input);
  }
  importLocal(input: UiImport) {
    if (!this.sources.local)
      throw new UiError("local_execution_unavailable", "Local import adapter is unavailable", 409);
    return this.sources.local.service.import(input);
  }
  private checkBinding(expected: OperationBinding, actual: OperationBinding): void {
    if (
      expected.kind !== actual.kind ||
      expected.requestId !== actual.requestId ||
      expected.taskSpecHash !== actual.taskSpecHash ||
      (expected.kind === "local_execution" && actual.kind === "local_execution"
        ? expected.taskFileHash !== actual.taskFileHash || expected.sequence !== actual.sequence
        : expected.kind === "hosted_delivery" &&
          actual.kind === "hosted_delivery" &&
          (expected.attemptId !== actual.attemptId || expected.revision !== actual.revision))
    )
      throw new UiError(
        "stale_operation_snapshot",
        "Action must bind the exact inspected operation",
        409,
      );
  }
  async mutate(input: unknown): Promise<OperationSource<OperationDetail>> {
    validateOperationsMutation(input);
    const { binding, action } = input;
    const read = await this.detail(binding.kind, binding.requestId);
    if (read.state !== "available" || read.value.kind === "fanout")
      throw new UiError("operation_unavailable", "Operation cannot currently be inspected", 409);
    const operation = read.value;
    if (this.stopping && (action === "approve" || action === "start"))
      throw new UiError(
        "runtime_shutting_down",
        "New approval and dispatch are disabled during shutdown",
        409,
      );
    this.checkBinding(binding, operation.binding);
    if (!operation.capabilities[action].enabled)
      throw new UiError(
        `${binding.kind}_${action}_unavailable`,
        operation.capabilities[action].reason,
        409,
      );
    if (action === "ack") {
      const terminal =
        operation.kind === "local_execution"
          ? operation.task.handshakes.terminal_result
          : operation.terminal;
      if (
        !terminal ||
        terminal.eventId !== input.terminal.eventId ||
        terminal.payloadSha256 !== input.terminal.payloadSha256
      )
        throw new UiError(
          "delivery_identity_mismatch",
          "ACK must bind the exact terminal event and payload",
          409,
        );
      if (operation.kind === "local_execution" && operation.task.result.synthetic) {
        const service = this.sources.local?.service;
        if (!service)
          throw new UiError("local_execution_unavailable", "Local adapter unavailable", 409);
        this.checkBinding(binding, this.localBinding(service.task(binding.requestId).task));
        const event = operation.task.handshakes.terminal_result;
        if (!event)
          throw new UiError("delivery_identity_mismatch", "Terminal delivery missing", 409);
        await service.acknowledge(binding.requestId, {
          ...input.terminal,
          sequence: event.sequence,
        });
      } else {
        const port = this.sources.materialization;
        const identity =
          operation.kind === "local_execution"
            ? this.localIdentity(operation.task, operation.context)
            : {
                requesterActorId: operation.context.requesterId,
                recipientActorId: operation.context.recipientActorId,
              };
        const materialize =
          !!port?.materializeAndAcknowledge &&
          identity?.requesterActorId === port.requesterActorId &&
          identity?.requesterActorId === this.sources.authenticatedActorId;
        const acknowledge = materialize ? port?.materializeAndAcknowledge : port?.acknowledge;
        if (!acknowledge || (!materialize && operation.delivery.materialization !== "verified"))
          throw new UiError(
            "materialization_required",
            "Verified materialization is required for ACK",
            409,
          );
        await acknowledge(binding, input.terminal);
      }
    } else if (action === "archive") {
      await this.sources.archive?.collect?.(binding);
    } else if (binding.kind === "local_execution") {
      const service = this.sources.local?.service;
      if (!service)
        throw new UiError("local_execution_unavailable", "Local adapter unavailable", 409);
      this.checkBinding(binding, this.localBinding(service.task(binding.requestId).task));
      if (action === "approve" || action === "start")
        await service[action](binding.requestId, binding);
      else await service[action](binding.requestId);
    } else {
      const hosted = this.sources.hosted;
      if (!hosted)
        throw new UiError("hosted_delivery_unavailable", "Hosted adapter unavailable", 409);
      if (action === "start") await hosted.scheduleStart?.(binding);
      else if (action === "approve") {
        const actor = this.sources.authenticatedActorId;
        if (!actor)
          throw new UiError(
            "trusted_approval_actor_unconfigured",
            "Trusted approval identity is unavailable",
            409,
          );
        await hosted.approve?.(binding, actor);
      } else await hosted[action]?.(binding);
    }
    return this.detail(binding.kind, binding.requestId);
  }
}
