/** A settings facade over one injected counter. No provider calls, ledger creation or HTTP observations. */
import type { OperationSource } from "../contracts/operations.js";
import { validateResult } from "../contracts/schema.js";
import type { BridgeResult } from "../contracts/types.js";
import { UiError } from "../contracts/ui.js";
import type { HostedOperationsRecord } from "./operations.js";
import {
  type ProCounterView,
  type ProObservationStore,
  validateProSettings,
} from "./pro-counter.js";

export type ProCounterSettingsView =
  | {
      version: "bridge-pro-counter-settings-1";
      state: "available";
      configurable: true;
      view: ProCounterView;
    }
  | {
      version: "bridge-pro-counter-settings-1";
      state: "unavailable";
      configurable: false;
      reason:
        | "pro_counter_unconfigured"
        | "counter_integrity_unavailable"
        | "counter_read_unavailable";
    };
export class UiProCounterSettings {
  constructor(private readonly store?: ProObservationStore) {}
  view(): ProCounterSettingsView {
    if (!this.store)
      return {
        version: "bridge-pro-counter-settings-1",
        state: "unavailable",
        configurable: false,
        reason: "pro_counter_unconfigured",
      };
    try {
      return {
        version: "bridge-pro-counter-settings-1",
        state: "available",
        configurable: true,
        view: this.store.view(),
      };
    } catch (error) {
      return {
        version: "bridge-pro-counter-settings-1",
        state: "unavailable",
        configurable: false,
        reason:
          error instanceof UiError && error.code === "counter_integrity_unavailable"
            ? "counter_integrity_unavailable"
            : "counter_read_unavailable",
      };
    }
  }
  update(input: unknown): ProCounterSettingsView {
    if (!this.store)
      throw new UiError(
        "pro_counter_unconfigured",
        "Bridge-observed counter is not configured",
        409,
      );
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join() !== "expectedRevision,settings"
    )
      throw new UiError(
        "invalid_counter_settings_request",
        "Only expectedRevision and complete manual settings are accepted",
      );
    const value = input as { expectedRevision: unknown; settings: unknown };
    if (
      !Number.isSafeInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 0 ||
      Number(value.expectedRevision) > 9999
    )
      throw new UiError(
        "invalid_counter_revision",
        "Expected revision must be a nonnegative bounded integer",
      );
    validateProSettings(value.settings);
    try {
      this.store.configure(value.settings, Number(value.expectedRevision));
      return this.view();
    } catch (error) {
      if (error instanceof UiError) throw error;
      throw new UiError(
        "counter_update_unavailable",
        "Counter settings could not be saved; refresh before retrying",
        409,
      );
    }
  }
}
export interface PersistedHostedProObservation {
  revision: number;
  result: BridgeResult;
}
/** Bind only at the trusted host's persisted-observation callback, never to request JSON.
 * The supplied observation must be read from this job's authoritative observation store.
 * Missing/ambiguous observations stay unavailable; requested model/preset is never usage evidence. */
export function createHostedProObserver(
  store: ProObservationStore | undefined,
  options: { synthetic: boolean },
) {
  return (
    job: HostedOperationsRecord | null,
    persisted?: PersistedHostedProObservation,
  ): OperationSource<{ requestId: string; attemptId: string; revision: number }> => {
    if (!store) return { state: "unavailable", reason: "pro_counter_unconfigured" };
    if (store.synthetic !== options.synthetic)
      return { state: "unavailable", reason: "counter_profile_mismatch" };
    if (
      job?.issued.route !== "ordinary_chat_browser" ||
      !job.attempted ||
      !job.attemptId ||
      !job.attemptedAt
    )
      return { state: "unavailable", reason: "hosted_attempt_identity_unavailable" };
    if (
      !persisted &&
      job.response &&
      (job.response.requestId !== job.issued.requestId ||
        job.response.taskSpecHash !== job.issued.taskSpecHash ||
        job.response.attemptId !== job.attemptId ||
        job.response.localExecution !== false)
    )
      return { state: "unavailable", reason: "hosted_response_identity_mismatch" };
    const record =
      persisted ?? (job.response ? { revision: job.revision, result: job.response.result } : null);
    if (!record)
      return { state: "unavailable", reason: "hosted_submission_observation_unavailable" };
    const result = record.result;
    if (
      !Number.isSafeInteger(record.revision) ||
      record.revision < 1 ||
      record.revision > job.revision ||
      !validateResult(result).valid ||
      result.requestId !== job.issued.requestId ||
      result.target === "dot" ||
      Date.parse(result.startedAt) < Date.parse(job.attemptedAt) ||
      Date.parse(result.completedAt) < Date.parse(result.startedAt)
    )
      return { state: "unavailable", reason: "hosted_submission_observation_mismatch" };
    try {
      store.observe({
        requestId: job.issued.requestId,
        attemptId: job.attemptId,
        revision: record.revision,
        attemptedAt: new Date(job.attemptedAt).toISOString(),
        observedAt: new Date(result.completedAt).toISOString(),
        submitted: result.submitted,
        observedPreset:
          result.observedPreset === "pro"
            ? "pro"
            : result.observedPreset === null
              ? "unknown"
              : "other",
        source: "trusted-ordinary-chat-observer",
        synthetic: options.synthetic,
      });
      return {
        state: "available",
        value: {
          requestId: job.issued.requestId,
          attemptId: job.attemptId,
          revision: record.revision,
        },
      };
    } catch {
      return { state: "unavailable", reason: "counter_observation_rejected" };
    }
  };
}

/** Call ONLY immediately after the scheduler verifies a newly committed attempt, before acceptance.
 * Never call during startup replay or arbitrary get/reconcile: missing recovery observations stay unknown.
 * The counter inserts this provenance only once; later read/cancel revisions cannot replace real evidence. */
export function observeHostedStartIntent(
  store: ProObservationStore | undefined,
  job: HostedOperationsRecord | null,
): OperationSource<{ requestId: string; attemptId: string }> {
  if (!store) return { state: "unavailable", reason: "pro_counter_unconfigured" };
  if (
    job?.issued.route !== "ordinary_chat_browser" ||
    !job.attempted ||
    !job.attemptId ||
    !job.attemptedAt ||
    job.state !== "unknown" ||
    job.response ||
    job.cancelRequestedAt
  )
    return { state: "unavailable", reason: "new_hosted_start_intent_unavailable" };
  try {
    const attemptedAt = new Date(job.attemptedAt).toISOString();
    store.observeStartIntent({
      requestId: job.issued.requestId,
      attemptId: job.attemptId,
      revision: job.revision,
      attemptedAt,
      observedAt: attemptedAt,
      submitted: "unknown",
      observedPreset: "unknown",
      source: "trusted-hosted-start-intent",
      synthetic: store.synthetic,
    });
    return {
      state: "available",
      value: { requestId: job.issued.requestId, attemptId: job.attemptId },
    };
  } catch {
    return { state: "unavailable", reason: "counter_start_intent_rejected" };
  }
}
