/**
 * Derived insights over normalised events:
 * - cache efficiency: how much of the prompt came from cache, and what caching saved compared with
 *   sending the same prompt uncached (net of the cache-write premium);
 * - spikes: days and sessions far above your usual, by a robust (median / MAD) rule;
 * - forecast: month-end spend from month-to-date plus your recent daily rate.
 */
import { dateKey, monthKey, startOfDay } from './aggregate.js';
import { costForTokens, usagePricing, type PricingTable } from './pricing.js';
import type { DailyAggregate, ToolId, UsageEvent, UsageRow } from './types.js';

/** YYYY-MM-DD plus `days` calendar days. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Cache efficiency

export interface CacheEfficiency {
  key: string;
  label: string;
  tools: ToolId[];
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + cache read + cache write */
  promptTokens: number;
  /** cache read ÷ prompt tokens (0-1) */
  hitRate: number;
  /** cache write ÷ prompt tokens (0-1) */
  writeRate: number;
  /** calculated cost of the priced events, at list prices */
  costUSD: number;
  /** the same events priced as if every prompt token were uncached input */
  uncachedCostUSD: number;
  /** uncachedCostUSD − costUSD: what caching saved (negative when writes outweighed reads) */
  savedUSD: number;
  /** prompt tokens of events without a known price (left out of the money figures) */
  unpricedPromptTokens: number;
  events: number;
}

export type CacheGroup = 'model' | 'tool' | 'day' | 'session' | 'total';

function emptyCache(key: string, label: string): CacheEfficiency {
  return {
    key,
    label,
    tools: [],
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    promptTokens: 0,
    hitRate: 0,
    writeRate: 0,
    costUSD: 0,
    uncachedCostUSD: 0,
    savedUSD: 0,
    unpricedPromptTokens: 0,
    events: 0,
  };
}

/**
 * Cache efficiency grouped by model, tool, day (in `timezone`), root session, or one total row.
 * Money figures use list prices (calculate mode) regardless of the report's cost mode, so the
 * cached and uncached figures are comparable.
 */
