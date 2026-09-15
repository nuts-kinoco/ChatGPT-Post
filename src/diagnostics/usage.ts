/**
 * Local usage ledger (PO request 2026-09-15): counts what THIS bridge sent, per rolling window, against
 * editable limits. It never reads ChatGPT's own counters (no internal API) and cannot see messages
 * the user sent by hand, so every number is a lower bound. Limits default to ChatGPT's own
 * (unverified) answer recorded in docs/live-results/20260915-R-012-usage-limits.md.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface UsageRecord {
  requestId: string;
  startedAt: string;
  submitted: "yes" | "no" | "unknown";
  status: string;
  errorCode: string | null;
  observedPreset: string | null;
  observedModel: string | null;
  observedModelSlug: string | null;
  attachments: number;
}

export interface UsageWindow {
  label: string;
  /** Regex on observedModelSlug (or "*" for every submitted message). */
  slug: string;
  /** null = unknown / unpublished: count only, no remaining. */
  limit: number | null;
  windowHours: number;
  /** When true the window counts attachments instead of messages. */
  countsAttachments?: boolean;
}

export interface UsageLimits {
  source: string;
  windows: Record<string, UsageWindow>;
}

export const DEFAULT_LIMITS: UsageLimits = {
  source:
    "ChatGPT 自身の回答（2026-09-15、公式未確認）。runtime/limits.json を編集して上書きできる。Pro $100 前提",
  windows: {
    pro_pool: {
      label: "Sol Pro / GPT-6 Pro（合算、週）",
      slug: "-pro$",
      limit: 50,
      windowHours: 168,
    },
    thinking_day: {
      label: "Thinking 系（中程度〜極高、日）上限非公開",
      slug: "-thinking$",
      limit: null,
      windowHours: 24,
    },
    instant_day: {
      label: "Instant（日）上限非公開",
      slug: "^gpt-[0-9-]+$",
      limit: null,
      windowHours: 24,
    },
    all_day: { label: "ブリッジ送信合計（日）", slug: "*", limit: null, windowHours: 24 },
    attachments_3h: {
      label: "添付ファイル（3 時間）",
      slug: "*",
      limit: 80,
      windowHours: 3,
      countsAttachments: true,
    },
  },
};

export interface UsageLine {
  key: string;
  label: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  windowHours: number;
  oldestInWindow: string | null;
}

export interface UsageReport {
  generatedAt: string;
  source: string;
  recordsScanned: number;
  lines: UsageLine[];
  lastRateLimited: { requestId: string; at: string } | null;
  note: string;
}

export function computeUsage(records: UsageRecord[], limits: UsageLimits, now: Date): UsageReport {
  const lines: UsageLine[] = [];
  for (const [key, w] of Object.entries(limits.windows)) {
    const since = now.getTime() - w.windowHours * 3_600_000;
    const re = w.slug === "*" ? null : new RegExp(w.slug);
    let used = 0;
    let oldest: string | null = null;
    for (const r of records) {
      if (r.submitted !== "yes") continue;
      const t = Date.parse(r.startedAt);
      if (Number.isNaN(t) || t < since || t > now.getTime()) continue;
      if (re && !(r.observedModelSlug && re.test(r.observedModelSlug))) continue;
      const n = w.countsAttachments ? r.attachments : 1;
      if (n === 0) continue;
      used += n;
      if (!oldest || t < Date.parse(oldest)) oldest = r.startedAt;
    }
    lines.push({
      key,
      label: w.label,
      used,
      limit: w.limit,
      remaining: w.limit === null ? null : Math.max(0, w.limit - used),
      windowHours: w.windowHours,
      oldestInWindow: oldest,
    });
  }
  let lastRateLimited: UsageReport["lastRateLimited"] = null;
  for (const r of records) {
    if (r.errorCode !== "RATE_LIMITED") continue;
    if (!lastRateLimited || Date.parse(r.startedAt) > Date.parse(lastRateLimited.at)) {
      lastRateLimited = { requestId: r.requestId, at: r.startedAt };
    }
  }
  return {
    generatedAt: now.toISOString(),
    source: limits.source,
    recordsScanned: records.length,
    lines,
    lastRateLimited,
    note: "ブリッジ経由の送信のみを数えた下限値。手動送信分は含まれない。上限値は公式未確認",
  };
}

