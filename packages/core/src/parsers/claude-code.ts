/**
 * Claude Code transcript parser. See docs/formats/claude.md.
 *
 * Sources:
 * - <root>/projects/**\/*.jsonl  (main session files and subagents/**\/agent-<id>.jsonl)
 * - <root>/stats-cache.json      (historical daily aggregates; only used for days with no transcript events)
 * - optional: Claude desktop session metadata (titles only), Windows %LOCALAPPDATA%\Claude-Data
 *
 * PRIVACY: only metadata and numbers are read from records. Prompt / message text, `last-prompt`,
 * `api-request-blob` and similar records are never retained or emitted. Titles (custom-title,
 * summary, agent-name, desktop metadata title) are the only strings extracted.
 */
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type {
  DailyAggregate,
  LoadOptions,
  ParseResult,
  SessionInfo,
  ToolParser,
  UsageEvent,
} from '../types.js';

const TOOL = 'claude-code' as const;
const IDLE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// private helpers (util.ts did not exist when this was written)
// ---------------------------------------------------------------------------------------------

function normPath(p: string): string {
  let s = p;
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  return path.resolve(s);
}

function splitEnvPaths(value: string | undefined): string[] | undefined {
  if (!value || !value.trim()) return undefined;
  const parts = value
    .split(',')
    .flatMap((v) => (process.platform === 'win32' ? [v] : v.split(path.delimiter)))
    .map((v) => v.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function walk(root: string, pred: (p: string) => boolean, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) await walk(full, pred, out);
    else if (e.isFile() && pred(full)) out.push(full);
  }
  return out;
}

async function* jsonLines(file: string): AsyncIterable<unknown> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      yield JSON.parse(t);
    } catch {
      // partial / invalid line (live file) - skip
    }
  }
}

function activeMsFrom(timestamps: number[], idleMs = IDLE_MS): number {
  const ts = [...timestamps].sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i]! - ts[i - 1]!;
    if (gap > 0 && gap < idleMs) sum += gap;
  }
  return sum;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function parseTs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/** numeric compare that treats equal infinities as equal (avoids NaN in sort comparators) */
function cmpNum(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function utcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// roots
// ---------------------------------------------------------------------------------------------

function candidateRoots(): string[] {
  const env = splitEnvPaths(process.env.CLAUDE_CONFIG_DIR);
  if (env) return env.map(normPath);
  const home = homedir();
  return [path.join(home, '.config', 'claude'), path.join(home, '.claude')].map(normPath);
}

/** Returns [root, projectsDir] pairs for roots that have a projects/ dir. */
async function resolveRoots(roots: string[]): Promise<Array<{ root: string; projects: string }>> {
  const out: Array<{ root: string; projects: string }> = [];
  const seen = new Set<string>();
  for (const r of roots) {
    const root = normPath(r);
    let projects = path.join(root, 'projects');
    let base = root;
    if (!(await isDir(projects))) {
      // allow pointing directly at a projects dir
      if (path.basename(root).toLowerCase() === 'projects' && (await isDir(root))) {
        projects = root;
        base = path.dirname(root);
      } else continue;
    }
    const key = process.platform === 'win32' ? projects.toLowerCase() : projects;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ root: base, projects });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// transcripts
// ---------------------------------------------------------------------------------------------

interface FileState {
  sessionKey: string;
  parentSessionId: string;
  isSubagent: boolean;
  project: string;
  timestamps: number[];
  userMessages: number;
  turns: number;
  assistantMessages: number;
  toolCalls: number;
  models: Set<string>;
  version?: string;
  title?: string;
  agentName?: string;
}

const AGENT_FILE_RE = /^agent-(.+)\.jsonl$/i;

function isUserPrompt(rec: Record<string, unknown>): boolean {
  if (rec.isMeta === true) return false;
  const msg = obj(rec.message);
  if (!msg) return false;
  const content = msg.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    if (content.length === 0) return false;
    return !content.some((b) => obj(b)?.type === 'tool_result');
  }
  return false;
}

interface ParseCtx {
  seenRequests: Set<string>;
  seenToolUses: Set<string>;
  seenLines: Set<string>;
  events: UsageEvent[];
}

