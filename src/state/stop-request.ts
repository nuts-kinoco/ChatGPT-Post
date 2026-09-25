import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../contracts/atomic-write.js";

export interface StopRequest {
  token: string;
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

export async function readStopRequest(path: string): Promise<StopRequest | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StopRequest>;
    if (typeof parsed.token !== "string" || typeof parsed.requestedAt !== "string") return null;
    if (parsed.requestedBy !== undefined && typeof parsed.requestedBy !== "string") return null;
    return {
      token: parsed.token,
      requestedAt: parsed.requestedAt,
      ...(parsed.requestedBy !== undefined ? { requestedBy: parsed.requestedBy } : {}),
    };
  } catch {
    return null;
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
