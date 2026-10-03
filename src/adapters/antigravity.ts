/** Antigravity 1.2.15 wire adapter. Provider output is untrusted transport data, never host evidence. */
import { parseResponseFrame, type ResponseFrameIdentity } from "../contracts/response-frame.js";
import { parseStrictProviderJsonBytes, sha256Bytes } from "../contracts/task.js";

export const ANTIGRAVITY_VERSION = "1.2.15";
export const ANTIGRAVITY_REQUIRED_FLAGS = [
  "--input-format",
  "--output-format",
  "--model",
  "--print-timeout",
  "--disable-slash-commands",
  "--sandbox",
] as const;
export interface AntigravityCliCapabilities {
  protocol: "bridge-antigravity-cli/1";
  version: string;
  helpSha256: string;
  flags: string[];
  inputFormats: string[];
  outputFormats: string[];
  efforts: string[];
}
/** Host feeds an explicitly obtained --help observation. No process, login or provider call. */
export function inspectAntigravityHelp(help: string, version: string): AntigravityCliCapabilities {
  if (Buffer.byteLength(help) > 65536 || help.includes("\0"))
    throw new Error("antigravity_help_invalid");
  const lines = help.split(/\r?\n/);
  const flags = lines.flatMap((line) => line.match(/^\s+(--[a-z-]+)\s/)?.[1] ?? []);
  const line = (flag: string) =>
    lines.find((value) => value.trimStart().startsWith(`${flag} `)) ?? "";
  const formats = (flag: string) =>
    ["text", "json", "stream-json"].filter((format) =>
      new RegExp(`(?:[\\s,(|])${format}(?:[\\s,)|.])`).test(line(flag)),
    );
  const capabilities: AntigravityCliCapabilities = {
    protocol: "bridge-antigravity-cli/1",
    version,
    helpSha256: sha256Bytes(Buffer.from(help)),
    flags,
    inputFormats: formats("--input-format"),
    outputFormats: formats("--output-format"),
    efforts: ["low", "medium", "high", "xhigh", "max"].filter((effort) =>
      new RegExp(`(?:[\\s,(|])${effort}(?:[\\s,)|])`).test(line("--effort")),
    ),
  };
  validateAntigravityCapabilities(capabilities, version);
  return capabilities;
}
export function validateAntigravityCapabilities(
  c: AntigravityCliCapabilities,
  version: string,
): void {
  if (version !== ANTIGRAVITY_VERSION) throw new Error("antigravity_version_unsupported");
  if (
    c?.protocol !== "bridge-antigravity-cli/1" ||
    c.version !== version ||
    !/^[a-f0-9]{64}$/.test(c.helpSha256) ||
    !Array.isArray(c.flags) ||
    !Array.isArray(c.inputFormats) ||
    !Array.isArray(c.outputFormats) ||
    !Array.isArray(c.efforts) ||
    ANTIGRAVITY_REQUIRED_FLAGS.some((flag) => !c.flags.includes(flag)) ||
    !c.inputFormats.includes("stream-json") ||
    !c.outputFormats.includes("stream-json")
  )
    throw new Error("antigravity_capability_unavailable");
}
export const ANTIGRAVITY_ADAPTER_CAPABILITIES = {
  agent: "antigravity",
  label: "Antigravity",
  roles: ["issuer", "response_producer"],
  supportedVersion: ANTIGRAVITY_VERSION,
  plan: "one-turn-stdin-ndjson",
  output: "strict-init-step_update-result",
  model: "registered-id-required-no-fallback",
  effort: { supported: false, reason: "TaskSpec has no effort field; CLI support is separate" },
  session: "fresh-only",
  resume: false,
  providerCancelRpc: false,
  providerStatusRpc: false,
  lifecycle: "existing-identity-bound-supervisor-status-cancel-collect",
  productionExecution: false,
  reason: "enforcing-os-supervisor-not-implemented",
  quota: "unknown",
  billingEstimate: null,
} as const;

export interface AntigravityOutputContext {
  responseFrame: ResponseFrameIdentity;
  requestedModel: string;
  cwd: string;
}
export type AntigravityStatus =
  | "SUCCESS"
  | "ERROR"
  | "CANCELED"
  | "INTERRUPTED"
  | "INVALID"
  | "WAITING"
  | "RUNNING";
