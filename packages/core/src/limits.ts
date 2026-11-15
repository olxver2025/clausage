/**
 * Usage-limit tracking: the 5-hour and weekly windows providers meter subscriptions by.
 *
 * - Tools that report their limits (Codex: `rate_limits` on every response) give exact windows,
 *   the percentage used, and the reset time. From their history we also estimate how many tokens
 *   (and how much API-priced cost) one full window holds at your usual model mix.
 * - For the other tools a window is the current 5-hour block (first request floored to the hour,
 *   which is how Claude's 5-hour limit starts) and a week either rolling or from the reset time
 *   you set; the percentage comes from the token limit you set.
 * - Limit hits are requests the provider refused because a limit was reached.
 *
 * Settings live in config.json under `limits`, shared by the CLI and the dashboard.
 */
import { buildBlocks, dateKey, startOfDay, resolveTimezone } from './aggregate.js';
import { readStored, writeStored } from './sync.js';
import type { BlockMeta } from './aggregate.js';
import type { LimitHit, LimitSnapshot, LimitWindow, ToolId, UsageEvent } from './types.js';
import { TOOL_IDS } from './types.js';
import { detectUsageResets, type UsageResetEvent } from './usage-resets.js';
import type { ResetAvailability } from './types.js';

const HOUR = 3_600_000;
const FIVE_HOURS = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;

export interface ToolLimitConfig {
  /** tokens allowed per 5-hour window */
  fiveHourTokens?: number;
  /** tokens allowed per week */
  weeklyTokens?: number;
  /** day the weekly limit resets, 0 = Sunday … 6 = Saturday; unset = rolling 7 days */
  weeklyResetDay?: number;
  /** hour (0-23, report timezone) the weekly limit resets */
  weeklyResetHour?: number;
}

export type LimitConfig = Partial<Record<ToolId, ToolLimitConfig>>;

function cleanToolConfig(v: unknown): ToolLimitConfig | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const pos = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined);
  const int = (n: unknown, lo: number, hi: number) => (typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi ? n : undefined);
  const out: ToolLimitConfig = {};
  const f = pos(o.fiveHourTokens);
  const w = pos(o.weeklyTokens);
  const d = int(o.weeklyResetDay, 0, 6);
  const h = int(o.weeklyResetHour, 0, 23);
  if (f) out.fiveHourTokens = f;
  if (w) out.weeklyTokens = w;
  if (d !== undefined) out.weeklyResetDay = d;
  if (h !== undefined) out.weeklyResetHour = h;
  return Object.keys(out).length ? out : undefined;
}

export function loadLimitConfig(): LimitConfig {
  const raw = readStored().limits;
  const out: LimitConfig = {};
  if (raw && typeof raw === 'object') {
    for (const t of TOOL_IDS) {
      const c = cleanToolConfig((raw as Record<string, unknown>)[t]);
      if (c) out[t] = c;
    }
  }
  return out;
}

/** Replace one tool's limit settings (null or an empty object clears them). */
export function saveLimitConfig(tool: ToolId, config: ToolLimitConfig | null): LimitConfig {
  if (!TOOL_IDS.includes(tool)) throw new Error(`Unknown tool ${tool}`);
  const stored = readStored();
  const next: LimitConfig = { ...loadLimitConfig() };
  const clean = cleanToolConfig(config);
  if (clean) next[tool] = clean;
  else delete next[tool];
  writeStored({ ...stored, limits: next });
  return next;
}

// ---------------------------------------------------------------------------------------------

export type LimitSource = 'reported' | 'configured';

export interface WindowStatus {
  kind: 'five_hour' | 'weekly';
  /** display name for windows beyond the main two (e.g. "Weekly · Opus") */
  label?: string;
  /** epoch ms; for a rolling week, now − 7 days */
  startMs: number;
  /** epoch ms when the window resets (for a rolling week: now) */
  endMs: number;
  /** a rolling 7-day total rather than a fixed window */
  rolling: boolean;
  /** usage inside the window, from the logs */
  tokens: number;
  costUSD: number;
  requests: number;
  /** % of the limit used (0-100+), when known */
  usedPercent?: number;
  /** where usedPercent comes from */
  source?: LimitSource;
  /** the configured token limit (source 'configured') */
  limitTokens?: number;
  /** epoch ms of the tool's report (source 'reported') */
  reportedAt?: number;
  /** % expected at the reset if the pace so far continues */
  projectedPercent?: number;
  /** epoch ms when the limit is reached at the pace so far, if before the reset */
  projectedLimitAt?: number;
  /** the window ended after the last report and no new one has started */
  expired?: boolean;
}

