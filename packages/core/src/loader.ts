import type {
  CostMode,
  DailyAggregate,
  LoadOptions,
  ParseResult,
  SessionInfo,
  ToolId,
  ToolParser,
  UsageEvent,
} from './types.js';
import { TOOL_IDS } from './types.js';
import { dateKey } from './aggregate.js';
import { claudeCodeParser } from './parsers/claude-code.js';
import { codexParser } from './parsers/codex.js';
import { grokParser } from './parsers/grok.js';
import { opencodeParser } from './parsers/opencode.js';
import { applyCosts, costForAggregate, loadPricing, type PricingTable } from './pricing.js';

export const PARSERS: Record<ToolId, ToolParser> = {
  'claude-code': claudeCodeParser,
  codex: codexParser,
  grok: grokParser,
  opencode: opencodeParser,
};

export interface LoadUsageOptions extends LoadOptions {
  tools?: ToolId[];
  offline?: boolean;
  /** re-download the pricing table even when the cache is fresh */
  refreshPricing?: boolean;
  /** pricing cache directory override */
  pricingCacheDir?: string;
  mode?: CostMode;
  /** include subagent / sidechain events and sessions (default true) */
  includeSubagents?: boolean;
  /** case-insensitive substring filter on the project path */
  project?: string;
  /** keep historical aggregates for (tool, UTC day) pairs that also have event data (default false) */
  keepOverlappingHistorical?: boolean;
  /** IANA timezone of the report; used to match historical (calendar-date) rows to since/until */
  timezone?: string;
  /**
   * Reuse raw parser output across calls (long-running hosts such as the web dashboard). Entries are
   * unfiltered parses keyed by tool; the caller owns invalidation. Returned events/sessions are copies,
   * so cost modes and filters never leak between calls.
   */
  parseCache?: Map<ToolId, Promise<ParseResult>>;
}

export interface LoadUsageResult {
  events: UsageEvent[];
  sessions: SessionInfo[];
  historical: DailyAggregate[];
  pricing: PricingTable;
  sources: Record<ToolId, string[]>;
  warnings: string[];
}


function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Run the selected parsers in parallel, merge and dedupe their output, filter by date /
 * project / subagent flags, and apply costs (to events and historical aggregates).
 */
