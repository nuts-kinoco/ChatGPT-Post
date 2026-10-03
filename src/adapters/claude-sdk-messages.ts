/** SDK yielded-message validation only. No raw subprocess bounds or OS exit evidence. */

import {
  parseTextResponse,
  TEXT_BOUNDS,
  TEXT_MODEL,
  type TextBinding,
  type TextObservation,
} from "../contracts/sdk-text-inference.js";
import { parseStrictProviderJsonBytes, sha256Bytes } from "../contracts/task.js";
import { canonicalSdkMessage } from "./sdk-json-boundary.js";

interface FinalObservation {
  text: string;
  observation: TextObservation;
  /** Private compatibility provenance, not a grant or public account/quota observation. */
  startup: {
    agentsInventory: "empty" | "unreported";
    pluginErrors: "empty" | "unreported";
    rateTelemetryEvents: number;
    overageUse: "reported_false" | "unreported";
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("text_provider_shape_invalid");
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000_000)
    throw new Error("text_provider_usage_invalid");
  return Number(value);
}
function noReportedTools(usage: Record<string, unknown>): void {
  for (const key of ["server_tool_use", "serverToolUse"]) {
    if (usage[key] !== undefined) {
      const counts = object(usage[key]);
      for (const [name, value] of Object.entries(counts))
        if (!["web_search_requests", "web_fetch_requests"].includes(name) || integer(value) !== 0)
          throw new Error("text_provider_server_tool_use");
    }
  }
  for (const key of ["output_tokens_details", "outputTokensDetails"]) {
    if (usage[key] !== undefined) {
      const details = object(usage[key]);
      for (const [name, value] of Object.entries(details)) {
        if (!["thinking_tokens", "thinkingTokens"].includes(name) || integer(value) !== 0)
          throw new Error("text_provider_tool_or_thinking_usage");
      }
    }
  }
  for (const key of [
    "webSearchRequests",
    "webFetchRequests",
    "thinking_tokens",
    "thinkingTokens",
    "tool_use_count",
    "toolUseCount",
  ])
    if (usage[key] !== undefined && integer(usage[key]) !== 0)
      throw new Error("text_provider_tool_or_thinking_usage");
}
export class ClaudeSdkMessages {
  private readonly source = Buffer.alloc(TEXT_BOUNDS.maxCanonicalMessagesBytes);
  private canonicalBytes = 0;
  private stderrBytes = 0;
  private failure: string | null = null;
  private ended = false;
  private session: string | null = null;
  private text: string | null = null;
  private result: Record<string, unknown> | null = null;
  private lines = 0;
  private totalEvents = 0;
  private readonly rateIds = new Set<string>();
  private agentsInventory: "empty" | "unreported" = "unreported";
  private pluginErrors: "empty" | "unreported" = "unreported";
  private overageUse: "reported_false" | "unreported" = "unreported";
  private missingOverageUse = false;
  constructor(
    private readonly expected: {
      binding: TextBinding;
      attemptId: string;
      binarySha256ObservedBefore: string;
      cliVersion: "2.1.288";
    },
    private readonly onViolation: (code: string) => void,
  ) {
    this.expected = structuredClone(expected);
  }
  private reject(code: string): never {
    if (!this.failure) {
      this.failure = code;
      try {
        this.onViolation(code);
      } catch {
        /* Violation remains failed even if host cancellation reporting fails. */
      }
    }
    throw new Error(this.failure);
  }
  feedMessage(value: unknown): void {
    if (this.failure) throw new Error(this.failure);
    if (this.ended) this.reject("text_provider_after_eof");
    let bytes: Buffer;
    try {
      bytes = canonicalSdkMessage(value, TEXT_BOUNDS.maxCanonicalMessageBytes);
    } catch {
      this.reject("text_provider_sdk_value_invalid");
    }
    if (this.canonicalBytes + bytes.length + 1 > TEXT_BOUNDS.maxCanonicalMessagesBytes)
      this.reject("text_provider_canonical_limit");
    this.source.set(bytes, this.canonicalBytes);
    this.canonicalBytes += bytes.length;
    this.source[this.canonicalBytes++] = 10;
    this.consume(bytes);
  }
  observeStderr(value: string): void {
    if (this.failure) throw new Error(this.failure);
    if (typeof value !== "string" || value.length > TEXT_BOUNDS.maxSdkStderrObservedBytes)
      this.reject("text_provider_stderr_limit");
    this.stderrBytes += Buffer.byteLength(value);
    if (this.stderrBytes > TEXT_BOUNDS.maxSdkStderrObservedBytes)
      this.reject("text_provider_stderr_limit");
  }
  private consume(line: Uint8Array): void {
    try {
      const event = object(parseStrictProviderJsonBytes(line));
      this.totalEvents++;
      if (this.totalEvents > 7) throw new Error("text_provider_event_limit");
      if (event.type === "rate_limit_event") {
        this.rateTelemetry(event);
        return;
      }
      this.lines++;
      if (this.lines > 3) throw new Error("text_provider_extra_event");
      if (this.lines === 1) {
        if (
          event.type !== "system" ||
          event.subtype !== "init" ||
          event.model !== TEXT_MODEL ||
          typeof event.session_id !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            event.session_id,
          ) ||
          event.session_id.length !== 36
        )
          throw new Error("text_provider_init_invalid");
        for (const key of ["tools", "mcp_servers", "slash_commands", "skills"])
          if (!Array.isArray(event[key]) || (event[key] as unknown[]).length !== 0)
            throw new Error("text_provider_tools_or_customizations");
        if (event.agents !== undefined) {
          if (!Array.isArray(event.agents) || event.agents.length !== 0)
            throw new Error("text_provider_tools_or_customizations");
          this.agentsInventory = "empty";
        }
        if (!Array.isArray(event.plugins) || event.plugins.length !== 0)
          throw new Error("text_provider_plugins_unapproved");
        if (event.plugin_errors !== undefined) {
          if (!Array.isArray(event.plugin_errors) || event.plugin_errors.length !== 0)
            throw new Error("text_provider_plugin_errors");
          this.pluginErrors = "empty";
        }
        if (
          (event.claude_code_version !== undefined &&
            event.claude_code_version !== this.expected.cliVersion) ||
          (event.apiKeySource !== undefined && event.apiKeySource !== "none") ||
          (event.effort !== undefined && event.effort !== null) ||
          (event.permissionMode !== undefined && event.permissionMode !== "dontAsk")
        )
          throw new Error("text_provider_profile_mismatch");
        this.session = event.session_id;
        return;
      }
      if (event.session_id !== this.session) throw new Error("text_provider_session_mismatch");
      if (this.lines === 2) {
        if (event.type !== "assistant" || event.parent_tool_use_id !== null)
          throw new Error("text_provider_assistant_invalid");
        const message = object(event.message);
        if (
          message.model !== TEXT_MODEL ||
          message.role !== "assistant" ||
          !Array.isArray(message.content) ||
          message.content.length !== 1
        )
          throw new Error("text_provider_model_or_turn_mismatch");
        if (message.usage !== undefined) noReportedTools(object(message.usage));
        const part = object(message.content[0]);
        if (
          part.type !== "text" ||
          typeof part.text !== "string" ||
          Object.keys(part).sort().join(",") !== "text,type"
        )
          throw new Error("text_provider_nontext_content");
        parseTextResponse(part.text, this.expected.binding, this.expected.attemptId);
        this.text = part.text;
        return;
      }
      if (
        event.type !== "result" ||
        event.subtype !== "success" ||
        event.is_error !== false ||
        event.num_turns !== 1 ||
        event.result !== this.text ||
        this.text === null
      )
        throw new Error("text_provider_terminal_invalid");
      if (
        ["deferred_tool_use", "resume_reason", "local_command", "structured_output"].some(
          (k) => event[k] !== undefined,
        ) ||
        (event.queued_turn_count !== undefined && event.queued_turn_count !== 0) ||
        (event.result_index !== undefined && event.result_index !== 0)
      )
        throw new Error("text_provider_extra_work");
      const usage = object(event.usage),
        models = object(event.modelUsage);
      if (Object.keys(models).length !== 1 || !Object.hasOwn(models, TEXT_MODEL))
        throw new Error("text_provider_model_usage_invalid");
      const model = object(models[TEXT_MODEL]);
      noReportedTools(usage);
      noReportedTools(model);
      if (
        event.permission_denials !== undefined &&
        (!Array.isArray(event.permission_denials) || event.permission_denials.length !== 0)
      )
        throw new Error("text_provider_permission_denials");
      for (const [key, other] of [
        ["input_tokens", "inputTokens"],
        ["output_tokens", "outputTokens"],
        ["cache_read_input_tokens", "cacheReadInputTokens"],
        ["cache_creation_input_tokens", "cacheCreationInputTokens"],
      ] as const)
        if (integer(usage[key]) !== integer(model[other]))
          throw new Error("text_provider_usage_mismatch");
      if (integer(usage.output_tokens) > TEXT_BOUNDS.maxOutputTokens)
        throw new Error("text_provider_token_limit");
      this.result = event;
    } catch (error) {
      const known =
        error instanceof Error && /^text_provider_[a-z_]+$/.test(error.message)
          ? error.message
          : "text_provider_event_invalid";
      this.reject(known);
    }
  }
  private rateTelemetry(event: Record<string, unknown>): void {
    if (
      !this.session ||
      event.session_id !== this.session ||
      Object.keys(event).sort().join(",") !== "rate_limit_info,session_id,type,uuid" ||
      typeof event.uuid !== "string" ||
      event.uuid.length !== 36 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(event.uuid) ||
      this.rateIds.has(event.uuid) ||
      this.rateIds.size >= 4
    )
      throw new Error("text_provider_rate_event_invalid");
    const info = object(event.rate_limit_info);
    const enums: Record<string, readonly string[]> = {
      status: ["allowed", "allowed_warning"],
      rateLimitType: [
        "five_hour",
        "seven_day",
        "seven_day_opus",
        "seven_day_sonnet",
        "seven_day_overage_included",
        "overage",
      ],
      overageStatus: ["allowed", "allowed_warning", "rejected"],
      overageDisabledReason: [
        "overage_not_provisioned",
        "org_level_disabled",
        "org_level_disabled_until",
        "out_of_credits",
        "seat_tier_level_disabled",
        "member_level_disabled",
        "seat_tier_zero_credit_limit",
        "group_zero_credit_limit",
        "member_zero_credit_limit",
        "org_service_level_disabled",
        "no_limits_configured",
        "fetch_error",
        "unknown",
      ],
      limitScope: ["service", "channel", "group_pool"],
    };
    if (!Object.hasOwn(info, "status")) throw new Error("text_provider_rate_event_invalid");
    for (const [key, value] of Object.entries(info)) {
      if (enums[key]) {
        if (typeof value !== "string" || !enums[key]?.includes(value))
          throw new Error("text_provider_rate_event_invalid");
      } else if (
        ["resetsAt", "overageResetsAt", "utilization", "surpassedThreshold"].includes(key)
      ) {
        const max = key.endsWith("At") ? 1e12 : 1;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max)
          throw new Error("text_provider_rate_event_invalid");
      } else if (["isUsingOverage", "overageInUse"].includes(key)) {
        if (value !== false) throw new Error("text_provider_overage_unapproved");
      } else if (["canUserPurchaseCredits", "hasChargeableSavedPaymentMethod"].includes(key)) {
        if (typeof value !== "boolean") throw new Error("text_provider_rate_event_invalid");
      } else throw new Error("text_provider_rate_event_invalid");
    }
    if (!Object.hasOwn(info, "isUsingOverage") && !Object.hasOwn(info, "overageInUse"))
      this.missingOverageUse = true;
    this.overageUse = this.missingOverageUse ? "unreported" : "reported_false";
    this.rateIds.add(event.uuid);
  }
  complete(input: {
    sdkIteratorCompleted: boolean;
    sdkCloseRequested: boolean;
    cancelled: boolean;
    finishedAtMs: number;
    deadlineAtMs: number;
  }): FinalObservation {
    if (this.failure) throw new Error(this.failure);
    if (this.ended) this.reject("text_provider_duplicate_eof");
    this.ended = true;
    if (
      input.sdkIteratorCompleted !== true ||
      input.sdkCloseRequested !== true ||
      input.cancelled ||
      !Number.isFinite(input.finishedAtMs) ||
      !Number.isFinite(input.deadlineAtMs) ||
      input.finishedAtMs > input.deadlineAtMs ||
      this.lines !== 3 ||
      !this.result ||
      this.text === null ||
      !this.session
    )
      this.reject("text_provider_exit_or_incomplete");
    const u = object(this.result.usage);
    return {
      text: this.text,
      startup: {
        agentsInventory: this.agentsInventory,
        pluginErrors: this.pluginErrors,
        rateTelemetryEvents: this.rateIds.size,
        overageUse: this.overageUse,
      },
      observation: {
        schema: "sdk-text-observation-1",
        model: TEXT_MODEL,
        sessionId: this.session,
        turns: 1,
        toolUses: 0,
        thinkingBlocks: 0,
        inputTokens: integer(u.input_tokens),
        outputTokens: integer(u.output_tokens),
        cacheReadInputTokens: integer(u.cache_read_input_tokens),
        cacheCreationInputTokens: integer(u.cache_creation_input_tokens),
        providerHttpRequests: "unknown",
        sourceSdkMessagesSha256: sha256Bytes(this.source.subarray(0, this.canonicalBytes)),
        assurance: "trusted-host-official-sdk-controls",
        completion: "sdk_iterator_completed",
        osProcessExit: "unobserved",
        descendantTermination: "unverified",
        serverCancellation: "unverified",
        executableByteBinding: "trusted-host-path",
        bridgeSdkQueryInvocations: 1,
        cliInvocations: "unobserved",
        sdkCloseRequested: true,
        sdkVersion: "0.3.287",
        cliVersion: this.expected.cliVersion,
        binarySha256ObservedBefore: this.expected.binarySha256ObservedBefore,
      },
    };
  }
  /** Recipient-private crash recovery only; never include this raw stream in the Git result bundle. */
  privateRecoveryBytes(): Uint8Array {
    return Buffer.from(this.source.subarray(0, this.canonicalBytes));
  }
}
