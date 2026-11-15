/**
 * OpenCode (sst/opencode) usage parser.
 *
 * Sources (see docs/formats/opencode.md):
 *  - SQLite: <data>/opencode*.db (opened read-only via node:sqlite; falls back to a temp copy of db + wal)
 *  - Legacy JSON tree: <data>/storage/{session,message,part}/...
 * Both are merged and deduped by message id.
 *
 * Privacy: only metadata and numbers are extracted. From SQLite we pull individual JSON fields with
 * json_extract so message/part text never enters this process (of a tool part, only its `tool` name). Legacy JSON files must be parsed whole,
 * but only numeric/metadata fields are retained. Account / credential tables and auth.json are never read.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve, basename } from 'node:path';
import type { LoadOptions, ParseResult, SessionInfo, ToolParser, UsageEvent } from '../types.js';

import { providerSpeed } from '../speed.js';
import { countToolCall, toolCallName, toolCallsRecord } from './util.js';

const TOOL = 'opencode' as const;
const IDLE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// private helpers (util.ts is owned by another builder; keep these local)

function normPath(p: string): string {
  if (!p) return '';
  let s = p;
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  return resolve(s);
}

function envList(name: string): string[] | undefined {
  const v = process.env[name];
  if (!v || !v.trim()) return undefined;
  const parts = v
    .split(v.includes(',') ? ',' : delimiter)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function activeMsFrom(timestamps: number[], idleMs = IDLE_MS): number {
  const ts = timestamps.filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i]! - ts[i - 1]!;
    if (gap > 0 && gap < idleMs) total += gap;
  }
  return total;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------------------------
// normalised intermediate records

interface RawSession {
  id: string;
  parentId?: string;
  title?: string;
  directory?: string;
  worktree?: string;
  version?: string;
  timeCreated: number;
  timeUpdated: number;
}

interface StepAgg {
  count: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface RawMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | string;
  created: number;
  completed?: number;
  modelID?: string;
  speed?: string;
  providerID?: string;
  cwd?: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  hasError: boolean;
  steps?: StepAgg;
}

interface RawData {
  sessions: Map<string, RawSession>;
  messages: Map<string, RawMessage>;
  /** session id -> tool call count */
  toolCalls: Map<string, number>;
  /** session id -> tool name -> call count */
  toolNames: Map<string, Map<string, number>>;
  /** dedupe key for tool parts (part id) */
  toolPartIds: Set<string>;
}

function newRaw(): RawData {
  return { sessions: new Map(), messages: new Map(), toolCalls: new Map(), toolNames: new Map(), toolPartIds: new Set() };
}

function addSession(raw: RawData, s: RawSession): void {
  const prev = raw.sessions.get(s.id);
  if (!prev) {
    raw.sessions.set(s.id, s);
    return;
  }
  // merge: prefer populated fields, widen time range
  raw.sessions.set(s.id, {
    id: s.id,
    parentId: prev.parentId ?? s.parentId,
    title: prev.title ?? s.title,
    directory: prev.directory ?? s.directory,
    worktree: prev.worktree ?? s.worktree,
    version: prev.version ?? s.version,
    timeCreated: Math.min(prev.timeCreated || Infinity, s.timeCreated || Infinity) || 0,
    timeUpdated: Math.max(prev.timeUpdated, s.timeUpdated),
  });
}

function addMessage(raw: RawData, m: RawMessage): void {
  const prev = raw.messages.get(m.id);
  // dedupe by message id; keep the record with more info (completed / larger totals)
  if (prev) {
    const score = (x: RawMessage) =>
      (x.completed ? 1 : 0) + x.input + x.output + x.reasoning + x.cacheRead + x.cacheWrite;
    if (score(prev) >= score(m)) return;
  }
  raw.messages.set(m.id, m);
}

function addToolPart(raw: RawData, partId: string, sessionId: string, toolName?: unknown): void {
  if (raw.toolPartIds.has(partId)) return;
  raw.toolPartIds.add(partId);
  raw.toolCalls.set(sessionId, (raw.toolCalls.get(sessionId) ?? 0) + 1);
  const name = toolCallName(toolName);
  if (!name) return;
  let tally = raw.toolNames.get(sessionId);
  if (!tally) raw.toolNames.set(sessionId, (tally = new Map()));
  countToolCall(tally, name);
}

// ---------------------------------------------------------------------------------------------
// SQLite

// Minimal local typings: the repo's @types/node predates node:sqlite.
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDb;
}
const SQLITE_SPECIFIER = 'node:sqlite';
let sqliteMod: Promise<SqliteModule | null> | undefined;

