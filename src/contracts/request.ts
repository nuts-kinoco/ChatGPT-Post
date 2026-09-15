import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { validateRequest } from "./schema.js";
import { type BridgeRequest, DEFAULT_TIMEOUT_MS } from "./types.js";

const BOM = String.fromCharCode(0xfeff);
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]$/;
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

export function isValidRequestId(id: unknown): id is string {
  return typeof id === "string" && REQUEST_ID_PATTERN.test(id) && !WINDOWS_RESERVED.test(id);
}

export type ReadRequestOutcome =
  | { kind: "unreadable"; cause: string }
  | { kind: "read"; requestId: string | null; raw: unknown; requestDir: string };

/** Step [1]: read + parse request.json (BOM stripped). Never throws. */
export async function readRequestFile(requestPath: string): Promise<ReadRequestOutcome> {
  const absolute = resolve(requestPath);
  let text: string;
  try {
    const buf = await readFile(absolute);
    if (
      buf.length >= 2 &&
      ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
    ) {
      return { kind: "unreadable", cause: "request.json is not UTF-8 (UTF-16 BOM detected)" };
    }
    text = stripBom(buf.toString("utf8"));
  } catch (err) {
    return { kind: "unreadable", cause: `cannot read request.json: ${(err as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      kind: "unreadable",
      cause: `request.json is not valid JSON: ${(err as Error).message}`,
    };
  }
  const candidate = (raw as { requestId?: unknown } | null)?.requestId;
  return {
    kind: "read",
    requestId: isValidRequestId(candidate) ? candidate : null,
    raw,
    requestDir: dirname(absolute),
  };
}

export type ValidateOutcome =
  | { kind: "invalid"; errors: string[] }
  | {
      kind: "valid";
      request: BridgeRequest;
      prompt: string;
      promptPath: string;
      timeoutMs: number;
    };

/** Step [3]: schema validation + prompt read + non-empty check. Never throws. */
export async function validateAndLoad(raw: unknown, requestDir: string): Promise<ValidateOutcome> {
  const outcome = validateRequest(raw);
  const errors = [...outcome.errors];
  const req = raw as BridgeRequest;
  if (outcome.valid && !isValidRequestId(req.requestId)) {
    errors.push("/requestId is a Windows reserved device name");
  }
  if (errors.length > 0) return { kind: "invalid", errors };

  const promptPath = isAbsolute(req.promptFile)
    ? req.promptFile
    : resolve(requestDir, req.promptFile);
  let prompt: string;
  try {
    prompt = stripBom(await readFile(promptPath, "utf8"));
  } catch (err) {
    return { kind: "invalid", errors: [`promptFile cannot be read: ${(err as Error).message}`] };
  }
  if (prompt.trim().length === 0) {
    return { kind: "invalid", errors: ["prompt is empty or whitespace only"] };
  }
  return {
    kind: "valid",
    request: req,
    prompt,
    promptPath,
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}
