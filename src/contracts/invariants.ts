import { validateResult } from "./schema.js";
import {
  type BridgeResult,
  MANUAL_INTERVENTION_CODES,
  NO_RESULT_CODES,
  STATE_NAMES,
} from "./types.js";

const PRE_BOUNDARY = new Set(STATE_NAMES.slice(0, STATE_NAMES.indexOf("PROMPT_SUBMITTING")));
const POST_BOUNDARY = new Set(STATE_NAMES.slice(STATE_NAMES.indexOf("WAITING_FOR_RESPONSE")));

/**
 * Invariants that JSON Schema cannot express (12-IO-CONTRACT §3.4). Returns a list of violations;
 * empty means the result is consistent. Schema validation is included so callers need one call.
 */
const IMAGE_PATH = /^images\/[1-9][0-9]*\.(png|jpg|jpeg|webp|gif)$/;

export function checkResultInvariants(result: BridgeResult): string[] {
  const problems = validateResult(result).errors.map((e) => `schema: ${e}`);
  const err = result.error;
  // 1.2 images[]: requestDir-relative, under images/, numbered, unique, only on success (A-091)
  const images = result.images ?? [];
  for (const img of images) {
    if (!IMAGE_PATH.test(img)) problems.push(`images: "${img}" is not images/<n>.<ext>`);
  }
  if (new Set(images).size !== images.length) problems.push("images: duplicate entries");
  if (images.length > 0 && result.status !== "completed") {
    problems.push("images: present although status is not completed");
  }
  if (result.status === "completed") {
    if (err !== null) problems.push("completed must have error == null");
    if (result.submitted !== "yes") problems.push("completed must have submitted == yes");
    if (result.observedPreset === null && result.recoveredBy !== "collect")
      problems.push("completed must have observedPreset unless recoveredBy=collect");
    return problems;
  }
  if (err === null) {
    problems.push("non-completed must have error");
    return problems;
  }
  if (NO_RESULT_CODES.includes(err.code)) problems.push(`${err.code} never appears in result.json`);
  const isMi = MANUAL_INTERVENTION_CODES.includes(err.code);
  if (isMi !== (result.status === "manual_intervention_required")) {
    problems.push(`status ${result.status} inconsistent with code ${err.code}`);
  }
  const expected = expectedSubmitted(result);
  if (expected !== null && result.submitted !== expected) {
    problems.push(`submitted should be ${expected} for phase ${err.phase} / code ${err.code}`);
  }
  return problems;
}

function expectedSubmitted(result: BridgeResult): BridgeResult["submitted"] | null {
  const err = result.error;
  if (!err) return null;
  if (err.code === "SUBMIT_STATE_UNKNOWN") return "unknown";
  if (err.code === "SUBMIT_NOT_CONFIRMED") return "no";
  if (err.phase === "PROMPT_SUBMITTING") {
    return err.code === "MODEL_NOT_VERIFIABLE" && err.cause === "preset_changed" ? "no" : "unknown";
  }
  if (POST_BOUNDARY.has(err.phase)) return "yes";
  if (PRE_BOUNDARY.has(err.phase)) return "no";
  return null;
}