/** Import node:sqlite while suppressing only its ExperimentalWarning. */
function getSqlite(): Promise<SqliteModule | null> {
  if (!sqliteMod) {
    sqliteMod = (async () => {
      const orig = process.emitWarning;
      process.emitWarning = function (this: unknown, warning: unknown, ...rest: unknown[]) {
        const msg = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
        const type =
          typeof rest[0] === 'string' ? rest[0] : isObj(rest[0]) ? (rest[0] as { type?: string }).type : warning instanceof Error ? warning.name : '';
        if (type === 'ExperimentalWarning' && /sqlite/i.test(msg)) return;
        return (orig as (...a: unknown[]) => void).call(process, warning, ...rest);
      } as typeof process.emitWarning;
      try {
        return (await import(SQLITE_SPECIFIER)) as SqliteModule;
      } catch {
        return null;
      } finally {
        process.emitWarning = orig;
      }
    })();
  }
  return sqliteMod;
}

type Db = SqliteDb;

function openDb(sqlite: SqliteModule, path: string, warn: (m: string) => void): { db: Db; cleanup: () => void } | null {
  try {
    const db = new sqlite.DatabaseSync(path, { readOnly: true });
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    return { db, cleanup: () => db.close() };
  } catch (err) {
    // fallback: copy db + wal together (never shm without wal) and open the copy
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(tmpdir(), 'clausage-opencode-'));
      const target = join(dir, basename(path));
      copyFileSync(path, target);
      if (existsSync(path + '-wal')) copyFileSync(path + '-wal', target + '-wal');
      const db = new sqlite.DatabaseSync(target, { readOnly: false });
      const d = dir;
      return {
        db,
        cleanup: () => {
          try {
            db.close();
          } catch {
            /* ignore */
          }
          rmSync(d, { recursive: true, force: true });
        },
      };
    } catch (err2) {
      if (dir) rmSync(dir, { recursive: true, force: true });
      warn(`opencode: cannot open ${path}: ${(err2 as Error).message ?? (err as Error).message}`);
      return null;
    }
  }
}