export interface CapacityEstimate {
  /** ≈ total tokens in a full window */
  tokens: number;
  /** ≈ API-priced cost of a full window, USD */
  costUSD: number;
  /** windows the estimate is based on */
  windows: number;
}

export interface ToolLimitStatus {
  tool: ToolId;
  planType?: string;
  fiveHour: WindowStatus | null;
  weekly: WindowStatus | null;
  /** estimated size of a full window from reported history (tools that report limits only) */
  fiveHourCapacity?: CapacityEstimate;
  weeklyCapacity?: CapacityEstimate;
  /** further reported windows, e.g. a model-specific weekly limit */
  extra: WindowStatus[];
  /** limit hits, newest first */
  hits: LimitHit[];
  lastActivity?: number;
  config?: ToolLimitConfig;
  resets?: ResetAvailability;
  resetsReportedAt?: number;
  resetEvents: UsageResetEvent[];
  resetError?: string;
}

export interface LimitStatusInput {
  events: UsageEvent[];
  limits?: LimitSnapshot[];
  limitHits?: LimitHit[];
  config?: LimitConfig;
  now?: number;
  timezone?: string;
  /** only these tools (default: every tool with recent activity, reports or settings) */
  tools?: ToolId[];
}

function sumIn(events: UsageEvent[], from: number, to: number) {
  let tokens = 0;
  let costUSD = 0;
  let requests = 0;
  // events are sorted by timestamp
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.timestamp < from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < events.length && events[i]!.timestamp <= to; i++) {
    const e = events[i]!;
    tokens += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
    costUSD += e.costUSD || 0;
    requests++;
  }
  return { tokens, costUSD, requests };
}

/** Pace projection from the share used so far of the time elapsed in the window. */
function project(status: WindowStatus, now: number): void {
  if (status.usedPercent === undefined || status.rolling) return;
  const elapsed = Math.min(now, status.endMs) - status.startMs;
  const length = status.endMs - status.startMs;
  if (elapsed <= 0 || length <= 0) return;
  // Too early in the window to extrapolate meaningfully.
  if (elapsed < Math.min(15 * 60_000, length * 0.05)) return;
  const perMs = status.usedPercent / elapsed;
  status.projectedPercent = perMs * length;
  if (perMs > 0 && status.usedPercent < 100) {
    const at = status.startMs + 100 / perMs;
    if (at < status.endMs) status.projectedLimitAt = Math.max(now, at);
  }
}

/**
 * Codex's reported reset time jitters by a second or so between responses; reports whose reset
 * times are within a few minutes of each other belong to one window. Returns, per report index,
 * the canonical (latest) reset time of its window.
 */
