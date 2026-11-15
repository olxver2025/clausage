/**
 * Hermes Agent (NousResearch/hermes-agent) usage parser. See docs/formats/hermes.md.
 *
 * Source: `$HERMES_HOME/state.db` (default `~/.hermes`, `%LOCALAPPDATA%\hermes` on Windows) plus any
 * named profile store `<home>/profiles/<name>/state.db`. SQLite, opened read-only via node:sqlite
 * (temp copy of db + wal when locked).
 *
 * Hermes stores no per-API-call usage. Usage is accumulated per session in two places:
 *  - `session_model_usage`: one row per (session, model, billing route, task) with summed tokens and
 *    cost; `task` is '' for the main loop or an auxiliary task name (vision, compression, ...).
 *  - `sessions`: denormalised counters. The gateway may overwrite them with absolute totals that
 *    have no per-model rows, so (like Hermes' own Insights) the per-field residual
 *    `max(0, sessions.x - sum(rows.x))` is emitted as one extra event on the session's model.
 * One event is emitted per usage row (plus the residual). Token fields are already disjoint:
 * input_tokens excludes cache reads/writes and output_tokens includes reasoning_tokens.
 *
 * PRIVACY: only named numeric / metadata columns are selected. `messages.content`, reasoning
 * columns, `sessions.system_prompt`, `system_prompts`, `display_name`, `origin_json`, user/chat ids
 * and every auth / config file in HERMES_HOME are never read. The only text kept is
 * `sessions.title`, model names, provider names, the cwd and the tool names in
 * `messages.tool_calls` (extracted by SQLite; the call arguments are never selected).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadOptions, ParseResult, SessionInfo, ToolParser, UsageEvent } from '../types.js';
import { getSqlite, openReadOnly, tableColumns, type SqliteDb } from './sqlite-util.js';
import {
  computeActiveMs,
  countToolCall,
  envPaths,
  homeDir,
  normalizePath,
  num,
  toEpochMs,
  toolCallName,
  toolCallsRecord,
  toolCallTotal,
} from './util.js';

const TOOL = 'hermes' as const;

type Row = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function ms(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const t = toEpochMs(v);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'] as const;
type TokenKey = (typeof TOKEN_KEYS)[number];
type Counts = Record<TokenKey, number> & { est: number; actual: number };

function zeroCounts(): Counts {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, est: 0, actual: 0 };
}

interface RawSession {
  id: string;
  parentId?: string;
  model?: string;
  provider?: string;
  title?: string;
  cwd?: string;
  startedAt: number;
  endedAt: number;
  toolCalls: number;
  totals: Counts;
}

interface UsageRow {
  sessionId: string;
  model: string;
  provider?: string;
  mode: string;
  task: string;
  firstSeen: number;
  lastSeen: number;
  counts: Counts;
}

interface MsgStats {
  user: number;
  assistant: number;
  stamps: number[];
  /** tool name -> calls, from the function names in assistant `tool_calls` (names only) */
  toolNames?: Map<string, number>;
}

// ---------------------------------------------------------------------------------------------

function defaultPaths(): string[] {
  const env = envPaths('HERMES_HOME');
  if (env) return env.map(normalizePath);
  const suffix = process.env.HERMES_DATA_DIR_SUFFIX ?? '';
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA?.trim();
    const base = local || join(homeDir(), 'AppData', 'Local');
    return [normalizePath(join(base, 'hermes' + suffix))];
  }
  return [normalizePath(join(homeDir(), '.hermes' + suffix))];
}

/** state.db files under a Hermes home: the default store plus `profiles/<name>/state.db`. */
function dbFilesFor(root: string): string[] {
  let st;
  try {
    st = statSync(root);
  } catch {
    return [];
  }
  if (st.isFile()) return root.toLowerCase().endsWith('.db') ? [root] : [];
  const out: string[] = [];
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isFile(join(root, 'state.db'))) out.push(join(root, 'state.db'));
  let profiles: string[] = [];
  try {
    profiles = readdirSync(join(root, 'profiles'));
  } catch {
    /* no profiles */
  }
  for (const name of profiles.sort()) {
    if (name.startsWith('.')) continue; // `.deleted` tombstones
    const p = join(root, 'profiles', name, 'state.db');
    if (isFile(p)) out.push(p);
  }
  return out;
}

