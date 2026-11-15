/**
 * GitHub Copilot CLI (`copilot`) usage parser. See docs/formats/copilot.md.
 *
 * Sources under `<copilot>` = `$COPILOT_HOME` or `~/.copilot`:
 *  1. `session-store.db` (SQLite, opened read-only), table `assistant_usage_events`: one row per
 *     model call with `session_id`, `model` / `copilot_usage_model`, `input_tokens`,
 *     `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`,
 *     `total_nano_aiu`, `duration_ms`, `created_at`; table `sessions` gives `cwd`, `summary`,
 *     `created_at`, `updated_at`. The schema is not a documented API, so columns are probed first.
 *  2. `session-state/<sessionId>/events.jsonl`, the session event log. Per-call `assistant.usage`
 *     events are ephemeral (never written), so the only persisted usage is the cumulative per-model
 *     `data.modelMetrics.<model>.usage` on each `session.shutdown`. A resumed session restores the
 *     previous totals, so each shutdown is reported as the difference from the one before (a drop
 *     means an older CLI restarted the counters: the snapshot is then taken as-is). These coarse
 *     events are used only for sessions that have no rows in `session-store.db`.
 *     The log also gives the session metadata: `session.start` (`sessionId`, `startTime`,
 *     `context.cwd`, `copilotVersion`), `user.message`, `assistant.message`,
 *     `tool.execution_start` (`toolName`) and `subagent.started`.
 *
 * Token mapping (both sources): Copilot's `inputTokens` / `input_tokens` INCLUDE cache reads and
 * writes, so input = input − cacheRead − cacheWrite (clamped at 0). `reasoningTokens` is treated
 * as a subset of `outputTokens` (as ccusage and tokscale do). `total_nano_aiu` is GitHub's billed
 * AI-credit cost: 1 AI credit = $0.01 and 1 nano-AIU = 1e-9 AI credits, so USD = nanoAiu / 1e11
 * (recorded cost). `requests.cost` on shutdowns is a premium-request multiplier, not USD, and is
 * ignored.
 *
 * PRIVACY: from SQLite only numeric / metadata columns (and the session summary, used as title)
 * are selected; turn, message and search tables are never queried. Event-log lines are reduced
 * to type, ids, timestamps, cwd, model names, tool names and token numbers as they are read;
 * message text, tool arguments and results are dropped. config.json, the `logs/`, `otel/` and
 * `ide/` folders, `workspace.yaml` and every credential file are never opened.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadOptions, ParseResult, SessionInfo, ToolParser, UsageEvent } from '../types.js';
import { providerOf } from './model-provider.js';
import { getSqlite, openReadOnly, tableColumns, type SqliteDb } from './sqlite-util.js';
import { computeActiveMs, envPaths, homeDir, mapLimit, normalizePath, readJsonlFile, toEpochMs } from './util.js';

const TOOL = 'copilot' as const;
/** 1 AI credit = $0.01; nano-AIU = 1e-9 AIU. */
const NANO_AIU_PER_USD = 1e11;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}
function n(v: unknown): number {
  const x = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(x) && x > 0 ? x : 0;
}
/** ISO strings, epoch s/ms, and SQLite `YYYY-MM-DD HH:MM:SS` (UTC) timestamps. */
export function copilotTime(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(v.trim())) {
    const t = Date.parse(v.trim().replace(' ', 'T') + 'Z');
    return Number.isFinite(t) ? t : 0;
  }
  const t = toEpochMs(typeof v === 'bigint' ? Number(v) : v);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

function tokensOf(u: Obj): Tokens {
  return {
    input: n(u.inputTokens),
    output: n(u.outputTokens),
    cacheRead: n(u.cacheReadTokens),
    cacheWrite: n(u.cacheWriteTokens),
    reasoning: n(u.reasoningTokens),
  };
}

const KEYS: Array<keyof Tokens> = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

/** Per-interval usage from cumulative snapshots: the difference, or the snapshot after a reset. */
export function shutdownDelta(prev: Tokens | undefined, cur: Tokens): Tokens {
  if (!prev || KEYS.some((k) => cur[k] < prev[k])) return { ...cur };
  return { input: cur.input - prev.input, output: cur.output - prev.output, cacheRead: cur.cacheRead - prev.cacheRead, cacheWrite: cur.cacheWrite - prev.cacheWrite, reasoning: cur.reasoning - prev.reasoning };
}

