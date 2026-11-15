/**
 * `clausage mcp`: a Model Context Protocol server over stdio, so any agent can ask about usage,
 * limits and spend without the dashboard running. Hand-rolled JSON-RPC 2.0 (newline-delimited
 * messages, per the MCP stdio transport) to keep the CLI free of runtime dependencies.
 *
 * Claude Code:  claude mcp add clausage -- clausage mcp
 * Codex:        [mcp_servers.clausage] command = "clausage", args = ["mcp"]
 *
 * Read-only: every tool only reads local logs (and the cached price list unless --offline is off
 * and the cache is stale). stdout carries protocol messages only; diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';
import {
  TOOL_IDS,
  buildReport,
  cacheEfficiency,
  dailySeries,
  dailySpikes,
  dateKey,
  endOfDay,
  forecastMonth,
  limitStatus,
  loadLimitConfig,
  loadSyncConfig,
  loadUsage,
  monthKey,
  resolveTimezone,
  sessionSpikes,
  startOfDay,
  sumTotals,
  weekKey,
  weekKeyFromDate,
  type CostMode,
  type ParseResult,
  type ReportKind,
  type ToolId,
  type UsageRow,
} from '@clausage/core';
import { parseTool, type CliOptions } from '../args.js';

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PARSE_TTL_MS = 30_000;
const REPORT_KINDS: ReportKind[] = ['daily', 'weekly', 'monthly', 'session', 'blocks', 'models', 'projects', 'tools'];

type Json = Record<string, unknown>;

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  run: (args: Json, ctx: Ctx) => Promise<unknown>;
}

interface Ctx {
  opts: CliOptions;
  parseCache: Map<ToolId, Promise<ParseResult>>;
}

class InvalidParams extends Error {}

const filterProps: Json = {
  since: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive, report timezone)' },
  until: { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
  tools: { type: 'array', items: { type: 'string' }, description: `Only these tools: ${TOOL_IDS.join(', ')} (aliases like claude, cc, oc work)` },
  project: { type: 'string', description: 'Only projects whose path contains this text' },
  timezone: { type: 'string', description: 'IANA zone, UTC or local (default: the server’s --timezone)' },
  mode: { type: 'string', enum: ['auto', 'calculate', 'display'], description: 'Cost mode (default auto)' },
};

function str(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new InvalidParams(`${name} must be a string`);
  return v;
}

function date(v: unknown, name: string): string | undefined {
  const s = str(v, name);
  if (s === undefined) return undefined;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s.trim());
  if (!m) throw new InvalidParams(`${name} must be YYYY-MM-DD`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function toolsArg(v: unknown): ToolId[] | undefined {
  if (v === undefined || v === null) return undefined;
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!list) throw new InvalidParams('tools must be an array of tool names');
  try {
    const out = [...new Set(list.map((x) => parseTool(String(x))))];
    return out.length ? out : undefined;
  } catch (e) {
    throw new InvalidParams((e as Error).message);
  }
}

function limitArg(v: unknown, def: number): number {
  if (v === undefined || v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new InvalidParams('limit must be an integer 1-1000');
  return n;
}

async function load(ctx: Ctx, args: Json, range?: { since?: number; until?: number }) {
  const tzArg = str(args.timezone, 'timezone');
  let tz = ctx.opts.timezone;
  try {
    if (tzArg) tz = resolveTimezone(tzArg);
  } catch (e) {
    throw new InvalidParams((e as Error).message);
  }
  const modeArg = str(args.mode, 'mode');
  if (modeArg && !['auto', 'calculate', 'display'].includes(modeArg)) throw new InvalidParams('mode must be auto, calculate or display');
  const sinceDate = date(args.since, 'since');
  const untilDate = date(args.until, 'until');
  const data = await loadUsage({
    tools: toolsArg(args.tools) ?? ctx.opts.tools,
    paths: ctx.opts.paths,
    since: range?.since ?? (sinceDate ? startOfDay(sinceDate, tz) : ctx.opts.since),
    until: range?.until ?? (untilDate ? endOfDay(untilDate, tz) : ctx.opts.until),
    offline: ctx.opts.offline,
    mode: (modeArg as CostMode | undefined) ?? ctx.opts.mode,
    includeSubagents: ctx.opts.subagents,
    project: str(args.project, 'project') ?? ctx.opts.project,
    timezone: tz,
    parseCache: ctx.parseCache,
    ...(ctx.opts.local ? {} : { sync: loadSyncConfig() }),
  });
  return { data, tz };
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

function slimRow(r: UsageRow, breakdown: boolean) {
  const { breakdown: b, ...rest } = r;
  return {
    ...rest,
    costUSD: round(r.costUSD),
    ...(breakdown ? { breakdown: b.map((x) => ({ ...x, costUSD: round(x.costUSD) })) } : {}),
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'get_usage_report',
    title: 'Usage report',
    description:
      'Token usage and cost grouped by day, week, month, session, 5-hour billing block, model, project or tool, across local agentic coding tools. Returns rows (newest first) and totals.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: REPORT_KINDS, description: 'How to group usage' },
        ...filterProps,
        breakdown: { type: 'boolean', description: 'Include per-model sub-rows (default false)' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max rows (default 50)' },
      },
      required: ['kind'],
    },
    async run(args, ctx) {
      const kind = str(args.kind, 'kind') as ReportKind | undefined;
      if (!kind || !REPORT_KINDS.includes(kind)) throw new InvalidParams(`kind must be one of ${REPORT_KINDS.join(', ')}`);
      const { data, tz } = await load(ctx, args);
      const report = buildReport(kind, data.events, data.sessions, { timezone: tz, order: 'desc', breakdown: true, historical: data.historical, startOfWeek: ctx.opts.startOfWeek });
      const limit = limitArg(args.limit, 50);
      return {
        kind,
        timezone: report.timezone,
        totals: { ...report.totals, costUSD: round(report.totals.costUSD) },
        rowCount: report.rows.length,
        rows: report.rows.slice(0, limit).map((r) => slimRow(r, args.breakdown === true)),
        ...(report.rows.length > limit ? { truncated: true } : {}),
        warnings: [...new Set(data.warnings)].slice(0, 10),
      };
    },
  },
  {
    name: 'get_limits',
    title: 'Usage limits',
    description:
      'Current 5-hour and weekly usage-limit windows per tool: % used, reset time, pace projection and recent limit hits. Use before starting a large task to check remaining headroom.',
    inputSchema: { type: 'object', properties: { tools: filterProps.tools, timezone: filterProps.timezone } },
    async run(args, ctx) {
      const now = Date.now();
      const { data, tz } = await load(ctx, args, { since: now - 35 * 86_400_000, until: undefined });
      const status = limitStatus({ events: data.events, limits: data.limits, limitHits: data.limitHits, config: loadLimitConfig(), now, timezone: tz, ...(toolsArg(args.tools) ? { tools: toolsArg(args.tools) } : {}) });
      const win = (w: (typeof status)[number]['fiveHour']) =>
        w && {
          usedPercent: w.usedPercent === undefined ? null : round(w.usedPercent, 1),
          source: w.source ?? null,
          resetsAt: w.rolling ? null : new Date(w.endMs).toISOString(),
          minutesLeft: w.rolling ? null : Math.max(0, Math.round((w.endMs - now) / 60_000)),
          tokens: w.tokens,
          costUSD: round(w.costUSD),
          projectedPercentAtReset: w.projectedPercent === undefined ? null : round(w.projectedPercent, 1),
          projectedLimitAt: w.projectedLimitAt ? new Date(w.projectedLimitAt).toISOString() : null,
          rolling: w.rolling,
          ...(w.expired ? { expired: true } : {}),
        };
      return {
        now: new Date(now).toISOString(),
        tools: status.map((s) => ({
          tool: s.tool,
          plan: s.planType ?? null,
          fiveHour: win(s.fiveHour),
          weekly: win(s.weekly),
          extra: s.extra.map((x) => ({ label: x.label, ...win(x) })),
          recentLimitHits: s.hits.slice(0, 5).map((h) => ({ at: new Date(h.timestamp).toISOString(), kind: h.kind ?? null })),
          savedResetsAvailable: s.resets?.availableCount ?? null,
        })),
      };
    },
  },
  {
    name: 'get_spend_summary',
    title: 'Spend summary and forecast',
    description: 'Spend and tokens today, this week and this month, per tool, plus a month-end forecast from the recent daily rate.',
    inputSchema: { type: 'object', properties: { tools: filterProps.tools, project: filterProps.project, timezone: filterProps.timezone, mode: filterProps.mode } },
    async run(args, ctx) {
      const now = Date.now();
      const { data, tz } = await load(ctx, args, { since: now - 62 * 86_400_000, until: undefined });
      const today = dateKey(now, tz);
      const week = weekKey(now, tz, ctx.opts.startOfWeek);
      const month = monthKey(now, tz);
      const ev = data.events;
      const pick = (f: (ts: number) => boolean, hf: (d: string) => boolean) => {
        const t = sumTotals([...ev.filter((e) => f(e.timestamp)), ...data.historical.filter((h) => hf(h.date))]);
        return { costUSD: round(t.costUSD), totalTokens: t.totalTokens, requests: t.events };
      };
      const perTool = TOOL_IDS.map((tool) => {
        const t = sumTotals(ev.filter((e) => e.tool === tool && monthKey(e.timestamp, tz) === month));
        return { tool, monthCostUSD: round(t.costUSD), monthTokens: t.totalTokens };
      }).filter((t) => t.monthTokens > 0);
      const f = forecastMonth(ev, data.historical, { timezone: tz, now });
      return {
        timezone: tz,
        today: pick((ts) => dateKey(ts, tz) === today, (d) => d === today),
        thisWeek: pick((ts) => weekKey(ts, tz, ctx.opts.startOfWeek) === week, (d) => weekKeyFromDate(d, ctx.opts.startOfWeek) === week),
        thisMonth: pick((ts) => monthKey(ts, tz) === month, (d) => d.startsWith(month)),
        perToolThisMonth: perTool,
        forecast: { ...f, toDateUSD: round(f.toDateUSD, 2), projectedUSD: round(f.projectedUSD, 2), lowUSD: round(f.lowUSD, 2), highUSD: round(f.highUSD, 2), dailyRateUSD: round(f.dailyRateUSD, 2) },
      };
    },
  },
  {
    name: 'get_cache_efficiency',
    title: 'Prompt cache efficiency',
    description: 'Cache hit rate (cache reads ÷ prompt tokens) and the money prompt caching saved versus uncached input, grouped by model, tool, day or session.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', enum: ['total', 'model', 'tool', 'day', 'session'], description: 'Grouping (default model)' },
        ...filterProps,
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max rows (default 25)' },
      },
    },
    async run(args, ctx) {
      const group = (str(args.group, 'group') ?? 'model') as 'total' | 'model' | 'tool' | 'day' | 'session';
      if (!['total', 'model', 'tool', 'day', 'session'].includes(group)) throw new InvalidParams('group must be total, model, tool, day or session');
      const { data, tz } = await load(ctx, args);
      const rows = cacheEfficiency(data.events, data.pricing, group, { timezone: tz });
      const total = cacheEfficiency(data.events, data.pricing, 'total')[0];
      const fmt = (r: (typeof rows)[number]) => ({ ...r, hitRate: round(r.hitRate), writeRate: round(r.writeRate), costUSD: round(r.costUSD), uncachedCostUSD: round(r.uncachedCostUSD), savedUSD: round(r.savedUSD) });
      return { group, total: total ? fmt(total) : null, rows: rows.slice(0, limitArg(args.limit, 25)).map(fmt) };
    },
  },
  {
    name: 'find_spikes',
    title: 'Unusual days and sessions',
    description: 'Days and sessions whose cost is far above your usual (robust median/MAD rule), e.g. to find runaway loops or retries.',
    inputSchema: { type: 'object', properties: { ...filterProps } },
    async run(args, ctx) {
      const hasRange = args.since !== undefined || args.until !== undefined || ctx.opts.since !== undefined || ctx.opts.until !== undefined;
      const now = Date.now();
      const { data, tz } = await load(ctx, args, hasRange ? undefined : { since: now - 90 * 86_400_000, until: undefined });
      const days = dailySpikes(dailySeries(data.events, data.historical, { timezone: tz }));
      const sessions = sessionSpikes(buildReport('session', data.events, data.sessions, { timezone: tz, breakdown: false }).rows);
      const fmt = (s: (typeof days)[number]) => ({ ...s, value: round(s.value, 2), baseline: round(s.baseline, 2), ratio: round(s.ratio, 1), score: round(s.score, 1) });
      return { timezone: tz, days: days.slice(0, 20).map(fmt), sessions: sessions.slice(0, 20).map(fmt) };
    },
  },
];

function send(msg: Json): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function version(): string {
  return process.env.npm_package_version || '0.1.0';
}

export async function handleMessage(msg: Json, ctx: Ctx): Promise<void> {
  const id = msg.id;
  const isRequest = id !== undefined && id !== null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  if (msg.jsonrpc !== '2.0' || !method) {
    if (isRequest) fail(id, -32600, 'Invalid request');
    return;
  }
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Json;
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'clausage', title: 'clausage usage tracker', version: version() },
        instructions:
          'Read-only usage data for local agentic coding tools (tokens, cost, limits). Call get_limits before long tasks to check headroom; costs are API-equivalent USD estimates, not bills.',
      });
    }
    case 'ping':
      return isRequest ? reply(id, {}) : undefined;
    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })),
      });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${String(params.name)}`);
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Json;
      try {
        const result = await tool.run(args, ctx);
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        if (!(e instanceof InvalidParams)) process.stderr.write(`clausage mcp: ${tool.name} failed: ${(e as Error).stack ?? message}\n`);
        return reply(id, { content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      if (method.startsWith('notifications/')) return;
      if (isRequest) fail(id, -32601, `Method not found: ${method}`);
  }
}

export async function runMcp(opts: CliOptions): Promise<number> {
  const ctx: Ctx = { opts, parseCache: new Map() };
  // Re-read changed logs at most every PARSE_TTL_MS; parsers re-parse only changed files anyway.
  const timer = setInterval(() => ctx.parseCache.clear(), PARSE_TTL_MS);
  timer.unref();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      fail(null, -32700, 'Parse error');
      continue;
    }
    const batch = Array.isArray(msg) ? msg : [msg];
    for (const m of batch) {
      if (!m || typeof m !== 'object') {
        fail(null, -32600, 'Invalid request');
        continue;
      }
      const p = handleMessage(m as Json, ctx).catch((e) => fail((m as Json).id, -32603, (e as Error).message));
      pending.add(p);
      void p.finally(() => pending.delete(p));
    }
  }
  await Promise.all(pending);
  clearInterval(timer);
  return 0;
}
