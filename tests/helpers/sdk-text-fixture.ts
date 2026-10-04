import { randomUUID } from "node:crypto";
import { join, parse, resolve } from "node:path";
import type { ClaudeSdkHostProfile } from "../../src/adapters/claude-sdk-profile.js";
import { prepareSdkTextPlan, sdkProfileDigest } from "../../src/adapters/claude-sdk-text.js";
import { encodeResponseFrame } from "../../src/contracts/response-frame.js";
import {
  TEXT_BOUNDS,
  TEXT_MODEL,
  type TextObservation,
  type TextRequest,
  textChallenge,
} from "../../src/contracts/sdk-text-inference.js";
import { sha256Bytes } from "../../src/contracts/task.js";
export const json = (v: unknown) => Buffer.from(JSON.stringify(v));
/** Synthetic absolute path that is canonical on this platform (POSIX `/a/b`, Windows `X:\a\b`). Never touched on disk. */
export const syntheticAbsolute = (...segments: string[]) =>
  resolve(parse(process.cwd()).root, ...segments);
export function sdkFixture(now = Date.now()) {
  const home = syntheticAbsolute("private", "home");
  const profile: ClaudeSdkHostProfile = {
    schema: "claude-sdk-host-profile-1",
    profileId: 1,
    revision: 1,
    assurance: "trusted-host-and-provider-controls",
    trustAdminPolicy: true,
    recipientId: "recipient",
    approverId: "operator",
    policySha256: "a".repeat(64),
    executable: syntheticAbsolute("trusted", "claude"),
    binarySha256: "b".repeat(64),
    cliVersion: "2.1.288",
    cwd: syntheticAbsolute("private", "empty"),
    home,
    configDirectory: join(home, ".claude"),
    approvedAuthContextId: "existing-context",
    providerRouteId: "claude-first-party-existing-subscription",
    authMethod: "claude.ai",
    allowedBuiltinPlugins: [],
  };
  const id = randomUUID(),
    md = textChallenge(id),
    attemptId = randomUUID(),
    sessionId = randomUUID();
  const request: TextRequest = {
    schema: "sdk-text-request-1",
    requestId: id,
    projectRegistration: {
      projectId: randomUUID(),
      registryRevision: 1,
      snapshotSha256: "c".repeat(64),
    },
    repoId: "product-a",
    requesterId: "requester",
    recipientId: "recipient",
    destination: { repositoryFullName: "owner/bus", branch: "main", namespace: "bridge-v2" },
    provider: "claude",
    model: TEXT_MODEL,
    policySha256: profile.policySha256,
    sdkProfileSha256: sdkProfileDigest(profile),
    executionProfile: "official-sdk-managed",
    taskFile: "task.md",
    taskFileSha256: sha256Bytes(md),
    syntheticInput: true,
    purpose: "handshake",
    response: "echo_request_identity",
    bounds: TEXT_BOUNDS,
    modelTools: "none",
    taskFilesystem: "none",
    taskCommands: "none",
    taskNetwork: "none",
    providerNetwork: "configured_auth_route_only",
    effort: "unsupported",
    thinking: "off_requested",
    expiresAt: new Date(now + 120000).toISOString(),
    retryPolicy: "no-automatic-reexecution",
  };
  const raw = json(request),
    binding = {
      requestId: id,
      requestSha256: sha256Bytes(raw),
      requesterId: request.requesterId,
      recipientId: request.recipientId,
    };
  const grant = {
    ...binding,
    schema: "sdk-text-approval-1",
    grantId: randomUUID(),
    nonce: randomUUID(),
    issuedPacketSha256: "d".repeat(64),
    taskFileSha256: request.taskFileSha256,
    policySha256: profile.policySha256,
    sdkProfileSha256: request.sdkProfileSha256,
    executionProfile: "official-sdk-managed",
    approverId: profile.approverId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    maxStarts: 1,
  };
  const responseFrame = encodeResponseFrame(
    JSON.stringify({
      ...{ requestId: id, requestSha256: binding.requestSha256, attemptId },
      message: "bridge-handshake-ok",
    }),
    { requestId: id, taskSpecHash: binding.requestSha256, attemptId },
  );
  const events: Record<string, unknown>[] = [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: TEXT_MODEL,
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      skills: [],
      plugins: [],
      permissionMode: "dontAsk",
    },
    {
      type: "assistant",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        model: TEXT_MODEL,
        role: "assistant",
        content: [{ type: "text", text: responseFrame }],
      },
    },
    {
      type: "result",
      session_id: sessionId,
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: responseFrame,
      usage: {
        input_tokens: 20,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {
        [TEXT_MODEL]: {
          inputTokens: 20,
          outputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      permission_denials: [],
    },
  ];
  const observation: TextObservation = {
    schema: "sdk-text-observation-1",
    model: TEXT_MODEL,
    sessionId,
    turns: 1,
    toolUses: 0,
    thinkingBlocks: 0,
    inputTokens: 20,
    outputTokens: 100,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    providerHttpRequests: "unknown",
    sourceSdkMessagesSha256: "e".repeat(64),
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
    cliVersion: "2.1.288",
    binarySha256ObservedBefore: profile.binarySha256,
  };
  return {
    profile,
    request,
    raw,
    md,
    grant,
    attemptId,
    binding,
    responseFrame,
    events,
    observation,
    now,
    plan: () =>
      prepareSdkTextPlan(
        profile,
        raw,
        md,
        json(grant),
        attemptId,
        new Date(now + 60000).toISOString(),
      ),
  };
}
