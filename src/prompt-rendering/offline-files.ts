/** Explicit file materializer for the standalone OFFLINE preview command, never a host service. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { parseStrictJsonBytes } from "../contracts/task.js";
import { boundedText, exactObject } from "./brief.js";
import { prepareOfflinePromptPreview, renderPromptPreview } from "./preview.js";
import {
  createPromptProfileRegistry,
  type PreviewProfilePin,
  type PromptProfileDefinition,
} from "./profiles.js";

function readBounded(path: unknown, maximum: number): Uint8Array {
  if (
    !Number.isSafeInteger(constants.O_NONBLOCK) ||
    constants.O_NONBLOCK <= 0 ||
    !Number.isSafeInteger(constants.O_NOFOLLOW) ||
    constants.O_NOFOLLOW <= 0
  )
    throw new Error("offline_file_flags_unsupported");
  const fd = openSync(
    boundedText(path, 4096),
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error("offline_input_file_invalid");
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maximum) throw new Error("offline_input_file_too_large");
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
export function previewFiles(specPath: string, taskPath: string, configPath: string) {
  const config = exactObject(parseStrictJsonBytes(readBounded(configPath, 65536)), [
    "profile",
    "pin",
    "expectedTaskSpecSha256",
    "routeId",
    "context",
  ]);
  if (!Array.isArray(config.context) || config.context.length > 32)
    throw new Error("offline_context_invalid");
  const context = [];
  let total = 0;
  for (const raw of config.context) {
    const row = exactObject(raw, ["id", "path"]);
    const bytes = readBounded(row.path, Math.min(1024 * 1024, 2 * 1024 * 1024 - total));
    total += bytes.byteLength;
    context.push({ id: boundedText(row.id, 128), bytes });
  }
  const prepared = prepareOfflinePromptPreview({
    rawTaskSpec: readBounded(specPath, 256 * 1024),
    taskFileBytes: readBounded(taskPath, 1024 * 1024),
    expectedTaskSpecSha256: boundedText(config.expectedTaskSpecSha256, 64),
    routeId: boundedText(config.routeId, 128),
    registry: createPromptProfileRegistry([config.profile as PromptProfileDefinition]),
    profilePin: config.pin as PreviewProfilePin,
    context,
  });
  return renderPromptPreview(prepared);
}

const PUBLIC_ERROR_CODES = new Set([
  "offline_arguments_invalid",
  "offline_context_invalid",
  "offline_file_flags_unsupported",
  "offline_input_file_invalid",
  "offline_input_file_too_large",
  "prompt_brief_marker_invalid",
  "prompt_brief_noncanonical",
  "prompt_brief_too_large",
  "prompt_bytes_invalid",
  "prompt_context_digest_mismatch",
  "prompt_context_invalid",
  "prompt_context_set_mismatch",
  "prompt_context_too_large",
  "prompt_fields_invalid",
  "prompt_input_invalid",
  "prompt_list_invalid",
  "prompt_policy_pin_invalid",
  "prompt_prepared_snapshot_unknown",
  "prompt_preview_too_large",
  "prompt_profile_binding_mismatch",
  "prompt_profile_duplicate",
  "prompt_profile_invalid",
  "prompt_profile_pin_mismatch",
  "prompt_registry_invalid",
  "prompt_registry_unknown",
  "prompt_task_file_mismatch",
  "prompt_task_file_too_large",
  "prompt_task_kind_invalid",
  "prompt_task_spec_invalid",
  "prompt_text_invalid",
]);

/** Finite host error vocabulary; arbitrary Error.message text is never a diagnostic code. */
export function offlinePreviewErrorCode(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : null;
    return typeof message === "string" && PUBLIC_ERROR_CODES.has(message)
      ? message
      : "offline_preview_failed";
  } catch {
    return "offline_preview_failed";
  }
}
