/**
 * Codex CLI / Codex Desktop parser.
 *
 * Source of truth: rollout JSONL files (often zstd-compressed) under
 *   <CODEX_HOME | ~/.codex>/sessions/** and <root>/archived_sessions/**.
 * See docs/formats/codex.md.
 *
 * Token method (validated to the token against the reference totals):
 * - Per file, when the thread has its own `token_usage_record` lines, sum their per-response
 *   `usage` (deduped globally by response_id). These also capture remote compaction calls.
 * - Otherwise (older rollouts), use `event_msg/token_count` cumulative `total_token_usage`
 *   deltas, treating copied parent history (ordinal < subagent_history_start_ordinal, or any
 *   snapshot before the first own task_started) as a baseline, skipping unchanged re-emissions,
 *   and adding compaction usage from `compacted.latest_token_usage_record`.
 *
 * Normalisation: input_tokens includes cached (and cache-write) tokens, output_tokens includes
 * reasoning. inputTokens = input - cached - cacheWrite, cacheReadTokens = cached,
 * outputTokens = output, reasoningTokens informational.
 *
 * PRIVACY: only metadata and numbers are extracted. Message text, instructions, tool
 * arguments/outputs and credit balances are never read into results. Titles (from the state
 * SQLite `threads.title` or session_index.jsonl `thread_name`) are kept as session titles.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  LoadOptions,
  ParseResult,
  SessionInfo,
  ToolParser,
  UsageEvent,
} from '../types.js';
import {
  computeActiveMs,
  envPaths,
  exists,
  homeDir,
  normalizePath,
  readJsonlLines,
  toEpochMs,
  walkFiles,
} from './util.js';

const TOOL = 'codex' as const;
const ROLLOUT_RE = /^rollout-.*\.jsonl(\.zst)?$/i;
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
const TOOL_CALL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'web_search_call',
  'tool_search_call',
]);

type Obj = Record<string, unknown>;

interface Usage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

/** Thread metadata from the state SQLite / session_index.jsonl (no usage). */
export interface CodexThreadMeta {
  title?: string;
  cwd?: string;
  model?: string;
  provider?: string;
}

