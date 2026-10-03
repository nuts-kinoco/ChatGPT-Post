/** A bounded owner of the existing hosted start future. It never replays a durable attempt. */
import type { HostedOperationBinding, OperationCapabilities } from "../contracts/operations.js";
import { UiError } from "../contracts/ui.js";
import type { HostedOperationsRecord, UiOperationsSources } from "./operations.js";
export interface HostedUiService {
  get(requestId: string): HostedOperationsRecord | null;
  listPage(after: string, limit: number): { requestIds: string[]; next: string | null };
  recentPage?(after: string, limit: number): { requestIds: string[]; next: string | null };
  approve(
    requestId: string,
    authorization: {
      actorId: string;
      taskSpecHash: string;
      expiresAt: string;
      authenticated: true;
    },
  ): void;
  start(requestId: string): Promise<HostedOperationsRecord>;
  cancel(requestId: string): Promise<void>;
  reconcile(requestId: string): Promise<HostedOperationsRecord>;
}
export class HostedUiScheduler {
  private readonly active = new Map<string, Promise<void>>();
  private closing = false;
  constructor(
    private readonly service: HostedUiService,
    private readonly maximum = 4,
    private readonly onDurableStart?: (record: HostedOperationsRecord) => void,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8)
      throw new Error("hosted_ui_capacity_invalid");
  }
  private exact(binding: HostedOperationBinding): HostedOperationsRecord {
    const job = this.service.get(binding.requestId);
    if (
      !job ||
      job.issued.taskSpecHash !== binding.taskSpecHash ||
      job.attemptId !== binding.attemptId ||
      job.revision !== binding.revision
    )
      throw new UiError(
        "stale_hosted_binding",
        "Hosted record changed; refresh before acting",
        409,
      );
    return job;
  }
  /** BrowserDeliveryService.start commits intent synchronously before its first async effect. */
  scheduleStart(binding: HostedOperationBinding): { accepted: true } {
    if (this.closing || this.active.size >= this.maximum || this.active.has(binding.requestId))
      throw new UiError(
        "hosted_ui_busy",
        "Hosted worker is at capacity or already owns this attempt",
        409,
      );
    const before = this.exact(binding);
    if (before.attempted || before.cancelRequestedAt || before.state !== "approved")
      throw new UiError("hosted_start_denied", "A new hosted attempt is not allowed", 409);
    const running = this.service.start(binding.requestId);
    const observed = this.service.get(binding.requestId);
    const tracked = running
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        if (this.active.get(binding.requestId) === tracked) this.active.delete(binding.requestId);
      });
    this.active.set(binding.requestId, tracked);
    if (
      !observed?.attempted ||
      !observed.attemptId ||
      observed.revision <= binding.revision ||
      observed.issued.taskSpecHash !== binding.taskSpecHash
    )
      throw new UiError(
        "hosted_start_unconfirmed",
        "Durable hosted attempt was not observed; do not retry",
        409,
      );
    try {
      this.onDurableStart?.(structuredClone(observed));
    } catch {
      /* Optional counter telemetry is not execution authority. */
    }
    return { accepted: true };
  }
  approve(binding: HostedOperationBinding, actorId: string, expiresAt: string): void {
    if (this.closing) throw new UiError("hosted_ui_closing", "Hosted worker is closing", 409);
    this.exact(binding);
    this.service.approve(binding.requestId, {
      actorId,
      taskSpecHash: binding.taskSpecHash,
      expiresAt,
      authenticated: true,
    });
  }
  async cancel(binding: HostedOperationBinding): Promise<void> {
    this.exact(binding);
    await this.service.cancel(binding.requestId);
  }
  async reconcile(binding: HostedOperationBinding): Promise<void> {
    this.exact(binding);
    await this.service.reconcile(binding.requestId);
  }
  /** Host shutdown only. Hiding/collapsing UI must never call this method or close the service. */
  async close(timeoutMs = 5000): Promise<void> {
    this.closing = true;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
      throw new Error("hosted_close_timeout_invalid");
    const ids = [...this.active.keys()];
    const stopping = Promise.all(
      ids.map((id) =>
        Promise.resolve()
          .then(() => this.service.cancel(id))
          .catch(() => {}),
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        stopping.then(() => Promise.all([...this.active.values()])),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("hosted_shutdown_pending")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
export function hostedOperationsPort(
  service: HostedUiService,
  options: {
    policyHash: string;
    conversationId: string | null;
    destinationId: string | null;
    capabilities(record: HostedOperationsRecord): Partial<OperationCapabilities>;
    maximumActive?: number;
    /** Host-only, non-authoritative observation consumer (for the Bridge-observed counter). */
    onObservation?(record: HostedOperationsRecord): void;
    onDurableStart?(record: HostedOperationsRecord): void;
    now?: () => Date;
    approvalSeconds?: number;
  },
) {
  const seconds = options.approvalSeconds ?? 60;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 900)
    throw new Error("hosted_approval_age_invalid");
  const observe = (record: HostedOperationsRecord | null) => {
    if (record)
      try {
        options.onObservation?.(structuredClone(record));
      } catch {
        /* Optional telemetry never blocks cancellation or changes authority. */
      }
    return record;
  };
  const observedService: HostedUiService = {
    get: (id) => observe(service.get(id)),
    listPage: (after, limit) =>
      service.recentPage?.(after, limit) ?? service.listPage(after, limit),
    approve: (id, value) => {
      service.approve(id, value);
      observe(service.get(id));
    },
    start: (id) =>
      service.start(id).finally(() => {
        observe(service.get(id));
      }),
    cancel: async (id) => {
      await service.cancel(id);
      observe(service.get(id));
    },
    reconcile: async (id) => {
      const record = await service.reconcile(id);
      observe(record);
      return record;
    },
  };
  const scheduler = new HostedUiScheduler(
    observedService,
    options.maximumActive,
    options.onDurableStart,
  );
  const source: NonNullable<UiOperationsSources["hosted"]> = {
    policyHash: options.policyHash,
    conversationId: options.conversationId,
    destinationId: options.destinationId,
    get: (id) => observedService.get(id),
    list: (after, limit) => observedService.listPage(after, limit),
    capabilities: options.capabilities,
    approve: (binding, actorId) =>
      scheduler.approve(
        binding,
        actorId,
        new Date((options.now?.() ?? new Date()).getTime() + seconds * 1000).toISOString(),
      ),
    scheduleStart: (binding) => scheduler.scheduleStart(binding),
    cancel: (binding) => scheduler.cancel(binding),
    reconcile: (binding) => scheduler.reconcile(binding),
  };
  return { source, close: (timeoutMs?: number) => scheduler.close(timeoutMs) };
}
