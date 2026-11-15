/**
 * Amp (Sourcegraph / ampcode.com) usage parser. See docs/formats/amp.md.
 *
 * Source: thread files `<amp>/threads/T-<uuid>.json`, one JSON object per thread, where `<amp>` is
 * `$AMP_DATA_DIR` (comma-separated, the convention ccusage uses) or `$XDG_DATA_HOME/amp` /
 * `~/.local/share/amp`. A root may also be a directory of exported thread JSON files.
 *
 * Thread shape (only these keys are read):
 *   { id, created (epoch ms), title?, env?.initial.trees[].uri (file:// workspace root),
 *     messages: [{ role, messageId, meta?.sentAt, usage?: { model, inputTokens, outputTokens,
 *       cacheCreationInputTokens, cacheReadInputTokens, totalTokens?, timestamp },
 *       content: [{ type, name? }] }],
 *     usageLedger?: { events: [{ id, timestamp, model, tokens: { input, output, total? },
 *       toMessageId?, credits? }] } }
 * Amp's message `inputTokens` is already uncached (Anthropic-style: `totalInputTokens` =
 * input + cache creation + cache read), so the counts map straight onto the disjoint shape.
 *
 * Like ccusage, when the thread has a non-empty `usageLedger.events` those events are the usage
 * records (they also cover calls that have no assistant message) and the cache split comes from
 * the assistant message the event points at (`toMessageId`); otherwise each assistant message's
 * `usage` is one event. A total without a split is counted as output (ccusage's fallback).
 * Amp `credits` are not converted to USD (no documented rate), so there is no recorded cost.
 *
 * PRIVACY: a thread file must be parsed whole, but only ids, roles, timestamps, model names, token
 * numbers, tool names, the thread title and the workspace URI are kept; message text, thinking,
 * tool inputs and results are dropped with the parsed object. `secrets.json`, settings and logs
 * under the Amp data dir are never opened.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadOptions, ParseResult, SessionInfo, ToolParser, UsageEvent } from '../types.js';
import { providerOf } from './model-provider.js';
import { computeActiveMs, envPaths, exists, homeDir, normalizePath, toEpochMs, walkFiles } from './util.js';

const TOOL = 'amp' as const;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}
function ms(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const t = toEpochMs(v);
  return Number.isFinite(t) && t > 0 ? t : 0;
}
function idOf(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return str(v);
}

interface LiteUsage {
  model?: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
  ts: number;
}

interface LiteMessage {
  role: string;
  messageId?: string;
  ts: number;
  usage?: LiteUsage;
  tools: string[];
}

interface LiteLedgerEvent {
  id?: string;
  ts: number;
  model?: string;
  input: number;
  output: number;
  total: number;
  cacheWrite?: number;
  cacheRead?: number;
  toMessageId?: string;
}

interface LiteThread {
  id: string;
  created: number;
  title?: string;
  project: string;
  messages: LiteMessage[];
  ledger: LiteLedgerEvent[];
}

function liteUsage(u: Obj, fallbackTs: number): LiteUsage {
  return {
    model: str(u.model),
    input: n(u.inputTokens),
    output: n(u.outputTokens),
    cacheWrite: n(u.cacheCreationInputTokens),
    cacheRead: n(u.cacheReadInputTokens),
    total: n(u.totalTokens),
    ts: ms(u.timestamp) || fallbackTs,
  };
}

function projectOf(thread: Obj): string {
  const env = isObj(thread.env) ? thread.env : undefined;
  const initial = env && isObj(env.initial) ? env.initial : undefined;
  const trees = initial && Array.isArray(initial.trees) ? initial.trees : [];
  for (const t of trees) {
    const uri = isObj(t) ? str(t.uri) : undefined;
    if (!uri) continue;
    try {
      return normalizePath(uri.startsWith('file:') ? fileURLToPath(uri) : uri);
    } catch {
      /* not a file URI */
    }
  }
  return '';
}