/** Per-line metadata kept so that cross-file dedupe can run after files are ordered chronologically. */
interface LineItem {
  uuid?: string;
  ts?: number;
  /** 0 = not a prompt, 1 = prompt (turn only, sidechain), 2 = prompt that also counts as a user message */
  prompt: 0 | 1 | 2;
}

interface ParsedFile {
  file: string;
  st: FileState;
  /** every usage line, including in-file duplicates; `dedupeKey` undefined when ids are missing */
  events: Array<{ ev: UsageEvent; dedupeKey?: string }>;
  toolUses: Array<string | undefined>;
  lines: LineItem[];
  firstTs: number;
  lastTs: number;
  /** file creation time (0 if unknown); breaks ties between an original and its fork, which share firstTs */
  birthMs: number;
}

async function parseFile(file: string, projectsDir: string): Promise<ParsedFile | null> {
  const fileName = path.basename(file);
  const agentMatch = AGENT_FILE_RE.exec(fileName);
  const fileAgentId = agentMatch?.[1];
  // Session id from path: main file is <sessionId>.jsonl; subagent file lives under <sessionId>/subagents/...
  const rel = path.relative(projectsDir, file).split(path.sep);
  let pathSessionId: string | undefined;
  const subIdx = rel.indexOf('subagents');
  if (subIdx > 0) pathSessionId = rel[subIdx - 1];
  else if (!fileAgentId) pathSessionId = fileName.replace(/\.jsonl$/i, '');

  const st: FileState = {
    sessionKey: '',
    parentSessionId: '',
    isSubagent: !!fileAgentId,
    project: '',
    timestamps: [],
    userMessages: 0,
    turns: 0,
    assistantMessages: 0,
    toolCalls: 0,
    models: new Set(),
  };
  let recordSessionId: string | undefined;
  let recordAgentId: string | undefined;
  const fileEvents: Array<{ ev: UsageEvent; dedupeKey?: string }> = [];
  const toolUses: Array<string | undefined> = [];
  const lines: LineItem[] = [];
  let firstTs = Infinity;
  let lastTs = -Infinity;
  let lineNo = 0;

  for await (const raw of jsonLines(file)) {
    lineNo++;
    const rec = obj(raw);
    if (!rec) continue;
    const type = rec.type;
    if (!recordSessionId) recordSessionId = str(rec.sessionId);
    if (!recordAgentId) recordAgentId = str(rec.agentId);
    const ts = parseTs(rec.timestamp);
    if (ts !== undefined) {
      if (ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
    }
    const item: LineItem = { uuid: str(rec.uuid), ts, prompt: 0 };
    lines.push(item);
    const cwd = str(rec.cwd);
    if (cwd && !st.project) st.project = normPath(cwd);
    const version = str(rec.version);
    if (version) st.version = version;

    if (type === 'custom-title') {
      const t = str(rec.customTitle) ?? str(rec.title);
      if (t) st.title = t;
      continue;
    }
    if (type === 'summary') {
      const t = str(rec.summary);
      if (t && !st.title) st.title = t;
      continue;
    }
    if (type === 'agent-name') {
      const t = str(rec.agentName);
      if (t) st.agentName = t;
      continue;
    }
    if (type === 'user') {
      if (isUserPrompt(rec)) item.prompt = rec.isSidechain === true ? 1 : 2;
      continue;
    }
    if (type !== 'assistant') continue;

    const msg = obj(rec.message);
    if (!msg) continue;
    // tool calls: content blocks are split across duplicate lines, so collect from every line
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        const block = obj(b);
        if (block?.type !== 'tool_use') continue;
        toolUses.push(str(block.id));
      }
    }
    const usage = obj(msg.usage);
    if (!usage) continue;
    const model = str(msg.model);
    if (!model || model === '<synthetic>') continue;
    if (ts === undefined) continue;

    const msgId = str(msg.id);
    const reqId = str(rec.requestId);
    let id: string;
    let dedupeKey: string | undefined;
    if (msgId && reqId) {
      dedupeKey = `${msgId}:${reqId}`;
      id = `${TOOL}:${dedupeKey}`;
    } else {
      // no dedupe possible (very old logs)
      const uuid = str(rec.uuid);
      id = uuid ? `${TOOL}:uuid:${uuid}` : `${TOOL}:${file}:${lineNo}`;
    }

    const cacheWrite = num(usage.cache_creation_input_tokens);
    const cc = obj(usage.cache_creation);
    // absent split => treat all writes as 5m
    const cacheWrite1h = cc ? Math.min(cacheWrite, num(cc.ephemeral_1h_input_tokens)) : 0;
    const outDetails = obj(usage.output_tokens_details);
    const serverTools = obj(usage.server_tool_use);

    const ev: UsageEvent = {
      tool: TOOL,
      id,
      timestamp: ts,
      sessionId: '', // filled after the file is read
      rootSessionId: '',
      isSubagent: st.isSubagent || rec.isSidechain === true,
      project: cwd ? normPath(cwd) : '',
      model,
      provider: 'anthropic',
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: cacheWrite,
      cacheWrite1hTokens: cacheWrite1h,
      reasoningTokens: num(outDetails?.thinking_tokens),
      costUSD: 0,
    };
    if (typeof rec.costUSD === 'number' && Number.isFinite(rec.costUSD)) ev.recordedCostUSD = rec.costUSD;
    const speed = str(usage.speed);
    if (speed) ev.speed = speed;
    const ws = num(serverTools?.web_search_requests);
    if (ws) ev.webSearchRequests = ws;

    fileEvents.push({ ev, dedupeKey });
  }

  const parentId = pathSessionId ?? recordSessionId;
  if (!parentId) return null;
  const agentId = fileAgentId ?? (st.isSubagent ? recordAgentId : undefined);
  st.parentSessionId = parentId;
  // Subagent files share the parent's sessionId, so give them their own key `<parent>:<agentId>`.
  st.sessionKey = st.isSubagent && agentId ? `${parentId}:${agentId}` : parentId;

  for (const { ev } of fileEvents) {
    ev.sessionId = st.sessionKey;
    ev.rootSessionId = parentId;
    if (!ev.project) ev.project = st.project;
  }
  let birthMs = 0;
  try {
    birthMs = (await stat(file)).birthtimeMs || 0;
  } catch {
    // ignore
  }
  return { file, st, events: fileEvents, toolUses, lines, firstTs, lastTs, birthMs };
}

