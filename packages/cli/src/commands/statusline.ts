/**
 * `clausage statusline`: one line for Claude Code's `statusLine` setting (or any prompt / tmux bar).
 *
 *   5h 42% · 2h14m left · wk 61% · today $12.30 · session $3.10
 *
 * Claude Code pipes a JSON object on stdin (session_id, cwd, model …); when present, the line is for
 * Claude Code and includes the current session's cost. The computed figures are cached for
 * --cache seconds (default 30) so a status bar that refreshes often never re-parses the logs each time.
 * Pricing is never downloaded here (cache or embedded snapshot), so the line never waits on the network,
 * except the opt-in Claude limits check when it is turned on (at most once a minute, 3 s budget).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TOOL_IDS,
  appendClaudeUsage,
  dateKey,
  defaultPricingCacheDir,
  fetchClaudeUsage,
  limitStatus,
  loadClaudeUsageConfig,
  loadLimitConfig,
  type ToolId,
  type WindowStatus,
} from '@clausage/core';
import type { CliOptions } from '../args.js';
import { loadData, printJson } from '../context.js';
import { c, fmtDuration, fmtShort, fmtUSD, TOOL_SHORT } from '../format.js';

interface WindowFigure {
  percent?: number;
  tokens: number;
  endMs: number;
  rolling: boolean;
  projectedLimitAt?: number;
  /** epoch ms of the provider's report the percentage comes from */
  reportedAt?: number;
}

interface ToolFigure {
  tool: ToolId;
  fiveHour?: WindowFigure;
  weekly?: WindowFigure;
}

export interface StatuslineData {
  computedAt: number;
  todayCostUSD: number;
  todayTokens: number;
  sessionCostUSD?: number;
  tools: ToolFigure[];
}

interface ClaudeStatusInput {
  session_id?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
}

/** Read Claude Code's JSON from stdin, if something is piped in (never waits more than `ms`). */
async function readStdinJson(ms = 300): Promise<ClaudeStatusInput | null> {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    let buf = '';
    const done = (v: ClaudeStatusInput | null) => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.pause();
      resolve(v);
    };
    const parse = () => {
      try {
        const v = JSON.parse(buf) as unknown;
        return v && typeof v === 'object' ? (v as ClaudeStatusInput) : null;
      } catch {
        return null;
      }
    };
    const timer = setTimeout(() => done(buf.trim() ? parse() : null), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
      if (buf.length > 1_000_000) done(null);
    });
    process.stdin.on('end', () => done(buf.trim() ? parse() : null));
    process.stdin.on('error', () => done(null));
  });
}

function cacheFile(): string {
  return join(defaultPricingCacheDir(), 'statusline.json');
}

type CacheShape = Record<string, StatuslineData>;

function readCache(): CacheShape {
  try {
    const v = JSON.parse(readFileSync(cacheFile(), 'utf8')) as unknown;
    return v && typeof v === 'object' ? (v as CacheShape) : {};
  } catch {
    return {};
  }
}

function writeCache(cache: CacheShape, now: number): void {
  // keep the last hour of keys only (one per session that asked)
  const kept: CacheShape = {};
  for (const [k, v] of Object.entries(cache)) if (now - v.computedAt < 3_600_000) kept[k] = v;
  try {
    const file = cacheFile();
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(kept), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* a read-only cache dir only costs speed */
  }
}

function figure(w: WindowStatus | null): WindowFigure | undefined {
  if (!w || w.expired) return undefined;
  return {
    ...(w.usedPercent !== undefined ? { percent: w.usedPercent } : {}),
    tokens: w.tokens,
    endMs: w.endMs,
    rolling: w.rolling,
    ...(w.projectedLimitAt !== undefined ? { projectedLimitAt: w.projectedLimitAt } : {}),
    ...(w.source === 'reported' && w.reportedAt ? { reportedAt: w.reportedAt } : {}),
  };
}

/** Refresh the opt-in Claude limits (once a minute at most), never longer than `budgetMs`. */
async function refreshClaudeLimits(budgetMs = 3000): Promise<void> {
  if (!loadClaudeUsageConfig().enabled) return;
  const result = await Promise.race([
    fetchClaudeUsage().catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), budgetMs).unref()),
  ]);
  if (result?.ok) appendClaudeUsage(result.snapshot);
}

/** Tools with a known limit %; only when none has one, tools with an active 5-hour window (as tokens). */
function pickTools(all: ToolFigure[]): ToolFigure[] {
  const withPercent = all.filter((t) => t.fiveHour?.percent !== undefined || t.weekly?.percent !== undefined);
  return withPercent.length ? withPercent : all.filter((t) => t.fiveHour);
}

