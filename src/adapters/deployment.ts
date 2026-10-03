import type { TaskArchivePort } from "../archive/types.js";
/** Composition root shared by an authenticated UI host and the GitHub recipient worker.
 * Configuration is trusted host code, never a TaskSpec, transport message or imported JSON.
 */

import { TaskController } from "../state/task-controller.js";
import type { TaskExecutor } from "../state/task-executor.js";
import type { TaskPolicy } from "../state/task-policy.js";
import type { QuotaFallback, QuotaObservation } from "../state/task-preflight.js";
import { type AccountQuotaPort, validateAccountRateLimits } from "../state/task-quota.js";
import type { TaskStore } from "../state/task-store.js";
import { BridgeHost } from "./bridge-host.js";
import {
  GitHubRecipientPump,
  type GitHubTaskBus,
  type TransportJournal,
} from "./github-transport.js";
import { type AuthoritySession, LocalTaskAuthority } from "./local-authority.js";
export interface DeploymentOptions {
  store: TaskStore;
  artifactArchive?: TaskArchivePort;
  executor: TaskExecutor;
  policy: TaskPolicy;
  bus: GitHubTaskBus;
  journal: TransportJournal;
  authoritySession(): AuthoritySession;
  quota?: AccountQuotaPort;
  quotaLimitId?: string;
  quotaTimeoutMs?: number;
  quotaGuard?: {
    observation: QuotaObservation;
    fallback: QuotaFallback | null;
    strictMoneyBudget: boolean;
  };
  autoDispatch: boolean;
  evaluateBoundedPolicy: boolean;
  now?: () => Date;
}
export function createBridgeDeployment(options: DeploymentOptions) {
  const now = options.now ?? (() => new Date());
  const quotaGuard = options.quotaGuard ?? {
    observation: {
      source: "unknown" as const,
      observedAt: null,
      windowEndsAt: null,
      remainingPercent: null,
      maxAgeSeconds: 60,
    },
    fallback: null,
    strictMoneyBudget: false,
  };
  if (options.quota && !options.quotaLimitId) throw new Error("quota_limit_selection_required");
  let quotaGeneration = 0;
  const quotaTimeoutMs = options.quotaTimeoutMs ?? 4000;
  if (!Number.isInteger(quotaTimeoutMs) || quotaTimeoutMs < 1 || quotaTimeoutMs > 4000)
    throw new Error("quota_timeout_invalid");
  const quota: AccountQuotaPort | undefined = options.quota
    ? {
        async readRateLimits() {
          const generation = ++quotaGeneration;
          const requestStartedAt = now().toISOString();
          quotaGuard.observation = {
            ...quotaGuard.observation,
            source: "unknown",
            observedAt: null,
            windowEndsAt: null,
            remainingPercent: null,
          };
          const source = options.quota;
          if (!source) throw new Error("quota_source_unavailable");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const value = await Promise.race([
              source.readRateLimits(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("quota_refresh_timeout")),
                  quotaTimeoutMs,
                );
              }),
            ]);
            if (generation !== quotaGeneration) throw new Error("quota_refresh_stale");
            validateAccountRateLimits(value);
            const bucket = value.limits.find((limit) => limit.limitId === options.quotaLimitId);
            const windows = [bucket?.primary, bucket?.secondary].filter(
              (window): window is NonNullable<typeof window> => !!window,
            );
            if (!bucket || !windows.length) throw new Error("quota_selected_bucket_unavailable");
            quotaGuard.observation = {
              source: "provider",
              observedAt: requestStartedAt,
              windowEndsAt: new Date(
                Math.min(...windows.map((window) => window.resetsAt)) * 1000,
              ).toISOString(),
              remainingPercent: Math.min(...windows.map((window) => 100 - window.usedPercent)),
              maxAgeSeconds: quotaGuard.observation.maxAgeSeconds,
            };
            return value;
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
      }
    : undefined;
  const controller = new TaskController(
    options.store,
    options.executor,
    options.policy,
    now,
    quotaGuard,
    5000,
    quota,
    options.artifactArchive,
  );
  const authority = new LocalTaskAuthority(controller, options.authoritySession, now);
  const pump = new GitHubRecipientPump(options.bus, controller, options.journal, () =>
    now().getTime(),
  );
  const host = new BridgeHost(pump, authority, {
    autoDispatch: options.autoDispatch,
    evaluateBoundedPolicy: options.evaluateBoundedPolicy,
    maxPerTick: 32,
  });
  return {
    bus: options.bus,
    host,
    authority,
    controller,
    uiRuntime: {
      store: options.store,
      controller,
      authority,
      authenticatedRequesterId: "local-ui-requester",
      capabilities: { approve: true, start: true, cancel: true, reconcile: true },
      capabilityReasons: {},
    },
  };
}