function tableColumns(db: Db, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

function readSqlite(db: Db, raw: RawData, warn: (m: string) => void, path: string): void {
  const sCols = tableColumns(db, 'session');
  const mCols = tableColumns(db, 'message');
  const pCols = tableColumns(db, 'part');
  const projCols = tableColumns(db, 'project');
  if (!mCols.has('data') || !mCols.has('session_id')) {
    warn(`opencode: ${path} has no message table; skipped`);
    return;
  }

  if (sCols.has('id')) {
    const col = (c: string) => (sCols.has(c) ? `s.${c}` : 'NULL');
    const joinProject = sCols.has('project_id') && projCols.has('worktree');
    const sql = `SELECT s.id AS id, ${col('parent_id')} AS parent_id, ${col('title')} AS title,
        ${col('directory')} AS directory, ${col('version')} AS version,
        ${col('time_created')} AS time_created, ${col('time_updated')} AS time_updated,
        ${joinProject ? 'p.worktree' : 'NULL'} AS worktree
      FROM session s ${joinProject ? 'LEFT JOIN project p ON p.id = s.project_id' : ''}`;
    for (const r of db.prepare(sql).all() as Array<Record<string, unknown>>) {
      addSession(raw, {
        id: String(r.id),
        parentId: str(r.parent_id),
        title: str(r.title),
        directory: str(r.directory),
        worktree: str(r.worktree),
        version: str(r.version),
        timeCreated: num(r.time_created),
        timeUpdated: num(r.time_updated),
      });
    }
  }

  // step-finish aggregates per message (only relevant when a message has >1 steps)
  const steps = new Map<string, StepAgg>();
  if (pCols.has('data') && pCols.has('message_id')) {
    const sql = `SELECT message_id AS mid, COUNT(*) AS n,
        SUM(COALESCE(json_extract(data,'$.tokens.input'),0)) AS input,
        SUM(COALESCE(json_extract(data,'$.tokens.output'),0)) AS output,
        SUM(COALESCE(json_extract(data,'$.tokens.reasoning'),0)) AS reasoning,
        SUM(COALESCE(json_extract(data,'$.tokens.cache.read'),0)) AS cache_read,
        SUM(COALESCE(json_extract(data,'$.tokens.cache.write'),0)) AS cache_write,
        SUM(COALESCE(json_extract(data,'$.cost'),0)) AS cost
      FROM part WHERE CASE WHEN json_valid(data) THEN json_extract(data,'$.type') END = 'step-finish' GROUP BY message_id`;
    for (const r of db.prepare(sql).all() as Array<Record<string, unknown>>) {
      steps.set(String(r.mid), {
        count: num(r.n),
        input: num(r.input),
        output: num(r.output),
        reasoning: num(r.reasoning),
        cacheRead: num(r.cache_read),
        cacheWrite: num(r.cache_write),
        cost: num(r.cost),
      });
    }

    // The tool's name only ($.tool, capped); the call's input and output ($.state) are never selected.
    const toolSql = `SELECT id, ${pCols.has('session_id') ? 'session_id' : 'NULL'} AS sid, message_id AS mid,
        CASE WHEN json_valid(data) THEN CASE WHEN json_type(data,'$.tool') = 'text' THEN substr(json_extract(data,'$.tool'),1,200) END END AS tool_name
      FROM part WHERE CASE WHEN json_valid(data) THEN json_extract(data,'$.type') END = 'tool'`;
    const toolRows = db.prepare(toolSql).all() as Array<Record<string, unknown>>;
    // session id may need resolving from message when part.session_id is absent
    const pending: Array<{ id: string; mid: string; name: unknown }> = [];
    for (const r of toolRows) {
      if (str(r.sid)) addToolPart(raw, String(r.id), String(r.sid), r.tool_name);
      else pending.push({ id: String(r.id), mid: String(r.mid), name: r.tool_name });
    }
    if (pending.length) {
      const look = db.prepare('SELECT session_id FROM message WHERE id = ?');
      for (const p of pending) {
        const row = look.get(p.mid) as { session_id?: string } | undefined;
        if (row?.session_id) addToolPart(raw, p.id, row.session_id, p.name);
      }
    }
  }

  const sql = `SELECT id, session_id, time_created,
      json_extract(data,'$.role') AS role,
      json_extract(data,'$.time.created') AS t_created,
      json_extract(data,'$.time.completed') AS t_completed,
      json_extract(data,'$.modelID') AS model_id,
      json_extract(data,'$.speed') AS speed,
      json_extract(data,'$.service_tier') AS service_tier,
      json_extract(data,'$.providerID') AS provider_id,
      json_extract(data,'$.path.cwd') AS cwd,
      json_extract(data,'$.tokens.input') AS input,
      json_extract(data,'$.tokens.output') AS output,
      json_extract(data,'$.tokens.reasoning') AS reasoning,
      json_extract(data,'$.tokens.cache.read') AS cache_read,
      json_extract(data,'$.tokens.cache.write') AS cache_write,
      json_extract(data,'$.cost') AS cost,
      json_type(data,'$.error') AS err
    FROM message WHERE json_valid(data)`;
  // A single malformed data row must not make json_extract abort the whole query (and drop the DB).
  try {
    const bad = db.prepare('SELECT COUNT(*) AS n FROM message WHERE NOT json_valid(data)').get() as { n?: number } | undefined;
    if (bad?.n) warn(`opencode: ${path}: skipped ${bad.n} message row(s) with malformed JSON`);
  } catch {
    /* ignore */
  }
  for (const r of db.prepare(sql).all() as Array<Record<string, unknown>>) {
    const id = String(r.id);
    addMessage(raw, {
      id,
      sessionId: String(r.session_id),
      role: String(r.role ?? ''),
      created: num(r.t_created) || num(r.time_created),
      completed: num(r.t_completed) || undefined,
      modelID: str(r.model_id),
      speed: providerSpeed(str(r.model_id) ?? '', str(r.speed), str(r.service_tier)),
      providerID: str(r.provider_id),
      cwd: str(r.cwd),
      input: num(r.input),
      output: num(r.output),
      reasoning: num(r.reasoning),
      cacheRead: num(r.cache_read),
      cacheWrite: num(r.cache_write),
      cost: num(r.cost),
      hasError: r.err != null,
      steps: steps.get(id),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// legacy JSON storage

function listDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(p, 'utf8'));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

function readLegacy(storage: string, raw: RawData): void {
  const sessionDir = join(storage, 'session');
  for (const projectId of listDir(sessionDir)) {
    const pdir = join(sessionDir, projectId);
    for (const f of listDir(pdir)) {
      if (!f.endsWith('.json')) continue;
      const d = readJson(join(pdir, f));
      if (!d || !str(d.id)) continue;
      const time = isObj(d.time) ? d.time : {};
      addSession(raw, {
        id: String(d.id),
        parentId: str(d.parentID),
        title: str(d.title),
        directory: str(d.directory),
        version: str(d.version),
        timeCreated: num(time.created),
        timeUpdated: num(time.updated),
      });
    }
  }

  const messageDir = join(storage, 'message');
  const partDir = join(storage, 'part');
  for (const sid of listDir(messageDir)) {
    const sdir = join(messageDir, sid);
    for (const f of listDir(sdir)) {
      if (!f.endsWith('.json')) continue;
      const d = readJson(join(sdir, f));
      if (!d || !str(d.id)) continue;
      const id = String(d.id);
      const sessionId = str(d.sessionID) ?? sid;
      const time = isObj(d.time) ? d.time : {};
      const tokens = isObj(d.tokens) ? d.tokens : {};
      const cache = isObj(tokens.cache) ? tokens.cache : {};
      const path = isObj(d.path) ? d.path : {};

      // parts: only type / tool name / tokens / cost are retained
      let steps: StepAgg | undefined;
      const mpdir = join(partDir, id);
      for (const pf of listDir(mpdir)) {
        if (!pf.endsWith('.json')) continue;
        const p = readJson(join(mpdir, pf));
        if (!p) continue;
        if (p.type === 'tool') {
          addToolPart(raw, str(p.id) ?? `${id}/${pf}`, str(p.sessionID) ?? sessionId, p.tool);
        } else if (p.type === 'step-finish') {
          const t = isObj(p.tokens) ? p.tokens : {};
          const c = isObj(t.cache) ? t.cache : {};
          steps ??= { count: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
          steps.count++;
          steps.input += num(t.input);
          steps.output += num(t.output);
          steps.reasoning += num(t.reasoning);
          steps.cacheRead += num(c.read);
          steps.cacheWrite += num(c.write);
          steps.cost += num(p.cost);
        }
      }

      addMessage(raw, {
        id,
        sessionId,
        role: String(d.role ?? ''),
        created: num(time.created),
        completed: num(time.completed) || undefined,
        modelID: str(d.modelID),
        speed: providerSpeed(str(d.modelID) ?? '', str(d.speed), str(d.service_tier)),
        providerID: str(d.providerID),
        cwd: str(path.cwd) ?? str(path.root),
        input: num(tokens.input),
        output: num(tokens.output),
        reasoning: num(tokens.reasoning),
        cacheRead: num(cache.read),
        cacheWrite: num(cache.write),
        cost: num(d.cost),
        hasError: d.error != null,
        steps,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// build results

function rootOf(sessions: Map<string, RawSession>, id: string): string {
  let cur = id;
  const seen = new Set<string>();
  for (;;) {
    seen.add(cur);
    const parent = sessions.get(cur)?.parentId;
    if (!parent || seen.has(parent)) return cur;
    cur = parent;
  }
}

function build(raw: RawData, opts: LoadOptions): { events: UsageEvent[]; sessions: SessionInfo[] } {
  const events: UsageEvent[] = [];
  const bySession = new Map<string, RawMessage[]>();
  for (const m of raw.messages.values()) {
    let list = bySession.get(m.sessionId);
    if (!list) bySession.set(m.sessionId, (list = []));
    list.push(m);
  }

  const projectOf = (sid: string, msgs: RawMessage[]): string => {
    const s = raw.sessions.get(sid);
    const p = s?.directory ?? s?.worktree ?? msgs.find((m) => m.cwd)?.cwd;
    return p ? normPath(p) : '';
  };

  const sessions: SessionInfo[] = [];
  const allSessionIds = new Set<string>([...raw.sessions.keys(), ...bySession.keys()]);
  for (const sid of allSessionIds) {
    const s = raw.sessions.get(sid);
    const msgs = (bySession.get(sid) ?? []).sort((a, b) => a.created - b.created);
    const rootSessionId = rootOf(raw.sessions, sid);
    const isSubagent = !!s?.parentId;
    const project = projectOf(sid, msgs);
    const models = new Set<string>();
    const stamps: number[] = [];
    let userMessages = 0;
    let assistantMessages = 0;
    let lastTs = 0;

    for (const m of msgs) {
      if (m.created) stamps.push(m.created);
      if (m.completed) stamps.push(m.completed);
      lastTs = Math.max(lastTs, m.created, m.completed ?? 0);
      if (m.role === 'user') {
        userMessages++;
        continue;
      }
      if (m.role !== 'assistant') continue;
      assistantMessages++;

      const multi = m.steps && m.steps.count > 1;
      const src = multi ? m.steps! : m;
      const input = src.input;
      const output = src.output;
      const reasoning = src.reasoning;
      const cacheRead = src.cacheRead;
      const cacheWrite = src.cacheWrite;
      const cost = multi ? Math.max(m.steps!.cost, m.cost) : m.cost;
      if (input + output + reasoning + cacheRead + cacheWrite === 0 && cost === 0) continue; // errored / empty

      const model = m.modelID ?? 'unknown';
      models.add(model);
      const ev: UsageEvent = {
        tool: TOOL,
        id: `opencode:${m.id}`,
        timestamp: m.created,
        sessionId: sid,
        rootSessionId,
        isSubagent,
        project: project || (m.cwd ? normPath(m.cwd) : ''),
        model,
        provider: m.providerID,
        ...(m.speed ? { speed: m.speed } : {}),
        inputTokens: input,
        outputTokens: output + reasoning,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        cacheWrite1hTokens: 0,
        reasoningTokens: reasoning,
        costUSD: 0,
      };
      // cost 0 means OpenCode had no price for the model -> leave recorded cost absent
      if (cost > 0) ev.recordedCostUSD = cost;
      if (m.completed && m.completed >= m.created) ev.durationMs = m.completed - m.created;
      if (opts.since !== undefined && ev.timestamp < opts.since) continue;
      if (opts.until !== undefined && ev.timestamp > opts.until) continue;
      events.push(ev);
    }

    const startedAt = s?.timeCreated || msgs[0]?.created || 0;
    const endedAt = Math.max(s?.timeUpdated ?? 0, lastTs, startedAt);
    const info: SessionInfo = {
      tool: TOOL,
      sessionId: sid,
      rootSessionId,
      isSubagent,
      project,
      startedAt,
      endedAt,
      activeMs: activeMsFrom(stamps),
      userMessages,
      assistantMessages,
      toolCalls: raw.toolCalls.get(sid) ?? 0,
      turns: userMessages,
      models: [...models],
    };
    const byName = toolCallsRecord(raw.toolNames.get(sid) ?? new Map());
    if (byName) info.toolCallsByName = byName;
    if (s?.title) info.title = s.title;
    if (s?.version) info.version = s.version;
    if (opts.since !== undefined && endedAt < opts.since) continue;
    if (opts.until !== undefined && startedAt > opts.until) continue;
    sessions.push(info);
  }

  events.sort((a, b) => a.timestamp - b.timestamp);
  sessions.sort((a, b) => a.startedAt - b.startedAt);
  return { events, sessions };
}

// ---------------------------------------------------------------------------------------------

function defaultPaths(): string[] {
  const env = envList('OPENCODE_DATA_DIR');
  if (env) return env.map(normPath);
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return [normPath(join(xdg, 'opencode'))];
  return [normPath(join(homedir(), '.local', 'share', 'opencode'))];
}

function isDbFile(name: string): boolean {
  return /^opencode.*\.db$/i.test(name);
}

async function load(opts: LoadOptions): Promise<ParseResult> {
  const warn = opts.warn ?? (() => {});
  const roots = (opts.paths?.opencode?.length ? opts.paths.opencode : defaultPaths()).map(normPath);
  const raw = newRaw();
  const sources: string[] = [];

  for (const root of roots) {
    let st;
    try {
      st = statSync(root);
    } catch {
      continue;
    }
    // allow pointing directly at a db file
    const dbFiles: string[] = [];
    let dataDir = root;
    if (st.isFile()) {
      if (root.toLowerCase().endsWith('.db')) dbFiles.push(root);
      dataDir = '';
    } else {
      for (const f of listDir(root)) if (isDbFile(f)) dbFiles.push(join(root, f));
    }

    let used = false;
    if (dbFiles.length) {
      const sqlite = await getSqlite();
      if (!sqlite) warn('opencode: node:sqlite is unavailable in this Node.js version; SQLite data skipped');
      else {
        for (const f of dbFiles) {
          const h = openDb(sqlite, f, warn);
          if (!h) continue;
          try {
            readSqlite(h.db, raw, warn, f);
            used = true;
          } catch (err) {
            warn(`opencode: failed reading ${f}: ${(err as Error).message}`);
          } finally {
            h.cleanup();
          }
        }
      }
    }
    if (dataDir) {
      const storage = join(dataDir, 'storage');
      if (existsSync(join(storage, 'message')) || existsSync(join(storage, 'session'))) {
        try {
          readLegacy(storage, raw);
          used = true;
        } catch (err) {
          warn(`opencode: failed reading legacy storage ${storage}: ${(err as Error).message}`);
        }
      }
    }
    if (used) sources.push(root);
  }

  const { events, sessions } = build(raw, opts);
  return { tool: TOOL, events, sessions, historical: [], sources };
}

export const opencodeParser: ToolParser = {
  tool: TOOL,
  defaultPaths,
  load,
};
