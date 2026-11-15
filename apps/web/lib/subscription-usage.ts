import { dateKey, type DailyAggregate, type ToolId, type UsageEvent } from "@clausage/core";

export interface ValueUsage {
  tool: ToolId;
  todayUSD: number;
  monthUSD: number;
  unpriced: number;
  estimated: boolean;
}

export function valueUsage(events: UsageEvent[], historical: DailyAggregate[], tools: readonly ToolId[], today: string, timezone: string): ValueUsage[] {
  const usage = tools.map((tool) => ({ tool, todayUSD: 0, monthUSD: 0, unpriced: 0, estimated: false }));
  const byTool = new Map(usage.map((u) => [u.tool, u]));
  const month = today.slice(0, 7);
  for (const e of events) {
    const u = byTool.get(e.tool);
    if (!u) continue;
    const day = dateKey(e.timestamp, timezone);
    if (!day.startsWith(month) || day > today) continue;
    u.monthUSD += e.costUSD;
    if (day === today) u.todayUSD += e.costUSD;
    if (e.costUnknown) u.unpriced++;
  }
  for (const h of historical) {
    const u = byTool.get(h.tool);
    if (!u || !h.date.startsWith(month) || h.date > today) continue;
    u.monthUSD += h.costUSD ?? 0;
    if (h.date === today) u.todayUSD += h.costUSD ?? 0;
    if (h.costUnknown) u.unpriced++;
    u.estimated = true;
  }
  return usage;
}