export async function computeStatusline(opts: CliOptions, tools: ToolId[] | undefined, sessionId: string | undefined, now: number): Promise<StatuslineData> {
  if (!tools || tools.includes('claude-code')) await refreshClaudeLimits();
  // 8 days covers today, the 5-hour window and any weekly window
  const data = await loadData({ ...opts, tools, offline: true, mode: opts.mode }, { since: now - 8 * 86_400_000, until: undefined, ignoreRange: true });
  const tz = opts.timezone;
  const today = dateKey(now, tz);
  let todayCostUSD = 0;
  let todayTokens = 0;
  let sessionCostUSD: number | undefined;
  for (const e of data.events) {
    if (dateKey(e.timestamp, tz) === today) {
      todayCostUSD += e.costUSD || 0;
      todayTokens += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
    }
    if (sessionId && (e.rootSessionId === sessionId || e.sessionId === sessionId)) sessionCostUSD = (sessionCostUSD ?? 0) + (e.costUSD || 0);
  }
  const status = limitStatus({ events: data.events, limits: data.limits, limitHits: data.limitHits, config: loadLimitConfig(), now, timezone: tz, ...(tools ? { tools } : {}) });
  return {
    computedAt: now,
    todayCostUSD,
    todayTokens,
    ...(sessionId ? { sessionCostUSD: sessionCostUSD ?? 0 } : {}),
    tools: pickTools(status.map((s) => ({ tool: s.tool, fiveHour: figure(s.fiveHour), weekly: figure(s.weekly) }))),
  };
}

function pctColor(p: number): (s: string) => string {
  return p >= 90 ? c.red : p >= 70 ? c.yellow : c.green;
}

function pct(w: WindowFigure, now: number): string {
  const s = `${Math.round(w.percent!)}%`;
  const stale = w.reportedAt !== undefined && now - w.reportedAt > 30 * 60_000;
  return stale ? c.dim(s + '~') : pctColor(w.percent!)(s);
}

function clock(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));
}

export function renderStatusline(d: StatuslineData, now: number, tz: string, showToolNames: boolean): string {
  const parts: string[] = [];
  for (const t of d.tools) {
    const seg: string[] = [];
    const prefix = showToolNames ? `${TOOL_SHORT[t.tool] ?? t.tool} ` : '';
    const f = t.fiveHour;
    if (f && f.endMs > now) {
      const amount = f.percent !== undefined ? pct(f, now) : `${fmtShort(f.tokens)} tok`;
      seg.push(`${prefix}5h ${amount} ${c.dim(`${fmtDuration(f.endMs - now)} left`)}`);
      if (f.projectedLimitAt && f.projectedLimitAt < f.endMs) seg.push(c.red(`⚠ limit ~${clock(f.projectedLimitAt, tz)}`));
    }
    const w = t.weekly;
    if (w?.percent !== undefined) {
      seg.push(`${seg.length ? '' : prefix}wk ${pct(w, now)}`);
      if (w.projectedLimitAt && !w.rolling && w.projectedLimitAt < w.endMs && !seg.some((s) => s.includes('⚠')))
        seg.push(c.yellow(`⚠ wk limit in ${fmtDuration(w.projectedLimitAt - now)}`));
    }
    if (seg.length) parts.push(seg.join(' · '));
  }
  parts.push(`today ${c.bold(fmtUSD(d.todayCostUSD))}`);
  if (d.sessionCostUSD !== undefined) parts.push(`session ${fmtUSD(d.sessionCostUSD)}`);
  return parts.join(c.dim(' · '));
}

export async function runStatusline(opts: CliOptions): Promise<number> {
  const now = Date.now();
  const input = await readStdinJson();
  const sessionId = typeof input?.session_id === 'string' ? input.session_id : undefined;
  // Piped from Claude Code: show Claude's own limits unless -t says otherwise.
  const tools = opts.tools ?? (input ? (['claude-code'] as ToolId[]) : undefined);
  const ttl = opts.cacheSeconds * 1000;
  const key = JSON.stringify([tools ?? TOOL_IDS, sessionId ?? '', opts.local, opts.mode, opts.timezone, opts.project ?? '']);
  const cache = ttl > 0 ? readCache() : {};
  let data = cache[key];
  if (!data || now - data.computedAt > ttl || data.computedAt > now) {
    data = await computeStatusline(opts, tools, sessionId, now);
    if (ttl > 0) writeCache({ ...readCache(), [key]: data }, now);
  }
  if (opts.json) {
    printJson(data);
    return 0;
  }
  const showToolNames = data.tools.length > 1 || !tools || tools.length !== 1;
  process.stdout.write(renderStatusline(data, now, opts.timezone, showToolNames) + '\n');
  return 0;
}
