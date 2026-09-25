import type { BridgeRequest, RequestStatus } from "./state.js";

export const COMPLETION_TOAST_DURATION_MS = 6_000;

const TERMINAL_STATUSES = new Set<RequestStatus>(["Completed", "Failed", "Blocked"]);

/**
 * Returns only terminal transitions that were observable across two polls.
 * An absent previous snapshot is an initialization baseline, so it cannot
 * produce notifications for requests that were already complete at launch.
 */
export function terminalTransitionsSinceLastPoll(
  previous: readonly Pick<BridgeRequest, "requestId" | "status">[] | undefined,
  current: readonly BridgeRequest[],
): BridgeRequest[] {
  if (!previous) return [];
  const previousStatus = new Map(previous.map((request) => [request.requestId, request.status]));
  return current.filter((request) => {
    const prior = previousStatus.get(request.requestId);
    return prior !== undefined && !TERMINAL_STATUSES.has(prior) && TERMINAL_STATUSES.has(request.status);
  });
}
