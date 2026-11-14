/**
 * Grok Build (xAI `grok` CLI) parser. See docs/formats/grok.md.
 *
 * Primary source: $GROK_HOME/sessions/<encoded-cwd>/<session-id>/updates.jsonl, the
 * `turn_completed` records that carry `usage` (per turn, not cumulative).
 * Fallback (only for session dirs without updates.jsonl): logs/unified.jsonl
 * `shell.turn.inference_done` lines.
 *
 * PRIVACY: only metadata and numbers are extracted. prompt_history.jsonl, chat_history.jsonl,
 * config.toml and auth.json are never read. The only text kept is summary.json's
 * generated_title (as the session title).
 */
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  LoadOptions,
  ParseResult,
  SessionInfo,
  ToolParser,
  UsageEvent,
} from '../types.js';

const TOOL = 'grok' as const;
const PROVIDER = 'xai';
const TICKS_PER_USD = 1e10;
const IDLE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- private helpers

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function parseTime(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

function normPath(p: string): string {
  let s = p;
  if (s.startsWith('\\\\?\\UNC\\')) s = '\\\\' + s.slice(8);
  else if (s.startsWith('\\\\?\\')) s = s.slice(4);
  return resolve(s);
}

function splitEnv(value: string | undefined): string[] | undefined {
  if (!value || !value.trim()) return undefined;
  const parts = value
    .split(',')
    .flatMap((p) => (delimiter === ';' ? p.split(';') : p.split(':')))
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function listDirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
function readJson(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Stream a JSONL file; invalid / partial lines are skipped. */
async function* jsonl(path: string): AsyncIterable<unknown> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      try {
        yield JSON.parse(t);
      } catch {
        /* partial or corrupt line */
      }
    }
  } finally {
    rl.close();
  }
}

function idleGapActive(ts: number[], idleMs = IDLE_MS): number {
  const s = ts.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < s.length; i++) {
    const gap = s[i]! - s[i - 1]!;
    if (gap > 0 && gap < idleMs) total += gap;
  }
  return total;
}

// ---------------------------------------------------------------- homes

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

function discoverHomes(): string[] {
  const env = splitEnv(process.env.GROK_HOME);
  if (env) return env.map((p) => normPath(expandHome(p)));
  const home = homedir();
  const out = [normPath(join(home, '.grok'))];
  try {
    for (const d of readdirSync(home, { withFileTypes: true })) {
      if (!d.isDirectory() || !d.name.startsWith('.grok-')) continue;
      const p = join(home, d.name);
      if (isDir(join(p, 'sessions'))) out.push(normPath(p));
    }
  } catch {
    /* ignore */
  }
  return out;
}

// ---------------------------------------------------------------- usage mapping

interface RawUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  modelCalls: number;
  apiDurationMs?: number;
  costUsdTicks?: number;
}

function rawUsage(u: Obj): RawUsage {
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cachedReadTokens: num(u.cachedReadTokens),
    cacheCreationTokens: num(u.cacheCreationTokens),
    reasoningTokens: num(u.reasoningTokens),
    modelCalls: num(u.modelCalls),
    apiDurationMs: optNum(u.apiDurationMs),
    costUsdTicks: optNum(u.costUsdTicks),
  };
}

function usageTotal(u: RawUsage): number {
  return u.inputTokens + u.outputTokens + u.reasoningTokens;
}

/**
 * Split a turn's usage into per-model entries. Uses modelUsage when present, otherwise the
 * top-level usage attributed to `fallbackModel`. Distributes a top-level costUsdTicks across
 * models proportionally (by tokens) when the per-model entries carry no ticks of their own.
 */