/**
 * Global dedupe, applied to files in chronological order (earliest record first) so that history
 * copied into a resumed / forked session file stays attributed to the session where it happened.
 * - requests: by `${message.id}:${requestId}` (ccusage key); first occurrence wins
 * - tool calls: by tool_use id
 * - session stats (timestamps, prompts): records copied verbatim carry the same `uuid`, so lines
 *   whose uuid was already seen are skipped (lines without uuid are always counted)
 */
function applyFile(pf: ParsedFile, ctx: ParseCtx): void {
  const st = pf.st;
  for (const li of pf.lines) {
    if (li.uuid) {
      if (ctx.seenLines.has(li.uuid)) continue;
      ctx.seenLines.add(li.uuid);
    }
    if (li.ts !== undefined) st.timestamps.push(li.ts);
    if (li.prompt) {
      st.turns++;
      if (li.prompt === 2) st.userMessages++;
    }
  }
  for (const id of pf.toolUses) {
    if (id) {
      if (ctx.seenToolUses.has(id)) continue;
      ctx.seenToolUses.add(id);
    }
    st.toolCalls++;
  }
  for (const { ev, dedupeKey } of pf.events) {
    if (dedupeKey) {
      if (ctx.seenRequests.has(dedupeKey)) continue;
      ctx.seenRequests.add(dedupeKey);
    }
    st.models.add(ev.model);
    st.assistantMessages++;
    ctx.events.push(ev);
  }
}

// ---------------------------------------------------------------------------------------------
// desktop metadata (titles only)
// ---------------------------------------------------------------------------------------------

