import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const DOCTOR_POLL_INTERVAL_MS = 3_000;
export const REQUESTS_POLL_INTERVAL_MS = 2_000;
export type RequestStatus = "Running" | "Unknown" | "Completed" | "Failed" | "Blocked";
export interface DoctorLock { requestId: string | null; stale?: boolean; reclaimable?: boolean; }
export interface DoctorItem { name: string; ok: boolean; detail: string; warn?: boolean; lock?: DoctorLock; }
export interface BridgeRequest { requestId: string; caller: string; project: string; title: string; status: RequestStatus; startedAt: string; completedAt: string | undefined; requestMtimeMs: number; terminalSortMs: number | undefined; }
export interface BridgeGuiState { doctor: { ok: boolean; items: DoctorItem[]; error?: string }; lockHeld: boolean | null; requests: BridgeRequest[]; updatedAt: string; }
interface RequestMetadata { caller?: unknown; project?: unknown; title?: unknown; }
interface RequestFile { requestId?: unknown; }
interface ResultFile { status?: unknown; error?: { code?: unknown } | null; startedAt?: unknown; completedAt?: unknown; }
interface ScannedRequest extends Omit<BridgeRequest, "status"> { hasResult: boolean; result: ResultFile | undefined; }
const BLOCKED_ERROR_CODES = new Set(["CAPTCHA_OR_CHALLENGE", "AUTH_REQUIRED", "RATE_LIMITED"]);
const DISPLAY_TITLE_MAX_LENGTH = 80;
export const EMPTY_STATE: BridgeGuiState = { doctor: { ok: false, items: [], error: "Awaiting doctor poll" }, lockHeld: null, requests: [], updatedAt: new Date(0).toISOString() };

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function readString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function validDate(value: unknown): string | undefined { const text = readString(value); return text && Number.isFinite(Date.parse(text)) ? text : undefined; }
function validRequestId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]$/u.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(value); }
function trimTitle(value: string): string { return value.length <= DISPLAY_TITLE_MAX_LENGTH ? value : `${value.slice(0, DISPLAY_TITLE_MAX_LENGTH - 1)}…`; }
async function readJson(filePath: string): Promise<unknown> { return JSON.parse(await readFile(filePath, "utf8")) as unknown; }
async function optionalJson(filePath: string): Promise<unknown | undefined> { try { return await readJson(filePath); } catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return undefined; console.warn(`Bridge GUI: could not read ${filePath}; skipping this poll`, error); return undefined; } }
async function promptTitle(filePath: string, requestId: string): Promise<string> { try { const prompt = await readFile(filePath, "utf8"); const firstLine = prompt.split(/\r?\n/u).find((line) => line.trim()); return firstLine ? trimTitle(firstLine.trim()) : requestId; } catch (error: unknown) { if (!isRecord(error) || error.code !== "ENOENT") console.warn(`Bridge GUI: could not read ${filePath}; using request id`, error); return requestId; } }
function terminalStatus(result: ResultFile): RequestStatus { if (result.status === "completed") return "Completed"; if (result.status === "manual_intervention_required") return "Blocked"; if (result.status === "failed" && BLOCKED_ERROR_CODES.has(readString(result.error?.code) ?? "")) return "Blocked"; return "Failed"; }

export function aggregateState(doctor: BridgeGuiState["doctor"], scannedRequests: ScannedRequest[]): BridgeGuiState {
  const lockItem = doctor.items.find((item) => item.name === "lock");
  const lockHeld = lockItem ? !lockItem.ok : null;
  const lockedRequestId =
    lockHeld === true && typeof lockItem?.lock?.requestId === "string"
      ? lockItem.lock.requestId
      : undefined;
  const lockedRequestMatches =
    lockedRequestId !== undefined &&
    scannedRequests.some((request) => request.requestId === lockedRequestId);
  const newestResultlessMtime = Math.max(...scannedRequests.filter((request) => !request.hasResult).map((request) => request.requestMtimeMs), -Infinity);
  const requests = scannedRequests.map((request) => {
    const status = request.hasResult && request.result
      ? terminalStatus(request.result)
      : lockHeld === true && (lockedRequestMatches ? request.requestId === lockedRequestId : request.requestMtimeMs === newestResultlessMtime)
        ? "Running"
        : "Unknown";
    const { hasResult: _hasResult, result: _result, ...publicRequest } = request;
    return { ...publicRequest, status };
  });
  return { doctor, lockHeld, requests, updatedAt: new Date().toISOString() };
}

export async function scanRequests(requestsPath: string): Promise<ScannedRequest[]> {
  let entries;
  try { entries = await readdir(requestsPath, { withFileTypes: true }); } catch (error) { console.warn(`Bridge GUI: could not scan ${requestsPath}; retrying next tick`, error); return []; }
  const requests = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const requestDir = path.join(requestsPath, entry.name);
    try {
      const requestStats = await stat(path.join(requestDir, "request.json"));
      if (!requestStats.isFile()) return undefined;
      const [requestValue, metadataValue, resultValue, title] = await Promise.all([optionalJson(path.join(requestDir, "request.json")), optionalJson(path.join(requestDir, "meta.json")), optionalJson(path.join(requestDir, "result.json")), promptTitle(path.join(requestDir, "prompt.md"), entry.name)]);
      const request = isRecord(requestValue) ? requestValue as RequestFile : {};
      const metadata = isRecord(metadataValue) ? metadataValue as RequestMetadata : {};
      const result = isRecord(resultValue) ? resultValue as ResultFile : undefined;
      const completedAt = result ? validDate(result.completedAt) : undefined;
      const startedAt = result ? validDate(result.startedAt) : undefined;
      const directoryStats = result ? await stat(requestDir) : undefined;
      return { requestId: validRequestId(request.requestId) ? request.requestId : entry.name, caller: readString(metadata.caller) ?? "—", project: readString(metadata.project) ?? "—", title: trimTitle(readString(metadata.title) ?? title), startedAt: startedAt ?? requestStats.mtime.toISOString(), completedAt, requestMtimeMs: requestStats.mtimeMs, terminalSortMs: completedAt ? Date.parse(completedAt) : directoryStats?.mtimeMs, hasResult: result !== undefined, result } satisfies ScannedRequest;
    } catch (error) { console.warn(`Bridge GUI: could not read request ${entry.name}; skipping this poll`, error); return undefined; }
  }));
  return requests.filter((request): request is ScannedRequest => request !== undefined);
}