/** Reduce a parsed thread to the metadata and numbers clausage needs. */
export function liteThread(data: unknown, fallbackId: string): LiteThread | null {
  if (!isObj(data)) return null;
  const id = str(data.id) ?? fallbackId;
  const created = ms(data.created);
  const messages: LiteMessage[] = [];
  for (const m of Array.isArray(data.messages) ? data.messages : []) {
    if (!isObj(m)) continue;
    const role = str(m.role);
    if (!role) continue;
    const meta = isObj(m.meta) ? m.meta : undefined;
    const ts = ms(meta?.sentAt) || ms(m.timestamp);
    const tools: string[] = [];
    if (role === 'assistant' && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (isObj(block) && block.type === 'tool_use') tools.push(str(block.name) ?? 'unknown');
      }
    }
    const lite: LiteMessage = { role, messageId: idOf(m.messageId), ts, tools };
    if (role === 'assistant' && isObj(m.usage)) {
      lite.usage = liteUsage(m.usage, ts);
      if (!lite.ts) lite.ts = lite.usage.ts;
    }
    messages.push(lite);
  }
  const ledger: LiteLedgerEvent[] = [];
  const ul = isObj(data.usageLedger) ? data.usageLedger : undefined;
  for (const e of ul && Array.isArray(ul.events) ? ul.events : []) {
    if (!isObj(e)) continue;
    const tokens = isObj(e.tokens) ? e.tokens : {};
    const ev: LiteLedgerEvent = {
      id: idOf(e.id),
      ts: ms(e.timestamp),
      model: str(e.model),
      input: n(tokens.input),
      output: n(tokens.output),
      total: n(tokens.total),
      toMessageId: idOf(e.toMessageId),
    };
    if ('cacheCreationInputTokens' in tokens) ev.cacheWrite = n(tokens.cacheCreationInputTokens);
    if ('cacheReadInputTokens' in tokens) ev.cacheRead = n(tokens.cacheReadInputTokens);
    ledger.push(ev);
  }
  const lite: LiteThread = { id, created, project: projectOf(data), messages, ledger };
  const title = str(data.title);
  if (title) lite.title = title;
  return lite;
}

// ---------------------------------------------------------------------------------------------

function defaultPaths(): string[] {
  const env = envPaths('AMP_DATA_DIR');
  if (env) return env.map(normalizePath);
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const out = [normalizePath(join(homeDir(), '.local', 'share', 'amp'))];
  if (xdg) out.unshift(normalizePath(join(xdg, 'amp')));
  return [...new Set(out)];
}

const isThreadFile = (_f: string, name: string) => name.endsWith('.json') && name.startsWith('T-');