export function splitTurnUsage(usage: Obj, fallbackModel: string): Array<{ model: string; u: RawUsage }> {
  const top = rawUsage(usage);
  const mu = usage.modelUsage;
  const entries: Array<{ model: string; u: RawUsage }> = [];
  if (isObj(mu)) {
    for (const [model, v] of Object.entries(mu)) {
      if (isObj(v) && model) entries.push({ model, u: rawUsage(v) });
    }
  }
  if (entries.length === 0) return [{ model: fallbackModel, u: top }];

  const anyModelTicks = entries.some((e) => e.u.costUsdTicks !== undefined);
  if (!anyModelTicks && top.costUsdTicks !== undefined) {
    const totalTok = entries.reduce((s, e) => s + usageTotal(e.u), 0);
    for (const e of entries) {
      const share = totalTok > 0 ? usageTotal(e.u) / totalTok : 1 / entries.length;
      e.u.costUsdTicks = top.costUsdTicks * share;
    }
  }
  if (entries.length === 1 && entries[0]!.u.apiDurationMs === undefined) {
    entries[0]!.u.apiDurationMs = top.apiDurationMs;
  }
  return entries;
}

function toEvent(
  u: RawUsage,
  base: Pick<UsageEvent, 'timestamp' | 'sessionId' | 'rootSessionId' | 'isSubagent' | 'project'>,
  model: string,
  id: string,
): UsageEvent {
  const cacheRead = u.cachedReadTokens;
  const cacheWrite = u.cacheCreationTokens;
  const ev: UsageEvent = {
    tool: TOOL,
    id,
    ...base,
    model,
    provider: PROVIDER,
    inputTokens: Math.max(0, u.inputTokens - cacheRead - cacheWrite),
    // Grok reports reasoning separately from output; both are billed at the output rate.
    outputTokens: u.outputTokens + u.reasoningTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheWrite1hTokens: 0,
    reasoningTokens: u.reasoningTokens,
    costUSD: 0,
  };
  if (u.costUsdTicks !== undefined) ev.recordedCostUSD = u.costUsdTicks / TICKS_PER_USD;
  if (u.apiDurationMs !== undefined) ev.durationMs = u.apiDurationMs;
  return ev;
}

// ---------------------------------------------------------------- session scanning

interface Turn {
  promptId: string;
  /** 0 until resolved; see the fallback chain at the end of scanSession */
  ts: number;
  elapsedMs?: number;
  usage?: Obj;
}

interface ScannedSession {
  dir: string;
  sessionId: string;
  parentSessionId?: string;
  project: string;
  title?: string;
  currentModel?: string;
  createdAt?: number;
  lastActiveAt?: number;
  turns: Turn[];
  timestamps: number[];
  promptIndexes: Set<number | string>;
  toolCallIds: Set<string>;
  chunkModels: string[];
  turnDurations: number[];
  hasUpdates: boolean;
  childIds: string[];
}

function groupCwd(groupDir: string, groupName: string): string {
  const cwdFile = join(groupDir, '.cwd');
  if (isFile(cwdFile)) {
    try {
      const c = readFileSync(cwdFile, 'utf8').trim();
      if (c) return c;
    } catch {
      /* ignore */
    }
  }
  try {
    return decodeURIComponent(groupName);
  } catch {
    return '';
  }
}

function subagentChildIds(sessionDir: string): string[] {
  const subDir = join(sessionDir, 'subagents');
  const out: string[] = [];
  for (const name of listDirs(subDir)) {
    const meta = readJson(join(subDir, name, 'meta.json'));
    if (isObj(meta)) {
      for (const k of ['session_id', 'sessionId', 'child_session_id', 'childSessionId', 'id']) {
        const v = str(meta[k]);
        if (v) {
          out.push(v);
          break;
        }
      }
    } else {
      out.push(name); // directory may itself be named after the child session id
    }
  }
  return out;
}