function windowKeys(snapshots: LimitSnapshot[], which: 'primary' | 'secondary'): Map<number, number> {
  const resets = [...new Set(snapshots.map((s) => s[which]?.resetsAt).filter((r): r is number => r !== undefined))].sort((a, b) => a - b);
  const canonical = new Map<number, number>();
  let group: number[] = [];
  const close = () => {
    const key = group[group.length - 1]!;
    for (const r of group) canonical.set(r, key);
    group = [];
  };
  for (const r of resets) {
    if (group.length && r - group[0]! > 5 * 60_000) close();
    group.push(r);
  }
  if (group.length) close();
  return canonical;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * How much one full window holds, from reported windows: for each past window, the usage up to its
 * last report with at least 10% used, scaled to 100%. The median keeps one odd window from skewing it.
 */
export function estimateCapacity(
  events: UsageEvent[],
  snapshots: LimitSnapshot[],
  which: 'primary' | 'secondary',
  now: number = Date.now(),
): CapacityEstimate | undefined {
  const keys = windowKeys(snapshots, which);
  const lastByWindow = new Map<number, { snap: LimitSnapshot; w: LimitWindow }>();
  for (const s of snapshots) {
    const w = s[which];
    if (!w || w.usedPercent < 10) continue;
    const key = keys.get(w.resetsAt) ?? w.resetsAt;
    const prev = lastByWindow.get(key);
    if (!prev || s.timestamp > prev.snap.timestamp) lastByWindow.set(key, { snap: s, w });
  }
  const tokens: number[] = [];
  const cost: number[] = [];
  const resets = detectUsageResets(snapshots, now);
  for (const { snap, w } of lastByWindow.values()) {
    const start = w.resetsAt - w.windowMinutes * 60_000;
    // only windows whose usage is fully in the logs we loaded
    if (start > now) continue;
    if (resets.some((r) => r.timestamp >= start && r.timestamp <= snap.timestamp && r.windows.some((x) => x.key === which))) continue;
    const used = sumIn(events, start, snap.timestamp);
    if (used.tokens <= 0) continue;
    tokens.push(used.tokens / (w.usedPercent / 100));
    cost.push(used.costUSD / (w.usedPercent / 100));
  }
  if (!tokens.length) return undefined;
  return { tokens: Math.round(median(tokens)), costUSD: median(cost), windows: tokens.length };
}

function reportedWindow(kind: WindowStatus['kind'], snap: LimitSnapshot, w: LimitWindow, events: UsageEvent[], now: number): WindowStatus {
  const length = w.windowMinutes * 60_000;
  if (w.resetsAt <= now) {
    // The reported window has ended. A new one starts with the next request; until the tool reports
    // on it, only its usage from the logs is known.
    const next = events.find((e) => e.timestamp > w.resetsAt);
    const start = next ? next.timestamp : w.resetsAt;
    const end = next ? start + length : w.resetsAt;
    if (next && end <= now) return { kind, startMs: end, endMs: end, rolling: false, tokens: 0, costUSD: 0, requests: 0, expired: true, reportedAt: snap.timestamp };
    return { kind, startMs: start, endMs: end, rolling: false, ...sumIn(events, start, now), expired: !next, reportedAt: snap.timestamp };
  }
  const start = w.resetsAt - length;
  const status: WindowStatus = {
    kind,
    startMs: start,
    endMs: w.resetsAt,
    rolling: false,
    ...sumIn(events, start, now),
    usedPercent: w.usedPercent,
    source: 'reported',
    reportedAt: snap.timestamp,
  };
  project(status, now);
  return status;
}

/** Start of the current week for a weekly reset on `day` (0 = Sunday) at `hour`, in `tz`. */
export function weekStart(now: number, day: number, hour: number, tz?: string): number {
  const zone = resolveTimezone(tz);
  for (let back = 0; back <= 7; back++) {
    const key = dateKey(now - back * 24 * HOUR, zone);
    const [y, m, d] = key.split('-').map(Number) as [number, number, number];
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== day) continue;
    const at = startOfDay(key, zone) + hour * HOUR;
    if (at <= now) return at;
  }
  return now - WEEK;
}

