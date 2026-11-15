import { dtf } from "@/lib/format";
import type { BlockMeta, Report, ToolId, UsageEvent } from "@clausage/core";

export interface BlockSummary {
  id: string;
  tool: ToolId;
  startMs: number;
  endMs: number;
  firstMs: number;
  lastMs: number;
  isActive: boolean;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD: number;
  events: number;
  sessions: number;
  models: string[];
  tokensPerMinute: number | null;
  costPerHour: number | null;
  projectedTokens: number | null;
  projectedCost: number | null;
  remainingMinutes: number | null;
  /** the block is the provider's reported limit window */
  anchored: boolean;
  /** % of the 5-hour limit, when known */
  limitPercent: number | null;
  limitSource: "reported" | "configured" | null;
  limitHit: boolean;
}

export function summarizeBlocks(report: Report): BlockSummary[] {
  const out: BlockSummary[] = [];
  for (const row of report.rows) {
    const meta = row.meta as unknown as BlockMeta | undefined;
    if (!meta) continue;
    const lastMs = Date.parse(meta.actualEndTime);
    out.push({
      id: row.key,
      tool: meta.tool,
      startMs: Date.parse(meta.startTime),
      endMs: Date.parse(meta.endTime),
      firstMs: lastMs - meta.durationMinutes * 60_000,
      lastMs,
      isActive: meta.isActive,
      totalTokens: row.totalTokens,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      costUSD: row.costUSD,
      events: row.events,
      sessions: meta.sessions,
      models: row.models,
      tokensPerMinute: meta.burnRate?.tokensPerMinute ?? null,
      costPerHour: meta.burnRate?.costPerHour ?? null,
      projectedTokens: meta.projection?.totalTokens ?? null,
      projectedCost: meta.projection?.totalCost ?? null,
      remainingMinutes: meta.projection?.remainingMinutes ?? null,
      anchored: meta.anchored === true,
      limitPercent: meta.limit?.percent ?? null,
      limitSource: meta.limit?.percent !== undefined ? meta.limit.source : null,
      limitHit: meta.limit?.hit === true,
    });
  }
  return out.sort((a, b) => b.startMs - a.startMs || a.tool.localeCompare(b.tool));
}

export type TimelineItem = { kind: "block"; block: BlockSummary } | { kind: "gap"; id: string; fromMs: number; toMs: number };

// Newest first. An idle stretch of at least minGapMs with no block from any tool becomes a gap item.
export function blockTimeline(blocks: BlockSummary[], minGapMs: number): TimelineItem[] {
  const asc = [...blocks].sort((a, b) => a.firstMs - b.firstMs);
  const items: TimelineItem[] = [];
  let coveredUntil: number | null = null;
  for (const block of asc) {
    if (coveredUntil !== null && block.firstMs - coveredUntil >= minGapMs) {
      items.push({ kind: "gap", id: `gap:${coveredUntil}`, fromMs: coveredUntil, toMs: block.firstMs });
    }
    items.push({ kind: "block", block });
    coveredUntil = Math.max(coveredUntil ?? 0, block.lastMs);
  }
  return items.reverse();
}

export interface Heatmap {
  // [weekday, Monday = 0][hour 0-23]
  tokens: number[][];
  events: number[][];
  max: number;
  total: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const QUARTER_HOUR = 15 * 60_000;

export function activityHeatmap(events: UsageEvent[], timeZone: string): Heatmap {
  const tokens = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const counts = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const fmt = dtf("en-US", { timeZone, weekday: "short", hour: "numeric", hourCycle: "h23" });
  // Every IANA offset is a multiple of 15 minutes, so one lookup per quarter hour is exact.
  const slots = new Map<number, [number, number]>();
  let total = 0;
  for (const e of events) {
    const q = Math.floor(e.timestamp / QUARTER_HOUR);
    let slot = slots.get(q);
    if (!slot) {
      let day = 0;
      let hour = 0;
      for (const part of fmt.formatToParts(q * QUARTER_HOUR)) {
        if (part.type === "weekday") day = WEEKDAY_INDEX[part.value] ?? 0;
        else if (part.type === "hour") hour = Number(part.value) % 24;
      }
      slot = [day, hour];
      slots.set(q, slot);
    }
    const t = e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
    tokens[slot[0]]![slot[1]]! += t;
    counts[slot[0]]![slot[1]]! += 1;
    total += t;
  }
  let max = 0;
  for (const row of tokens) for (const v of row) if (v > max) max = v;
  return { tokens, events: counts, max, total };
}

// Only call after connection() (getFilters and getUsage do), so this is the request time.
export function requestTime(): number {
  return Date.now();
}
