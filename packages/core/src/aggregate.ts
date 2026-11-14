import type {
  DailyAggregate,
  ModelBreakdown,
  Report,
  SessionInfo,
  TokenTotals,
  ToolId,
  UsageEvent,
  UsageRow,
} from './types.js';
import { computeActiveMs } from './parsers/util.js';

export type ReportKind = Report['kind'];

export type WeekDay = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

export const WEEK_DAYS: readonly WeekDay[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export interface BuildReportOptions {
  /** IANA zone, 'UTC' or 'local' (default local) */
  timezone?: string;
  /** default 'asc' for time-based reports; models/projects/tools are always sorted by cost desc */
  order?: 'asc' | 'desc';
  /** fill UsageRow.breakdown with per (tool, model) sub-totals (default true) */
  breakdown?: boolean;
  /** billing block length in hours for 'blocks' (default 5) */
  sessionLengthHours?: number;
  /** aggregates without event detail merged into daily/weekly/monthly/models/tools */
  historical?: DailyAggregate[];
  /** first day of week for 'weekly' (default monday) */
  startOfWeek?: WeekDay;
  /** clock used for active-block detection (default Date.now()) */
  now?: number;
}

const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Timezones and date keys

/** Resolve 'local' / undefined / '' to the system IANA zone; validates other names. */
// Constructing Intl.DateTimeFormat is expensive and this runs per event, so results are memoised.
const resolvedZones = new Map<string, string>();
export function resolveTimezone(tz?: string): string {
  const k = tz ?? '';
  const hit = resolvedZones.get(k);
  if (hit) return hit;
  let zone: string;
  if (!tz || tz.toLowerCase() === 'local') {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } else if (tz.toUpperCase() === 'UTC') {
    zone = 'UTC';
  } else {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      throw new RangeError(`Invalid timezone: ${tz}`);
    }
    zone = tz;
  }
  resolvedZones.set(k, zone);
  return zone;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

/** Wall-clock components of `ts` in zone `tz`. */
export function zonedParts(
  ts: number,
  tz?: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const zone = resolveTimezone(tz);
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of partsFormatter(zone).formatToParts(new Date(ts))) {
    if (p.type in out) (out as Record<string, number>)[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of `ts` in timezone `tz` (default local). */
export function dateKey(ts: number, tz?: string): string {
  const p = zonedParts(ts, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 'YYYY-MM' of `ts` in timezone `tz`. */
export function monthKey(ts: number, tz?: string): string {
  return dateKey(ts, tz).slice(0, 7);
}

/** Week-start 'YYYY-MM-DD' for a calendar date string. */
export function weekKeyFromDate(date: string, startOfWeek: WeekDay = 'monday'): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  const dow = new Date(utc).getUTCDay();
  const start = WEEK_DAYS.indexOf(startOfWeek);
  const diff = (dow - (start < 0 ? 1 : start) + 7) % 7;
  return new Date(utc - diff * DAY_MS).toISOString().slice(0, 10);
}

/** Week-start 'YYYY-MM-DD' of `ts` in timezone `tz`. */
export function weekKey(ts: number, tz?: string, startOfWeek: WeekDay = 'monday'): string {
  return weekKeyFromDate(dateKey(ts, tz), startOfWeek);
}

function tzOffsetMs(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * Epoch ms of the wall-clock time `date` (YYYY-MM-DD or YYYYMMDD) + h:m:s:ms in zone `tz`.
 * Handles DST transitions by re-evaluating the offset at the candidate instant.
 */
export function zonedTimeToEpoch(date: string, tz?: string, h = 0, mi = 0, s = 0, ms = 0): number {
  const zone = resolveTimezone(tz);
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(date.trim());
  if (!m) throw new RangeError(`Invalid date (expected YYYYMMDD or YYYY-MM-DD): ${date}`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi, s, ms);
  let t = guess - tzOffsetMs(guess, zone);
  const off2 = tzOffsetMs(t, zone);
  t = guess - off2;
  return t;
}

/** Start (inclusive) of the given calendar day in `tz`. */
export function startOfDay(date: string, tz?: string): number {
  const zone = resolveTimezone(tz);
  const t = zonedTimeToEpoch(date, zone, 0, 0, 0, 0);
  const want = date.trim().replace(/^(\d{4})-?(\d{2})-?(\d{2})$/, '$1-$2-$3');
  // Midnight can fall in a DST gap (e.g. America/Santiago, Asia/Beirut): the guess then lands
  // on the previous day. Binary-search the first instant whose local date is `date`.
  if (dateKey(t, zone) >= want) return t;
  let lo = t;
  let hi = t + 6 * HOUR_MS;
  if (dateKey(hi, zone) < want) return t;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateKey(mid, zone) >= want) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** End (inclusive, last ms) of the given calendar day in `tz`: one ms before the next day starts. */
export function endOfDay(date: string, tz?: string): number {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(date.trim());
  if (!m) throw new RangeError(`Invalid date (expected YYYYMMDD or YYYY-MM-DD): ${date}`);
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10);
  return startOfDay(next, tz) - 1;
}

// ---------------------------------------------------------------------------
// Totals

export function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    events: 0,
  };
}

function isEvent(x: UsageEvent | TokenTotals | DailyAggregate): x is UsageEvent {
  return 'id' in x && 'timestamp' in x;
}
function isAggregate(x: UsageEvent | TokenTotals | DailyAggregate): x is DailyAggregate {
  return 'date' in x && 'source' in x;
}

/** Add an event, a historical aggregate, or another totals object into `acc` (mutates). */
export function addTotals(acc: TokenTotals, x: UsageEvent | TokenTotals | DailyAggregate): TokenTotals {
  acc.inputTokens += x.inputTokens || 0;
  acc.outputTokens += x.outputTokens || 0;
  acc.cacheReadTokens += x.cacheReadTokens || 0;
  acc.cacheWriteTokens += x.cacheWriteTokens || 0;
  if (isAggregate(x)) {
    acc.costUSD += x.costUSD || 0;
    acc.events += x.messages || 0;
  } else {
    acc.reasoningTokens += x.reasoningTokens || 0;
    acc.costUSD += x.costUSD || 0;
    acc.events += isEvent(x) ? 1 : x.events || 0;
  }
  acc.totalTokens = acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheWriteTokens;
  return acc;
}

/** Sum events, historical aggregates and/or totals objects. */
export function sumTotals(items: Iterable<UsageEvent | TokenTotals | DailyAggregate>): TokenTotals {
  const acc = emptyTotals();
  for (const x of items) addTotals(acc, x);
  return acc;
}

// ---------------------------------------------------------------------------
// Row accumulation

interface Acc {
  key: string;
  label: string;
  totals: TokenTotals;
  tools: Set<ToolId>;
  models: Set<string>;
  breakdown: Map<string, ModelBreakdown>;
  events: UsageEvent[];
  historical: boolean;
  costUnknown: boolean;
  meta: Record<string, unknown>;
}

function newAcc(key: string, label = key): Acc {
  return {
    key,
    label,
    totals: emptyTotals(),
    tools: new Set(),
    models: new Set(),
    breakdown: new Map(),
    events: [],
    historical: false,
    costUnknown: false,
    meta: {},
  };
}

function accAdd(a: Acc, x: UsageEvent | DailyAggregate, keepEvents = false): void {
  addTotals(a.totals, x);
  a.tools.add(x.tool);
  if (x.model) a.models.add(x.model);
  const bk = `${x.tool}\u0000${x.model}`;
  let b = a.breakdown.get(bk);
  if (!b) {
    b = { ...emptyTotals(), model: x.model, tool: x.tool };
    a.breakdown.set(bk, b);
  }
  addTotals(b, x);
  if (x.costUnknown) a.costUnknown = true;
  if (isAggregate(x)) a.historical = true;
  else if (keepEvents) a.events.push(x);
}

function finish(a: Acc, breakdown: boolean): UsageRow {
  const meta: Record<string, unknown> = { ...a.meta };
  if (a.historical) meta.historical = true;
  if (a.costUnknown) meta.costUnknown = true;
  return {
    key: a.key,
    label: a.label,
    ...a.totals,
    tools: [...a.tools].sort(),
    models: [...a.models].sort(),
    breakdown: breakdown
      ? [...a.breakdown.values()].sort((x, y) => y.costUSD - x.costUSD || y.totalTokens - x.totalTokens)
      : [],
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}

function groupBy(
  events: UsageEvent[],
  historical: DailyAggregate[],
  keyOf: (e: UsageEvent) => string,
  histKeyOf: ((h: DailyAggregate) => string) | null,
  keepEvents = false,
): Map<string, Acc> {
  const m = new Map<string, Acc>();
  const get = (k: string) => {
    let a = m.get(k);
    if (!a) m.set(k, (a = newAcc(k)));
    return a;
  };
  for (const e of events) accAdd(get(keyOf(e)), e, keepEvents);
  if (histKeyOf) for (const h of historical) accAdd(get(histKeyOf(h)), h);
  return m;
}

const byKey = (order: 'asc' | 'desc') => (a: UsageRow, b: UsageRow) =>
  order === 'asc' ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.key < b.key ? 1 : a.key > b.key ? -1 : 0;

const byCost = (a: UsageRow, b: UsageRow) =>
  b.costUSD - a.costUSD || b.totalTokens - a.totalTokens || (a.key < b.key ? -1 : 1);

// ---------------------------------------------------------------------------
// Blocks

export interface BlockMeta {
  tool: ToolId;
  startTime: string;
  endTime: string;
  actualEndTime: string;
  isActive: boolean;
  /** ms since previous block of the same tool ended (actual end), when > session length */
  gapBeforeMs?: number;
  durationMinutes: number;
  burnRate: { tokensPerMinute: number; tokensPerMinuteIndicator: number; costPerHour: number } | null;
  projection: { totalTokens: number; totalCost: number; remainingMinutes: number } | null;
  sessions: number;
}

function floorToHourUTC(ts: number): number {
  return Math.floor(ts / HOUR_MS) * HOUR_MS;
}

/**
 * ccusage-style billing blocks per tool: a block starts at the first event floored to the
 * (UTC) hour and lasts `lengthHours`. An event more than `lengthHours` after the block start
 * or after the previous event starts a new block.
 */
export function buildBlocks(
  events: UsageEvent[],
  opts: { sessionLengthHours?: number; now?: number; breakdown?: boolean } = {},
): UsageRow[] {
  const L = (opts.sessionLengthHours ?? 5) * HOUR_MS;
  const now = opts.now ?? Date.now();
  const byTool = new Map<ToolId, UsageEvent[]>();
  for (const e of events) {
    let list = byTool.get(e.tool);
    if (!list) byTool.set(e.tool, (list = []));
    list.push(e);
  }
  const rows: UsageRow[] = [];
  for (const [tool, list] of byTool) {
    list.sort((a, b) => a.timestamp - b.timestamp);
    let cur: { start: number; acc: Acc; first: number; last: number; sessions: Set<string> } | null = null;
    let prevEnd: number | null = null;
    const flush = () => {
      if (!cur) return;
      const end = cur.start + L;
      const t = cur.acc.totals;
      const durMin = (cur.last - cur.first) / 60_000;
      const isActive = now - cur.last < L && now < end;
      const meta: BlockMeta = {
        tool,
        startTime: new Date(cur.start).toISOString(),
        endTime: new Date(end).toISOString(),
        actualEndTime: new Date(cur.last).toISOString(),
        isActive,
        durationMinutes: Math.round(durMin * 100) / 100,
        burnRate: null,
        projection: null,
        sessions: cur.sessions.size,
      };
      if (prevEnd !== null && cur.first - prevEnd > L) meta.gapBeforeMs = cur.first - prevEnd;
      if (durMin > 0) {
        meta.burnRate = {
          tokensPerMinute: t.totalTokens / durMin,
          tokensPerMinuteIndicator: (t.inputTokens + t.outputTokens) / durMin,
          costPerHour: (t.costUSD / durMin) * 60,
        };
      }
      if (isActive) {
        const remainingMinutes = Math.max(0, (end - now) / 60_000);
        const rate = meta.burnRate;
        meta.projection = {
          totalTokens: Math.round(t.totalTokens + (rate ? rate.tokensPerMinute * remainingMinutes : 0)),
          totalCost: t.costUSD + (rate ? (rate.costPerHour / 60) * remainingMinutes : 0),
          remainingMinutes: Math.round(remainingMinutes),
        };
      }
      cur.acc.meta = meta as unknown as Record<string, unknown>;
      rows.push(finish(cur.acc, opts.breakdown !== false));
      prevEnd = cur.last;
      cur = null;
    };
    for (const e of list) {
      if (cur && (e.timestamp - cur.start > L || e.timestamp - cur.last > L)) flush();
      if (!cur) {
        const start = floorToHourUTC(e.timestamp);
        const iso = new Date(start).toISOString();
        cur = { start, acc: newAcc(`${tool}:${iso}`, iso), first: e.timestamp, last: e.timestamp, sessions: new Set() };
      }
      accAdd(cur.acc, e);
      cur.last = e.timestamp;
      cur.sessions.add(e.rootSessionId || e.sessionId);
    }
    flush();
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Sessions

export interface SessionMeta {
  tool: ToolId;
  sessionId: string;
  project: string;
  title?: string;
  startedAt: number;
  endedAt: number;
  activeMs: number;
  toolCalls: number;
  userMessages: number;
  assistantMessages: number;
  turns: number;
  subagents: number;
  version?: string;
}

function buildSessions(events: UsageEvent[], sessions: SessionInfo[], breakdown: boolean): UsageRow[] {
  const groups = new Map<string, { acc: Acc; tool: ToolId; root: string; infos: SessionInfo[]; ts: number[]; project: string }>();
  const get = (tool: ToolId, root: string) => {
    const k = `${tool}:${root}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { acc: newAcc(k, root), tool, root, infos: [], ts: [], project: '' }));
    return g;
  };
  for (const e of events) {
    const g = get(e.tool, e.rootSessionId || e.sessionId);
    accAdd(g.acc, e);
    g.ts.push(e.timestamp);
    if (!g.project && e.project) g.project = e.project;
  }
  for (const s of sessions) get(s.tool, s.rootSessionId || s.sessionId).infos.push(s);

  const rows: UsageRow[] = [];
  for (const g of groups.values()) {
    const rootInfo = g.infos.find((s) => s.sessionId === g.root && !s.isSubagent) ?? g.infos.find((s) => s.sessionId === g.root);
    const subs = new Set<string>();
    for (const s of g.infos) if (s.isSubagent && s.sessionId !== g.root) subs.add(s.sessionId);
    let startedAt = Infinity;
    let endedAt = -Infinity;
    let toolCalls = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let turns = 0;
    for (const s of g.infos) {
      if (Number.isFinite(s.startedAt)) startedAt = Math.min(startedAt, s.startedAt);
      if (Number.isFinite(s.endedAt)) endedAt = Math.max(endedAt, s.endedAt);
      toolCalls += s.toolCalls || 0;
      userMessages += s.userMessages || 0;
      assistantMessages += s.assistantMessages || 0;
      turns += s.turns || 0;
    }
    for (const t of g.ts) {
      startedAt = Math.min(startedAt, t);
      endedAt = Math.max(endedAt, t);
    }
    if (!Number.isFinite(startedAt)) startedAt = 0;
    if (!Number.isFinite(endedAt)) endedAt = startedAt;
    const project = rootInfo?.project || g.infos.find((s) => s.project)?.project || g.project;
    // Wall-clock active time of the whole tree: the root's own figure, or the idle-gap
    // estimate over every request in the group (main + subagents), whichever is larger.
    // Subagents usually run while the root is waiting, so summing them would double count.
    const activeMs = Math.max(
      rootInfo ? rootInfo.activeMs || 0 : 0,
      computeActiveMs(g.ts),
      ...(rootInfo ? [] : g.infos.map((s) => s.activeMs || 0)),
      0,
    );
    const title = rootInfo?.title ?? g.infos.find((s) => s.title)?.title;
    const version = rootInfo?.version;
    const meta: SessionMeta = {
      tool: g.tool,
      sessionId: g.root,
      project,
      ...(title ? { title } : {}),
      startedAt,
      endedAt,
      activeMs,
      toolCalls,
      userMessages,
      assistantMessages,
      turns,
      subagents: subs.size,
      ...(version ? { version } : {}),
    };
    g.acc.tools.add(g.tool);
    for (const s of g.infos) for (const m of s.models || []) if (m) g.acc.models.add(m);
    g.acc.meta = meta as unknown as Record<string, unknown>;
    rows.push(finish(g.acc, breakdown));
  }
  return rows;
}

// ---------------------------------------------------------------------------

/** Build a report of the given kind from (already filtered and costed) events. */
export function buildReport(
  kind: ReportKind,
  events: UsageEvent[],
  sessions: SessionInfo[] = [],
  opts: BuildReportOptions = {},
): Report {
  const tz = resolveTimezone(opts.timezone);
  const order = opts.order ?? 'asc';
  const breakdown = opts.breakdown !== false;
  const historical = opts.historical ?? [];
  const sow = opts.startOfWeek ?? 'monday';
  let rows: UsageRow[];
  let includeHistoricalInTotals = false;

  switch (kind) {
    case 'daily': {
      // historical dates are UTC days as stored by the source; they cannot be re-bucketed.
      rows = [...groupBy(events, historical, (e) => dateKey(e.timestamp, tz), (h) => h.date).values()].map((a) =>
        finish(a, breakdown),
      );
      rows.sort(byKey(order));
      includeHistoricalInTotals = true;
      break;
    }
    case 'weekly': {
      rows = [
        ...groupBy(
          events,
          historical,
          (e) => weekKey(e.timestamp, tz, sow),
          (h) => weekKeyFromDate(h.date, sow),
        ).values(),
      ].map((a) => finish(a, breakdown));
      rows.sort(byKey(order));
      includeHistoricalInTotals = true;
      break;
    }
    case 'monthly': {
      rows = [...groupBy(events, historical, (e) => monthKey(e.timestamp, tz), (h) => h.date.slice(0, 7)).values()].map(
        (a) => finish(a, breakdown),
      );
      rows.sort(byKey(order));
      includeHistoricalInTotals = true;
      break;
    }
    case 'models': {
      rows = [...groupBy(events, historical, (e) => e.model || '(unknown)', (h) => h.model || '(unknown)').values()].map(
        (a) => finish(a, breakdown),
      );
      rows.sort(byCost);
      includeHistoricalInTotals = true;
      break;
    }
    case 'tools': {
      rows = [...groupBy(events, historical, (e) => e.tool, (h) => h.tool).values()].map((a) => finish(a, breakdown));
      rows.sort(byCost);
      includeHistoricalInTotals = true;
      break;
    }
    case 'projects': {
      const m = groupBy(events, [], (e) => e.project || '', null);
      // count sessions per project
      const sess = new Map<string, Set<string>>();
      for (const e of events) {
        const k = e.project || '';
        let s = sess.get(k);
        if (!s) sess.set(k, (s = new Set()));
        s.add(`${e.tool}:${e.rootSessionId || e.sessionId}`);
      }
      rows = [...m.values()].map((a) => {
        a.label = a.key || '(unknown)';
        a.meta = { sessions: sess.get(a.key)?.size ?? 0 };
        return finish(a, breakdown);
      });
      rows.sort(byCost);
      break;
    }
    case 'session': {
      rows = buildSessions(events, sessions, breakdown);
      rows.sort((a, b) => {
        const ea = Number((a.meta as unknown as SessionMeta).endedAt) || 0;
        const eb = Number((b.meta as unknown as SessionMeta).endedAt) || 0;
        return order === 'asc' ? ea - eb : eb - ea;
      });
      break;
    }
    case 'blocks': {
      rows = buildBlocks(events, { sessionLengthHours: opts.sessionLengthHours, now: opts.now, breakdown });
      rows.sort((a, b) => {
        const sa = Date.parse(String(a.meta?.startTime));
        const sb = Date.parse(String(b.meta?.startTime));
        return order === 'asc' ? sa - sb : sb - sa;
      });
      break;
    }
    default: {
      const never: never = kind;
      throw new Error(`Unknown report kind: ${String(never)}`);
    }
  }

  const totals = sumTotals(includeHistoricalInTotals ? [...events, ...historical] : events);
  return {
    kind,
    rows,
    totals,
    generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    timezone: tz,
    warnings: [],
  };
}