async function scanSession(dir: string, dirName: string, cwdFallback: string): Promise<ScannedSession> {
  const summary = readJson(join(dir, 'summary.json'));
  const s: ScannedSession = {
    dir,
    sessionId: dirName,
    project: cwdFallback,
    turns: [],
    timestamps: [],
    promptIndexes: new Set(),
    toolCallIds: new Set(),
    chunkModels: [],
    turnDurations: [],
    hasUpdates: false,
    childIds: subagentChildIds(dir),
  };
  if (isObj(summary)) {
    const info = isObj(summary.info) ? summary.info : {};
    s.sessionId = str(info.id) ?? s.sessionId;
    s.project = str(info.cwd) ?? s.project;
    s.title = str(summary.generated_title);
    s.currentModel = str(summary.current_model_id);
    s.parentSessionId = str(summary.parent_session_id);
    s.createdAt = parseTime(summary.created_at);
    s.lastActiveAt = parseTime(summary.last_active_at) ?? parseTime(summary.updated_at);
  }

  const updates = join(dir, 'updates.jsonl');
  if (isFile(updates)) {
    s.hasUpdates = true;
    let lastTs: number | undefined;
    for await (const rec of jsonl(updates)) {
      if (!isObj(rec) || !isObj(rec.params)) continue;
      const params = rec.params;
      const update = params.update;
      if (!isObj(update)) continue;
      const meta = isObj(params._meta) ? params._meta : {};
      const ts = parseTime(meta.agentTimestampMs) ?? parseTime(rec.timestamp);
      if (ts !== undefined) {
        s.timestamps.push(ts);
        lastTs = ts;
      }
      const kind = update.sessionUpdate;
      if (kind === 'user_message_chunk') {
        const um = isObj(update._meta) ? update._meta : {};
        const pi = um.promptIndex;
        if (typeof pi === 'number' || typeof pi === 'string') s.promptIndexes.add(pi);
        const mid = str(um.modelId);
        if (mid) s.chunkModels.push(mid);
      } else if (kind === 'tool_call') {
        const id = str(update.toolCallId);
        if (id) s.toolCallIds.add(id);
      } else if (kind === 'turn_completed') {
        const promptId = str(update.prompt_id) ?? `${s.sessionId}:${str(meta.eventId) ?? s.turns.length}`;
        s.turns.push({
          promptId,
          // a turn line without its own timestamp inherits the previous record's time
          ts: ts ?? lastTs ?? 0,
          elapsedMs: optNum(update.elapsed_ms),
          usage: isObj(update.usage) ? update.usage : undefined,
        });
      }
    }
  }

  // turn timing from events.jsonl (turn_started -> turn_ended); only type/ts are read
  const events = join(dir, 'events.jsonl');
  if (isFile(events)) {
    let start: number | undefined;
    for await (const rec of jsonl(events)) {
      if (!isObj(rec)) continue;
      const t = parseTime(rec.ts);
      if (t === undefined) continue;
      if (rec.type === 'turn_started') start = t;
      else if (rec.type === 'turn_ended' && start !== undefined) {
        s.turnDurations.push(Math.max(0, t - start));
        start = undefined;
      }
    }
  }
  // turns before any timestamped record: fall back to the summary times, then the file mtime,
  // so an event never lands at the epoch (1970) and always has a matching session row
  const unresolved = s.turns.filter((t) => !t.ts);
  if (unresolved.length) {
    const firstSeen = s.timestamps.length ? Math.min(...s.timestamps) : undefined;
    let mtime: number | undefined;
    try {
      mtime = Math.floor(statSync(updates).mtimeMs);
    } catch {
      /* ignore */
    }
    const fb = firstSeen ?? s.lastActiveAt ?? s.createdAt ?? mtime;
    if (fb !== undefined) {
      for (const t of unresolved) t.ts = fb;
      if (!s.timestamps.length) s.timestamps.push(fb);
    }
  }
  return s;
}

