import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../contracts/atomic-write.js";
import { parseStrictJsonBytes } from "../contracts/task.js";
import { readBoundedUsageText, USAGE_MARKER_MAX_BYTES } from "./usage-read.js";

export interface SubmissionBinding {
  version: 1;
  requestId: string;
  attemptId: string;
  attemptedAt: string;
  scopeId: string;
  owner: "direct" | "hosted";
}
export interface SubmitMarker {
  submissionBinding?: SubmissionBinding;
  recoveredUsage?: { raw: string };
  observedModelBefore?: string | null;
  observedPresetBefore?: string | null;
  target?: "dot";
  completionMarker?: string | undefined;
  requestId: string;
  /** Absolute request.json path, retained so direct `run` recovery does not require jobs.db. */
  requestPath?: string;
  writtenAt: string;
  urlBefore: string;
  baselineAssistantCount: number;
  presetLabelBefore: string;
  dispatchedAt?: string;
  urlAfter?: string;
}

export function markerPath(runtimeStateDir: string, requestId: string): string {
  return join(runtimeStateDir, requestId, "submit.marker");
}

/** Existence check: 0-byte or unparseable files count as present (11 §6.4). */
export async function markerExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readMarker(path: string): Promise<SubmitMarker | null> {
  try {
    return parseStrictJsonBytes(
      Buffer.from(await readBoundedUsageText(path, USAGE_MARKER_MAX_BYTES)),
    ) as SubmitMarker;
  } catch {
    return null;
  }
}

/** Write-ahead: tmp -> file fsync -> rename. Process-crash atomicity; directory power-loss durability is not certified. */
export async function writeMarker(path: string, marker: SubmitMarker): Promise<void> {
  const raw = `${JSON.stringify(marker, null, 2)}\n`;
  if (Buffer.byteLength(raw) > USAGE_MARKER_MAX_BYTES) throw new Error("usage_marker_oversized");
  await atomicWriteFile(path, raw);
}

/** Post-dispatch append (best-effort; caller catches). */
export async function updateMarker(
  path: string,
  patch: Pick<SubmitMarker, "dispatchedAt" | "urlAfter">,
): Promise<void> {
  const current = await readMarker(path);
  if (!current) throw new Error("marker unreadable");
  await writeMarker(path, { ...current, ...patch });
}

export async function deleteMarker(path: string): Promise<void> {
  await unlink(path);
}