/** Current 5-hour and weekly limit status per tool. */
export function limitStatus(input: LimitStatusInput): ToolLimitStatus[] {
  const now = input.now ?? Date.now();
  const config = input.config ?? {};
  const byTool = new Map<ToolId, UsageEvent[]>();
  for (const e of input.events) {
    let list = byTool.get(e.tool);
    if (!list) byTool.set(e.tool, (list = []));
    list.push(e);
  }
  for (const list of byTool.values()) list.sort((a, b) => a.timestamp - b.timestamp);
  const snapsByTool = new Map<ToolId, LimitSnapshot[]>();
  for (const s of input.limits ?? []) {
    if (!Number.isFinite(s.timestamp) || s.timestamp > now) continue;
    let list = snapsByTool.get(s.tool);
    if (!list) snapsByTool.set(s.tool, (list = []));
    list.push(s);
  }
  for (const list of snapsByTool.values()) list.sort((a, b) => a.timestamp - b.timestamp);

  const recent = (t: ToolId) => {
    const list = byTool.get(t);
    return !!list?.length && now - list[list.length - 1]!.timestamp < 8 * 24 * HOUR;
  };
  const tools = input.tools ?? TOOL_IDS.filter((t) => recent(t) || snapsByTool.has(t) || config[t]);

  return tools.map((tool): ToolLimitStatus => {
    const events = byTool.get(tool) ?? [];
    const snaps = snapsByTool.get(tool) ?? [];
    const cfg = config[tool];
    const latest = snaps[snaps.length - 1];
    const account = snaps.filter((s) => s.accountKey || s.resets).at(-1);
    const resetEvents = detectUsageResets(snaps, now);
    const out: ToolLimitStatus = {
      tool,
      fiveHour: null,
      weekly: null,
      extra: [],
      resetEvents,
      ...(account?.resets ? { resets: account.resets, resetsReportedAt: account.timestamp } : {}),
      hits: (input.limitHits ?? []).filter((h) => h.tool === tool).sort((a, b) => b.timestamp - a.timestamp),
      ...(events.length ? { lastActivity: events[events.length - 1]!.timestamp } : {}),
      ...(cfg ? { config: cfg } : {}),
      ...(latest?.planType ? { planType: latest.planType } : {}),
    };

    // 5-hour window
    if (latest?.primary) {
      out.fiveHour = reportedWindow('five_hour', latest, latest.primary, events, now);
      out.fiveHourCapacity = estimateCapacity(events, snaps, 'primary', now);
    } else {
      const active = buildBlocks(events, { sessionLengthHours: 5, now, breakdown: false })
        .map((r) => r.meta as unknown as BlockMeta)
        .find((m) => m?.isActive);
      if (active) {
        const start = Date.parse(active.startTime);
        const status: WindowStatus = { kind: 'five_hour', startMs: start, endMs: start + FIVE_HOURS, rolling: false, ...sumIn(events, start, now) };
        if (cfg?.fiveHourTokens) {
          status.limitTokens = cfg.fiveHourTokens;
          status.usedPercent = (status.tokens / cfg.fiveHourTokens) * 100;
          status.source = 'configured';
          project(status, now);
        }
        out.fiveHour = status;
      }
    }

    // model-specific and other reported windows; usage counts the requests of that model
    for (const x of latest?.extra ?? []) {
      const model = x.key.replace(/^seven_day_|^five_hour_/, '').replace(/_/g, '-');
      const own = events.filter((e) => e.model.toLowerCase().includes(model));
      const kind = x.window.windowMinutes <= 300 ? 'five_hour' : 'weekly';
      out.extra.push({ ...reportedWindow(kind, latest!, x.window, own, now), label: x.label });
    }

    // weekly window
    if (latest?.secondary) {
      out.weekly = reportedWindow('weekly', latest, latest.secondary, events, now);
      out.weeklyCapacity = estimateCapacity(events, snaps, 'secondary', now);
    } else {
      const fixed = cfg?.weeklyResetDay !== undefined;
      const start = fixed ? weekStart(now, cfg!.weeklyResetDay!, cfg!.weeklyResetHour ?? 0, input.timezone) : now - WEEK;
      const status: WindowStatus = { kind: 'weekly', startMs: start, endMs: fixed ? start + WEEK : now, rolling: !fixed, ...sumIn(events, start, now) };
      if (cfg?.weeklyTokens) {
        status.limitTokens = cfg.weeklyTokens;
        status.usedPercent = (status.tokens / cfg.weeklyTokens) * 100;
        status.source = 'configured';
        project(status, now);
      }
      out.weekly = status;
    }
    return out;
  });
}

/** Reported 5-hour windows per tool, for anchoring billing blocks to the provider's real windows. */
export function reportedWindows(limits: LimitSnapshot[] | undefined): Map<ToolId, Array<{ start: number; end: number; peakPercent: number }>> {
  const out = new Map<ToolId, Map<number, { start: number; end: number; peakPercent: number }>>();
  const byTool = new Map<ToolId, LimitSnapshot[]>();
  for (const s of limits ?? []) {
    let l = byTool.get(s.tool);
    if (!l) byTool.set(s.tool, (l = []));
    l.push(s);
  }
  for (const [tool, snaps] of byTool) {
    const keys = windowKeys(snaps, 'primary');
    const m = new Map<number, { start: number; end: number; peakPercent: number }>();
    out.set(tool, m);
    for (const s of snaps) {
      const w = s.primary;
      if (!w) continue;
      const key = keys.get(w.resetsAt) ?? w.resetsAt;
      const cur = m.get(key);
      if (cur) cur.peakPercent = Math.max(cur.peakPercent, w.usedPercent);
      else m.set(key, { start: key - w.windowMinutes * 60_000, end: key, peakPercent: w.usedPercent });
    }
  }
  return new Map([...out].map(([t, m]) => [t, [...m.values()].sort((a, b) => a.start - b.start)]));
}