/** Copilot's input includes both cache buckets. */
function normalise(t: Tokens) {
  const cacheRead = t.cacheRead;
  const cacheWrite = t.cacheWrite;
  return {
    inputTokens: Math.max(0, t.input - cacheRead - cacheWrite),
    outputTokens: t.output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: Math.min(t.reasoning, t.output),
  };
}

// ---------------------------------------------------------------------------------------------
// event log

type LiteEvent =
  | { kind: 'start'; ts: number; sessionId?: string; cwd?: string; version?: string; parentId?: string }
  | { kind: 'resume'; ts: number; cwd?: string }
  | { kind: 'shutdown'; ts: number; id?: string; metrics: Array<[string, Tokens]> }
  | { kind: 'user' | 'assistant' | 'subagent' | 'other'; ts: number; sub: boolean }
  | { kind: 'tool'; ts: number; name: string };

function liteEvent(v: unknown): LiteEvent | undefined {
  if (!isObj(v) || v.checkpoint === true) return undefined; // replay checkpoints duplicate history
  const type = str(v.type);
  if (!type) return undefined;
  const ts = copilotTime(v.timestamp);
  const data = isObj(v.data) ? v.data : {};
  const sub = typeof v.agentId === 'string' && v.agentId.length > 0;
  switch (type) {
    case 'session.start': {
      const ctx = isObj(data.context) ? data.context : {};
      return {
        kind: 'start',
        ts: copilotTime(data.startTime) || ts,
        sessionId: str(data.sessionId),
        cwd: str(ctx.cwd),
        version: str(data.copilotVersion),
        parentId: str(data.detachedFromSpawningParentSessionId),
      };
    }
    case 'session.resume': {
      const ctx = isObj(data.context) ? data.context : {};
      return { kind: 'resume', ts: copilotTime(data.resumeTime) || ts, cwd: str(ctx.cwd) };
    }
    case 'session.shutdown': {
      const metrics: Array<[string, Tokens]> = [];
      const mm = isObj(data.modelMetrics) ? data.modelMetrics : {};
      for (const [model, m] of Object.entries(mm)) if (isObj(m) && isObj(m.usage)) metrics.push([model, tokensOf(m.usage)]);
      return { kind: 'shutdown', ts, id: str(v.id), metrics };
    }
    case 'user.message':
      return { kind: 'user', ts, sub };
    case 'assistant.message':
      return { kind: 'assistant', ts, sub };
    case 'subagent.started':
      return { kind: 'subagent', ts, sub };
    case 'tool.execution_start':
      return { kind: 'tool', ts, name: str(data.toolName) ?? 'unknown' };
    default:
      return { kind: 'other', ts, sub };
  }
}

// ---------------------------------------------------------------------------------------------

interface SessionAcc {
  id: string;
  parentId?: string;
  cwd?: string;
  title?: string;
  version?: string;
  startedAt: number;
  endedAt: number;
  stamps: number[];
  user: number;
  assistant: number;
  tools: Record<string, number>;
  toolCalls: number;
  models: Set<string>;
  dbUsage: boolean;
  shutdowns: Array<{ ts: number; id?: string; metrics: Array<[string, Tokens]> }>;
}

function acc(map: Map<string, SessionAcc>, id: string): SessionAcc {
  let a = map.get(id);
  if (!a) {
    a = { id, startedAt: 0, endedAt: 0, stamps: [], user: 0, assistant: 0, tools: {}, toolCalls: 0, models: new Set(), dbUsage: false, shutdowns: [] };
    map.set(id, a);
  }
  return a;
}

function touch(a: SessionAcc, ts: number): void {
  if (!ts) return;
  if (!a.startedAt || ts < a.startedAt) a.startedAt = ts;
  if (ts > a.endedAt) a.endedAt = ts;
}

