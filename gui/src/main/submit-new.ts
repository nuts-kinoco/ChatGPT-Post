import { randomBytes } from "node:crypto";
import path from "node:path";

export const MAX_PROMPT_CHARS = 20_000;
export const MAX_ATTACHMENTS = 20;
export const PRESETS = ["current", "instant", "medium", "high", "extra_high", "pro"] as const;
export const MODELS = ["current", "latest", "gpt-5.6-sol", "gpt-5.5"] as const;
export const SUBMIT_CONVERSATION_URL_PATTERN = /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/u;

export type NewSubmissionInput = {
  prompt: unknown;
  preset: unknown;
  model: unknown;
  newChat: unknown;
  conversationUrl?: unknown;
  attachments?: unknown;
};

export type ValidNewSubmission = {
  prompt: string;
  preset: (typeof PRESETS)[number];
  model: (typeof MODELS)[number];
  newChat: boolean;
  conversationUrl?: string;
  attachments: string[];
};

export type NewRequestFile = {
  schemaVersion: "1.1";
  requestId: string;
  promptFile: "prompt.md";
  attachments?: string[];
  preset: (typeof PRESETS)[number];
  model: (typeof MODELS)[number];
  newChat: boolean;
  conversationUrl?: string;
  responseFormat: "markdown";
};
export type NewRequestWriter = Pick<typeof import("node:fs/promises"), "mkdir" | "writeFile">;

export function buildSubmitArgs(cliPath: string, requestFilePath: string): string[] {
  return [cliPath, "submit", "--request", requestFilePath, "--json"];
}

const oneOf = <T extends readonly string[]>(value: unknown, allowed: T): value is T[number] => typeof value === "string" && (allowed as readonly string[]).includes(value);

export function validateNewSubmission(value: unknown): { ok: true; value: ValidNewSubmission } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null) return { ok: false, reason: "Invalid submission" };
  const input = value as NewSubmissionInput;
  if (typeof input.prompt !== "string" || !input.prompt.trim()) return { ok: false, reason: "Prompt is required" };
  if (input.prompt.length > MAX_PROMPT_CHARS) return { ok: false, reason: `Prompt must be ${MAX_PROMPT_CHARS.toLocaleString("en-US")} characters or fewer` };
  if (!oneOf(input.preset, PRESETS)) return { ok: false, reason: "Invalid preset" };
  if (!oneOf(input.model, MODELS)) return { ok: false, reason: "Invalid model" };
  if (typeof input.newChat !== "boolean") return { ok: false, reason: "New chat selection is required" };
  if (!Array.isArray(input.attachments)) return { ok: false, reason: "Attachments must be a list" };
  if (input.attachments.length > MAX_ATTACHMENTS) return { ok: false, reason: `Attachments are limited to ${MAX_ATTACHMENTS}` };
  if (!input.attachments.every((attachment) => typeof attachment === "string" && attachment.length > 0 && path.isAbsolute(attachment))) return { ok: false, reason: "Each attachment must be an absolute file path" };
  if (!input.newChat) {
    if (typeof input.conversationUrl !== "string" || !SUBMIT_CONVERSATION_URL_PATTERN.test(input.conversationUrl)) return { ok: false, reason: "A valid ChatGPT conversation URL is required when continuing a chat" };
  }
  return {
    ok: true,
    value: {
      prompt: input.prompt,
      preset: input.preset,
      model: input.model,
      newChat: input.newChat,
      ...(input.newChat ? {} : { conversationUrl: input.conversationUrl as string }),
      attachments: input.attachments,
    },
  };
}

export function createRequestId(now = new Date(), random = randomBytes(4)): string {
  const iso = now.toISOString();
  const timestamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return `${timestamp}-${random.toString("hex")}`;
}

export function buildNewRequest(requestId: string, input: ValidNewSubmission): NewRequestFile {
  return {
    schemaVersion: "1.1",
    requestId,
    promptFile: "prompt.md",
    ...(input.attachments.length ? { attachments: input.attachments } : {}),
    preset: input.preset,
    model: input.model,
    newChat: input.newChat,
    ...(input.newChat ? {} : { conversationUrl: input.conversationUrl }),
    responseFormat: "markdown",
  };
}

export async function writeNewRequest(requestsPath: string, requestId: string, input: ValidNewSubmission, writer: NewRequestWriter): Promise<string> {
  const requestDirectory = path.resolve(requestsPath, requestId);
  await writer.mkdir(requestDirectory, { recursive: false });
  await Promise.all([
    writer.writeFile(path.join(requestDirectory, "prompt.md"), input.prompt, "utf8"),
    writer.writeFile(path.join(requestDirectory, "request.json"), `${JSON.stringify(buildNewRequest(requestId, input), null, 2)}\n`, "utf8"),
  ]);
  return requestDirectory;
}