/** Fallback: per-inference lines from logs/unified.jsonl for sessions lacking updates.jsonl. */
async function scanLogs(
  home: string,
  wanted: Map<string, ScannedSession>,
): Promise<Map<string, Array<{ ts: number; u: RawUsage; idx: number }>>> {
  const out = new Map<string, Array<{ ts: number; u: RawUsage; idx: number }>>();
  const log = join(home, 'logs', 'unified.jsonl');
  if (wanted.size === 0 || !isFile(log)) return out;
  let idx = 0;
  for await (const rec of jsonl(log)) {
    idx++;
    if (!isObj(rec) || rec.msg !== 'shell.turn.inference_done') continue;
    const sid = str(rec.sid);
    if (!sid || !wanted.has(sid) || !isObj(rec.ctx)) continue;
    const c = rec.ctx;
    const u: RawUsage = {
      inputTokens: num(c.prompt_tokens),
      cachedReadTokens: num(c.cached_prompt_tokens),
      cacheCreationTokens: 0,
      outputTokens: num(c.completion_tokens),
      reasoningTokens: num(c.reasoning_tokens),
      modelCalls: 1,
      apiDurationMs: optNum(c.model_elapsed_ms),
    };
    const arr = out.get(sid) ?? [];
    arr.push({ ts: parseTime(rec.ts) ?? 0, u, idx });
    out.set(sid, arr);
  }
  return out;
}

// ---------------------------------------------------------------- parser

function homesFrom(opts: LoadOptions): string[] {
  const override = opts.paths?.grok;
  const list = override && override.length ? override.map((p) => normPath(expandHome(p))) : discoverHomes();
  return [...new Set(list)];
}

