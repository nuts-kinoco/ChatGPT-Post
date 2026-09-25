import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../contracts/atomic-write.js";

export interface StopRequest {
  requestedAt: string;
  requestedBy?: string;
}

export function stopRequestPath(runtimeStateDir: string, requestId: string): string {
  return join(runtimeStateDir, requestId, "stop.request");
}

export async function stopRequestExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Cooperative-stop request: tmp -> fsync -> rename, matching the submit.marker discipline. */
export async function writeStopRequest(path: string, request: StopRequest): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(request, null, 2)}\n`);
}

/** Terminal cleanup is idempotent because another path may already have consumed the marker. */
export async function deleteStopRequest(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