export function cacheEfficiency(
  events: UsageEvent[],
  pricing: PricingTable,
  group: CacheGroup,
  opts: { timezone?: string } = {},
): CacheEfficiency[] {
  const out = new Map<string, CacheEfficiency>();
  for (const e of events) {
    const prompt = e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens;
    if (prompt <= 0) continue;
    const key =
      group === 'model'
        ? e.model
        : group === 'tool'
          ? e.tool
          : group === 'day'
            ? dateKey(e.timestamp, opts.timezone)
            : group === 'session'
              ? `${e.tool}:${e.rootSessionId || e.sessionId}${e.machine ? `@${e.machine}` : ''}`
              : 'total';
    let row = out.get(key);
    if (!row) out.set(key, (row = emptyCache(key, group === 'total' ? 'All usage' : key)));
    if (!row.tools.includes(e.tool)) row.tools.push(e.tool);
    row.inputTokens += e.inputTokens;
    row.cacheReadTokens += e.cacheReadTokens;
    row.cacheWriteTokens += e.cacheWriteTokens;
    row.promptTokens += prompt;
    row.events++;
    const base = pricing.lookup(e.model, e.tool, e.provider, e.timestamp);
    const p = base ? usagePricing(base, e.model, e.speed) : null;
    if (!p) {
      row.unpricedPromptTokens += prompt;
      continue;
    }
    const applyTiers = e.tool !== 'grok';
    const actual = costForTokens(e, p, { applyTiers });
    const uncached = costForTokens({ inputTokens: prompt, outputTokens: e.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, p, { applyTiers });
    row.costUSD += actual;
    row.uncachedCostUSD += uncached;
  }
  const rows = [...out.values()];
  for (const r of rows) {
    r.hitRate = r.promptTokens ? r.cacheReadTokens / r.promptTokens : 0;
    r.writeRate = r.promptTokens ? r.cacheWriteTokens / r.promptTokens : 0;
    r.savedUSD = r.uncachedCostUSD - r.costUSD;
  }
  return group === 'day' ? rows.sort((a, b) => (a.key < b.key ? -1 : 1)) : rows.sort((a, b) => b.promptTokens - a.promptTokens);
}

// ---------------------------------------------------------------------------------------------
// Daily series, spikes and forecast

export interface DailyPoint {
  /** YYYY-MM-DD in the report timezone */
  date: string;
  costUSD: number;
  tokens: number;
  events: number;
}

/** Cost and tokens per calendar day from `first` to `last` inclusive, zero-filled. */
export function dailySeries(
  events: UsageEvent[],
  historical: DailyAggregate[] = [],
  opts: { timezone?: string; first?: string; last?: string } = {},
): DailyPoint[] {
  const map = new Map<string, DailyPoint>();
  const add = (date: string, cost: number, tokens: number, n: number) => {
    let p = map.get(date);
    if (!p) map.set(date, (p = { date, costUSD: 0, tokens: 0, events: 0 }));
    p.costUSD += cost;
    p.tokens += tokens;
    p.events += n;
  };
  for (const e of events) add(dateKey(e.timestamp, opts.timezone), e.costUSD || 0, e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens, 1);
  for (const h of historical) add(h.date, h.costUSD ?? 0, h.inputTokens + h.outputTokens + h.cacheReadTokens + h.cacheWriteTokens, h.messages ?? 0);
  const dates = [...map.keys()].sort();
  const first = opts.first ?? dates[0];
  const last = opts.last ?? dates[dates.length - 1];
  if (!first || !last || first > last) return [];
  const out: DailyPoint[] = [];
  for (let d = first, guard = 0; d <= last && guard < 20_000; d = addDays(d, 1), guard++) out.push(map.get(d) ?? { date: d, costUSD: 0, tokens: 0, events: 0 });
  return out;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export interface Spike {
  key: string;
  label: string;
  value: number;
  /** the usual value it is compared with (median of the baseline) */
  baseline: number;
  /** value ÷ baseline */
  ratio: number;
  /** robust z-score: (value − median) ÷ (1.4826 × MAD) */
  score: number;
  /** for session spikes: the root session */
  session?: { tool: ToolId; sessionId: string; machine?: string };
}

export interface SpikeOptions {
  /** robust z-score at or above which a value is a spike (default 3.5) */
  threshold?: number;
  /** and at least this many times the median (default 2) */
  minRatio?: number;
  /** ignore values below this (default $1, so a $0.30 day never "spikes") */
  minValue?: number;
  /** baseline needs this many values (default 7) */
  minSamples?: number;
}

function robustSpikes(items: Array<{ key: string; label: string; value: number; session?: Spike['session'] }>, baselineValues: number[], o: SpikeOptions): Spike[] {
  const threshold = o.threshold ?? 3.5;
  const minRatio = o.minRatio ?? 2;
  const minValue = o.minValue ?? 1;
  if (baselineValues.length < (o.minSamples ?? 7)) return [];
  const med = median(baselineValues);
  const mad = median(baselineValues.map((v) => Math.abs(v - med)));
  // With a flat baseline (MAD 0) fall back to the mean absolute deviation, then to the ratio rule.
  const meanAbs = baselineValues.reduce((s, v) => s + Math.abs(v - med), 0) / baselineValues.length;
  const scale = mad > 0 ? 1.4826 * mad : meanAbs > 0 ? 1.2533 * meanAbs : 0;
  const out: Spike[] = [];
  for (const it of items) {
    if (it.value < minValue) continue;
    const ratio = med > 0 ? it.value / med : Infinity;
    const score = scale > 0 ? (it.value - med) / scale : ratio === Infinity ? Infinity : 0;
    if (score >= threshold && ratio >= minRatio) out.push({ ...it, baseline: med, ratio, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Days whose cost is far above the usual. Only days with usage form the baseline (an idle weekend
 * should not make every working day look like a spike).
 */
export function dailySpikes(series: DailyPoint[], opts: SpikeOptions = {}): Spike[] {
  const active = series.filter((p) => p.events > 0 || p.costUSD > 0);
  return robustSpikes(
    active.map((p) => ({ key: p.date, label: p.date, value: p.costUSD })),
    active.map((p) => p.costUSD),
    opts,
  ).sort((a, b) => (a.key < b.key ? 1 : -1));
}

/**
 * Root sessions (session report rows) whose cost is far above your usual session. Sessions under
 * 10 cents (one-shot helpers, title generators) are left out of the baseline, and the bar is
 * higher than for days: sessions vary far more than daily totals.
 */
export function sessionSpikes(rows: UsageRow[], opts: SpikeOptions = {}): Spike[] {
  const priced = rows.filter((r) => r.costUSD >= 0.1);
  return robustSpikes(
    priced.map((r) => {
      const m = r.meta as { title?: string; tool?: ToolId; sessionId?: string; machine?: string } | undefined;
      return {
        key: r.key,
        label: String(m?.title || r.label),
        value: r.costUSD,
        ...(m?.tool && m.sessionId ? { session: { tool: m.tool, sessionId: m.sessionId, ...(m.machine ? { machine: m.machine } : {}) } } : {}),
      };
    }),
    priced.map((r) => r.costUSD),
    { minValue: 5, minRatio: 5, threshold: 5, ...opts },
  );
}

export interface MonthForecast {
  /** YYYY-MM */
  month: string;
  /** spend so far this month */
  toDateUSD: number;
  /** expected month total */
  projectedUSD: number;
  /** projected range from your quieter and busier days (25th–75th percentile daily cost) */
  lowUSD: number;
  highUSD: number;
  /** average daily cost the projection uses */
  dailyRateUSD: number;
  /** days of history behind the rate */
  basisDays: number;
  /** fraction of the month elapsed (0-1) */
  elapsed: number;
  daysInMonth: number;
}

/**
 * Month-end projection: month-to-date + the average daily cost of the last `basisDays` complete
 * days (idle days count as $0) × the time left in the month. Low/high use the 25th and 75th
 * percentile day instead of the mean.
 */
export function forecastMonth(
  events: UsageEvent[],
  historical: DailyAggregate[] = [],
  opts: { timezone?: string; now?: number; basisDays?: number } = {},
): MonthForecast {
  const now = opts.now ?? Date.now();
  const tz = opts.timezone;
  const basisDays = opts.basisDays ?? 14;
  const today = dateKey(now, tz);
  const month = monthKey(now, tz);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthStart = startOfDay(`${month}-01`, tz);
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const monthEnd = startOfDay(nextMonth, tz);
  const elapsed = Math.min(1, Math.max(0, (now - monthStart) / (monthEnd - monthStart)));

  let toDateUSD = 0;
  for (const e of events) if (e.timestamp >= monthStart && e.timestamp <= now) toDateUSD += e.costUSD || 0;
  for (const h of historical) if (h.date.startsWith(month) && h.date <= today) toDateUSD += h.costUSD ?? 0;

  const first = addDays(today, -basisDays);
  const last = addDays(today, -1);
  const series = dailySeries(
    events.filter((e) => e.timestamp >= startOfDay(first, tz) && e.timestamp < startOfDay(today, tz)),
    historical.filter((h) => h.date >= first && h.date <= last),
    { timezone: tz, first, last },
  );
  // Only count days since your first recorded usage, so a brand-new install isn't averaged with empty days.
  const firstUse = series.findIndex((p) => p.events > 0 || p.costUSD > 0);
  const basis = firstUse < 0 ? [] : series.slice(firstUse);
  const costs = basis.map((p) => p.costUSD);
  const rate = costs.length ? costs.reduce((s, v) => s + v, 0) / costs.length : 0;
  const daysLeft = Math.max(0, (monthEnd - now) / 86_400_000);
  return {
    month,
    toDateUSD,
    projectedUSD: toDateUSD + rate * daysLeft,
    lowUSD: toDateUSD + quantile(costs, 0.25) * daysLeft,
    highUSD: toDateUSD + quantile(costs, 0.75) * daysLeft,
    dailyRateUSD: rate,
    basisDays: basis.length,
    elapsed,
    daysInMonth,
  };
}