async function loadDesktopTitles(warn?: (m: string) => void): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== 'win32' || !local) return titles;
  const base = path.join(local, 'Claude-Data');
  if (!(await isDir(base))) return titles;
  try {
    const files = await walk(
      base,
      (p) => /[\\/]claude-code-sessions[\\/]/i.test(p) && /^local_.*\.json$/i.test(path.basename(p)),
    );
    for (const f of files) {
      try {
        const o = obj(JSON.parse(await readFile(f, 'utf8')));
        const sid = str(o?.cliSessionId);
        const title = str(o?.title);
        if (sid && title) titles.set(sid, title);
      } catch {
        // ignore unreadable metadata
      }
    }
  } catch (e) {
    warn?.(`claude-code: could not read desktop session metadata: ${(e as Error).message}`);
  }
  return titles;
}

// ---------------------------------------------------------------------------------------------
// stats-cache.json
// ---------------------------------------------------------------------------------------------

/**
 * stats-cache.json only stores a combined per-day per-model token total (`dailyModelTokens`);
 * the input/output/cacheRead/cacheWrite split exists only lifetime-per-model (`modelUsage`).
 * We therefore distribute each day's total using that model's lifetime ratio (an ESTIMATE),
 * rounding and assigning the rounding remainder to cacheRead so the day total is exact.
 * If a model has no `modelUsage` entry the whole day total is reported as inputTokens.
 * dailyActivity (messages / sessions / toolCalls) is per day, not per model; it is attached to the
 * day's largest model row only, so summing rows never double counts.
 * Only days that have no transcript events are emitted.
 */
