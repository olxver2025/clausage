/**
 * OpenClaw (openclaw/openclaw) and Pi (badlogic/pi-mono, `@mariozechner/pi-coding-agent` /
 * `@earendil-works/pi-coding-agent`) usage parsers. See docs/formats/openclaw.md.
 *
 * Both tools write pi-style session transcripts: a `{"type":"session","id","cwd",...}` header,
 * then entries such as `{"type":"message","id","timestamp","message":{"role":"assistant",
 * "provider","model","usage":{input,output,cacheRead,cacheWrite,totalTokens,cost:{total}},
 * "timestamp"}}`, `model_change`, `usage` (model-attributed usage outside the context),
 * `compaction` / `branch_summary` (may carry the summariser's `usage`) and `session_info` (name).
 * pi-ai's Usage is already disjoint: `input` excludes cache reads/writes, `output` includes
 * reasoning (`reasoning` is an informational subset), `cacheWrite1h` is a subset of `cacheWrite`.
 *
 * Sources:
 *  - Pi: `$PI_CODING_AGENT_DIR/sessions/<--encoded-cwd-->/*.jsonl` (default `~/.pi/agent`), plus
 *    `$PI_CODING_AGENT_SESSION_DIR` when set.
 *  - OpenClaw: `$OPENCLAW_STATE_DIR` (default `~/.openclaw`, profile dirs `~/.openclaw-*`, legacy
 *    `~/.clawdbot`, `~/.moltbot`):
 *      `agents/<agentId>/sessions/<id>.jsonl` (pre-v2026.8.1 live transcripts, and archives
 *      `<id>.jsonl.reset.<ts>[.zst]` / `<id>.jsonl.deleted.<ts>[.zst]`), and
 *      `agents/<agentId>/agent/openclaw-agent.sqlite` `transcript_events` (v2026.8.1+).
 *    Labels come from `sessions.json` (`label` only) or `session_nodes.label`.
 *
 * Forks copy earlier entries (same entry id and message timestamp) into a new file, so usage is
 * deduped by `<tool>:<entryId>:<messageTimestamp>` across all files and databases.
 *
 * PRIVACY: JSONL lines are parsed one at a time and only numeric / metadata fields are kept;
 * message content, tool arguments/results, summaries and system prompts are dropped immediately
 * (of a toolCall block only its name is kept).
 * From SQLite only json_extract()ed fields are selected (zstd-compressed rows are decoded in
 * memory and reduced the same way). auth.json, auth-profiles, models.json, settings.json,
 * openclaw.json, credential databases and `auth_profile_*` tables are never opened.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import zlib from 'node:zlib';
import type { LoadOptions, ParseResult, SessionInfo, ToolId, ToolParser, UsageEvent } from '../types.js';
import { providerSpeed } from '../speed.js';
import { getSqlite, openReadOnly, tableColumns, type SqliteDb } from './sqlite-util.js';
import {
  computeActiveMs,
  countToolCall,
  envPaths,
  homeDir,
  normalizePath,
  readJsonlFile,
  toEpochMs,
  toolCallName,
  toolCallsRecord,
  walkFiles,
} from './util.js';

type PiTool = Extract<ToolId, 'openclaw' | 'pi'>;
type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function n(v: unknown): number {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(x) && x > 0 ? x : 0;
}
function ms(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const t = toEpochMs(v);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

// ---------------------------------------------------------------------------------------------
// normalised, text-free view of one transcript entry

interface LiteUsage {
  speed?: string;
  serviceTier?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
  cost: number;
}

interface Lite {
  kind: 'header' | 'assistant' | 'user' | 'usage' | 'model_change' | 'session_info' | 'other';
  id?: string;
  /** entry timestamp, epoch ms */
  ts: number;
  headerId?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  usage?: LiteUsage;
  /** message.timestamp (request start), epoch ms */
  msgTs?: number;
  durationMs?: number;
  toolCalls?: number;
  /** names of this message's toolCall blocks (names only; arguments are dropped) */
  toolNames?: string[];
  name?: string;
}