function readStore(
  db: SqliteDb,
  sessions: Map<string, SessionAcc>,
  events: Map<string, UsageEvent>,
  warn: (m: string) => void,
): boolean {
  const uCols = tableColumns(db, 'assistant_usage_events');
  if (!uCols.has('session_id') || !uCols.has('input_tokens') || !uCols.has('output_tokens')) return false;
  const col = (c: string) => (uCols.has(c) ? `u.${c}` : 'NULL');
  const sCols = tableColumns(db, 'sessions');
  const scol = (c: string) => (sCols.has('id') && sCols.has(c) ? `s.${c}` : 'NULL');
  const join = sCols.has('id') ? 'LEFT JOIN sessions s ON s.id = u.session_id' : '';
  const rowid = uCols.has('id') ? 'u.id' : 'u.rowid';
  let rows: Obj[];
  try {
    rows = db
      .prepare(
        `SELECT ${rowid} AS rid, u.session_id AS sid, ${col('model')} AS model, ${col('copilot_usage_model')} AS usage_model,
           u.input_tokens AS input, u.output_tokens AS output, ${col('cache_read_tokens')} AS cache_read,
           ${col('cache_write_tokens')} AS cache_write, ${col('reasoning_tokens')} AS reasoning,
           ${col('total_nano_aiu')} AS nano_aiu, ${col('duration_ms')} AS duration_ms, ${col('created_at')} AS created_at,
           ${scol('created_at')} AS s_created
         FROM assistant_usage_events u ${join}`,
      )
      .all() as Obj[];
  } catch (err) {
    warn(`copilot: cannot read session-store usage events: ${(err as Error).message}`);
    return false;
  }
  for (const r of rows) {
    const sid = str(r.sid);
    if (!sid) continue;
    const t: Tokens = { input: n(r.input), output: n(r.output), cacheRead: n(r.cache_read), cacheWrite: n(r.cache_write), reasoning: n(r.reasoning) };
    const nano = n(r.nano_aiu);
    if (t.input + t.output + t.cacheRead + t.cacheWrite === 0 && nano === 0) continue;
    const ts = copilotTime(r.created_at) || copilotTime(r.s_created);
    if (!ts) continue;
    const model = str(r.usage_model) ?? str(r.model) ?? 'auto';
    const a = acc(sessions, sid);
    a.dbUsage = true;
    a.models.add(model);
    a.stamps.push(ts);
    touch(a, ts);
    const id = `copilot:${sid}:db:${String(r.rid)}`;
    if (events.has(id)) continue;
    const ev: UsageEvent = {
      tool: TOOL,
      id,
      timestamp: ts,
      sessionId: sid,
      rootSessionId: sid,
      isSubagent: false,
      project: '',
      model,
      ...normalise(t),
      cacheWrite1hTokens: 0,
      costUSD: 0,
    };
    if (nano > 0) ev.recordedCostUSD = nano / NANO_AIU_PER_USD;
    const dur = n(r.duration_ms);
    if (dur) ev.durationMs = dur;
    const provider = providerOf(model);
    if (provider) ev.provider = provider;
    events.set(id, ev);
  }
  if (sCols.has('id')) {
    const sel = ['cwd', 'summary', 'created_at', 'updated_at'].map((c) => `${sCols.has(c) ? c : 'NULL'} AS ${c}`).join(', ');
    try {
      for (const r of db.prepare(`SELECT id, ${sel} FROM sessions`).all() as Obj[]) {
        const sid = str(r.id);
        if (!sid) continue;
        const a = acc(sessions, sid);
        a.cwd ??= str(r.cwd);
        a.title ??= str(r.summary);
        touch(a, copilotTime(r.created_at));
        touch(a, copilotTime(r.updated_at));
      }
    } catch (err) {
      warn(`copilot: cannot read session-store sessions: ${(err as Error).message}`);
    }
  }
  return true;
}

async function readEventLog(file: string, dirName: string, sessions: Map<string, SessionAcc>): Promise<void> {
  const lines = (await readJsonlFile(file, liteEvent)) as LiteEvent[];
  const start = lines.find((l) => l.kind === 'start') as Extract<LiteEvent, { kind: 'start' }> | undefined;
  const a = acc(sessions, start?.sessionId ?? dirName);
  if (start?.parentId) a.parentId ??= start.parentId;
  if (start?.version) a.version = start.version;
  for (const l of lines) {
    touch(a, l.ts);
    switch (l.kind) {
      case 'start':
      case 'resume':
        if (l.cwd) a.cwd ??= l.cwd;
        break;
      case 'shutdown':
        a.shutdowns.push({ ts: l.ts, id: l.id, metrics: l.metrics });
        break;
      case 'user':
        if (l.ts) a.stamps.push(l.ts);
        if (!l.sub) a.user++;
        break;
      case 'assistant':
        if (l.ts) a.stamps.push(l.ts);
        if (!l.sub) a.assistant++;
        break;
      case 'tool':
        if (l.ts) a.stamps.push(l.ts);
        a.toolCalls++;
        a.tools[l.name] = (a.tools[l.name] ?? 0) + 1;
        break;
      default:
        break;
    }
  }
}

function defaultPaths(): string[] {
  const env = envPaths('COPILOT_HOME');
  if (env) return env.map(normalizePath);
  return [normalizePath(join(homeDir(), '.copilot'))];
}