function readDb(db: SqliteDb): { sessions: RawSession[]; usage: UsageRow[]; msgs: Map<string, MsgStats> } | null {
  const sCols = tableColumns(db, 'sessions');
  if (!sCols.has('id')) return null;
  const col = (c: string) => (sCols.has(c) ? c : 'NULL');
  const sql = `SELECT id, ${col('parent_session_id')} AS parent_session_id, ${col('model')} AS model,
      ${col('billing_provider')} AS billing_provider, ${col('title')} AS title, ${col('cwd')} AS cwd,
      ${col('git_repo_root')} AS git_repo_root, ${col('started_at')} AS started_at, ${col('ended_at')} AS ended_at,
      ${col('last_activity_at')} AS last_activity_at, ${col('tool_call_count')} AS tool_call_count,
      ${TOKEN_KEYS.map((k) => `${col(k)} AS ${k}`).join(', ')},
      ${col('estimated_cost_usd')} AS estimated_cost_usd, ${col('actual_cost_usd')} AS actual_cost_usd
    FROM sessions`;
  const sessions: RawSession[] = [];
  for (const r of db.prepare(sql).all() as Row[]) {
    const totals = zeroCounts();
    for (const k of TOKEN_KEYS) totals[k] = num(r[k]);
    totals.est = num(r.estimated_cost_usd);
    totals.actual = num(r.actual_cost_usd);
    const startedAt = ms(r.started_at);
    sessions.push({
      id: String(r.id),
      parentId: str(r.parent_session_id),
      model: str(r.model),
      provider: str(r.billing_provider),
      title: str(r.title),
      cwd: str(r.cwd) ?? str(r.git_repo_root),
      startedAt,
      endedAt: Math.max(ms(r.ended_at), ms(r.last_activity_at)),
      toolCalls: num(r.tool_call_count),
      totals,
    });
  }

  const usage: UsageRow[] = [];
  const uCols = tableColumns(db, 'session_model_usage');
  if (uCols.has('session_id') && uCols.has('model')) {
    const ucol = (c: string) => (uCols.has(c) ? c : 'NULL');
    const usql = `SELECT session_id, model, ${ucol('billing_provider')} AS billing_provider,
        ${ucol('billing_mode')} AS billing_mode, ${ucol('task')} AS task,
        ${TOKEN_KEYS.map((k) => `${ucol(k)} AS ${k}`).join(', ')},
        ${ucol('estimated_cost_usd')} AS estimated_cost_usd, ${ucol('actual_cost_usd')} AS actual_cost_usd,
        ${ucol('first_seen')} AS first_seen, ${ucol('last_seen')} AS last_seen
      FROM session_model_usage`;
    for (const r of db.prepare(usql).all() as Row[]) {
      const counts = zeroCounts();
      for (const k of TOKEN_KEYS) counts[k] = num(r[k]);
      counts.est = num(r.estimated_cost_usd);
      counts.actual = num(r.actual_cost_usd);
      usage.push({
        sessionId: String(r.session_id),
        model: str(r.model) ?? 'unknown',
        provider: str(r.billing_provider),
        mode: str(r.billing_mode) ?? '',
        task: str(r.task) ?? '',
        firstSeen: ms(r.first_seen),
        lastSeen: ms(r.last_seen),
        counts,
      });
    }
  }

  // Message counts / timestamps only (never content).
  const msgs = new Map<string, MsgStats>();
  const mCols = tableColumns(db, 'messages');
  if (mCols.has('session_id') && mCols.has('role')) {
    const tcol = mCols.has('timestamp') ? 'timestamp' : 'NULL';
    for (const r of db.prepare(`SELECT session_id, role, ${tcol} AS ts FROM messages`).all() as Row[]) {
      const sid = String(r.session_id);
      let m = msgs.get(sid);
      if (!m) msgs.set(sid, (m = { user: 0, assistant: 0, stamps: [] }));
      if (r.role === 'user') m.user++;
      else if (r.role === 'assistant') m.assistant++;
      const t = ms(r.ts);
      if (t) m.stamps.push(t);
    }
    if (mCols.has('tool_calls')) readToolNames(db, msgs);
  }
  return { sessions, usage, msgs };
}