export function formatUsage(r: UsageReport): string {
  const out: string[] = [`usage (${r.generatedAt}) — ${r.recordsScanned} 件の result.json を集計`];
  for (const l of r.lines) {
    const win = l.windowHours % 24 === 0 ? `${l.windowHours / 24} 日` : `${l.windowHours} 時間`;
    const lim = l.limit === null ? "上限不明" : `${l.used}/${l.limit}（残り ${l.remaining}）`;
    out.push(`  ${l.label.padEnd(28)} ${l.limit === null ? `${l.used} 件` : lim}  [直近 ${win}]`);
  }
  out.push(
    `  最後の RATE_LIMITED: ${r.lastRateLimited ? `${r.lastRateLimited.at} (${r.lastRateLimited.requestId})` : "なし"}`,
  );
  out.push(`  注: ${r.note}`);
  out.push(`  上限の出所: ${r.source}`);
  return out.join("\n");
}

/** Scans runtime/requests/<id>/result.json (+ request.json for attachments). Unreadable entries are skipped. */
export async function loadRecords(requestsDir: string): Promise<UsageRecord[]> {
  let dirs: string[];
  try {
    dirs = await readdir(requestsDir);
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const d of dirs) {
    try {
      const res = JSON.parse(await readFile(join(requestsDir, d, "result.json"), "utf8")) as Record<
        string,
        unknown
      >;
      let attachments = 0;
      try {
        const req = JSON.parse(await readFile(join(requestsDir, d, "request.json"), "utf8")) as {
          attachments?: unknown[];
        };
        attachments = Array.isArray(req.attachments) ? req.attachments.length : 0;
      } catch {
        /* no request.json */
      }
      const err = res.error as { code?: string } | null;
      out.push({
        requestId: String(res.requestId ?? d),
        startedAt: String(res.startedAt ?? ""),
        submitted: (res.submitted as UsageRecord["submitted"]) ?? "unknown",
        status: String(res.status ?? ""),
        errorCode: err?.code ?? null,
        observedPreset: (res.observedPreset as string | null) ?? null,
        observedModel: (res.observedModel as string | null) ?? null,
        observedModelSlug: (res.observedModelSlug as string | null) ?? null,
        attachments,
      });
    } catch {
      /* not a completed request dir */
    }
  }
  return out;
}

/** Validates every window; returns an error reason when anything is off (Codex P5-4). */
export function validateLimits(raw: unknown): { limits: UsageLimits } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "not an object" };
  const r = raw as Partial<UsageLimits>;
  if (!r.windows || typeof r.windows !== "object") return { error: "windows missing" };
  const windows: Record<string, UsageWindow> = {};
  for (const [key, w] of Object.entries(r.windows as Record<string, Partial<UsageWindow>>)) {
    if (!w || typeof w !== "object") return { error: `${key}: not an object` };
    if (typeof w.label !== "string" || !w.label) return { error: `${key}: label` };
    if (typeof w.slug !== "string" || !w.slug) return { error: `${key}: slug` };
    if (w.slug !== "*") {
      try {
        new RegExp(w.slug);
      } catch {
        return { error: `${key}: slug is not a valid regex` };
      }
    }
    if (!(w.limit === null || (Number.isInteger(w.limit) && (w.limit as number) > 0))) {
      return { error: `${key}: limit must be null or a positive integer` };
    }
    if (typeof w.windowHours !== "number" || !(w.windowHours > 0) || w.windowHours > 24 * 366) {
      return { error: `${key}: windowHours` };
    }
    windows[key] = {
      label: w.label,
      slug: w.slug,
      limit: w.limit as number | null,
      windowHours: w.windowHours,
      ...(w.countsAttachments ? { countsAttachments: true } : {}),
    };
  }
  if (Object.keys(windows).length === 0) return { error: "no windows" };
  return {
    limits: { source: typeof r.source === "string" ? r.source : DEFAULT_LIMITS.source, windows },
  };
}

export async function loadLimits(
  path: string,
  onInvalid: (reason: string) => void = () => undefined,
): Promise<UsageLimits> {
  try {
    const v = validateLimits(JSON.parse(await readFile(path, "utf8")));
    if ("limits" in v) return v.limits;
    onInvalid(v.error);
    return DEFAULT_LIMITS;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      onInvalid((err as Error).message);
      return DEFAULT_LIMITS;
    }
  }
  try {
    await writeFile(path, `${JSON.stringify(DEFAULT_LIMITS, null, 2)}\n`, { flag: "wx" });
  } catch {
    /* exists or not writable */
  }
  return DEFAULT_LIMITS;
}
