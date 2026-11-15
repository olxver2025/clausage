import "server-only";
import { buildReport, usageSpeed, computeActiveMs, sumTotals, type ModelBreakdown, type SessionMeta, type TokenTotals, type ToolId, type UsageEvent } from "@clausage/core";
import { getUsage, type Filters } from "@/lib/data";
import { displayTitle } from "./links";

export interface SubagentRow extends TokenTotals {
  sessionId: string;
  title?: string;
  startedAt: number;
  endedAt: number;
  activeMs: number;
  turns: number;
  toolCalls: number;
  models: string[];
  speeds: string[];
}

export interface SessionDetail {
  meta: SessionMeta;
  totals: TokenTotals;
  models: string[];
  breakdown: ModelBreakdown[];
  costUnknown: boolean;
  main: TokenTotals;
  subagents: SubagentRow[];
  timeline: { ts: number[]; tokens: number[]; cost: number[]; sub: number[] };
  timezone: string;
  loadedAt: number;
}

/** A session's whole tree regardless of the date range, with the page's cost mode. */
export function detailFilters(filters: Filters, tool: ToolId): Filters {
  return { ...filters, tools: [tool], allTools: false, range: "all", since: undefined, until: undefined, project: undefined, subagents: true };
}

export async function getSessionDetail(filters: Filters, tool: ToolId, rootId: string): Promise<SessionDetail | null> {
  const data = await getUsage(detailFilters(filters, tool));
  const events = data.events.filter((e) => e.tool === tool && (e.rootSessionId || e.sessionId) === rootId);
  const infos = data.sessions.filter((s) => s.tool === tool && ((s.rootSessionId || s.sessionId) === rootId || s.sessionId === rootId));
  if (!events.length && !infos.length) return null;

  const report = buildReport("session", events, infos, { timezone: data.timezone });
  const row = report.rows[0];
  if (!row) return null;

  const bySub = new Map<string, UsageEvent[]>();
  for (const e of events) {
    if (!e.isSubagent || e.sessionId === rootId) continue;
    let list = bySub.get(e.sessionId);
    if (!list) bySub.set(e.sessionId, (list = []));
    list.push(e);
  }
  const subInfos = new Map(infos.filter((s) => s.isSubagent && s.sessionId !== rootId).map((s) => [s.sessionId, s]));
  const subIds = new Set([...bySub.keys(), ...subInfos.keys()]);
  const subagents: SubagentRow[] = [...subIds].map((id) => {
    const list = bySub.get(id) ?? [];
    const info = subInfos.get(id);
    const times = list.map((e) => e.timestamp);
    const models = new Set<string>(info?.models ?? []);
    for (const e of list) if (e.model) models.add(e.model);
    return {
      ...sumTotals(list),
      sessionId: id,
      title: displayTitle(info?.title),
      startedAt: times.reduce((m, t) => Math.min(m, t), info?.startedAt ?? Infinity),
      endedAt: times.reduce((m, t) => Math.max(m, t), info?.endedAt ?? -Infinity),
      activeMs: Math.max(info?.activeMs ?? 0, computeActiveMs(times)),
      turns: info?.turns ?? 0,
      toolCalls: info?.toolCalls ?? 0,
      models: [...models].sort(),
      speeds: [...new Set(list.flatMap((e) => usageSpeed(e.model, e.speed) ?? []))].sort(),
    };
  });
  subagents.sort((a, b) => a.startedAt - b.startedAt);

  return {
    meta: row.meta as unknown as SessionMeta,
    totals: report.totals,
    models: row.models,
    breakdown: row.breakdown,
    costUnknown: Boolean(row.meta?.costUnknown),
    main: sumTotals(events.filter((e) => !e.isSubagent || e.sessionId === rootId)),
    subagents,
    timeline: {
      ts: events.map((e) => e.timestamp),
      tokens: events.map((e) => e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens),
      cost: events.map((e) => e.costUSD),
      sub: events.map((e) => (e.isSubagent && e.sessionId !== rootId ? 1 : 0)),
    },
    timezone: data.timezone,
    loadedAt: data.loadedAt,
  };
}