async function load(opts: LoadOptions): Promise<ParseResult> {
  const warn = opts.warn ?? (() => {});
  const roots = (opts.paths?.amp?.length ? opts.paths.amp : defaultPaths()).map(normalizePath);
  const result: ParseResult = { tool: TOOL, events: [], sessions: [], historical: [], sources: [] };
  const events = new Map<string, UsageEvent>();
  const sessions = new Map<string, SessionInfo>();
  const seenFiles = new Set<string>();
  const inRange = (t: number) =>
    !(opts.since !== undefined && t < opts.since) && !(opts.until !== undefined && t > opts.until);

  for (const root of roots) {
    // `<amp>/threads/**` for a data dir; any T-*.json below the root for a threads / export dir
    const threadsDir = join(root, 'threads');
    const base = (await exists(threadsDir)) ? threadsDir : root;
    const files = (await walkFiles(base, isThreadFile)).filter((f) => !seenFiles.has(f));
    if (!files.length) continue;
    result.sources.push(root);
    for (const file of files) {
      seenFiles.add(file);
      if (opts.since !== undefined) {
        const st = await stat(file).catch(() => null);
        if (st && st.mtimeMs < opts.since) continue;
      }
      let thread: LiteThread | null;
      try {
        thread = liteThread(JSON.parse(await readFile(file, 'utf8')), file.replace(/^.*[\\/]/, '').replace(/\.json$/, ''));
      } catch (err) {
        warn(`amp: cannot read ${file}: ${(err as Error).message}`);
        continue;
      }
      if (!thread) continue;
      if (sessions.has(thread.id)) continue; // same thread in two roots (backup + live)
      addThread(thread, events, sessions, inRange, opts);
    }
  }

  result.events = [...events.values()].sort((a, b) => a.timestamp - b.timestamp);
  result.sessions = [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  return result;
}

function addThread(
  t: LiteThread,
  events: Map<string, UsageEvent>,
  sessions: Map<string, SessionInfo>,
  inRange: (ts: number) => boolean,
  opts: LoadOptions,
): void {
  const models = new Set<string>();
  const stamps: number[] = [];
  const byName: Record<string, number> = {};
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  const byMessageId = new Map<string, LiteMessage>();
  for (const m of t.messages) {
    if (m.ts) stamps.push(m.ts);
    if (m.role === 'user') userMessages++;
    if (m.role !== 'assistant') continue;
    assistantMessages++;
    if (m.messageId) byMessageId.set(m.messageId, m);
    for (const name of m.tools) {
      toolCalls++;
      byName[name] = (byName[name] ?? 0) + 1;
    }
  }

  const push = (key: string, ts: number, model: string, input: number, output: number, cacheRead: number, cacheWrite: number) => {
    if (input + output + cacheRead + cacheWrite === 0) return;
    models.add(model);
    if (ts) stamps.push(ts);
    const id = `amp:${t.id}:${key}`;
    if (!inRange(ts) || events.has(id)) return;
    const ev: UsageEvent = {
      tool: TOOL,
      id,
      timestamp: ts,
      sessionId: t.id,
      rootSessionId: t.id,
      isSubagent: false,
      project: t.project,
      model,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cacheWrite1hTokens: 0,
      reasoningTokens: 0,
      costUSD: 0,
    };
    const provider = providerOf(model);
    if (provider) ev.provider = provider;
    events.set(id, ev);
  };

  const ledger = t.ledger.filter((e) => e.model && e.ts);
  if (ledger.length) {
    ledger.forEach((e, i) => {
      const msg = e.toMessageId ? byMessageId.get(e.toMessageId) : undefined;
      const cacheWrite = e.cacheWrite ?? msg?.usage?.cacheWrite ?? 0;
      const cacheRead = e.cacheRead ?? msg?.usage?.cacheRead ?? 0;
      const output = e.input + e.output + cacheWrite + cacheRead === 0 ? e.total : e.output;
      push(`L:${e.id ?? i}`, e.ts, e.model!, e.input, output, cacheRead, cacheWrite);
    });
  } else {
    t.messages.forEach((m, i) => {
      const u = m.usage;
      if (!u) return;
      const ts = u.ts || m.ts || t.created;
      const output = u.input + u.output + u.cacheWrite + u.cacheRead === 0 ? u.total : u.output;
      push(`M:${m.messageId ?? i}`, ts, u.model ?? 'unknown', u.input, output, u.cacheRead, u.cacheWrite);
    });
  }

  const first = stamps.reduce((a, b) => (a === 0 || b < a ? b : a), 0);
  const last = stamps.reduce((a, b) => (b > a ? b : a), 0);
  const startedAt = t.created || first;
  const endedAt = Math.max(last, startedAt);
  if (opts.since !== undefined && endedAt < opts.since) return;
  if (opts.until !== undefined && startedAt > opts.until) return;
  const info: SessionInfo = {
    tool: TOOL,
    sessionId: t.id,
    rootSessionId: t.id,
    isSubagent: false,
    project: t.project,
    startedAt,
    endedAt,
    activeMs: computeActiveMs(stamps),
    userMessages,
    assistantMessages,
    toolCalls,
    turns: userMessages,
    models: [...models],
  };
  if (toolCalls) info.toolCallsByName = byName;
  if (t.title) info.title = t.title;
  sessions.set(t.id, info);
}

export const ampParser: ToolParser = {
  tool: TOOL,
  defaultPaths,
  load,
};