export const grokParser: ToolParser = {
  tool: TOOL,

  defaultPaths(): string[] {
    return discoverHomes();
  },

  async load(opts: LoadOptions): Promise<ParseResult> {
    const warn = opts.warn ?? (() => {});
    const result: ParseResult = { tool: TOOL, events: [], sessions: [], historical: [], sources: [] };
    const scanned: Array<{ home: string; s: ScannedSession }> = [];

    for (const home of homesFrom(opts)) {
      const sessionsRoot = join(home, 'sessions');
      if (!isDir(sessionsRoot)) continue;
      result.sources.push(home);
      for (const group of listDirs(sessionsRoot)) {
        const groupDir = join(sessionsRoot, group);
        const cwd = groupCwd(groupDir, group);
        for (const sid of listDirs(groupDir)) {
          const dir = join(groupDir, sid);
          if (!isFile(join(dir, 'updates.jsonl')) && !isFile(join(dir, 'summary.json'))) continue;
          try {
            scanned.push({ home, s: await scanSession(dir, sid, cwd) });
          } catch (err) {
            warn(`grok: failed to read session ${dir}: ${(err as Error).message}`);
          }
        }
      }
    }

    // Subagent child sessions: their usage is already included in the parent turn.
    const childToParent = new Map<string, string>();
    for (const { s } of scanned) for (const c of s.childIds) childToParent.set(c, s.sessionId);

    // Log fallback for sessions without updates.jsonl
    const logUsage = new Map<string, Array<{ ts: number; u: RawUsage; idx: number }>>();
    const byHome = new Map<string, Map<string, ScannedSession>>();
    for (const { home, s } of scanned) {
      if (s.hasUpdates) continue;
      const m = byHome.get(home) ?? new Map<string, ScannedSession>();
      m.set(s.sessionId, s);
      byHome.set(home, m);
    }
    for (const [home, wanted] of byHome) {
      try {
        for (const [k, v] of await scanLogs(home, wanted)) if (!logUsage.has(k)) logUsage.set(k, v);
      } catch (err) {
        warn(`grok: failed to read logs in ${home}: ${(err as Error).message}`);
      }
    }

    // Forks copy their parent's history (same prompt_id). Process originals before forks so the
    // copied turns stay attributed to the session where they actually ran, whatever the directory order.
    const byId = new Map<string, ScannedSession>();
    for (const { s } of scanned) if (!byId.has(s.sessionId)) byId.set(s.sessionId, s);
    const depth = (s: ScannedSession): number => {
      let d = 0;
      const seen = new Set<string>([s.sessionId]);
      let p = s.parentSessionId;
      while (p && !seen.has(p) && byId.has(p)) {
        seen.add(p);
        d++;
        p = byId.get(p)!.parentSessionId;
      }
      return d;
    };
    const firstTs = (s: ScannedSession): number =>
      s.createdAt ?? (s.timestamps.length ? Math.min(...s.timestamps) : Number.MAX_SAFE_INTEGER);
    const ordered = scanned
      .map((x, i) => ({ ...x, d: depth(x.s), t: firstTs(x.s), i }))
      .sort((a, b) => a.d - b.d || a.t - b.t || a.i - b.i);

    const seenPrompts = new Set<string>();
    const seenSessions = new Set<string>();

    for (const { s } of ordered) {
      if (seenSessions.has(s.sessionId)) continue; // same session under two homes
      seenSessions.add(s.sessionId);

      const parent = childToParent.get(s.sessionId);
      const isSubagent = parent !== undefined;
      const rootSessionId = parent ?? s.sessionId;
      const project = s.project ? normPath(s.project) : '';
      const fallbackModel = s.currentModel ?? s.chunkModels[s.chunkModels.length - 1] ?? 'unknown';
      const base = { sessionId: s.sessionId, rootSessionId, isSubagent, project };
      const models = new Set<string>();
      let assistantMessages = 0;
      let turnsCount = 0;

      for (const turn of s.turns) {
        if (seenPrompts.has(turn.promptId)) continue; // forks copy parent history
        seenPrompts.add(turn.promptId);
        turnsCount++;
        if (!turn.usage) continue;
        assistantMessages += num(turn.usage.modelCalls);
        for (const { model, u } of splitTurnUsage(turn.usage, fallbackModel)) {
          models.add(model);
          if (isSubagent) continue; // counted by the parent
          result.events.push(
            toEvent(u, { ...base, timestamp: turn.ts }, model, `grok:${s.sessionId}:${turn.promptId}:${model}`),
          );
        }
      }

      const logRows = s.hasUpdates ? undefined : logUsage.get(s.sessionId);
      if (logRows) {
        for (const r of logRows) {
          assistantMessages++;
          models.add(fallbackModel);
          s.timestamps.push(r.ts);
          if (isSubagent) continue;
          result.events.push(
            toEvent(r.u, { ...base, timestamp: r.ts }, fallbackModel, `grok:${s.sessionId}:log:${r.ts}:${r.idx}`),
          );
        }
      }
      if (models.size === 0 && s.currentModel) models.add(s.currentModel);

      // timing
      const ts = s.timestamps.filter((t) => t > 0);
      const startCandidates = [...ts, ...(s.createdAt ? [s.createdAt] : [])];
      const endCandidates = [...ts, ...(s.lastActiveAt ? [s.lastActiveAt] : [])];
      if (startCandidates.length === 0) continue;
      const startedAt = Math.min(...startCandidates);
      const endedAt = Math.max(...endCandidates);

      let activeMs = 0;
      let haveTurnTiming = false;
      s.turns.forEach((t, i) => {
        const d = t.elapsedMs ?? s.turnDurations[i];
        if (d !== undefined) {
          activeMs += d;
          haveTurnTiming = true;
        }
      });
      if (!haveTurnTiming && s.turnDurations.length) {
        activeMs = s.turnDurations.reduce((a, b) => a + b, 0);
        haveTurnTiming = true;
      }
      if (!haveTurnTiming) activeMs = idleGapActive(ts);

      const info: SessionInfo = {
        tool: TOOL,
        sessionId: s.sessionId,
        rootSessionId,
        isSubagent,
        project,
        startedAt,
        endedAt,
        activeMs,
        userMessages: s.promptIndexes.size,
        assistantMessages,
        toolCalls: s.toolCallIds.size,
        turns: turnsCount,
        models: [...models],
      };
      if (s.title) info.title = s.title;
      result.sessions.push(info);
    }

    if (result.sources.length === 0) {
      // nothing found is not an error; keep quiet unless a path was explicitly given
      if (opts.paths?.grok?.length) warn(`grok: no sessions/ directory found in ${opts.paths.grok.join(', ')}`);
    }
    return result;
  },
};
