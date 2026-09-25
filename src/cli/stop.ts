import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultLockDeps,
  judgeStale,
  type LockDeps,
  type LockRecord,
  readLockRecord,
} from "../state/lock.js";
import { slotPath } from "../state/slot-lock.js";
import { stopRequestPath, writeStopRequest } from "../state/stop-request.js";
import type { BridgeConfig } from "./config.js";

export type StopOutcome = { ok: true; requestId: string } | { ok: false; reason: string };

interface InspectedLock {
  path: string;
  record: LockRecord | null;
}

async function lockExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sameOwner(left: LockRecord | null, right: LockRecord | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.pid === right.pid &&
    left.token === right.token &&
    left.requestId === right.requestId
  );
}

/**
 * Requests an in-process interruption. This never changes a lock and never signals a process;
 * its sole possible side effect is the atomic stop.request write after a live-owner recheck.
 */
export async function requestStop(
  cfg: BridgeConfig,
  requestId: string,
  requestedBy = "cli",
  deps: LockDeps = defaultLockDeps,
): Promise<StopOutcome> {
  const base = join(cfg.locksDir, "bridge.lock");
  const paths =
    cfg.maxConcurrency > 1
      ? Array.from({ length: cfg.maxConcurrency }, (_, index) => slotPath(base, index))
      : [base];
  const inspected: InspectedLock[] = [];
  for (const path of paths) {
    if (await lockExists(path)) inspected.push({ path, record: await readLockRecord(path) });
  }
  if (inspected.length === 0) return { ok: false, reason: "no lock exists" };

  const matching = inspected.filter(({ record }) => record?.requestId === requestId);
  if (matching.length === 0) {
    const heldIds = inspected
      .map(({ record }) => record?.requestId ?? "unreadable/unknown")
      .join(", ");
    return {
      ok: false,
      reason: `lock requestId mismatch (requested ${requestId}; lock has ${heldIds})`,
    };
  }

  const staleReasons: string[] = [];
  for (const candidate of matching) {
    const verdict = await judgeStale(candidate.path, candidate.record, deps);
    if (verdict.stale) {
      staleReasons.push(verdict.reason);
      continue;
    }

    // Refuse if ownership changed during the liveness check. The second stale judgment also
    // closes the common dead-owner race immediately before the marker write.
    const current = await readLockRecord(candidate.path);
    if (!sameOwner(candidate.record, current)) {
      return { ok: false, reason: "lock changed while checking; retry stop" };
    }
    const currentVerdict = await judgeStale(candidate.path, current, deps);
    if (currentVerdict.stale) {
      return { ok: false, reason: `matching lock is stale: ${currentVerdict.reason}` };
    }

    await writeStopRequest(stopRequestPath(cfg.stateDir, requestId), {
      requestedAt: deps.now().toISOString(),
      requestedBy,
    });
    return { ok: true, requestId };
  }

  return {
    ok: false,
    reason: `matching lock is stale: ${staleReasons.join("; ")}`,
  };
}
