/**
 * Gemini CLI (google-gemini/gemini-cli) usage parser. See docs/formats/gemini.md.
 *
 * Source: chat recordings written by ChatRecordingService under
 *   `<gemini>/tmp/<project-id>/chats/session-<ts>-<short>.jsonl`   (append-only JSONL, current)
 *   `<gemini>/tmp/<project-id>/chats/session-*.json`               (legacy whole-file record)
 *   `<gemini>/tmp/<project-id>/chats/<parentSessionId>/<id>.jsonl`  (subagent sessions)
 * where `<gemini>` is `$GEMINI_CLI_HOME/.gemini` or `~/.gemini` (plus `~/.cache/.gemini`, used under
 * the macOS seatbelt sandbox). `<project-id>` is a short slug (or a legacy sha256 hash); the
 * project root comes from `tmp/<project-id>/.project_root`, else the `projects.json` registry.
 *
 * Each `gemini` message carries `tokens: {input, output, cached, thoughts, tool, total}` copied from
 * the API's usageMetadata. Gemini's `input` (promptTokenCount) INCLUDES cached tokens and
 * `output` (candidatesTokenCount) EXCLUDES thoughts, so:
 *   inputTokens = input − cached (+ tool when total shows it is separate), cacheRead = cached,
 *   outputTokens = output + thoughts, reasoningTokens = thoughts.
 * Messages are re-appended when updated, so records are deduped by message id (last wins).
 * Rewound / removed messages still count: their tokens were billed.
 *
 * PRIVACY: lines are parsed one at a time and reduced to ids, types, timestamps, model names,
 * token numbers and tool-call counts and names; message content, thoughts, tool args/results, memory
 * scratchpads and directories are dropped. Only the `tmp/` tree is read (plus the `projects.json`
 * path registry); settings.json, oauth_creds.json, google_accounts.json, mcp-oauth-tokens.json,
 * installation_id, logs, checkpoints, shell_history and every other folder under the Gemini dir
 * are never opened.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { LoadOptions, ParseResult, SessionInfo, ToolParser, UsageEvent } from '../types.js';
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

const TOOL = 'gemini' as const;
const PROVIDER = 'google';

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
function statOrNull(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

interface LiteTokens {
  input: number;
  output: number;
  cached: number;
  thoughts: number;
  tool: number;
  total: number;
}

interface LiteMessage {
  id: string;
  type: string;
  ts: number;
  model?: string;
  tokens?: LiteTokens;
  toolCalls: number;
  /** names of this message's tool calls (names only; args and results are dropped) */
  toolNames: string[];
}

interface LiteSession {
  sessionId?: string;
  startTime: number;
  lastUpdated: number;
  summary?: string;
  kind?: string;
  messages: Map<string, LiteMessage>;
}

function liteMessage(m: Obj): LiteMessage | null {
  const id = str(m.id);
  const type = str(m.type);
  if (!id || !type) return null;
  const t = isObj(m.tokens) ? m.tokens : undefined;
  const lite: LiteMessage = {
    id,
    type,
    ts: ms(m.timestamp),
    model: str(m.model),
    toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls.length : 0,
    toolNames: [],
  };
  if (Array.isArray(m.toolCalls)) {
    for (const c of m.toolCalls) {
      const name = isObj(c) ? toolCallName(c.name) : undefined;
      if (name) lite.toolNames.push(name);
    }
  }
  if (t) lite.tokens = { input: n(t.input), output: n(t.output), cached: n(t.cached), thoughts: n(t.thoughts), tool: n(t.tool), total: n(t.total) };
  return lite;
}

function applyMeta(s: LiteSession, meta: Obj): void {
  s.sessionId = str(meta.sessionId) ?? s.sessionId;
  s.startTime = ms(meta.startTime) || s.startTime;
  s.lastUpdated = ms(meta.lastUpdated) || s.lastUpdated;
  s.summary = str(meta.summary) ?? s.summary;
  s.kind = str(meta.kind) ?? s.kind;
  if (Array.isArray(meta.messages)) addMessages(s, meta.messages);
}