async function load(opts: LoadOptions): Promise<ParseResult> {
  const warn = opts.warn ?? (() => {});
  const roots = [...new Set((opts.paths?.copilot?.length ? opts.paths.copilot : defaultPaths()).map(normalizePath))];
  const result: ParseResult = { tool: TOOL, events: [], sessions: [], historical: [], sources: [] };
  const events = new Map<string, UsageEvent>();
  const sessions = new Map<string, SessionAcc>();
  const inRange = (t: number) =>
    !(opts.since !== undefined && t < opts.since) && !(opts.until !== undefined && t > opts.until);

  for (const root of roots) {
    let used = false;
    const dbPath = join(root, 'session-store.db');
    if (existsSync(dbPath)) {
      const sqlite = await getSqlite();
      if (!sqlite) warn('copilot: node:sqlite is unavailable (Node >= 22.5 needed); session-store.db skipped');
      else {
        const h = openReadOnly(sqlite, dbPath, TOOL, warn);
        if (h) {
          try {
            if (readStore(h.db, sessions, events, warn)) used = true;
          } finally {
            h.cleanup();
          }
        }
      }
    }
    const stateDir = join(root, 'session-state');
    let dirs: string[] = [];
    try {
      dirs = readdirSync(stateDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      /* no session-state */
    }
    const files = dirs.map((d) => ({ dir: d, file: join(stateDir, d, 'events.jsonl') })).filter((f) => existsSync(f.file));
    await mapLimit(files, 8, async ({ dir, file }) => {
      if (opts.since !== undefined) {
        try {
          if (statSync(file).mtimeMs < opts.since) return;
        } catch {
          return;
        }
      }
      try {
        await readEventLog(file, dir, sessions);
      } catch (err) {
        warn(`copilot: cannot read ${file}: ${(err as Error).message}`);
      }
    });
    if (files.length) used = true;
    if (used) result.sources.push(root);
  }

  const out: SessionInfo[] = [];
  for (const a of sessions.values()) {
    const project = a.cwd ? normalizePath(a.cwd) : '';
    const rootSessionId = a.parentId ?? a.id;
    // coarse shutdown intervals only where no per-call rows exist
    if (!a.dbUsage) {
      const prev = new Map<string, Tokens>();
      a.shutdowns.forEach((s, i) => {
        for (const [model, cur] of s.metrics) {
          const d = shutdownDelta(prev.get(model), cur);
          prev.set(model, cur);
          if (d.input + d.output + d.cacheRead + d.cacheWrite === 0) continue;
          a.models.add(model);
          if (!s.ts || !inRange(s.ts)) continue;
          const id = `copilot:${a.id}:shutdown:${s.id ?? i}:${model}`;
          const ev: UsageEvent = {
            tool: TOOL,
            id,
            timestamp: s.ts,
            sessionId: a.id,
            rootSessionId,
            isSubagent: rootSessionId !== a.id,
            project,
            model,
            ...normalise(d),
            cacheWrite1hTokens: 0,
            costUSD: 0,
          };
          const provider = providerOf(model);
          if (provider) ev.provider = provider;
          events.set(id, ev);
        }
      });
    }
    if (!a.startedAt) continue;
    if (opts.since !== undefined && a.endedAt < opts.since) continue;
    if (opts.until !== undefined && a.startedAt > opts.until) continue;
    const info: SessionInfo = {
      tool: TOOL,
      sessionId: a.id,
      rootSessionId,
      isSubagent: rootSessionId !== a.id,
      project,
      startedAt: a.startedAt,
      endedAt: a.endedAt,
      activeMs: computeActiveMs(a.stamps),
      userMessages: a.user,
      assistantMessages: a.assistant,
      toolCalls: a.toolCalls,
      turns: a.user,
      models: [...a.models],
    };
    if (a.toolCalls) info.toolCallsByName = a.tools;
    if (a.title) info.title = a.title;
    if (a.version) info.version = a.version;
    out.push(info);
  }
  // per-call rows carry no cwd or lineage: take both from the session
  for (const ev of events.values()) {
    const a = sessions.get(ev.sessionId);
    if (!a) continue;
    if (!ev.project && a.cwd) ev.project = normalizePath(a.cwd);
    if (a.parentId) {
      ev.rootSessionId = a.parentId;
      ev.isSubagent = true;
    }
  }

  result.events = [...events.values()].filter((e) => inRange(e.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  result.sessions = out.sort((a, b) => a.startedAt - b.startedAt);
  return result;
}

export const copilotParser: ToolParser = {
  tool: TOOL,
  defaultPaths,
  load,
};
