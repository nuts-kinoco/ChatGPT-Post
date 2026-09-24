import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../contracts/atomic-write.js";

export interface SubmitMarker {
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
    return JSON.parse(await readFile(path, "utf8")) as SubmitMarker;
  } catch {
    return null;
  }
}

/** Write-ahead: tmp -> fsync -> rename. Throws AtomicWriteError on failure. */
export async function writeMarker(path: string, marker: SubmitMarker): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(marker, null, 2)}\n`);
}

/** Post-dispatch append (best-effort; caller catches). */
export async function updateMarker(
  path: string,
  patch: Pick<SubmitMarker, "dispatchedAt" | "urlAfter">,
): Promise<void> {
  const current = await readMarker(path);
  if (!current) throw new Error("marker unreadable");
  await atomicWriteFile(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

export async function deleteMarker(path: string): Promise<void> {
  await unlink(path);
}