interface Line {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: unknown;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readUsage(v: unknown): Usage | null {
  if (!isObj(v)) return null;
  const input = n(v.input_tokens);
  const output = n(v.output_tokens);
  return {
    input,
    cached: n(v.cached_input_tokens),
    cacheWrite: n(v.cache_write_input_tokens),
    output,
    reasoning: n(v.reasoning_output_tokens),
    total: typeof v.total_tokens === 'number' ? v.total_tokens : input + output,
  };
}

function subUsage(a: Usage, b: Usage): Usage {
  const d = (x: number, y: number) => Math.max(0, x - y);
  return {
    input: d(a.input, b.input),
    cached: d(a.cached, b.cached),
    cacheWrite: d(a.cacheWrite, b.cacheWrite),
    output: d(a.output, b.output),
    reasoning: d(a.reasoning, b.reasoning),
    total: d(a.total, b.total),
  };
}

function isEmptyUsage(u: Usage): boolean {
  return u.input === 0 && u.output === 0 && u.cached === 0 && u.cacheWrite === 0;
}

/** Context shared across files during one load (global dedupe + enrichment). */
export interface CodexParseContext {
  seenResponseIds: Set<string>;
  threadMeta?: Map<string, CodexThreadMeta>;
}

export interface CodexParseOptions {
  /** testing / validation only: ignore token_usage_record and use the token_count method */
  forceTokenCount?: boolean;
  /** file id from the file name, used when session_meta is missing */
  fileId?: string;
}

export interface CodexFileResult {
  events: UsageEvent[];
  session: SessionInfo | null;
  method: 'records' | 'token_count' | 'none';
}

function threadSourceIsSub(meta: Obj): boolean {
  const ts = str(meta.thread_source);
  if (ts && ts !== 'user') return true;
  const src = meta.source;
  return isObj(src) && 'subagent' in src;
}

/**
 * Parse one rollout's lines into usage events and one session. Pure (apart from ctx dedupe).
 */
export function parseCodexRolloutLines(
  rawLines: unknown[],
  ctx: CodexParseContext,
  opts: CodexParseOptions = {},
): CodexFileResult {
  const lines: Line[] = [];
  for (const l of rawLines) if (isObj(l)) lines.push(l as Line);
  if (lines.length === 0) return { events: [], session: null, method: 'none' };

  const ord = (l: Line, i: number) => (typeof l.ordinal === 'number' ? l.ordinal : i);

  // The first session_meta is this thread's; a later one (ordinal 1 in forks) is the parent's.
  let meta: Obj = {};
  for (const l of lines) {
    if (l.type === 'session_meta' && isObj(l.payload)) {
      meta = l.payload;
      break;
    }
  }
  const threadId = str(meta.id) ?? opts.fileId;
  if (!threadId) return { events: [], session: null, method: 'none' };
  const rootId = str(meta.session_id) ?? threadId;
  const isSubagent = rootId !== threadId || threadSourceIsSub(meta);
  const tmeta = ctx.threadMeta?.get(threadId);

  // Copied-history prefix: ordinal < subagent_history_start_ordinal (ignored when past EOF).
  let maxOrd = -1;
  lines.forEach((l, i) => {
    maxOrd = Math.max(maxOrd, ord(l, i));
  });
  let startOrd = n(meta.subagent_history_start_ordinal);
  if (startOrd > maxOrd) startOrd = 0;

  // Pass 1: turn_id -> model / cwd over the whole file (compaction records precede turn_context).
  const turnModel = new Map<string, string>();
  const turnCwd = new Map<string, string>();
  let hasOwnRecords = false;
  let hasOwnTaskStarted = false;
  // Turns / responses covered by this thread's own token_usage_record lines, and the position
  // of the first one. A thread resumed by a newer CLI can have an older token_count-only
  // segment before it; that segment is counted with the token_count method.
  const recordTurns = new Set<string>();
  const recordIds = new Set<string>();
  let firstRecordIdx = Infinity;
  lines.forEach((l, i) => {
    const p = isObj(l.payload) ? l.payload : {};
    if (l.type === 'turn_context') {
      const tid = str(p.turn_id);
      const model = str(p.model) ?? str(isObj(p.collaboration_mode) && isObj(p.collaboration_mode.settings) ? p.collaboration_mode.settings.model : undefined);
      if (tid && model) turnModel.set(tid, model);
      if (tid && str(p.cwd)) turnCwd.set(tid, str(p.cwd)!);
    } else if (l.type === 'token_usage_record' && ord(l, i) >= startOrd) {
      const tid = str(p.thread_id);
      if (!tid || tid === threadId) {
        hasOwnRecords = true;
        if (i < firstRecordIdx) firstRecordIdx = i;
        const turn = str(p.turn_id);
        if (turn) recordTurns.add(turn);
        const rid = str(p.response_id);
        if (rid) recordIds.add(rid);
      }
    } else if (l.type === 'event_msg' && isObj(l.payload) && l.payload.type === 'task_started' && ord(l, i) >= startOrd) {
      hasOwnTaskStarted = true;
    }
  });
  const useRecords = hasOwnRecords && !opts.forceTokenCount;
  if (!useRecords) firstRecordIdx = Infinity;

  const metaCwd = str(meta.cwd) ?? tmeta?.cwd;
  const provider = str(meta.model_provider) ?? tmeta?.provider;

  const events: UsageEvent[] = [];
  const timestamps: number[] = [];
  const turnIds = new Set<string>();
  let anonTurns = 0;
  let durationSum = 0;
  let hasDurations = false;
  let userMsgs = 0;
  let agentMsgs = 0;
  let legacyUser = 0;
  let legacyAgent = 0;
  let respUser = 0;
  let respAgent = 0;
  let sawItemCompleted = false;
  let sawLegacyMsg = false;
  let toolCalls = 0;
  const seenCallIds = new Set<string>();
  const contextModels = new Set<string>();

  let curModel: string | undefined;
  let settingsModel: string | undefined;
  let worldModel: string | undefined;
  let curCwd: string | undefined;
  let serviceTier: string | undefined;
  // Without any own task_started (older rollouts did not persist it) usage starts at once;
  // otherwise a cumulative snapshot before the first own turn is an inherited fork baseline.
  // Only forked / subagent threads can carry an inherited snapshot.
  const metaCount = lines.filter((l) => l.type === 'session_meta').length;
  const mayInherit = isSubagent || startOrd > 0 || metaCount > 1 || !!str(meta.parent_thread_id) || !!str(meta.forked_from_id);
  let started = !hasOwnTaskStarted || !mayInherit;
  let curTurn: string | undefined;
  let prevTotal: Usage | null = null;
  let lastTs = NaN;
  const metaTs = toEpochMs(meta.timestamp);

  const resolveModel = (turnId?: string): string =>
    (turnId ? turnModel.get(turnId) : undefined) ??
    curModel ??
    settingsModel ??
    worldModel ??
    tmeta?.model ??
    'unknown';

  const pushEvent = (id: string, ts: number, u: Usage, model: string) => {
    if (isEmptyUsage(u)) return;
    const cacheRead = u.cached;
    const cacheWrite = u.cacheWrite;
    const ev: UsageEvent = {
      tool: TOOL,
      id,
      timestamp: ts,
      sessionId: threadId,
      rootSessionId: rootId,
      isSubagent,
      project: normalizePath(metaCwd ?? curCwd ?? ''),
      model,
      inputTokens: Math.max(0, u.input - cacheRead - cacheWrite),
      outputTokens: u.output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cacheWrite1hTokens: 0,
      reasoningTokens: u.reasoning,
      costUSD: 0,
    };
    if (provider) ev.provider = provider;
    if (serviceTier && serviceTier !== 'default' && serviceTier !== 'auto') ev.speed = serviceTier;
    events.push(ev);
  };

  lines.forEach((l, i) => {
    const o = ord(l, i);
    const own = o >= startOrd;
    const p: Obj = isObj(l.payload) ? l.payload : {};
    const ptype = str(p.type);
    let ts = toEpochMs(l.timestamp);
    if (!Number.isFinite(ts)) ts = Number.isFinite(lastTs) ? lastTs : metaTs;

    // Model/cwd tracking happens for copied lines too (they precede our own turns).
    if (l.type === 'turn_context') {
      curModel = str(p.model) ?? curModel;
      curCwd = str(p.cwd) ?? curCwd;
      if (own && str(p.turn_id)) curTurn = str(p.turn_id);
      if (own && str(p.model)) contextModels.add(str(p.model)!);
    } else if (l.type === 'world_state' && isObj(p.state)) {
      worldModel = str(p.state.model) ?? worldModel;
    } else if (l.type === 'event_msg' && ptype === 'thread_settings_applied' && isObj(p.thread_settings)) {
      settingsModel = str(p.thread_settings.model) ?? settingsModel;
      const tier = str(p.thread_settings.service_tier);
      if (tier) serviceTier = tier;
    }

    if (!own) {
      // Inherited parent history: a cumulative snapshot here is the baseline, never usage.
      if (l.type === 'event_msg' && ptype === 'token_count' && isObj(p.info)) {
        const t = readUsage(p.info.total_token_usage);
        if (t) prevTotal = t;
      }
      return;
    }
    if (Number.isFinite(ts)) {
      timestamps.push(ts);
      lastTs = ts;
    }

    switch (l.type) {
      case 'token_usage_record': {
        if (!useRecords) break;
        const tid = str(p.thread_id);
        if (tid && tid !== threadId) break;
        const u = readUsage(p.usage);
        if (!u) break;
        const rid = str(p.response_id);
        if (rid) {
          if (ctx.seenResponseIds.has(rid)) break;
          ctx.seenResponseIds.add(rid);
        }
        pushEvent(rid ? `codex:${rid}` : `codex:${threadId}:rec:${o}`, ts, u, resolveModel(str(p.turn_id)));
        break;
      }
      case 'compacted': {
        // Compaction responses have their own token_usage_record in newer rollouts; only count
        // this copy in a token_count-only segment.
        if (useRecords && i > firstRecordIdx) break;
        const rec = p.latest_token_usage_record;
        const cid = str(p.compaction_response_id);
        if (!cid || !isObj(rec) || str(rec.response_id) !== cid) break;
        if (useRecords && recordIds.has(cid)) break;
        const tid = str(rec.thread_id);
        if (tid && tid !== threadId) break;
        const u = readUsage(rec.usage);
        if (!u || ctx.seenResponseIds.has(cid)) break;
        ctx.seenResponseIds.add(cid);
        const prevModel = isObj(p.resume_metadata) && isObj(p.resume_metadata.previous_turn_settings)
          ? str(p.resume_metadata.previous_turn_settings.model)
          : undefined;
        const tidTurn = str(rec.turn_id);
        const model = (tidTurn ? turnModel.get(tidTurn) : undefined) ?? prevModel ?? resolveModel();
        pushEvent(`codex:${cid}`, ts, u, model);
        break;
      }
      case 'response_item': {
        if (ptype && TOOL_CALL_TYPES.has(ptype)) {
          const cid = str(p.call_id) ?? str(p.id);
          if (cid) {
            if (seenCallIds.has(cid)) break;
            seenCallIds.add(cid);
          }
          toolCalls++;
        } else if (ptype === 'message') {
          if (p.role === 'user') respUser++;
          else if (p.role === 'assistant') respAgent++;
        }
        break;
      }
      case 'event_msg': {
        switch (ptype) {
          case 'task_started': {
            started = true;
            const tid = str(p.turn_id);
            if (tid) curTurn = tid;
            if (tid) turnIds.add(tid);
            else anonTurns++;
            break;
          }
          case 'task_complete':
          case 'turn_aborted': {
            const tid = str(p.turn_id);
            if (tid) turnIds.add(tid);
            else if (!started) anonTurns++;
            if (typeof p.duration_ms === 'number' && p.duration_ms > 0) {
              durationSum += p.duration_ms;
              hasDurations = true;
            }
            break;
          }
          case 'item_completed': {
            sawItemCompleted = true;
            const it = isObj(p.item) ? str(p.item.type) : undefined;
            if (it === 'UserMessage' || it === 'userMessage') userMsgs++;
            else if (it === 'AgentMessage' || it === 'agentMessage') agentMsgs++;
            break;
          }
          case 'user_message':
            sawLegacyMsg = true;
            legacyUser++;
            break;
          case 'agent_message':
            sawLegacyMsg = true;
            legacyAgent++;
            break;
          case 'token_count': {
            if (!isObj(p.info)) break;
            // With records, token_count only counts in a segment they do not cover (before the
            // first own record, in a turn without records: e.g. a thread resumed by a newer CLI).
            const emit = !useRecords || (i < firstRecordIdx && !(curTurn && recordTurns.has(curTurn)));
            const total = readUsage(p.info.total_token_usage);
            const last = readUsage(p.info.last_token_usage);
            if (!total) {
              if (last && started && emit) pushEvent(`codex:${threadId}:tc:${o}`, ts, last, resolveModel());
              break;
            }
            if (!started) {
              // Snapshot before this thread's first turn = inherited fork baseline.
              prevTotal = total;
              break;
            }
            if (prevTotal && total.total === prevTotal.total) break; // duplicate re-emission
            let delta: Usage;
            if (prevTotal && total.total < prevTotal.total) {
              // Cumulative counter went backwards (counter reset on reload): rebase on it.
              delta = last && last.total <= total.total ? last : total;
            } else {
              delta = prevTotal ? subUsage(total, prevTotal) : total;
            }
            prevTotal = total;
            if (!emit) break;
            pushEvent(`codex:${threadId}:tc:${o}`, ts, delta, resolveModel());
            break;
          }
        }
        break;
      }
    }
  });

  if (Number.isFinite(metaTs)) timestamps.push(metaTs);
  const finite = timestamps.filter(Number.isFinite);
  const startedAt = finite.length ? Math.min(...finite) : 0;
  const endedAt = finite.length ? Math.max(...finite) : 0;
  const models = [...new Set(events.map((e) => e.model))];
  for (const m of contextModels) if (!models.includes(m)) models.push(m);

  const session: SessionInfo = {
    tool: TOOL,
    sessionId: threadId,
    rootSessionId: rootId,
    isSubagent,
    project: normalizePath(metaCwd ?? curCwd ?? ''),
    startedAt,
    endedAt,
    activeMs: hasDurations ? durationSum : computeActiveMs(finite),
    userMessages: sawItemCompleted ? userMsgs : sawLegacyMsg ? legacyUser : respUser,
    assistantMessages: sawItemCompleted ? agentMsgs : sawLegacyMsg ? legacyAgent : respAgent,
    toolCalls,
    turns: turnIds.size + anonTurns,
    models,
  };
  if (tmeta?.title) session.title = tmeta.title;
  const version = str(meta.cli_version);
  if (version) session.version = version;

  return { events, session, method: useRecords ? 'records' : events.length ? 'token_count' : 'none' };
}

// ---------------------------------------------------------------------------------------------
// Discovery

async function collectRollouts(root: string): Promise<string[]> {
  const pred = (_full: string, name: string) => ROLLOUT_RE.test(name);
  const [a, b] = await Promise.all([
    walkFiles(path.join(root, 'sessions'), pred),
    walkFiles(path.join(root, 'archived_sessions'), pred),
  ]);
  return [...a, ...b];
}

function fileIdOf(file: string): string | undefined {
  return UUID_RE.exec(path.basename(file))?.[1]?.toLowerCase();
}

async function readLines(file: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const v of readJsonlLines(file)) out.push(v);
  return out;
}

