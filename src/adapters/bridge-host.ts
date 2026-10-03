/** Host coordinator. Deploy only with an explicitly configured trusted authority/executor.
 * Tick reconciles ongoing identities, dependency gates and transport. Unknown never reexecutes.
 */
import type { GitHubRecipientPump, TransportTick } from "./github-transport.js";
import type { LocalTaskAuthority } from "./local-authority.js";
export interface HostTick {
  transport: TransportTick;
  advanced: string[];
  blocked: { requestId: string; reason: string }[];
}
export class BridgeHost {
  private busy = false;
  constructor(
    readonly pump: GitHubRecipientPump,
    readonly authority: LocalTaskAuthority,
    readonly options: { autoDispatch: boolean; evaluateBoundedPolicy: boolean; maxPerTick: number },
  ) {
    if (
      pump.controller !== authority.controller ||
      !Number.isInteger(options.maxPerTick) ||
      options.maxPerTick < 1 ||
      options.maxPerTick > 256
    )
      throw new Error("host_config_invalid");
    if (options.evaluateBoundedPolicy && pump.controller.policy.confirmation === "manual")
      throw new Error("host_automatic_policy_not_configured");
  }
  async tick(): Promise<HostTick> {
    if (this.busy) throw new Error("host_tick_in_progress");
    this.busy = true;
    try {
      const result: HostTick = { transport: await this.pump.tick(), advanced: [], blocked: [] };
      const controller = this.pump.controller;
      const tasks = controller.store
        .listSession(controller.policy.sessionId)
        .filter((row) => !["failed", "succeeded", "cancelled"].includes(row.result.status))
        .sort((a, b) => a.result.request_id.localeCompare(b.result.request_id));
      const cursor = this.pump.journal.cursor("host");
      const ordered = [
        ...tasks.filter((t) => t.result.request_id > cursor),
        ...tasks.filter((t) => t.result.request_id <= cursor),
      ].slice(0, this.options.maxPerTick);
      for (const task of ordered) {
        const id = task.result.request_id;
        try {
          if (task.intent) {
            await controller.status(id);
            result.advanced.push(id);
            continue;
          }
          if (task.result.status === "awaiting_approval" && this.options.evaluateBoundedPolicy)
            this.authority.evaluatePolicy(id);
          const current = controller.store.get(id);
          if (current?.result.status === "approved" && this.options.autoDispatch) {
            const grant = controller.store
              .approvalsForRequest(id)
              .reverse()
              .find((row) => !row.consumed && row.envelope.decision === "approved");
            if (!grant) throw new Error("host_approval_missing");
            await controller.start(id, grant.envelope.approval_id);
            result.advanced.push(id);
          }
        } catch (error) {
          result.blocked.push({
            requestId: id,
            reason:
              error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
                ? error.message
                : "host_operation_failed",
          });
        } finally {
          this.pump.journal.advance("host", id);
        }
      }
      // Receipt/result writeback after newly observed transitions, without waiting another cycle.
      const after = await this.pump.tick();
      result.transport.received.push(...after.received);
      result.transport.delivered.push(...after.delivered);
      result.transport.acknowledged.push(...after.acknowledged);
      result.transport.blocked.push(...after.blocked);
      return result;
    } finally {
      this.busy = false;
    }
  }
}