export interface AntigravityOutput {
  protocol: "bridge-antigravity-output/1";
  conversationId: string;
  reportedModel: string | null;
  providerStatus: AntigravityStatus;
  response: string;
  frame: ReturnType<typeof parseResponseFrame> | null;
  error: string | null;
  exitCode: number | null;
  streamSha256: string;
  /** This remains false even for exit 0 + SUCCESS + a valid response frame. */
  authoritativeExecutionEvidence: false;
}
const STATUSES = new Set([
  "SUCCESS",
  "ERROR",
  "CANCELED",
  "INTERRUPTED",
  "INVALID",
  "WAITING",
  "RUNNING",
]);
const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 100000;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("antigravity_output_invalid");
  return value as Record<string, unknown>;
}
function counter(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function resultOutput(
  value: unknown,
  context: AntigravityOutputContext,
  exitCode: number | null,
  streamSha256: string,
  session: { conversationId: string; model: string } | null,
): AntigravityOutput {
  const result = object(value);
  if (
    typeof result.status !== "string" ||
    !STATUSES.has(result.status) ||
    typeof result.response !== "string" ||
    typeof result.conversation_id !== "string" ||
    (result.conversation_id !== "" && !CONVERSATION.test(result.conversation_id)) ||
    (result.error !== undefined && typeof result.error !== "string") ||
    !counter(result.num_turns) ||
    (result.num_turns as number) > 1 ||
    typeof result.duration_seconds !== "number" ||
    !Number.isFinite(result.duration_seconds) ||
    result.duration_seconds < 0
  )
    throw new Error("antigravity_result_invalid");
  if (session && result.conversation_id !== session.conversationId)
    throw new Error("antigravity_conversation_mismatch");
  const usage = object(result.usage);
  for (const name of [
    "input_tokens",
    "output_tokens",
    "thinking_tokens",
    "cache_read_tokens",
    "total_tokens",
  ])
    if (!counter(usage[name])) throw new Error("antigravity_usage_invalid");
  const success = result.status === "SUCCESS";
  if (
    success &&
    (!session || exitCode !== 0 || result.num_turns !== 1 || result.error !== undefined)
  )
    throw new Error("antigravity_success_unconfirmed");
  if (!session && result.status !== "ERROR") throw new Error("antigravity_init_missing");
  return {
    protocol: "bridge-antigravity-output/1",
    conversationId: result.conversation_id,
    reportedModel: session?.model ?? null,
    providerStatus: result.status as AntigravityStatus,
    response: result.response,
    frame: success ? parseResponseFrame(result.response, context.responseFrame) : null,
    error: (result.error as string | undefined) ?? null,
    exitCode,
    streamSha256,
    authoritativeExecutionEvidence: false,
  };
}
/** One fresh turn only. No concatenation of partial text/tool logs into the final answer. */
export class AntigravityOutputParser {
  private buffer = Buffer.alloc(0);
  private bytes = 0;
  private finished = false;
  private readonly context: AntigravityOutputContext;
  constructor(context: AntigravityOutputContext) {
    this.context = structuredClone(context);
  }
  push(chunk: Uint8Array): void {
    if (this.finished) throw new Error("antigravity_parser_closed");
    const required = this.bytes + chunk.byteLength;
    if (required > MAX_OUTPUT_BYTES) {
      this.finished = true;
      this.buffer = Buffer.alloc(0);
      throw new Error("antigravity_output_limit");
    }
    // Coalesce fragments so millions of tiny writes cannot create unbounded Buffer objects.
    if (required > this.buffer.length) {
      const next = Buffer.allocUnsafe(
        Math.min(MAX_OUTPUT_BYTES, Math.max(4096, required, this.buffer.length * 2)),
      );
      this.buffer.copy(next, 0, 0, this.bytes);
      this.buffer = next;
    }
    this.buffer.set(chunk, this.bytes);
    this.bytes = required;
  }
  finish(exitCode: number | null): AntigravityOutput {
    if (this.finished) throw new Error("antigravity_parser_closed");
    this.finished = true;
    const bytes = this.buffer.subarray(0, this.bytes);
    this.buffer = Buffer.alloc(0);
    if (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < 0))
      throw new Error("antigravity_exit_invalid");
    const raw = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!raw.endsWith("\n") || raw.includes("\0")) throw new Error("antigravity_stream_truncated");
    const lines = raw.slice(0, -1).split("\n");
    if (lines.length > MAX_EVENTS) throw new Error("antigravity_event_limit");
    let session: { conversationId: string; model: string } | null = null;
    let result: unknown;
    for (const line of lines) {
      const event = object(parseStrictProviderJsonBytes(Buffer.from(line)));
      if (result !== undefined) throw new Error("antigravity_event_after_result");
      if (event.event === "init") {
        if (session) throw new Error("antigravity_duplicate_init");
        const init = object(event.init);
        if (
          typeof event.conversation_id !== "string" ||
          !CONVERSATION.test(event.conversation_id) ||
          init.cwd !== this.context.cwd ||
          init.model !== this.context.requestedModel ||
          init.permission_mode !== "request-review" ||
          !Array.isArray(init.tools) ||
          init.tools.some((tool) => typeof tool !== "string") ||
          init.agent !== undefined
        )
          throw new Error("antigravity_init_mismatch");
        session = { conversationId: event.conversation_id, model: this.context.requestedModel };
      } else if (event.event === "step_update") {
        const step = object(event.step_update);
        if (
          !session ||
          step.conversation_id !== session.conversationId ||
          !counter(step.step_index) ||
          typeof step.state !== "string" ||
          !["ACTIVE", "DONE"].includes(step.state) ||
          typeof step.step_type !== "string" ||
          (step.text_delta !== undefined && typeof step.text_delta !== "string")
        )
          throw new Error("antigravity_step_invalid");
      } else if (event.event === "result") {
        result = event.result;
        if (result === undefined) throw new Error("antigravity_result_invalid");
      } else throw new Error("antigravity_event_unsupported");
    }
    if (result === undefined) throw new Error("antigravity_result_missing");
    return resultOutput(result, this.context, exitCode, sha256Bytes(bytes), session);
  }
}
export function parseAntigravityOutput(
  bytes: Uint8Array,
  context: AntigravityOutputContext,
  exitCode: number | null,
): AntigravityOutput {
  const parser = new AntigravityOutputParser(context);
  parser.push(bytes);
  return parser.finish(exitCode);
}
