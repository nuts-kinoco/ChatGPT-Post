/** Task states are independent of browser transport completion (legacy schema 1.x). */
import type { TaskStatus } from "../contracts/task-types.js";

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  received: ["awaiting_approval", "failed", "cancelled"],
  awaiting_approval: ["approved", "failed", "cancelled"],
  approved: ["awaiting_approval", "running", "unknown", "failed", "cancelled"],
  running: ["cancel_requested", "succeeded", "failed", "unknown"],
  cancel_requested: ["cancelled", "failed", "unknown"],
  unknown: ["running", "cancel_requested", "cancelled", "succeeded", "failed"],
  cancelled: [],
  succeeded: [],
  failed: [],
};

export function isTerminalTask(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to && !isTerminalTask(from)) return; // A newer observation, never a rerun.
  if (!transitions[from].includes(to)) throw new Error(`invalid_task_transition: ${from} -> ${to}`);
}
