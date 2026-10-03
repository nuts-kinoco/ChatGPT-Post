import type { Locator } from "playwright";

/** A bound is a safety limit, never permission to call a partial scan unique/absent. */
export const MAX_DOM_CANDIDATES = 256;

export type ScanReason =
  | "complete"
  | "candidate_limit"
  | "count_unreadable"
  | "visibility_unreadable"
  | "collection_changed"
  | "candidate_unreadable"
  | "enabled_unreadable";

export interface ScanCounts {
  attached: number | null;
  scanned: number;
  visible: number;
}

export type VisibleObservation = ScanCounts &
  (
    | { kind: "absent"; complete: true; reason: "complete"; locators: Locator[] }
    | {
        kind: "unique";
        complete: true;
        reason: "complete";
        locators: Locator[];
        locator: Locator;
      }
    | { kind: "ambiguous"; complete: true; reason: "complete"; locators: Locator[] }
    | { kind: "incomplete"; complete: false; reason: ScanReason; locators: Locator[] }
  );

export function incompleteObservation(
  reason: ScanReason,
  counts: ScanCounts = { attached: null, scanned: 0, visible: 0 },
): VisibleObservation {
  return { ...counts, kind: "incomplete", complete: false, reason, locators: [] };
}

/** Read-only, bounded and nonthrowing. No page text or raw errors enter diagnostics. */
export async function scanVisible(loc: Locator): Promise<VisibleObservation> {
  let attached: number;
  try {
    attached = await loc.count();
    if (!Number.isSafeInteger(attached) || attached < 0) throw new Error("count");
  } catch {
    return incompleteObservation("count_unreadable");
  }
  const counts: ScanCounts = { attached, scanned: 0, visible: 0 };
  if (attached > MAX_DOM_CANDIDATES) return incompleteObservation("candidate_limit", counts);
  const locators: Locator[] = [];
  const visibility: boolean[] = [];
  try {
    for (let i = 0; i < attached; i++) {
      const item = loc.nth(i);
      const visible = await item.isVisible();
      visibility.push(visible);
      if (visible) locators.push(item);
      counts.scanned++;
      counts.visible = locators.length;
    }
  } catch {
    return incompleteObservation("visibility_unreadable", counts);
  }
  try {
    if ((await loc.count()) !== attached)
      return incompleteObservation("collection_changed", counts);
  } catch {
    return incompleteObservation("count_unreadable", counts);
  }
  try {
    for (let i = 0; i < attached; i++) {
      if ((await loc.nth(i).isVisible()) !== visibility[i])
        return incompleteObservation("collection_changed", counts);
    }
  } catch {
    return incompleteObservation("visibility_unreadable", counts);
  }
  try {
    if ((await loc.count()) !== attached)
      return incompleteObservation("collection_changed", counts);
  } catch {
    return incompleteObservation("count_unreadable", counts);
  }
  const common = { ...counts, complete: true as const, reason: "complete" as const, locators };
  if (locators.length === 0) return { ...common, kind: "absent" };
  if (locators.length === 1) return { ...common, kind: "unique", locator: locators[0] as Locator };
  return { ...common, kind: "ambiguous" };
}

/** Static/count-only diagnostic suitable for DomUnexpected.tried. */
export function describeObservation(observation: VisibleObservation): string {
  return `${observation.kind}:${observation.reason} attached=${observation.attached ?? "unknown"} scanned=${observation.scanned} visible=${observation.visible}`;
}
