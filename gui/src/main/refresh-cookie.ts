export type RefreshCookiePreflightResult = { ok: true } | { ok: false; reason: string };

interface DoctorItem {
  name: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
}

/**
 * Parses the passive doctor result used before opening the manual-login window.
 * A non-stale held lock is the only healthy-looking state that must block it.
 */
export function evaluateRefreshCookiePreflight(stdout: string): RefreshCookiePreflightResult {
  try {
    const line = stdout.split(/\r?\n/u).find((candidate) => candidate.trim());
    if (!line) throw new Error("doctor --json returned no JSON");
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") throw new Error("doctor --json returned a non-object");
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items)) throw new Error("doctor --json has an unexpected shape");
    const lock = items.find((item): item is DoctorItem =>
      typeof item === "object" && item !== null &&
      (item as DoctorItem).name === "lock" &&
      typeof (item as DoctorItem).ok === "boolean" &&
      typeof (item as DoctorItem).detail === "string",
    );
    if (!lock) return { ok: false, reason: "Could not verify the request lock; doctor did not return a lock status" };
    if (!lock.ok && !lock.warn) {
      return { ok: false, reason: "A request is currently running; wait for it to finish before refreshing cookies" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Could not verify the request lock: ${error instanceof Error ? error.message : "invalid doctor output"}` };
  }
}