function liteUsage(u: unknown): LiteUsage | undefined {
  if (!isObj(u)) return undefined;
  const cost = isObj(u.cost) ? n(u.cost.total) : 0;
  return {
    speed: str(u.speed),
    serviceTier: str(u.service_tier),
    input: n(u.input),
    output: n(u.output),
    cacheRead: n(u.cacheRead),
    cacheWrite: n(u.cacheWrite),
    cacheWrite1h: n(u.cacheWrite1h),
    reasoning: n(u.reasoning),
    cost,
  };
}

/** Reduce a parsed transcript entry to metadata + numbers. Content is never copied. */
function toLite(e: unknown): Lite | null {
  if (!isObj(e)) return null;
  const type = str(e.type);
  const ts = ms(e.timestamp);
  const id = str(e.id);
  switch (type) {
    case 'session':
      return { kind: 'header', ts, headerId: id, cwd: str(e.cwd) };
    case 'message': {
      const m = isObj(e.message) ? e.message : undefined;
      if (!m) return { kind: 'other', id, ts };
      if (m.role === 'user') return { kind: 'user', id, ts: ts || ms(m.timestamp) };
      if (m.role !== 'assistant') return { kind: 'other', id, ts };
      let toolCalls = 0;
      const toolNames: string[] = [];
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (!isObj(c) || c.type !== 'toolCall') continue;
          toolCalls++;
          const name = toolCallName(c.name);
          if (name) toolNames.push(name);
        }
      }
      const lite: Lite = {
        kind: 'assistant',
        id,
        ts: ts || ms(m.timestamp),
        provider: str(m.provider),
        model: str(m.model) ?? str(m.responseModel),
        usage: liteUsage(m.usage),
        msgTs: ms(m.timestamp) || undefined,
        toolCalls,
      };
      if (toolNames.length) lite.toolNames = toolNames;
      if (typeof m.durationMs === 'number' && Number.isFinite(m.durationMs) && m.durationMs >= 0) lite.durationMs = m.durationMs;
      return lite;
    }
    case 'model_change':
      return { kind: 'model_change', id, ts, provider: str(e.provider), model: str(e.modelId) };
    case 'usage':
      return { kind: 'usage', id, ts, provider: str(e.provider), model: str(e.model), usage: liteUsage(e.usage) };
    case 'compaction':
    case 'branch_summary':
      return isObj(e.usage) ? { kind: 'usage', id, ts, usage: liteUsage(e.usage) } : { kind: 'other', id, ts };
    case 'session_info':
      return { kind: 'session_info', id, ts, name: str(e.name) };
    default:
      return { kind: 'other', id, ts };
  }
}

// ---------------------------------------------------------------------------------------------
// transcripts -> events / sessions

interface Transcript {
  /** stable fallback id (file name / db session id) */
  sessionId: string;
  records: Lite[];
  title?: string;
  startedAt?: number;
  endedAt?: number;
  cwd?: string;
  /** used for deterministic processing order (originals before forks) */
  order: number;
}