export function parseStatsCache(data: unknown, excludeDates: Set<string>): DailyAggregate[] {
  const root = obj(data);
  if (!root) return [];
  const modelUsage = obj(root.modelUsage) ?? {};
  const activity = new Map<string, Record<string, unknown>>();
  if (Array.isArray(root.dailyActivity)) {
    for (const a of root.dailyActivity) {
      const o = obj(a);
      const d = str(o?.date);
      if (o && d) activity.set(d, o);
    }
  }
  const out: DailyAggregate[] = [];
  if (!Array.isArray(root.dailyModelTokens)) return out;
  for (const day of root.dailyModelTokens) {
    const d = obj(day);
    const date = str(d?.date);
    const byModel = obj(d?.tokensByModel);
    if (!date || !byModel || excludeDates.has(date)) continue;
    const rows: DailyAggregate[] = [];
    for (const [model, totalRaw] of Object.entries(byModel)) {
      const total = num(totalRaw);
      if (total <= 0 || model === '<synthetic>') continue;
      const mu = obj(modelUsage[model]);
      const li = num(mu?.inputTokens);
      const lo = num(mu?.outputTokens);
      const lr = num(mu?.cacheReadInputTokens);
      const lw = num(mu?.cacheCreationInputTokens);
      const lt = li + lo + lr + lw;
      let input: number, output: number, cacheRead: number, cacheWrite: number;
      if (lt > 0) {
        input = Math.round((total * li) / lt);
        output = Math.round((total * lo) / lt);
        cacheWrite = Math.round((total * lw) / lt);
        cacheRead = total - input - output - cacheWrite;
        if (cacheRead < 0) {
          // pathological rounding: fold back into the largest bucket
          cacheWrite += cacheRead;
          cacheRead = 0;
        }
      } else {
        input = total;
        output = cacheRead = cacheWrite = 0;
      }
      rows.push({
        tool: TOOL,
        date,
        model,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        source: 'stats-cache',
      });
    }
    if (rows.length === 0) continue;
    const act = activity.get(date);
    if (act) {
      const sum = (r: DailyAggregate) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
      const top = rows.reduce((a, b) => (sum(b) > sum(a) ? b : a));
      top.messages = num(act.messageCount);
      top.sessions = num(act.sessionCount);
      top.toolCalls = num(act.toolCallCount);
    }
    out.push(...rows);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

async function load(opts: LoadOptions): Promise<ParseResult> {
  const warn = opts.warn;
  const override = opts.paths?.[TOOL];
  const roots = await resolveRoots(override && override.length ? override : candidateRoots());
  const ctx: ParseCtx = { seenRequests: new Set(), seenToolUses: new Set(), seenLines: new Set(), events: [] };
  const states: FileState[] = [];
  const parsed: ParsedFile[] = [];

  for (const { projects } of roots) {
    const files = await walk(projects, (p) => {
      const b = path.basename(p).toLowerCase();
      return b.endsWith('.jsonl') && b !== 'journal.jsonl';
    });
    for (const f of files) {
      try {
        const pf = await parseFile(f, projects);
        if (pf) parsed.push(pf);
      } catch (e) {
        warn?.(`claude-code: failed to read ${f}: ${(e as Error).message}`);
      }
    }
  }
  // Chronological by first record. A fork / resumed copy shares the original's first timestamp, so
  // ties go to the file created first, then the one that ends first (the fork extends the copy),
  // then main files before subagent files, then by path.
  const isSub = (f: string) => (/[\\/]subagents[\\/]/.test(f) ? 1 : 0);
  parsed.sort(
    (a, b) =>
      cmpNum(a.firstTs, b.firstTs) ||
      (a.birthMs && b.birthMs ? cmpNum(a.birthMs, b.birthMs) : 0) ||
      cmpNum(a.lastTs, b.lastTs) ||
      isSub(a.file) - isSub(b.file) ||
      a.file.localeCompare(b.file),
  );
  for (const pf of parsed) {
    applyFile(pf, ctx);
    states.push(pf.st);
  }

  const desktopTitles = override ? new Map<string, string>() : await loadDesktopTitles(warn);

  // merge states that share a session key (same session in two roots)
  const byKey = new Map<string, FileState>();
  for (const st of states) {
    const prev = byKey.get(st.sessionKey);
    if (!prev) {
      byKey.set(st.sessionKey, st);
      continue;
    }
    prev.timestamps.push(...st.timestamps);
    prev.userMessages += st.userMessages;
    prev.turns += st.turns;
    prev.assistantMessages += st.assistantMessages;
    prev.toolCalls += st.toolCalls;
    for (const m of st.models) prev.models.add(m);
    prev.project ||= st.project;
    prev.version ??= st.version;
    prev.title ??= st.title;
    prev.agentName ??= st.agentName;
  }

  const sessions: SessionInfo[] = [];
  for (const st of byKey.values()) {
    if (st.timestamps.length === 0) continue;
    let min = Infinity;
    let max = -Infinity;
    for (const t of st.timestamps) {
      if (t < min) min = t;
      if (t > max) max = t;
    }
    const s: SessionInfo = {
      tool: TOOL,
      sessionId: st.sessionKey,
      rootSessionId: st.parentSessionId,
      isSubagent: st.isSubagent,
      project: st.project,
      startedAt: min,
      endedAt: max,
      activeMs: activeMsFrom(st.timestamps),
      userMessages: st.userMessages,
      assistantMessages: st.assistantMessages,
      toolCalls: st.toolCalls,
      turns: st.turns,
      models: [...st.models].sort(),
    };
    const title = st.isSubagent ? (st.agentName ?? st.title) : (st.title ?? desktopTitles.get(st.sessionKey));
    if (title) s.title = title;
    if (st.version) s.version = st.version;
    sessions.push(s);
  }

  // historical: stats-cache days with no transcript events
  const eventDates = new Set(ctx.events.map((e) => utcDate(e.timestamp)));
  const historical: DailyAggregate[] = [];
  const histSeen = new Set<string>();
  for (const { root } of roots) {
    const file = path.join(root, 'stats-cache.json');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    try {
      for (const row of parseStatsCache(JSON.parse(text), eventDates)) {
        // two roots may both cover a day; keep the first root's rows
        const k = `${row.date}|${row.model}`;
        if (histSeen.has(k)) continue;
        histSeen.add(k);
        historical.push(row);
      }
    } catch (e) {
      warn?.(`claude-code: invalid stats-cache.json at ${file}: ${(e as Error).message}`);
    }
  }

  return {
    tool: TOOL,
    events: ctx.events,
    sessions,
    historical,
    sources: roots.map((r) => r.root),
  };
}

export const claudeCodeParser: ToolParser = {
  tool: TOOL,
  defaultPaths(): string[] {
    return candidateRoots();
  },
  load,
};
