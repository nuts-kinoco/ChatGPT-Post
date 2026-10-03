/** Future transport boundary. Storage/push success is never requester result acceptance.
 * Ordinary ChatGPT uses the preserved browser route. Work/dot subscribed events are a distinct
 * future notification route, not an ordinary-ChatGPT executor. Ordinary Chat supported-app
 * events are another unverified candidate documented in DELIVERY-ADDENDUM.md.
 */
import type { TaskHandshake } from "./task-store.js";

export type TaskDeliveryRoute =
  | "github_storage"
  | "dot_work_subscribed_events"
  | "ordinary_chat_supported_app_events";
export interface TaskDeliveryAdapter {
  readonly id: string;
  readonly route: TaskDeliveryRoute;
  /** Deliver the exact immutable bytes from TaskStore.deliveryPayload. The adapter must enforce
   * authenticated recipients, signed callback requirements and approved retry/deadline limits.
   * Resolving only confirms transport submission. It must not synthesize a result_ack. */
  deliver(event: TaskHandshake, resultBytes: Uint8Array): Promise<void>;
}
export class UnavailableTaskDelivery implements TaskDeliveryAdapter {
  readonly id = "unconfigured-delivery";
  readonly route = "github_storage";
  async deliver(): Promise<void> {
    throw new Error("delivery_adapter_unconfigured");
  }
}