/** Read titles / cwd / model from `state_*.sqlite` threads (read-only) and session_index.jsonl. */
export async function readCodexThreadMeta(
  root: string,
  warn?: (m: string) => void,
): Promise<Map<string, CodexThreadMeta>> {
  const map = new Map<string, CodexThreadMeta>();
  // session_index.jsonl: {id, thread_name, updated_at}
  const idx = path.join(root, 'session_index.jsonl');
  if (await exists(idx)) {
    try {
      for await (const v of readJsonlLines(idx)) {
        if (!isObj(v)) continue;
        const id = str(v.id);
        const name = str(v.thread_name);
        if (id && name) map.set(id, { ...map.get(id), title: name });
      }
    } catch {
      /* ignore */
    }
  }
  let dbFile: string | undefined;
  try {
    const names = (await readdir(root)).filter((f) => /^state_\d+\.sqlite$/i.test(f));
    names.sort((x, y) => Number(/\d+/.exec(y)?.[0]) - Number(/\d+/.exec(x)?.[0]));
    if (names[0]) dbFile = path.join(root, names[0]);
  } catch {
    return map;
  }
  if (!dbFile) return map;
  try {
    const sqlite = (await import('node:sqlite' as string)) as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => {
        prepare(sql: string): { all(...a: unknown[]): unknown[] };
        close(): void;
      };
    };
    const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
    try {
      const cols = new Set(
        (db.prepare('PRAGMA table_info(threads)').all() as Obj[]).map((r) => String(r.name)),
      );
      if (!cols.has('id')) return map;
      const want = ['title', 'cwd', 'model', 'model_provider'].filter((c) => cols.has(c));
      const rows = db.prepare(`SELECT id${want.map((c) => `, ${c}`).join('')} FROM threads`).all() as Obj[];
      for (const r of rows) {
        const id = str(r.id);
        if (!id) continue;
        const prev = map.get(id) ?? {};
        const m: CodexThreadMeta = { ...prev };
        const title = str(r.title);
        if (title) m.title = title;
        if (str(r.cwd)) m.cwd = str(r.cwd);
        if (str(r.model)) m.model = str(r.model);
        if (str(r.model_provider)) m.provider = str(r.model_provider);
        map.set(id, m);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    warn?.(`codex: could not read ${path.basename(dbFile)} (${(err as Error).message}); titles skipped`);
  }
  return map;
}

function defaultPaths(): string[] {
  return envPaths('CODEX_HOME') ?? [path.join(homeDir(), '.codex')];
}

async function load(opts: LoadOptions): Promise<ParseResult> {
  const roots = opts.paths?.codex?.length ? opts.paths.codex.map((p) => path.resolve(p)) : defaultPaths();
  const result: ParseResult = { tool: TOOL, events: [], sessions: [], historical: [], sources: [] };
  const ctx: CodexParseContext = { seenResponseIds: new Set(), threadMeta: new Map() };

  // Group candidate files by thread id across roots, sessions/archived and .jsonl/.jsonl.zst.
  const groups = new Map<string, string[]>();
  const anonymous: string[] = [];
  for (const root of roots) {
    if (!(await exists(root))) continue;
    const files = await collectRollouts(root);
    if (files.length === 0 && !(await exists(path.join(root, 'sessions')))) continue;
    result.sources.push(normalizePath(root));
    const tm = await readCodexThreadMeta(root, opts.warn);
    for (const [k, v] of tm) ctx.threadMeta!.set(k, { ...ctx.threadMeta!.get(k), ...v });
    for (const f of files) {
      const id = fileIdOf(f);
      if (!id) anonymous.push(f);
      else groups.set(id, [...(groups.get(id) ?? []), f]);
    }
  }

  const jobs: Array<Promise<{ lines: unknown[]; fileId?: string }>> = [];
  for (const [id, files] of groups) {
    jobs.push(
      (async () => {
        if (files.length === 1) return { lines: await readLines(files[0]!), fileId: id };
        // Same rollout in several places (live .jsonl vs compressed .zst vs archived): keep the
        // most complete copy (most lines, then newest mtime).
        let best: { lines: unknown[]; mtime: number } | null = null;
        for (const f of files) {
          try {
            const lines = await readLines(f);
            const mtime = (await stat(f)).mtimeMs;
            if (!best || lines.length > best.lines.length || (lines.length === best.lines.length && mtime > best.mtime)) {
              best = { lines, mtime };
            }
          } catch (err) {
            opts.warn?.(`codex: failed to read ${f}: ${(err as Error).message}`);
          }
        }
        return { lines: best?.lines ?? [], fileId: id };
      })(),
    );
  }
  for (const f of anonymous) jobs.push(readLines(f).then((lines) => ({ lines })));

  const settled = await Promise.allSettled(jobs);
  // Deterministic processing order (dedupe keeps the first): sort by thread id.
  const parsed = settled
    .flatMap((s) => {
      if (s.status === 'fulfilled') return [s.value];
      opts.warn?.(`codex: ${(s.reason as Error)?.message ?? s.reason}`);
      return [];
    })
    .sort((a, b) => (a.fileId ?? '').localeCompare(b.fileId ?? ''));

  const seenThreads = new Set<string>();
  for (const { lines, fileId } of parsed) {
    const r = parseCodexRolloutLines(lines, ctx, fileId ? { fileId } : {});
    if (!r.session) continue;
    if (seenThreads.has(r.session.sessionId)) continue;
    seenThreads.add(r.session.sessionId);
    result.events.push(...r.events);
    result.sessions.push(r.session);
  }
  result.events.sort((a, b) => a.timestamp - b.timestamp);
  return result;
}

export const codexParser: ToolParser = {
  tool: TOOL,
  defaultPaths,
  load,
};

// ---------------------------------------------------------------------------------------------
// Rate limits (for a status view). Never includes credit balances.

export interface CodexRateWindow {
  used_percent: number;
  window_minutes?: number;
  /** epoch seconds as recorded by Codex */
  resets_at?: number;
}

export interface CodexRateLimits {
  primary: CodexRateWindow | null;
  secondary: CodexRateWindow | null;
  plan_type?: string;
  limit_id?: string;
  /** epoch ms of the token_count event the snapshot came from */
  timestamp: number;
  sessionId?: string;
}

function readWindow(v: unknown): CodexRateWindow | null {
  if (!isObj(v) || typeof v.used_percent !== 'number') return null;
  const w: CodexRateWindow = { used_percent: v.used_percent };
  if (typeof v.window_minutes === 'number') w.window_minutes = v.window_minutes;
  if (typeof v.resets_at === 'number') w.resets_at = v.resets_at;
  return w;
}

/**
 * Latest rate-limit snapshot across the most recently modified rollouts, or null if none.
 * Only scans the `maxFiles` newest files (default 8).
 */
export async function readCodexRateLimits(
  opts: { paths?: string[]; maxFiles?: number } = {},
): Promise<CodexRateLimits | null> {
  const roots = opts.paths?.length ? opts.paths.map((p) => path.resolve(p)) : defaultPaths();
  const files: Array<{ f: string; m: number }> = [];
  for (const root of roots) {
    if (!(await exists(root))) continue;
    for (const f of await collectRollouts(root)) {
      try {
        files.push({ f, m: (await stat(f)).mtimeMs });
      } catch {
        /* ignore */
      }
    }
  }
  files.sort((a, b) => b.m - a.m);
  let best: CodexRateLimits | null = null;
  for (const { f } of files.slice(0, opts.maxFiles ?? 8)) {
    let sid: string | undefined;
    try {
      for await (const v of readJsonlLines(f)) {
        if (!isObj(v)) continue;
        const p = isObj(v.payload) ? v.payload : null;
        if (!p) continue;
        if (v.type === 'session_meta' && !sid) sid = str(p.id);
        if (v.type !== 'event_msg' || p.type !== 'token_count' || !isObj(p.rate_limits)) continue;
        const ts = toEpochMs(v.timestamp);
        if (!Number.isFinite(ts) || (best && ts <= best.timestamp)) continue;
        const rl = p.rate_limits;
        const snap: CodexRateLimits = {
          primary: readWindow(rl.primary),
          secondary: readWindow(rl.secondary),
          timestamp: ts,
        };
        if (!snap.primary && !snap.secondary) continue;
        if (str(rl.plan_type)) snap.plan_type = str(rl.plan_type);
        if (str(rl.limit_id)) snap.limit_id = str(rl.limit_id);
        if (sid) snap.sessionId = sid;
        best = snap;
      }
    } catch {
      /* ignore unreadable file */
    }
  }
  return best;
}
