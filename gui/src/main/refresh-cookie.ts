export type RefreshCookiePreflightResult = { ok: true } | { ok: false; reason: string };

interface DoctorItem {
  name: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
  lock?: { stale?: boolean; reclaimable?: boolean };
}

/**
 * Parses the passive doctor result used before opening the manual-login window.
 * This intentionally fails closed: opening a second Chrome against the profile
 * is safe only when doctor explicitly reports no lock, or a reclaimable stale lock.
 * `processDetail` (exit status and stderr) is appended when stdout cannot be parsed.
 */
export function evaluateRefreshCookiePreflight(stdout: string, processDetail?: string): RefreshCookiePreflightResult {
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
    const profileFree = items.find((item): item is DoctorItem =>
      typeof item === "object" && item !== null &&
      (item as DoctorItem).name === "profile.free" &&
      typeof (item as DoctorItem).ok === "boolean" &&
      typeof (item as DoctorItem).detail === "string",
    );
    if (!lock) return { ok: false, reason: "Could not verify the request lock; doctor did not return a lock status" };
    if (!profileFree?.ok) return { ok: false, reason: "The browser profile is in use; wait for it to become free before refreshing cookies" };
    const daemon = items.find((item): item is DoctorItem => typeof item === "object" && item !== null && (item as DoctorItem).name === "daemon" && typeof (item as DoctorItem).detail === "string");
    if (daemon && (/^running:/u.test(daemon.detail) || /^not running here/u.test(daemon.detail))) {
      return { ok: false, reason: "The bridge daemon may be using the browser profile; stop it before refreshing cookies" };
    }
    const noLock = lock.ok && lock.detail === "no lock file";
    const reclaimableStaleLock = lock.lock?.stale === true && lock.lock.reclaimable === true;
    if (!lock.ok) return { ok: false, reason: "A request is currently running; wait for it to finish before refreshing cookies" };
    if (!noLock && !reclaimableStaleLock) return { ok: false, reason: "A request lock may still own the browser profile; wait for it to finish before refreshing cookies" };
    return { ok: true };
  } catch (error) {
    const detail = processDetail ? ` (${processDetail})` : "";
    return { ok: false, reason: `Could not verify the request lock: ${error instanceof Error ? error.message : "invalid doctor output"}${detail}` };
  }
}