export async function loadUsage(opts: LoadUsageOptions = {}): Promise<LoadUsageResult> {
  const warnings: string[] = [];
  const warn = (m: string) => {
    warnings.push(m);
    opts.warn?.(m);
  };
  const tools = (opts.tools && opts.tools.length ? opts.tools : [...TOOL_IDS]).filter((t, i, a) => a.indexOf(t) === i);
  const parserOpts: LoadOptions = { paths: opts.paths, since: opts.since, until: opts.until, warn };

  const pricingPromise = loadPricing({
    offline: opts.offline,
    refresh: opts.refreshPricing,
    warn,
    ...(opts.pricingCacheDir ? { cacheDir: opts.pricingCacheDir } : {}),
  });
  const cache = opts.parseCache;
  const parse = (t: ToolId): Promise<ParseResult> => {
    if (!cache) return PARSERS[t].load(parserOpts);
    let p = cache.get(t);
    if (!p) {
      const parseWarnings: string[] = [];
      const fresh = PARSERS[t].load({ paths: opts.paths, warn: (m) => parseWarnings.push(m) });
      p = fresh.then((r) => Object.assign(r, { parseWarnings }));
      cache.set(t, p);
      p.catch(() => {
        if (cache.get(t) === p) cache.delete(t);
      });
    }
    return p.then((r) => {
      (r as ParseResult & { parseWarnings?: string[] }).parseWarnings?.forEach(warn);
      return {
        ...r,
        events: r.events.map((e) => ({ ...e })),
        sessions: r.sessions.map((s) => ({ ...s })),
      };
    });
  };
  const settled = await Promise.allSettled(tools.map(parse));

  const sources = Object.fromEntries(TOOL_IDS.map((t) => [t, [] as string[]])) as Record<ToolId, string[]>;
  const results: ParseResult[] = [];
  settled.forEach((r, i) => {
    const tool = tools[i]!;
    if (r.status === 'fulfilled') {
      results.push(r.value);
      sources[tool] = r.value.sources ?? [];
    } else {
      warn(`${tool}: failed to load usage data: ${(r.reason as Error)?.message ?? String(r.reason)}`);
    }
  });

  const since = opts.since;
  const until = opts.until;
  const inRange = (ts: number) => (since === undefined || ts >= since) && (until === undefined || ts <= until);
  const includeSub = opts.includeSubagents !== false;
  const projectNeedle = opts.project?.toLowerCase();
  const projectOk = (p: string) => !projectNeedle || (p || '').toLowerCase().includes(projectNeedle);

  // Attribute every event to its root session's project, so a session whose cwd
  // wandered into sub-directories (or whose subagents ran elsewhere) stays one project.
  const rootProject = new Map<string, string>();
  for (const r of results) {
    for (const s of r.sessions) {
      if (!s.project) continue;
      const k = `${s.tool}:${s.sessionId}`;
      if (!s.isSubagent || !rootProject.has(k)) rootProject.set(k, s.project);
    }
  }
  for (const r of results) {
    for (const e of r.events) {
      const p = rootProject.get(`${e.tool}:${e.rootSessionId || e.sessionId}`);
      if (p) e.project = p;
    }
    for (const s of r.sessions) {
      if (!s.isSubagent || !s.rootSessionId) continue;
      const p = rootProject.get(`${s.tool}:${s.rootSessionId}`);
      if (p) s.project = p;
    }
  }

  // events: dedupe by id (first wins)
  const seen = new Set<string>();
  const events: UsageEvent[] = [];
  for (const r of results) {
    for (const e of r.events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (!Number.isFinite(e.timestamp) || !inRange(e.timestamp)) continue;
      if (!includeSub && e.isSubagent) continue;
      if (!projectOk(e.project)) continue;
      events.push(e);
    }
  }
  events.sort((a, b) => a.timestamp - b.timestamp);

  // sessions: dedupe by tool + sessionId; keep sessions overlapping the range
  const seenSess = new Set<string>();
  const sessions: SessionInfo[] = [];
  for (const r of results) {
    for (const s of r.sessions) {
      const k = `${s.tool}:${s.sessionId}`;
      if (seenSess.has(k)) continue;
      seenSess.add(k);
      if (!includeSub && s.isSubagent) continue;
      if (!projectOk(s.project)) continue;
      if (since !== undefined && Number.isFinite(s.endedAt) && s.endedAt < since) continue;
      if (until !== undefined && Number.isFinite(s.startedAt) && s.startedAt > until) continue;
      sessions.push(s);
    }
  }

  // historical: UTC days; drop days already covered by events of the same tool
  const covered = new Set<string>();
  if (!opts.keepOverlappingHistorical) {
    for (const r of results) for (const e of r.events) covered.add(`${e.tool}:${utcDay(e.timestamp)}`);
  }
  const historical: DailyAggregate[] = [];
  const sinceDay = since !== undefined ? dateKey(since, opts.timezone) : undefined;
  const untilDay = until !== undefined ? dateKey(until, opts.timezone) : undefined;
  if (!projectNeedle) {
    for (const r of results) {
      for (const h of r.historical ?? []) {
        // A historical row is a calendar date (as stored by the source), and reports label it with that
        // date. Compare it as a date against the range's calendar dates in the report timezone, so
        // --since/--until D selects day D only, not a neighbouring day that merely overlaps the range
        // by the zone offset.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date)) continue;
        if (sinceDay !== undefined && h.date < sinceDay) continue;
        if (untilDay !== undefined && h.date > untilDay) continue;
        if (covered.has(`${h.tool}:${h.date}`)) continue;
        historical.push({ ...h });
      }
    }
  }
  historical.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const pricing = await pricingPromise;
  const mode = opts.mode ?? 'auto';
  applyCosts(events, pricing, mode, warn);
  // historical aggregates are sums over many requests: priced untiered via costForAggregate
  const unpriced = new Set<string>();
  for (const h of historical) {
    if (mode === 'display') {
      h.costUSD = 0;
      continue;
    }
    const { costUSD, pricing: p } = costForAggregate(h, pricing);
    h.costUSD = costUSD;
    if (!p) {
      h.costUnknown = true;
      const k = `${h.tool}|${h.model}`;
      if (!unpriced.has(k)) {
        unpriced.add(k);
        warn(`No price for model ${h.model} (${h.tool}, historical); cost counted as $0`);
      }
    }
  }

  return { events, sessions, historical, pricing, sources, warnings };
}