/**
 * Tool names per session from assistant `messages.tool_calls` (an OpenAI-style array). SQLite's
 * json_each / json_extract pull out each call's `function.name` only, so the call arguments and
 * the column's other contents never enter this process.
 */
function readToolNames(db: SqliteDb, msgs: Map<string, MsgStats>): void {
  const sql = `SELECT m.session_id AS sid,
      CASE WHEN json_type(j.value,'$.function.name') = 'text' THEN substr(json_extract(j.value,'$.function.name'),1,200)
           WHEN json_type(j.value,'$.name') = 'text' THEN substr(json_extract(j.value,'$.name'),1,200) END AS name
    FROM messages m,
      json_each(COALESCE(CASE WHEN json_valid(m.tool_calls) THEN CASE WHEN json_type(m.tool_calls) = 'array' THEN m.tool_calls END END, '[]')) j
    WHERE m.role = 'assistant' AND m.tool_calls IS NOT NULL`;
  let rows: Row[];
  try {
    rows = db.prepare(sql).all() as Row[];
  } catch {
    return; // names are optional enrichment; counts still come from sessions.tool_call_count
  }
  for (const r of rows) {
    const name = toolCallName(r.name);
    if (!name) continue;
    const sid = String(r.sid);
    let m = msgs.get(sid);
    if (!m) msgs.set(sid, (m = { user: 0, assistant: 0, stamps: [] }));
    countToolCall((m.toolNames ??= new Map()), name);
  }
}

function costOf(c: Counts): number | undefined {
  if (c.actual > 0) return c.actual;
  if (c.est > 0) return c.est;
  return undefined;
}