function addMessages(s: LiteSession, list: unknown[]): void {
  for (const m of list) {
    if (!isObj(m)) continue;
    const l = liteMessage(m);
    if (!l) continue;
    const prev = s.messages.get(l.id);
    // last write wins, but never lose tokens / model recorded by an earlier copy
    if (prev) {
      l.tokens ??= prev.tokens;
      l.model ??= prev.model;
      l.ts ||= prev.ts;
      l.toolCalls = Math.max(l.toolCalls, prev.toolCalls);
      if (prev.toolNames.length > l.toolNames.length) l.toolNames = prev.toolNames;
    }
    s.messages.set(l.id, l);
  }
}

async function readRecording(file: string): Promise<LiteSession | null> {
  const s: LiteSession = { startTime: 0, lastUpdated: 0, messages: new Map() };
  if (file.endsWith('.json')) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
    if (!isObj(data)) return null;
    applyMeta(s, data);
    return s;
  }
  const values = await readJsonlFile(file);
  for (const v of values) {
    if (!isObj(v)) continue;
    if (isObj(v.$set)) applyMeta(s, v.$set);
    else if ('$patch' in v || '$rewindTo' in v) continue; // content edits / rewinds: no usage
    else if (str(v.id) && str(v.type)) addMessages(s, [v]);
    else if (str(v.sessionId)) applyMeta(s, v);
  }
  values.length = 0;
  return s;
}

// ---------------------------------------------------------------------------------------------

function defaultPaths(): string[] {
  const env = envPaths('GEMINI_CLI_HOME');
  if (env) return env.map((h) => normalizePath(join(h, '.gemini')));
  const home = homeDir();
  return [normalizePath(join(home, '.gemini')), normalizePath(join(home, '.cache', '.gemini'))];
}

/** Resolve a root to its `tmp` dir: accepts the Gemini dir, its tmp dir, or a GEMINI_CLI_HOME. */
function tmpDirOf(root: string): string | null {
  for (const c of [join(root, 'tmp'), join(root, '.gemini', 'tmp')]) if (statOrNull(c)?.isDirectory()) return c;
  if (basename(root) === 'tmp' && statOrNull(root)?.isDirectory()) return root;
  return null;
}

/** slug -> absolute project path from `<gemini>/projects.json` ({projects: {path: slug}}). */
function readRegistry(geminiDir: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const data: unknown = JSON.parse(readFileSync(join(geminiDir, 'projects.json'), 'utf8'));
    const projects = isObj(data) && isObj(data.projects) ? data.projects : {};
    for (const [p, slug] of Object.entries(projects)) if (typeof slug === 'string') out.set(slug, p);
  } catch {
    /* no registry */
  }
  return out;
}

function projectFor(tmp: string, slug: string, registry: Map<string, string>): string {
  try {
    const owner = readFileSync(join(tmp, slug, '.project_root'), 'utf8').trim();
    if (owner) return normalizePath(owner);
  } catch {
    /* fall through */
  }
  const p = registry.get(slug);
  return p ? normalizePath(p) : '';
}

