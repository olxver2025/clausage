import "server-only";
import { computeActiveMs, startOfDay, endOfDay, type Report, type SessionMeta, type ToolId, type UsageEvent } from "@clausage/core";
import { reportFrom, type UsageData } from "@/lib/data";
import type { Filters } from "@/lib/filters";
import { TOOL_IDS } from "@/lib/tools";

export interface PeriodStats {
  costUSD: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  sessions: number;
  activeMs: number;
  cacheHit: number | null;
  estimatedDays: number;
  daily: Report;
  sessionReport: Report;
}

export function cacheHitRatio(t: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number | null {
  const denom = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return denom > 0 ? t.cacheReadTokens / denom : null;
}

export function sessionMeta(row: Report["rows"][number]): SessionMeta {
  return row.meta as unknown as SessionMeta;
}

export function periodStats(data: UsageData, filters: Filters): PeriodStats {
  const daily = reportFrom(data, "daily", filters);
  const sessionReport = reportFrom(data, "session", filters, { order: "desc" });
  const t = daily.totals;
  return {
    costUSD: t.costUSD,
    totalTokens: t.totalTokens,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens,
    reasoningTokens: t.reasoningTokens,
    sessions: sessionReport.rows.length,
    activeMs: sessionReport.rows.reduce((s, r) => s + (sessionMeta(r).activeMs || 0), 0),
    cacheHit: cacheHitRatio(t),
    estimatedDays: daily.rows.filter((r) => r.meta?.historical).length,
    daily,
    sessionReport,
  };
}

export function ratio(cur: number, prev: number | undefined): number | null {
  if (prev === undefined || !Number.isFinite(prev) || prev === 0) return null;
  return (cur - prev) / prev;
}

export interface ToolDayStats {
  tool: ToolId;
  costUSD: number;
  totalTokens: number;
  sessions: number;
  activeMs: number;
  requests: number;
}

export interface DayStats {
  costUSD: number;
  totalTokens: number;
  sessions: number;
  activeMs: number;
  requests: number;
  lastAt?: number;
  byTool: ToolDayStats[];
}

/** Totals for one calendar day in the report timezone, from event-level data only. */
export function dayStats(events: UsageEvent[], day: string, timezone: string): DayStats {
  const from = startOfDay(day, timezone);
  const to = endOfDay(day, timezone);
  const byTool = new Map<ToolId, ToolDayStats>();
  const sessionTimes = new Map<string, number[]>();
  let lastAt: number | undefined;
  for (const e of events) {
    if (e.timestamp < from || e.timestamp > to) continue;
    let t = byTool.get(e.tool);
    if (!t) byTool.set(e.tool, (t = { tool: e.tool, costUSD: 0, totalTokens: 0, sessions: 0, activeMs: 0, requests: 0 }));
    t.costUSD += e.costUSD;
    t.totalTokens += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
    t.requests += 1;
    const key = `${e.tool}\u0000${e.rootSessionId || e.sessionId}`;
    let ts = sessionTimes.get(key);
    if (!ts) sessionTimes.set(key, (ts = []));
    ts.push(e.timestamp);
    if (lastAt === undefined || e.timestamp > lastAt) lastAt = e.timestamp;
  }
  for (const [key, ts] of sessionTimes) {
    const t = byTool.get(key.split("\u0000")[0] as ToolId)!;
    t.sessions += 1;
    t.activeMs += computeActiveMs(ts);
  }
  const list = TOOL_IDS.flatMap((id) => (byTool.has(id) ? [byTool.get(id)!] : []));
  return {
    costUSD: list.reduce((s, t) => s + t.costUSD, 0),
    totalTokens: list.reduce((s, t) => s + t.totalTokens, 0),
    sessions: list.reduce((s, t) => s + t.sessions, 0),
    activeMs: list.reduce((s, t) => s + t.activeMs, 0),
    requests: list.reduce((s, t) => s + t.requests, 0),
    lastAt,
    byTool: list,
  };
}

/** Latest activity per tool: the newest event, or for estimated-only tools the newest historical day. */
export function lastActiveByTool(data: UsageData): Partial<Record<ToolId, { at: number; estimated: boolean }>> {
  const out: Partial<Record<ToolId, { at: number; estimated: boolean }>> = {};
  for (const e of data.events) {
    const cur = out[e.tool];
    if (!cur || e.timestamp > cur.at) out[e.tool] = { at: e.timestamp, estimated: false };
  }
  for (const h of data.historical) {
    if (out[h.tool] && !out[h.tool]!.estimated) continue;
    const at = Date.parse(`${h.date}T12:00:00Z`);
    if (!out[h.tool] || at > out[h.tool]!.at) out[h.tool] = { at, estimated: true };
  }
  return out;
}

/** Request time; pages are dynamic (getFilters awaits connection()), so this runs per request. */
export function requestNow(): number {
  return Date.now();
}