function buildAll(tool: PiTool, transcripts: Transcript[], opts: LoadOptions): { events: UsageEvent[]; sessions: SessionInfo[] } {
  const events = new Map<string, UsageEvent>();
  const sessions = new Map<string, SessionInfo>();
  const inRange = (t: number) =>
    !(opts.since !== undefined && t < opts.since) && !(opts.until !== undefined && t > opts.until);

  transcripts.sort((a, b) => a.order - b.order || (a.sessionId < b.sessionId ? -1 : 1));
  for (const t of transcripts) {
    const header = t.records.find((r) => r.kind === 'header');
    const sessionId = header?.headerId ?? t.sessionId;
    const cwd = header?.cwd ?? t.cwd;
    const project = cwd ? normalizePath(cwd) : '';
    let curModel: string | undefined;
    let curProvider: string | undefined;
    let title = t.title;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    const toolNames = new Map<string, number>();
    const models = new Set<string>();
    const stamps: number[] = [];

    t.records.forEach((r, idx) => {
      if (r.ts) stamps.push(r.ts);
      if (r.kind === 'user') userMessages++;
      else if (r.kind === 'session_info') {
        if (r.name) title = r.name;
      } else if (r.kind === 'model_change') {
        curModel = r.model ?? curModel;
        curProvider = r.provider ?? curProvider;
      }
      if (r.kind !== 'assistant' && r.kind !== 'usage') return;
      if (r.kind === 'assistant') {
        assistantMessages++;
        toolCalls += r.toolCalls ?? 0;
        for (const name of r.toolNames ?? []) countToolCall(toolNames, name);
        if (r.model) curModel = r.model;
        if (r.provider) curProvider = r.provider;
      }
      const u = r.usage;
      if (!u) return;
      const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
      if (tokens === 0 && u.cost === 0) return; // errored / aborted / empty
      const model = r.model ?? curModel ?? 'unknown';
      const provider = r.provider ?? (r.model ? undefined : curProvider);
      const ts = r.msgTs || r.ts || t.startedAt || 0;
      const id = r.id ? `${tool}:${r.id}:${r.msgTs || r.ts}` : `${tool}:${sessionId}:${idx}`;
      models.add(model);
      if (!inRange(ts) || events.has(id)) return;
      const ev: UsageEvent = {
        tool,
        id,
        timestamp: ts,
        sessionId,
        rootSessionId: sessionId,
        isSubagent: false,
        project,
        model,
        inputTokens: u.input,
        outputTokens: u.output,
        cacheReadTokens: u.cacheRead,
        cacheWriteTokens: u.cacheWrite,
        cacheWrite1hTokens: Math.min(u.cacheWrite1h, u.cacheWrite),
        reasoningTokens: Math.min(u.reasoning, u.output),
        costUSD: 0,
      };
      const speed = providerSpeed(model, u.speed, u.serviceTier);
      if (speed) ev.speed = speed;
      if (provider) ev.provider = provider;
      if (u.cost > 0) ev.recordedCostUSD = u.cost;
      if (r.durationMs !== undefined) ev.durationMs = r.durationMs;
      events.set(id, ev);
    });

    if (!t.records.length && !t.startedAt) continue;
    const first = stamps.reduce((a, b) => (a === 0 || b < a ? b : a), 0);
    const last = stamps.reduce((a, b) => (b > a ? b : a), 0);
    const startedAt = t.startedAt || first;
    const endedAt = Math.max(t.endedAt ?? 0, last, startedAt);
    if (opts.since !== undefined && endedAt < opts.since) continue;
    if (opts.until !== undefined && startedAt > opts.until) continue;
    const prev = sessions.get(sessionId);
    if (prev) {
      // same session seen in two sources (e.g. JSONL archive + SQLite import): merge
      prev.startedAt = Math.min(prev.startedAt || startedAt, startedAt || prev.startedAt);
      prev.endedAt = Math.max(prev.endedAt, endedAt);
      prev.userMessages = Math.max(prev.userMessages, userMessages);
      prev.assistantMessages = Math.max(prev.assistantMessages, assistantMessages);
      prev.turns = prev.userMessages;
      if (toolCalls > prev.toolCalls) {
        prev.toolCalls = toolCalls;
        const byName = toolCallsRecord(toolNames);
        if (byName) prev.toolCallsByName = byName;
        else delete prev.toolCallsByName;
      }
      prev.activeMs = Math.max(prev.activeMs, computeActiveMs(stamps));
      prev.models = [...new Set([...prev.models, ...models])];
      if (!prev.title && title) prev.title = title;
      if (!prev.project && project) prev.project = project;
      continue;
    }
    const info: SessionInfo = {
      tool,
      sessionId,
      rootSessionId: sessionId,
      isSubagent: false,
      project,
      startedAt,
      endedAt,
      activeMs: computeActiveMs(stamps),
      userMessages,
      assistantMessages,
      toolCalls,
      turns: userMessages,
      models: [...models],
    };
    const byName = toolCallsRecord(toolNames);
    if (byName) info.toolCallsByName = byName;
    if (title) info.title = title;
    sessions.set(sessionId, info);
  }

  return {
    events: [...events.values()].sort((a, b) => a.timestamp - b.timestamp),
    sessions: [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt),
  };
}

// ---------------------------------------------------------------------------------------------
// JSONL

