/** Default local read adapters project the existing ledger. They never mirror or repair records. */
import type { BoundQuotaSnapshot } from "../state/task-quota.js";
import type { UiOperationsSources } from "./operations.js";
import type { TaskUiService } from "./service.js";
export function buildUiOperationsSources(
  service: TaskUiService,
  ports: UiOperationsSources = {},
): UiOperationsSources {
  const { store, controller, preflight } = service.runtime;
  return {
    authenticatedActorId: service.authenticatedRequesterId,
    ...(service.runtime.projectRegistry ? { registry: service.runtime.projectRegistry } : {}),
    local: {
      service,
      list: (after, limit) => store.recentPage(after, limit),
      context: (requestId) => {
        const record = store.get(requestId);
        if (!record) return null;
        return {
          requesterId: record.requesterId,
          recipientActorId: record.bridgeId,
          destinationId: null,
          projectRegistration: record.projectRegistration ?? null,
          sessionId: record.sessionId,
          dependencies: store.dependencies(requestId)?.dependencies ?? [],
        };
      },
    },
    resources: {
      read: (sessionId) => ({
        session: store.sessionSnapshot(sessionId),
        limits: {
          maxStarts: sessionId === controller.policy.sessionId ? controller.policy.maxStarts : null,
          deadlineAt:
            sessionId === controller.policy.sessionId ? controller.policy.sessionDeadline : null,
          maxReservedSeconds:
            sessionId === controller.policy.sessionId
              ? (controller.policy.maxTotalRunSeconds ?? null)
              : null,
        },
        locks: store.activeLocks(sessionId),
      }),
    },
    // Untagged preflight percentages are not a provider-bound quota observation.
    quota: {
      read: () => [
        {
          providerId: "unknown",
          source: "unknown",
          observedAt: null,
          windowEndsAt: null,
          remainingPercent: null,
          maxAgeSeconds: 60,
          boundedFallback: preflight?.fallback ?? null,
        },
      ],
    },
    ...ports,
  };
}

export type UiOperationsFactory =
  | UiOperationsSources
  | ((service: TaskUiService) => UiOperationsSources | Promise<UiOperationsSources>);

/** Read the same admission guard snapshot without initiating a provider RPC. */
export function deploymentQuotaPort(
  snapshot: () => BoundQuotaSnapshot,
): NonNullable<UiOperationsSources["quota"]> {
  return {
    read: () => {
      const value = snapshot(),
        bound = value.version === "bridge-quota-snapshot-1" && value.providerId === "codex";
      return [
        {
          providerId: bound ? "codex" : "unknown",
          ...(bound
            ? value.observation
            : {
                source: "unknown" as const,
                observedAt: null,
                windowEndsAt: null,
                remainingPercent: null,
                maxAgeSeconds: 60,
              }),
          boundedFallback: value.fallback,
          strictMoneyBudget: value.strictMoneyBudget,
        },
      ];
    },
  };
}

/** Read current authoritative bindings directly, without recursively reading materialization views. */
export function currentOperationBindingReader(
  service: TaskUiService,
  hosted?: Pick<import("./hosted-operations.js").HostedUiService, "get">,
) {
  return (binding: import("../contracts/operations.js").OperationBinding) => {
    if (binding.kind === "local_execution") {
      const result = service.task(binding.requestId).task.result;
      return {
        kind: "local_execution" as const,
        requestId: result.request_id,
        taskSpecHash: result.task_spec_hash,
        taskFileHash: result.task_file_hash,
        sequence: result.observation_seq,
      };
    }
    const job = hosted?.get(binding.requestId);
    return job
      ? {
          kind: "hosted_delivery" as const,
          requestId: job.issued.requestId,
          taskSpecHash: job.issued.taskSpecHash,
          attemptId: job.attemptId,
          revision: job.revision,
        }
      : null;
  };
}