function buildFromDb(
  data: { sessions: RawSession[]; usage: UsageRow[]; msgs: Map<string, MsgStats> },
  opts: LoadOptions,
  events: Map<string, UsageEvent>,
  sessions: Map<string, SessionInfo>,
): void {
  const byId = new Map(data.sessions.map((s) => [s.id, s]));
  const rootOf = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    for (;;) {
      seen.add(cur);
      const parent = byId.get(cur)?.parentId;
      if (!parent || seen.has(parent) || !byId.has(parent)) return cur;
      cur = parent;
    }
  };
  const usageBySession = new Map<string, UsageRow[]>();
  for (const u of data.usage) {
    let l = usageBySession.get(u.sessionId);
    if (!l) usageBySession.set(u.sessionId, (l = []));
    l.push(u);
  }
  const inRange = (t: number) =>
    !(opts.since !== undefined && t < opts.since) && !(opts.until !== undefined && t > opts.until);

  for (const s of data.sessions) {
    const rootSessionId = rootOf(s.id);
    const isSubagent = rootSessionId !== s.id;
    const rawProject = s.cwd ?? byId.get(rootSessionId)?.cwd;
    const project = rawProject ? normalizePath(rawProject) : '';
    const models = new Set<string>();
    const stats = data.msgs.get(s.id) ?? { user: 0, assistant: 0, stamps: [] };
    const sessionEvents: UsageEvent[] = [];

    const mk = (id: string, ts: number, model: string, provider: string | undefined, c: Counts): UsageEvent => {
      const reasoning = Math.min(c.reasoning_tokens, c.output_tokens);
      const ev: UsageEvent = {
        tool: TOOL,
        id,
        timestamp: ts,
        sessionId: s.id,
        rootSessionId,
        isSubagent,
        project,
        model,
        inputTokens: c.input_tokens,
        outputTokens: c.output_tokens,
        cacheReadTokens: c.cache_read_tokens,
        cacheWriteTokens: c.cache_write_tokens,
        cacheWrite1hTokens: 0,
        reasoningTokens: reasoning,
        costUSD: 0,
      };
      if (provider) ev.provider = provider;
      const cost = costOf(c);
      if (cost !== undefined) ev.recordedCostUSD = cost;
      return ev;
    };

    const sum = zeroCounts();
    const seenKeys = new Map<string, number>();
    for (const u of usageBySession.get(s.id) ?? []) {
      for (const k of TOKEN_KEYS) sum[k] += u.counts[k];
      sum.est += u.counts.est;
      sum.actual += u.counts.actual;
      const tokens = TOKEN_KEYS.reduce((a, k) => a + u.counts[k], 0);
      if (tokens === 0 && !costOf(u.counts)) continue;
      // The primary key also contains billing_base_url; it is never copied into ids, so
      // disambiguate repeated (model, provider, mode, task) tuples by ordinal instead.
      const base = `hermes:${s.id}:${u.model}:${u.provider ?? ''}:${u.mode}:${u.task}`;
      const n = seenKeys.get(base) ?? 0;
      seenKeys.set(base, n + 1);
      const ts = u.firstSeen || s.startedAt || u.lastSeen;
      sessionEvents.push(mk(n ? `${base}#${n}` : base, ts, u.model, u.provider, u.counts));
    }

    // Residual: session counters not attributed to any per-model row (legacy sessions, gateway
    // absolute updates). Same per-field max(0, …) reconciliation as Hermes Insights.
    const residual = zeroCounts();
    for (const k of TOKEN_KEYS) residual[k] = Math.max(0, s.totals[k] - sum[k]);
    residual.est = Math.max(0, s.totals.est - sum.est);
    residual.actual = Math.max(0, s.totals.actual - sum.actual);
    const residualTokens = residual.input_tokens + residual.output_tokens + residual.cache_read_tokens + residual.cache_write_tokens;
    if (residualTokens > 0 || costOf(residual) !== undefined) {
      sessionEvents.push(mk(`hermes:${s.id}:session`, s.startedAt, s.model ?? 'unknown', s.provider, residual));
    }

    for (const ev of sessionEvents) {
      models.add(ev.model);
      if (!inRange(ev.timestamp)) continue;
      if (!events.has(ev.id)) events.set(ev.id, ev);
    }

    const lastMsg = stats.stamps.reduce((a, b) => (b > a ? b : a), 0);
    const firstMsg = stats.stamps.reduce((a, b) => (a === 0 || b < a ? b : a), 0);
    const startedAt = s.startedAt || firstMsg;
    const endedAt = Math.max(s.endedAt, lastMsg, startedAt);
    if (opts.since !== undefined && endedAt < opts.since) continue;
    if (opts.until !== undefined && startedAt > opts.until) continue;
    if (sessions.has(s.id)) continue;
    const info: SessionInfo = {
      tool: TOOL,
      sessionId: s.id,
      rootSessionId,
      isSubagent,
      project,
      startedAt,
      endedAt,
      activeMs: computeActiveMs(stats.stamps),
      userMessages: stats.user,
      assistantMessages: stats.assistant,
      toolCalls: s.toolCalls,
      turns: stats.user,
      models: [...models],
    };
    const byName = stats.toolNames ? toolCallsRecord(stats.toolNames) : undefined;
    if (byName) {
      info.toolCallsByName = byName;
      // the session counter can lag the messages table; never report fewer calls than are named
      info.toolCalls = Math.max(info.toolCalls, toolCallTotal(stats.toolNames!));
    }
    if (s.title) info.title = s.title;
    sessions.set(s.id, info);
  }
}

async function load(opts: LoadOptions): Promise<ParseResult> {
  const warn = opts.warn ?? (() => {});
  const roots = (opts.paths?.hermes?.length ? opts.paths.hermes : defaultPaths()).map(normalizePath);
  const result: ParseResult = { tool: TOOL, events: [], sessions: [], historical: [], sources: [] };
  const events = new Map<string, UsageEvent>();
  const sessions = new Map<string, SessionInfo>();

  for (const root of roots) {
    const files = dbFilesFor(root);
    if (!files.length) continue;
    const sqlite = await getSqlite();
    if (!sqlite) {
      warn('hermes: node:sqlite is unavailable in this Node.js version; Hermes data skipped');
      break;
    }
    let used = false;
    for (const f of files) {
      const h = openReadOnly(sqlite, f, TOOL, warn);
      if (!h) continue;
      try {
        const data = readDb(h.db);
        if (!data) {
          warn(`hermes: ${f} has no sessions table; skipped`);
          continue;
        }
        buildFromDb(data, opts, events, sessions);
        used = true;
      } catch (err) {
        warn(`hermes: failed reading ${f}: ${(err as Error).message}`);
      } finally {
        h.cleanup();
      }
    }
    if (used) result.sources.push(root);
  }

  result.events = [...events.values()].sort((a, b) => a.timestamp - b.timestamp);
  result.sessions = [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  return result;
}

export const hermesParser: ToolParser = {
  tool: TOOL,
  defaultPaths,
  load,
};