async function load(opts: LoadOptions): Promise<ParseResult> {
  const warn = opts.warn ?? (() => {});
  const roots = (opts.paths?.gemini?.length ? opts.paths.gemini : defaultPaths()).map(normalizePath);
  const result: ParseResult = { tool: TOOL, events: [], sessions: [], historical: [], sources: [] };
  const events = new Map<string, UsageEvent>();
  const sessions = new Map<string, SessionInfo>();
  const seenTmp = new Set<string>();
  const inRange = (t: number) =>
    !(opts.since !== undefined && t < opts.since) && !(opts.until !== undefined && t > opts.until);

  for (const root of roots) {
    const tmp = tmpDirOf(root);
    if (!tmp || seenTmp.has(tmp)) continue;
    seenTmp.add(tmp);
    const registry = readRegistry(dirname(tmp));
    let slugs: string[] = [];
    try {
      slugs = readdirSync(tmp, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      continue;
    }
    let used = false;
    for (const slug of slugs) {
      const chats = join(tmp, slug, 'chats');
      if (!statOrNull(chats)?.isDirectory()) continue;
      used = true;
      const project = projectFor(tmp, slug, registry);
      const files = await walkFiles(chats, (_f, name) => name.endsWith('.jsonl') || (name.startsWith('session-') && name.endsWith('.json')));
      for (const file of files) {
        if (opts.since !== undefined) {
          const st = statOrNull(file);
          if (st && st.mtimeMs < opts.since) continue;
        }
        let rec: LiteSession | null;
        try {
          rec = await readRecording(file);
        } catch (err) {
          warn(`gemini: cannot read ${file}: ${(err as Error).message}`);
          continue;
        }
        if (!rec) {
          warn(`gemini: ${file} is not a valid chat recording; skipped`);
          continue;
        }
        const sessionId = rec.sessionId ?? basename(file).replace(/\.jsonl?$/, '');
        // subagent recordings live in chats/<parentSessionId>/<id>.jsonl
        const rel = relative(chats, dirname(file));
        const parentId = rel && !rel.startsWith('..') ? rel.split(sep)[0]! : undefined;
        const isSubagent = rec.kind === 'subagent' || !!parentId;
        const rootSessionId = parentId ?? sessionId;

        const msgs = [...rec.messages.values()].sort((a, b) => a.ts - b.ts);
        const models = new Set<string>();
        let userMessages = 0;
        let assistantMessages = 0;
        let toolCalls = 0;
        const toolNames = new Map<string, number>();
        const stamps: number[] = [];
        for (const m of msgs) {
          if (m.ts) stamps.push(m.ts);
          if (m.type === 'user') userMessages++;
          if (m.type !== 'gemini') continue;
          assistantMessages++;
          toolCalls += m.toolCalls;
          for (const name of m.toolNames) countToolCall(toolNames, name);
          const t = m.tokens;
          if (!t) continue;
          const toolExtra = t.tool > 0 && t.total >= t.input + t.output + t.thoughts + t.tool ? t.tool : 0;
          const input = Math.max(0, t.input - t.cached) + toolExtra;
          const cacheRead = Math.min(t.cached, t.input);
          const output = t.output + t.thoughts;
          if (input + output + cacheRead === 0) continue;
          const model = m.model ?? 'unknown';
          models.add(model);
          const ts = m.ts || rec.startTime;
          const id = `gemini:${sessionId}:${m.id}`;
          if (!inRange(ts) || events.has(id)) continue;
          events.set(id, {
            tool: TOOL,
            id,
            timestamp: ts,
            sessionId,
            rootSessionId,
            isSubagent,
            project,
            model,
            provider: PROVIDER,
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: 0,
            cacheWrite1hTokens: 0,
            reasoningTokens: t.thoughts,
            costUSD: 0,
          });
        }
        const first = stamps.reduce((a, b) => (a === 0 || b < a ? b : a), 0);
        const last = stamps.reduce((a, b) => (b > a ? b : a), 0);
        const startedAt = rec.startTime || first;
        const endedAt = Math.max(rec.lastUpdated, last, startedAt);
        if (opts.since !== undefined && endedAt < opts.since) continue;
        if (opts.until !== undefined && startedAt > opts.until) continue;
        if (sessions.has(sessionId)) continue;
        const info: SessionInfo = {
          tool: TOOL,
          sessionId,
          rootSessionId,
          isSubagent,
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
        if (rec.summary) info.title = rec.summary;
        sessions.set(sessionId, info);
      }
    }
    if (used) result.sources.push(dirname(tmp));
  }

  result.events = [...events.values()].sort((a, b) => a.timestamp - b.timestamp);
  result.sessions = [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  return result;
}

export const geminiParser: ToolParser = {
  tool: TOOL,
  defaultPaths,
  load,
};
