/** Official SDK-managed fixed text route. No native helper, custom spawner, PID signalling or OS-exit claim. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { createFramedPrompt } from "../contracts/response-frame.js";
import {
  parseTextRequest,
  TEXT_BOUNDS,
  TEXT_MODEL,
  type TextApproval,
  type TextBinding,
  type TextObservation,
  validateTextBody,
} from "../contracts/sdk-text-inference.js";
import { sha256Bytes } from "../contracts/task.js";
import { ClaudeSdkMessages } from "./claude-sdk-messages.js";
import {
  type ClaudeSdkHostProfile,
  cloneClaudeSdkHostProfile,
  sdkProfileEnvironment,
} from "./claude-sdk-profile.js";

export const SDK_TEXT_VERSION = "0.3.287" as const;
export interface SdkQueryLike extends AsyncIterable<unknown> {
  close(): void;
}
export interface SdkQueryPort {
  query(input: { prompt: string; options: Options }): SdkQueryLike;
}
export interface SdkTextPlan {
  readonly binding: TextBinding;
  readonly attemptId: string;
  readonly input: string;
  readonly inputSha256: string;
  readonly sdkOptionsSha256: string;
  readonly profile: ClaudeSdkHostProfile;
  readonly deadlineAt: string;
}
const plans = new WeakSet<object>(),
  used = new WeakSet<object>();
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.freeze(v);
    for (const child of Object.values(v)) freeze(child);
  }
  return v;
}
export function sdkProfileDigest(profile: ClaudeSdkHostProfile): string {
  const p = cloneClaudeSdkHostProfile(profile);
  return sha256Bytes(
    Buffer.from(
      JSON.stringify({
        schema: "sdk-text-profile-digest-1",
        profile: p,
        sdkVersion: SDK_TEXT_VERSION,
        model: TEXT_MODEL,
        bounds: TEXT_BOUNDS,
        assurance: "trusted-host-official-sdk-controls",
      }),
    ),
  );
}
function options(profile: ClaudeSdkHostProfile): Options {
  return {
    pathToClaudeCodeExecutable: profile.executable,
    cwd: profile.cwd,
    model: TEXT_MODEL,
    maxTurns: 1,
    maxThinkingTokens: 0,
    tools: [],
    allowedTools: [],
    disallowedTools: ["*"],
    mcpServers: {},
    strictMcpConfig: true,
    permissionMode: "dontAsk",
    permissionPrompts: "none",
    settingSources: [],
    plugins: [],
    agents: {},
    additionalDirectories: [],
    persistSession: false,
    enableFileCheckpointing: false,
    verbatimPrompts: true,
    extraArgs: {
      "safe-mode": null,
      restricted: null,
      "disable-slash-commands": null,
      "no-chrome": null,
    },
    env: sdkProfileEnvironment(profile),
  };
}
export function prepareSdkTextPlan(
  profile: ClaudeSdkHostProfile,
  raw: Uint8Array,
  md: Uint8Array,
  grantRaw: Uint8Array,
  attemptId: string,
  deadlineAt: string,
): SdkTextPlan {
  const p = cloneClaudeSdkHostProfile(profile),
    r = parseTextRequest(raw, md),
    g = validateTextBody("approval", grantRaw) as unknown as TextApproval;
  const requestSha256 = sha256Bytes(raw),
    profileSha = sdkProfileDigest(p);
  if (
    r.recipientId !== p.recipientId ||
    r.policySha256 !== p.policySha256 ||
    r.sdkProfileSha256 !== profileSha ||
    g.sdkProfileSha256 !== profileSha ||
    g.requestSha256 !== requestSha256 ||
    g.requestId !== r.requestId ||
    g.requesterId !== r.requesterId ||
    g.recipientId !== r.recipientId ||
    g.taskFileSha256 !== r.taskFileSha256 ||
    g.policySha256 !== p.policySha256 ||
    g.approverId !== p.approverId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(attemptId) ||
    attemptId.length !== 36 ||
    !Number.isFinite(Date.parse(deadlineAt)) ||
    new Date(deadlineAt).toISOString() !== deadlineAt ||
    Date.parse(deadlineAt) > Date.parse(r.expiresAt)
  )
    throw new Error("sdk_text_plan_binding_invalid");
  const body = Buffer.from(
    `The response body must be one JSON object with exactly four string fields.\nrequestId: ${r.requestId}\nrequestSha256: ${requestSha256}\nattemptId: ${attemptId}\nmessage: bridge-handshake-ok\n\n${new TextDecoder("utf8", { fatal: true }).decode(md)}`,
  );
  const input = Buffer.from(
    createFramedPrompt(body, { requestId: r.requestId, taskSpecHash: requestSha256, attemptId }),
  ).toString("utf8");
  const inputSha256 = sha256Bytes(Buffer.from(input));
  const plan: SdkTextPlan = {
    binding: {
      requestId: r.requestId,
      requestSha256,
      requesterId: r.requesterId,
      recipientId: r.recipientId,
    },
    attemptId,
    input,
    inputSha256,
    sdkOptionsSha256: sha256Bytes(
      Buffer.from(
        JSON.stringify({
          schema: "sdk-text-options-1",
          options: options(p),
          inputSha256,
          sdkVersion: SDK_TEXT_VERSION,
          canUseTool: "always-deny",
          onElicitation: "decline",
          onUserDialog: "cancelled",
          maxDeadlineMs: 60000,
        }),
      ),
    ),
    profile: p,
    deadlineAt,
  };
  freeze(plan);
  plans.add(plan);
  return plan;
}
export interface SdkTextOutcome {
  state: "response_received" | "unknown" | "not_started";
  queryInvocations: 0 | 1;
  liveProviderCallObserved: boolean;
  failureCode: string | null;
  cleanup: "iterator_settled" | "pending";
  osProcessExit: "unobserved";
  responseFrame?: string;
  observation?: TextObservation;
  finishedAt?: string;
  /** Recipient-private canonical yielded-message evidence. Never publish these bytes. */
  privateMessages: Uint8Array;
}
export interface SdkTextRun {
  outcome: Promise<SdkTextOutcome>;
  /** Iterator settlement only, not authoritative OS process termination. */
  settled: Promise<void>;
  cancel(): void;
}
export interface SdkTextAdapter {
  begin(plan: SdkTextPlan, signal?: AbortSignal): SdkTextRun;
  readonly source: "fake-sdk" | "official-sdk";
}
function adapter(port: SdkQueryPort, live: boolean): SdkTextAdapter {
  const query = port.query.bind(port);
  return Object.freeze({
    source: live ? ("official-sdk" as const) : ("fake-sdk" as const),
    begin(plan: SdkTextPlan, external?: AbortSignal): SdkTextRun {
      if (!plans.has(plan) || used.has(plan)) throw new Error("sdk_text_plan_not_available");
      used.add(plan);
      const abort = new AbortController();
      let q: SdkQueryLike | undefined,
        queryInvocations: 0 | 1 = 0,
        closed = false,
        finished = false,
        reason: string | null = null;
      let deadline: ReturnType<typeof setTimeout> | undefined,
        grace: ReturnType<typeof setTimeout> | undefined;
      let resolveOutcome!: (v: SdkTextOutcome) => void, resolveSettled!: () => void;
      const outcome = new Promise<SdkTextOutcome>((r) => (resolveOutcome = r)),
        settled = new Promise<void>((r) => (resolveSettled = r));
      const parser = new ClaudeSdkMessages(
        {
          binding: plan.binding,
          attemptId: plan.attemptId,
          binarySha256ObservedBefore: plan.profile.binarySha256,
          cliVersion: "2.1.288",
        },
        (code) => stop(code),
      );
      const result = (cleanup: "iterator_settled" | "pending"): SdkTextOutcome => ({
        state: queryInvocations ? "unknown" : "not_started",
        queryInvocations,
        liveProviderCallObserved: false,
        failureCode: reason ?? "sdk_text_incomplete",
        cleanup,
        osProcessExit: "unobserved",
        privateMessages: parser.privateRecoveryBytes(),
      });
      function close() {
        if (q && !closed) {
          closed = true;
          try {
            q.close();
          } catch {
            reason ??= "sdk_text_close_failed";
          }
        }
      }
      function stop(code: string) {
        if (finished) return;
        reason ??= code;
        abort.abort();
        close();
        grace ??= setTimeout(() => resolveOutcome(result("pending")), 6000);
      }
      const onAbort = () => stop("sdk_text_cancelled");
      external?.addEventListener("abort", onAbort, { once: true });
      const remaining = Date.parse(plan.deadlineAt) - Date.now();
      if (external?.aborted || remaining <= 0 || remaining > 60000) {
        reason = external?.aborted ? "sdk_text_cancelled" : "sdk_text_deadline_invalid";
        finished = true;
        external?.removeEventListener("abort", onAbort);
        resolveOutcome(result("iterator_settled"));
        resolveSettled();
        return { outcome, settled, cancel: onAbort };
      }
      deadline = setTimeout(() => stop("sdk_text_deadline"), remaining);
      void (async () => {
        try {
          if (abort.signal.aborted) throw new Error("sdk_text_cancelled");
          queryInvocations = 1;
          q = query({
            prompt: plan.input,
            options: {
              ...options(plan.profile),
              abortController: abort,
              canUseTool: async () => ({
                behavior: "deny",
                message: "Bridge fixed synthetic route does not permit tools",
              }),
              onElicitation: async () => ({ action: "decline" }),
              onUserDialog: async () => ({ behavior: "cancelled" }),
              stderr: (text: string) => {
                try {
                  parser.observeStderr(text);
                } catch {
                  stop("sdk_text_stderr_limit");
                }
              },
            },
          });
          if (!q || typeof q.close !== "function" || typeof q[Symbol.asyncIterator] !== "function")
            throw new Error("sdk_text_query_invalid");
          if (reason) close();
          for await (const message of q) {
            if (reason) throw new Error(reason);
            parser.feedMessage(message);
          }
          const completedAt = Date.now();
          close();
          if (reason || abort.signal.aborted) throw new Error(reason ?? "sdk_text_cancelled");
          const parsed = parser.complete({
            sdkIteratorCompleted: true,
            sdkCloseRequested: closed,
            cancelled: false,
            finishedAtMs: completedAt,
            deadlineAtMs: Date.parse(plan.deadlineAt),
          });
          resolveOutcome({
            state: "response_received",
            queryInvocations,
            liveProviderCallObserved: live,
            failureCode: null,
            cleanup: "iterator_settled",
            osProcessExit: "unobserved",
            responseFrame: parsed.text,
            observation: parsed.observation,
            finishedAt: new Date(completedAt).toISOString(),
            privateMessages: parser.privateRecoveryBytes(),
          });
        } catch {
          // SDK exception text is external diagnostic data, not one of our error-code authorities.
          reason ??= "sdk_text_query_failed";
          abort.abort();
          close();
          resolveOutcome(result("iterator_settled"));
        } finally {
          finished = true;
          if (deadline) clearTimeout(deadline);
          if (grace) clearTimeout(grace);
          external?.removeEventListener("abort", onAbort);
          resolveSettled();
        }
      })();
      return { outcome, settled, cancel: onAbort };
    },
  });
}
/** Synthetic tests cannot mint an official/live adapter brand. */
export function fakeSdkTextAdapter(port: SdkQueryPort): SdkTextAdapter {
  return adapter(port, false);
}
/** Imports the pinned official SDK, but does not call query, authenticate or start a model. */
export async function loadOfficialSdkTextAdapter(): Promise<SdkTextAdapter> {
  const require = createRequire(import.meta.url),
    entry = require.resolve("@anthropic-ai/claude-agent-sdk");
  const bytes = readFileSync(join(dirname(entry), "package.json"));
  if (bytes.length > 16384) throw new Error("sdk_text_package_invalid");
  const meta = JSON.parse(bytes.toString()) as { name?: unknown; version?: unknown };
  if (meta.name !== "@anthropic-ai/claude-agent-sdk" || meta.version !== SDK_TEXT_VERSION)
    throw new Error("sdk_text_version_unsupported");
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return adapter({ query: (input) => sdk.query(input) }, true);
}
