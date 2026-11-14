import type { Report, TokenTotals, ToolId, UsageRow } from "@clausage/core";
import { addDays } from "./filters";
import { TOOL_IDS } from "./tools";

export type Metric = keyof Pick<
  TokenTotals,
  "costUSD" | "totalTokens" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens" | "events"
>;

export const METRIC_LABELS: Record<Metric, string> = {
  costUSD: "Cost",
  totalTokens: "Tokens",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  cacheReadTokens: "Cache read",
  cacheWriteTokens: "Cache write",
  reasoningTokens: "Reasoning",
  events: "Requests",
};

export type ToolValues = Partial<Record<ToolId, number>>;

export interface StackedDatum {
  key: string;
  label: string;
  /** short x-axis label; defaults to label */
  short?: string;
  values: ToolValues;
}

/** Per-tool totals of one row, from its (tool, model) breakdown. */
export function toolValues(row: UsageRow, metric: Metric): ToolValues {
  const out: ToolValues = {};
  if (row.breakdown?.length) {
    for (const b of row.breakdown) out[b.tool] = (out[b.tool] ?? 0) + b[metric];
  } else if (row.tools.length === 1) {
    out[row.tools[0]!] = row[metric];
  }
  return out;
}

export function stackedSeries(report: Report, metric: Metric, label: (row: UsageRow) => string = (r) => r.label): StackedDatum[] {
  return report.rows.map((row) => ({ key: row.key, label: label(row), values: toolValues(row, metric) }));
}

/** Inserts empty days so a daily series has one entry per calendar day from `since` to `until`. */
export function fillDailyGaps(data: StackedDatum[], since: string | undefined, until: string | undefined, label: (key: string) => string = (k) => k): StackedDatum[] {
  if (!data.length && !(since && until)) return data;
  const sorted = [...data].sort((a, b) => (a.key < b.key ? -1 : 1));
  const start = since ?? sorted[0]!.key;
  const end = until ?? sorted[sorted.length - 1]!.key;
  if (start > end) return sorted;
  const byKey = new Map(sorted.map((d) => [d.key, d]));
  const out: StackedDatum[] = [];
  for (let k = start, guard = 0; k <= end && guard < 4000; k = addDays(k, 1), guard++) {
    out.push(byKey.get(k) ?? { key: k, label: label(k), values: {} });
  }
  return out;
}

export function sumValues(values: ToolValues): number {
  let s = 0;
  for (const t of TOOL_IDS) s += values[t] ?? 0;
  return s;
}

/** Tools that have any non-zero value in the series, in canonical order. */
export function toolsPresent(data: StackedDatum[]): ToolId[] {
  return TOOL_IDS.filter((t) => data.some((d) => (d.values[t] ?? 0) !== 0));
}
