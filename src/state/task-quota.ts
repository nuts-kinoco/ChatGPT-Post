/** Host-side management RPC port; never ask an LLM to run /status and never infer quota
 * from token/context counters. No live provider implementation is registered in this PR. */
export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}
export interface AccountRateLimits {
  source: "account/rateLimits/read";
  cliVersion: string;
  protocolVersion: string;
  limits: { limitId: string; primary: RateLimitWindow | null; secondary: RateLimitWindow | null }[];
}
export interface AccountQuotaPort {
  readRateLimits(): Promise<AccountRateLimits>;
}
export interface TaskQuotaSnapshot {
  requestId: string;
  phase: "pre_dispatch" | "post_result_ack";
  requestStartedAt: string;
  fetchedAt: string;
  state: "observed" | "unknown";
  observation: AccountRateLimits | null;
  error: string | null;
}
export function validateAccountRateLimits(value: AccountRateLimits): void {
  if (
    value.source !== "account/rateLimits/read" ||
    !value.cliVersion ||
    !value.protocolVersion ||
    !value.limits.length
  )
    throw new Error("quota_observation_unverified");
  const ids = new Set<string>();
  for (const limit of value.limits) {
    if (!limit.limitId || ids.has(limit.limitId)) throw new Error("quota_observation_invalid");
    ids.add(limit.limitId);
    for (const window of [limit.primary, limit.secondary])
      if (
        window &&
        (!Number.isFinite(window.usedPercent) ||
          window.usedPercent < 0 ||
          window.usedPercent > 100 ||
          !Number.isSafeInteger(window.windowDurationMins) ||
          window.windowDurationMins < 1 ||
          !Number.isSafeInteger(window.resetsAt) ||
          window.resetsAt < 0)
      )
        throw new Error("quota_observation_invalid");
  }
}
