/** Informational capability/quota observations. No probe here invokes a model or refreshes quota. */
import type { TaskSpec } from "../contracts/task-types.js";
import { checkTaskPolicy, type TaskPolicy } from "./task-policy.js";

export interface AdapterHealth {
  adapterId: string;
  route: "browser_subscription" | "cli_subscription" | "api_billed" | "fake";
  state: "unconfigured" | "configured" | "verified" | "auth_needed" | "unavailable";
  source: string;
  observedAt: string;
  maxAgeSeconds: number;
  models: readonly string[];
  efforts: readonly string[];
}
export interface QuotaObservation {
  source: "provider" | "user" | "unknown";
  observedAt: string | null;
  windowEndsAt: string | null;
  remainingPercent: number | null;
  maxAgeSeconds: number;
}
export interface QuotaFallback {
  preauthorized: boolean;
  maxStarts: number;
  maxRunSeconds: number;
}
export function quotaDecision(
  observation: QuotaObservation,
  fallback: QuotaFallback | null,
  strictMoneyBudget: boolean,
  now: Date,
): { state: "observed" | "unknown"; mayContinue: boolean; reason: string } {
  const age =
    observation.observedAt === null
      ? Number.POSITIVE_INFINITY
      : now.getTime() - Date.parse(observation.observedAt);
  const valid =
    observation.source !== "unknown" &&
    observation.remainingPercent !== null &&
    Number.isFinite(observation.remainingPercent) &&
    observation.remainingPercent >= 0 &&
    observation.remainingPercent <= 100 &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= observation.maxAgeSeconds * 1000 &&
    observation.windowEndsAt !== null &&
    Number.isFinite(Date.parse(observation.windowEndsAt)) &&
    Date.parse(observation.windowEndsAt) > now.getTime();
  if (strictMoneyBudget)
    return {
      state: valid ? "observed" : "unknown",
      mayContinue: false,
      reason: "strict_cost_bound_not_established",
    };
  if (valid)
    return {
      state: "observed",
      mayContinue: (observation.remainingPercent ?? 0) > 0,
      reason: "reported_quota_observation_not_billing_guarantee",
    };
  const permitted =
    !strictMoneyBudget &&
    fallback?.preauthorized === true &&
    Number.isSafeInteger(fallback.maxStarts) &&
    fallback.maxStarts > 0 &&
    Number.isSafeInteger(fallback.maxRunSeconds) &&
    fallback.maxRunSeconds > 0;
  return {
    state: "unknown",
    mayContinue: permitted,
    reason: permitted
      ? "preauthorized_bounded_fallback"
      : "quota_observation_or_authorization_required",
  };
}
export function taskPreflight(
  task: TaskSpec,
  policy: TaskPolicy,
  health: AdapterHealth,
  quota: QuotaObservation,
  fallback: QuotaFallback | null,
  now: Date,
  strictMoneyBudget = false,
) {
  const errors: string[] = [];
  try {
    checkTaskPolicy(task, policy, now);
  } catch (error) {
    errors.push((error as Error).message);
  }
  const healthAge = now.getTime() - Date.parse(health.observedAt);
  if (
    health.adapterId !== policy.executorId ||
    !Number.isFinite(healthAge) ||
    healthAge < 0 ||
    healthAge > health.maxAgeSeconds * 1000
  )
    errors.push("adapter_observation_stale_or_mismatched");
  if (health.state !== "verified") errors.push(`adapter_${health.state}`);
  if (!health.models.includes(task.requested_model)) errors.push("model_unverified");
  const decision = quotaDecision(quota, fallback, strictMoneyBudget, now);
  if (!decision.mayContinue) errors.push(decision.reason);
  return {
    advisory: true,
    executionAuthorized: false,
    ready: errors.length === 0,
    errors,
    agent: task.agent,
    model: task.requested_model,
    effort: { supported: false, value: null },
    mode: task.mode,
    paths: task.allowed_paths,
    commands: task.allowed_commands,
    route: health.route,
    health,
    quota: { ...quota, ...decision },
    billingEstimate: {
      amount: null,
      currency: null,
      source: "unknown",
      observedAt: now.toISOString(),
    },
    fallbackCeilings: decision.state === "unknown" && decision.mayContinue ? fallback : null,
  };
}
