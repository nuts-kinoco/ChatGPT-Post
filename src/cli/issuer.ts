/** Finite issuer method dispatcher. No arbitrary file path, URL, deployment or authority input. */

import type { Readable } from "node:stream";
import type { IssuerFacade } from "../adapters/issuer-session.js";
import { issuerRecord, strictBase64 } from "../contracts/issuer.js";
import { parseStrictJsonBytes } from "../contracts/task.js";
import { safeIssuerError } from "./issuer-errors.js";
export const ISSUER_COMMANDS = [
  "issuer-catalogue",
  "issuer-template",
  "issuer-prepare",
  "issuer-issue",
  "issuer-result",
  "issuer-ack",
] as const;
export const MAX_ISSUER_INPUT_BYTES = 1024 * 1024;
export async function readIssuerInput(
  input: Readable,
  timeoutMs = 5000,
  maxBytes = MAX_ISSUER_INPUT_BYTES,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_ISSUER_INPUT_BYTES
  )
    throw new Error("issuer_input_bounds_invalid");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0,
      ended = false;
    const finish = (error?: Error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      input.off("data", data);
      input.off("end", end);
      input.off("error", failed);
      input.pause();
      if (error) {
        chunks.length = 0;
        reject(error);
      } else resolve(Buffer.concat(chunks));
    };
    const data = (value: unknown) => {
      if (!Buffer.isBuffer(value)) {
        finish(new Error("issuer_input_invalid"));
        return;
      }
      size += value.length;
      if (size > maxBytes) {
        finish(new Error("issuer_input_too_large"));
        return;
      }
      chunks.push(Buffer.from(value));
    };
    const end = () => finish();
    const failed = () => finish(new Error("issuer_input_failed"));
    const timer = setTimeout(() => finish(new Error("issuer_input_timeout")), timeoutMs);
    input.on("data", data);
    input.on("end", end);
    input.on("error", failed);
  });
}
async function dispatchIssuerCommand(
  port: IssuerFacade | undefined,
  command: string,
  input?: Uint8Array,
): Promise<unknown> {
  if (!port) throw new Error("issuer_unconfigured");
  if (command === "issuer-catalogue") {
    if (input?.length) throw new Error("issuer_arguments_invalid");
    return port.catalogue();
  }
  if (!ISSUER_COMMANDS.includes(command as (typeof ISSUER_COMMANDS)[number]))
    throw new Error("issuer_command_invalid");
  if (!input || input.length > MAX_ISSUER_INPUT_BYTES) throw new Error("issuer_input_too_large");
  let value: unknown;
  try {
    value = parseStrictJsonBytes(input);
  } catch {
    throw new Error("issuer_input_invalid");
  }
  if (command === "issuer-template") {
    const candidate = value as { modelId?: unknown } | null;
    const body = issuerRecord(value, [
      "projectId",
      "destinationId",
      ...(candidate && Object.hasOwn(candidate, "modelId") ? ["modelId"] : []),
    ]);
    if (
      typeof body.projectId !== "string" ||
      typeof body.destinationId !== "string" ||
      (body.modelId !== undefined && typeof body.modelId !== "string")
    )
      throw new Error("issuer_arguments_invalid");
    return port.template(body.projectId, body.destinationId, body.modelId as string | undefined);
  }
  if (command === "issuer-prepare") return port.prepare(value);
  const fields = [
    "signedPreparationBase64",
    ...(command === "issuer-issue" ? [] : ["requestId"]),
    ...(command === "issuer-ack" ? ["payloadSha256"] : []),
  ];
  const body = issuerRecord(value, fields),
    raw = strictBase64(body.signedPreparationBase64, 524288);
  if (command === "issuer-issue") return port.issue(raw);
  if (typeof body.requestId !== "string") throw new Error("issuer_arguments_invalid");
  if (command === "issuer-result") return port.result(raw, body.requestId);
  if (typeof body.payloadSha256 !== "string") throw new Error("issuer_arguments_invalid");
  return port.acknowledge(raw, body.requestId, body.payloadSha256);
}

export async function runIssuerCommand(
  port: IssuerFacade | undefined,
  command: string,
  input?: Uint8Array,
): Promise<unknown> {
  try {
    return await dispatchIssuerCommand(port, command, input);
  } catch (error) {
    throw new Error(safeIssuerError(error));
  }
}