function statOrNull(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

async function readTranscriptFile(file: string, fallbackId: string, warn: (m: string) => void): Promise<Transcript | null> {
  let values: unknown[];
  try {
    values = await readJsonlFile(file);
  } catch (err) {
    warn(`cannot read ${file}: ${(err as Error).message}`);
    return null;
  }
  const records: Lite[] = [];
  for (const v of values) {
    const l = toLite(v);
    if (l) records.push(l);
  }
  values.length = 0;
  if (!records.length) return null;
  const header = records.find((r) => r.kind === 'header');
  return { sessionId: fallbackId, records, order: header?.ts || records[0]!.ts || 0 };
}

/** OpenClaw's own rule (transcript-file-names.ts parseUsageCountedSessionIdFromFileName). */
export function openclawTranscriptSessionId(fileName: string): string | null {
  const isPrimary = (f: string) =>
    f.endsWith('.jsonl') && !f.endsWith('.trajectory.jsonl') && !/\.checkpoint\.[0-9a-f-]{36}\.jsonl$/i.test(f);
  if (isPrimary(fileName)) return fileName.slice(0, -'.jsonl'.length);
  const name = fileName.endsWith('.zst') ? fileName.slice(0, -4) : fileName;
  for (const reason of ['reset', 'deleted']) {
    const marker = `.jsonl.${reason}.`;
    const i = name.lastIndexOf(marker);
    if (i <= 0) continue;
    const suffix = name.slice(i + marker.length);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z(?:\.[0-9a-f]{32})?$/.test(suffix)) continue;
    const sid = name.slice(0, i);
    return isPrimary(`${sid}.jsonl`) ? sid : null;
  }
  return null;
}

/** `label` per sessionId from an OpenClaw sessions.json index (no other field is kept). */
function readSessionLabels(file: string, into: Map<string, string>): void {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  const visit = (entry: unknown) => {
    if (!isObj(entry)) return;
    const sid = str(entry.sessionId);
    const label = str(entry.label);
    if (sid && label && !into.has(sid)) into.set(sid, label);
  };
  if (Array.isArray(data)) data.forEach(visit);
  else if (isObj(data)) {
    const inner = isObj(data.sessions) ? data.sessions : data;
    for (const v of Object.values(inner)) visit(v);
  }
}

// ---------------------------------------------------------------------------------------------
// OpenClaw SQLite (openclaw-agent.sqlite, transcript_events)

const SQL_FIELDS: Array<[string, string]> = [
  ['type', '$.type'],
  ['id', '$.id'],
  ['timestamp', '$.timestamp'],
  ['cwd', '$.cwd'],
  ['name', '$.name'],
  ['e_provider', '$.provider'],
  ['e_model', '$.model'],
  ['e_model_id', '$.modelId'],
  ['role', '$.message.role'],
  ['provider', '$.message.provider'],
  ['model', '$.message.model'],
  ['response_model', '$.message.responseModel'],
  ['m_ts', '$.message.timestamp'],
  ['duration', '$.message.durationMs'],
  ['u_in', '$.message.usage.input'],
  ['u_out', '$.message.usage.output'],
  ['u_cr', '$.message.usage.cacheRead'],
  ['u_cw', '$.message.usage.cacheWrite'],
  ['u_speed', '$.message.usage.speed'],
  ['u_tier', '$.message.usage.service_tier'],
  ['u_cw1h', '$.message.usage.cacheWrite1h'],
  ['u_reason', '$.message.usage.reasoning'],
  ['u_cost', '$.message.usage.cost.total'],
  ['e_in', '$.usage.input'],
  ['e_out', '$.usage.output'],
  ['e_cr', '$.usage.cacheRead'],
  ['e_cw', '$.usage.cacheWrite'],
  ['e_speed', '$.usage.speed'],
  ['e_tier', '$.usage.service_tier'],
  ['e_cw1h', '$.usage.cacheWrite1h'],
  ['e_reason', '$.usage.reasoning'],
  ['e_cost', '$.usage.cost.total'],
];

/** Rebuild a minimal entry object (numbers + metadata only) from json_extract()ed columns. */
function rowToEntry(r: Obj, toolNames: Array<string | null>): Obj {
  const usage = (p: 'u' | 'e') =>
    r[`${p}_in`] != null || r[`${p}_out`] != null
      ? {
          input: r[`${p}_in`],
          output: r[`${p}_out`],
          cacheRead: r[`${p}_cr`],
          cacheWrite: r[`${p}_cw`],
          speed: r[`${p}_speed`], service_tier: r[`${p}_tier`],
          cacheWrite1h: r[`${p}_cw1h`],
          reasoning: r[`${p}_reason`],
          cost: { total: r[`${p}_cost`] },
        }
      : undefined;
  const content = toolNames.length > 0 ? toolNames.map((name) => ({ type: 'toolCall', name })) : undefined;
  return {
    type: r.type,
    id: r.id,
    timestamp: r.timestamp ?? r.created_at,
    cwd: r.cwd,
    name: r.name,
    provider: r.e_provider,
    model: r.e_model,
    modelId: r.e_model_id,
    usage: usage('e'),
    message:
      r.role != null
        ? {
            role: r.role,
            provider: r.provider,
            model: r.model,
            responseModel: r.response_model,
            timestamp: r.m_ts,
            durationMs: r.duration,
            usage: usage('u'),
            content,
          }
        : undefined,
  };
}

/** The JSON array of tool names built by readAgentDb's query (null entries for unnamed calls). */
function parseToolNames(v: unknown): Array<string | null> {
  if (typeof v !== 'string' || !v) return [];
  try {
    const a: unknown = JSON.parse(v);
    return Array.isArray(a) ? a.map((x) => (typeof x === 'string' ? x : null)) : [];
  } catch {
    return [];
  }
}

function readAgentDb(db: SqliteDb, labels: Map<string, string>, warn: (m: string) => void, path: string): Transcript[] {
  const teCols = tableColumns(db, 'transcript_events');
  if (!teCols.has('session_id') || !teCols.has('event_json')) return [];
  const jx = (p: string) => `CASE WHEN json_valid(event_json) THEN json_extract(event_json,'${p}') END`;
  // one entry per toolCall block: its name only (capped; null when absent), never its arguments
  const toolNames = `CASE WHEN json_valid(event_json) AND json_type(event_json,'$.message.content') = 'array'
      THEN (SELECT json_group_array(CASE WHEN json_type(value,'$.name') = 'text' THEN substr(json_extract(value,'$.name'),1,200) END)
        FROM json_each(event_json,'$.message.content') WHERE json_extract(value,'$.type') = 'toolCall') END`;
  const seq = teCols.has('seq') ? 'seq' : 'rowid';
  const created = teCols.has('created_at') ? 'created_at' : 'NULL';
  const sql = `SELECT session_id, ${seq} AS seq, ${created} AS created_at,
      ${SQL_FIELDS.map(([a, p]) => `${jx(p)} AS ${a}`).join(',\n      ')},
      ${toolNames} AS tool_names
    FROM transcript_events WHERE event_json IS NOT NULL ORDER BY session_id, ${seq}`;

  const bySession = new Map<string, Lite[]>();
  const push = (sid: string, l: Lite | null) => {
    if (!l) return;
    let list = bySession.get(sid);
    if (!list) bySession.set(sid, (list = []));
    list.push(l);
  };
  for (const r of db.prepare(sql).all() as Obj[]) {
    const entry = rowToEntry(r, parseToolNames(r.tool_names));
    const l = toLite(entry);
    if (l && !l.ts) l.ts = ms(r.created_at);
    push(String(r.session_id), l);
  }

  // zstd-compressed rows: decoded in memory, reduced to the same text-free view, then dropped.
  if (teCols.has('event_zstd')) {
    const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
    const cnt = db
      .prepare('SELECT COUNT(*) AS n FROM transcript_events WHERE event_json IS NULL AND event_zstd IS NOT NULL')
      .get() as { n?: number } | undefined;
    if (cnt?.n) {
      if (typeof z.zstdDecompressSync !== 'function') {
        warn(`openclaw: ${path}: ${cnt.n} compressed transcript row(s) skipped (zstd needs Node >= 22.15)`);
      } else {
        const zsql = `SELECT session_id, ${created} AS created_at, event_zstd FROM transcript_events
          WHERE event_json IS NULL AND event_zstd IS NOT NULL ORDER BY session_id, ${seq}`;
        let bad = 0;
        for (const r of db.prepare(zsql).all() as Obj[]) {
          try {
            const buf = Buffer.from(r.event_zstd as Uint8Array);
            const l = toLite(JSON.parse(z.zstdDecompressSync(buf).toString('utf8')));
            if (l && !l.ts) l.ts = ms(r.created_at);
            push(String(r.session_id), l);
          } catch {
            bad++;
          }
        }
        if (bad) warn(`openclaw: ${path}: ${bad} compressed transcript row(s) could not be decoded`);
      }
    }
    const cold = db
      .prepare('SELECT COUNT(*) AS n FROM transcript_events WHERE event_json IS NULL AND event_zstd IS NULL')
      .get() as { n?: number } | undefined;
    if (cold?.n) warn(`openclaw: ${path}: ${cold.n} transcript row(s) are in cold storage and were not read`);
  }

  // Session windows give start/end times; labels come from session_nodes.label only.
  const meta = new Map<string, { startedAt: number; endedAt: number }>();
  const swCols = tableColumns(db, 'session_windows');
  if (swCols.has('session_id')) {
    const c = (x: string) => (swCols.has(x) ? `w.${x}` : 'NULL');
    const snCols = tableColumns(db, 'session_nodes');
    const joinNodes = swCols.has('session_key') && snCols.has('session_key') && snCols.has('label');
    const q = `SELECT w.session_id AS sid, ${c('started_at')} AS started_at, ${c('created_at')} AS created_at,
        ${c('ended_at')} AS ended_at, ${c('updated_at')} AS updated_at, ${joinNodes ? 'n.label' : 'NULL'} AS label
      FROM session_windows w ${joinNodes ? 'LEFT JOIN session_nodes n ON n.session_key = w.session_key' : ''}`;
    for (const r of db.prepare(q).all() as Obj[]) {
      const sid = String(r.sid);
      meta.set(sid, { startedAt: ms(r.started_at) || ms(r.created_at), endedAt: ms(r.ended_at) || ms(r.updated_at) });
      const label = str(r.label);
      if (label && !labels.has(sid)) labels.set(sid, label);
    }
  }

  const out: Transcript[] = [];
  for (const [sid, records] of bySession) {
    const m = meta.get(sid);
    const header = records.find((r) => r.kind === 'header');
    out.push({
      sessionId: sid,
      records,
      startedAt: m?.startedAt,
      endedAt: m?.endedAt,
      order: header?.ts || m?.startedAt || records[0]?.ts || 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// discovery + load

function listDirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function piDefaultPaths(): string[] {
  const agent = envPaths('PI_CODING_AGENT_DIR') ?? [join(homeDir(), '.pi', 'agent')];
  const extra = envPaths('PI_CODING_AGENT_SESSION_DIR') ?? [];
  return [...new Set([...agent, ...extra].map(normalizePath))];
}

function openclawDefaultPaths(): string[] {
  const env = envPaths('OPENCLAW_STATE_DIR');
  if (env) return env.map(normalizePath);
  const home = homeDir();
  const out = [join(home, '.openclaw')];
  // named profiles (`~/.openclaw-<profile>`) and pre-rename installs
  let entries: string[] = [];
  try {
    entries = readdirSync(home);
  } catch {
    /* ignore */
  }
  for (const e of entries.sort()) if (e.startsWith('.openclaw-')) out.push(join(home, e));
  out.push(join(home, '.clawdbot'), join(home, '.moltbot'));
  return out.map(normalizePath);
}

function skipByMtime(file: string, opts: LoadOptions): boolean {
  if (opts.since === undefined) return false;
  const st = statOrNull(file);
  return !!st && st.mtimeMs < opts.since;
}

async function loadPi(opts: LoadOptions): Promise<ParseResult> {
  const warn = opts.warn ?? (() => {});
  const roots = (opts.paths?.pi?.length ? opts.paths.pi : piDefaultPaths()).map(normalizePath);
  const result: ParseResult = { tool: 'pi', events: [], sessions: [], historical: [], sources: [] };
  const transcripts: Transcript[] = [];
  const seenFiles = new Set<string>();
  for (const root of roots) {
    const st = statOrNull(root);
    if (!st) continue;
    let files: string[];
    if (st.isFile()) files = root.endsWith('.jsonl') ? [root] : [];
    else {
      const sessionsDir = join(root, 'sessions');
      const base = statOrNull(sessionsDir)?.isDirectory() ? sessionsDir : root;
      files = await walkFiles(base, (_f, name) => name.endsWith('.jsonl'));
    }
    let used = false;
    for (const f of files) {
      if (seenFiles.has(f)) continue;
      seenFiles.add(f);
      used = true;
      if (skipByMtime(f, opts)) continue;
      const t = await readTranscriptFile(f, basename(f, '.jsonl').replace(/^.*_/, ''), (m) => warn(`pi: ${m}`));
      if (t) transcripts.push(t);
    }
    if (used) result.sources.push(root);
  }
  const built = buildAll('pi', transcripts, opts);
  result.events = built.events;
  result.sessions = built.sessions;
  return result;
}

async function loadOpenclaw(opts: LoadOptions): Promise<ParseResult> {
  const warn = opts.warn ?? (() => {});
  const roots = (opts.paths?.openclaw?.length ? opts.paths.openclaw : openclawDefaultPaths()).map(normalizePath);
  const result: ParseResult = { tool: 'openclaw', events: [], sessions: [], historical: [], sources: [] };
  const transcripts: Transcript[] = [];
  const labels = new Map<string, string>();
  const seen = new Set<string>();

  for (const root of roots) {
    const st = statOrNull(root);
    if (!st) continue;
    const sessionDirs: string[] = [];
    const dbFiles: string[] = [];
    if (st.isFile()) {
      if (root.endsWith('.sqlite')) dbFiles.push(root);
      else sessionDirs.push(dirname(root));
    } else if (statOrNull(join(root, 'agents'))?.isDirectory()) {
      for (const agent of listDirs(join(root, 'agents'))) {
        const a = join(root, 'agents', agent);
        if (statOrNull(join(a, 'sessions'))?.isDirectory()) sessionDirs.push(join(a, 'sessions'));
        const db = join(a, 'agent', 'openclaw-agent.sqlite');
        if (statOrNull(db)?.isFile()) dbFiles.push(db);
      }
      if (statOrNull(join(root, 'sessions'))?.isDirectory()) sessionDirs.push(join(root, 'sessions')); // pre-agent layout
    } else {
      // pointed directly at an agent dir or a sessions dir
      if (statOrNull(join(root, 'sessions'))?.isDirectory()) sessionDirs.push(join(root, 'sessions'));
      else sessionDirs.push(root);
      const db = join(root, 'agent', 'openclaw-agent.sqlite');
      if (statOrNull(db)?.isFile()) dbFiles.push(db);
      if (statOrNull(join(root, 'openclaw-agent.sqlite'))?.isFile()) dbFiles.push(join(root, 'openclaw-agent.sqlite'));
    }

    let used = false;
    for (const dir of sessionDirs) {
      let names: string[] = [];
      try {
        names = readdirSync(dir).sort();
      } catch {
        continue;
      }
      if (names.includes('sessions.json')) readSessionLabels(join(dir, 'sessions.json'), labels);
      for (const name of names) {
        const sid = openclawTranscriptSessionId(name);
        if (!sid) continue;
        const f = join(dir, name);
        if (seen.has(f)) continue;
        seen.add(f);
        used = true;
        if (skipByMtime(f, opts)) continue;
        const t = await readTranscriptFile(f, sid, (m) => warn(`openclaw: ${m}`));
        if (t) transcripts.push(t);
      }
    }
    if (dbFiles.length) {
      const sqlite = await getSqlite();
      if (!sqlite) warn('openclaw: node:sqlite is unavailable in this Node.js version; SQLite transcripts skipped');
      else
        for (const f of dbFiles) {
          if (seen.has(f)) continue;
          seen.add(f);
          const h = openReadOnly(sqlite, f, 'openclaw', warn);
          if (!h) continue;
          try {
            transcripts.push(...readAgentDb(h.db, labels, warn, f));
            used = true;
          } catch (err) {
            warn(`openclaw: failed reading ${f}: ${(err as Error).message}`);
          } finally {
            h.cleanup();
          }
        }
    }
    if (used) result.sources.push(root);
  }

  for (const t of transcripts) {
    const header = t.records.find((r) => r.kind === 'header');
    t.title ??= labels.get(header?.headerId ?? t.sessionId) ?? labels.get(t.sessionId);
  }
  const built = buildAll('openclaw', transcripts, opts);
  result.events = built.events;
  result.sessions = built.sessions;
  return result;
}

export const openclawParser: ToolParser = {
  tool: 'openclaw',
  defaultPaths: openclawDefaultPaths,
  load: loadOpenclaw,
};

export const piParser: ToolParser = {
  tool: 'pi',
  defaultPaths: piDefaultPaths,
  load: loadPi,
};
