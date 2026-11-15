/**
 * Qwen Code (QwenLM/qwen-code) usage parser. See docs/formats/qwen.md.
 *
 * Source: ChatRecordingService transcripts, one append-only JSONL file per session:
 *   `<qwen>/projects/<sanitised-cwd>/chats/<sessionId>.jsonl`
 * where `<qwen>` is `$QWEN_RUNTIME_DIR`, `$QWEN_HOME` or `~/.qwen` (Qwen's own resolution order;
 * `$QWEN_DATA_DIR`, ccusage's override, is honoured too).
 *
 * Each record is `{uuid, parentUuid, sessionId, timestamp, type, subtype?, cwd, version, model?,
 * usageMetadata?, isSidechain?, agentId?, executionContext?: {authType}, systemPayload?}`.
 * `type: 'assistant'` records carry Gemini-shaped `usageMetadata`: `promptTokenCount` INCLUDES the
 * cached prompt (`cachedContentTokenCount`), so input = prompt − cached, cacheRead = cached.
 * Whether `candidatesTokenCount` already includes `thoughtsTokenCount` depends on the provider;
 * this mirrors Qwen's own `outputTokenCount()` (telemetry/gen-ai-usage.ts): when `totalTokenCount`
 * − prompt lies between candidates and candidates + thoughts it decides, otherwise OpenAI-style
 * auth types (`openai`, `openai-responses`, `qwen-oauth`) include thoughts and Gemini ones don't.
 * Cache writes are not persisted (they stay in `promptTokenCount`, i.e. are counted as input).
 *
 * Records are deduped by `uuid` across files (resumed / forked sessions copy records).
 * `system` records with `subtype: 'custom_title'` give the title (`systemPayload.customTitle`),
 * `subtype: 'parent_session'` links a sub-session to `systemPayload.parentSessionId`, and records
 * with `isSidechain: true` come from a subagent.
 *
 * PRIVACY: lines are parsed one at a time and reduced to ids, types, timestamps, cwd, model, auth
 * type, token numbers and the title; `message` (prompts, responses, thoughts, function calls),
 * tool results, `userText` and every other payload are dropped straight away. settings.json,
 * oauth_creds.json, mcp-oauth-tokens.json, memory files, plans and logs are never opened.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoadOptions, ParseResult, SessionInfo, ToolParser, UsageEvent } from '../types.js';
import { computeActiveMs, envPaths, exists, homeDir, mapLimit, normalizePath, readJsonlFile, toEpochMs, walkFiles } from './util.js';

const TOOL = 'qwen' as const;

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

/** Auth types whose output count already includes reasoning (Qwen's outputIncludesThoughts). */
const OUTPUT_INCLUDES_THOUGHTS = new Set(['openai', 'openai-responses', 'qwen-oauth']);

interface LiteUsage {
  prompt: number;
  candidates: number;
  thoughts: number;
  cached: number;
  total: number;
}

interface LiteRecord {
  uuid?: string;
  sessionId?: string;
  type: string;
  subtype?: string;
  ts: number;
  cwd?: string;
  model?: string;
  version?: string;
  authType?: string;
  sidechain: boolean;
  usage?: LiteUsage;
  title?: string;
  parentSessionId?: string;
}

/** Keep only metadata and numbers from one transcript line. */
function liteRecord(v: unknown): LiteRecord | undefined {
  if (!isObj(v)) return undefined;
  const type = str(v.type);
  if (!type) return undefined;
  const r: LiteRecord = {
    uuid: str(v.uuid),
    sessionId: str(v.sessionId),
    type,
    subtype: str(v.subtype),
    ts: ms(v.timestamp),
    cwd: str(v.cwd),
    model: str(v.model),
    version: str(v.version),
    sidechain: v.isSidechain === true,
  };
  const ec = isObj(v.executionContext) ? v.executionContext : undefined;
  if (ec) r.authType = str(ec.authType);
  const u = isObj(v.usageMetadata) ? v.usageMetadata : undefined;
  if (type === 'assistant' && u) {
    r.usage = {
      prompt: n(u.promptTokenCount),
      candidates: n(u.candidatesTokenCount),
      thoughts: n(u.thoughtsTokenCount),
      cached: n(u.cachedContentTokenCount),
      total: n(u.totalTokenCount),
    };
  }
  const payload = isObj(v.systemPayload) ? v.systemPayload : undefined;
  if (payload && r.subtype === 'custom_title') r.title = str(payload.customTitle)?.trim() || undefined;
  if (payload && r.subtype === 'parent_session') r.parentSessionId = str(payload.parentSessionId);
  return r;
}

/** Output tokens with reasoning counted once (see the header). */
export function qwenOutputTokens(u: LiteUsage, authType: string | undefined): number {
  const derived = u.total - u.prompt;
  if (u.total > 0 && derived >= u.candidates && derived <= u.candidates + u.thoughts) return derived;
  if (u.prompt === 0 && u.candidates === 0 && u.total > 0) return u.total; // total without a breakdown
  return authType !== undefined && OUTPUT_INCLUDES_THOUGHTS.has(authType) ? u.candidates : u.candidates + u.thoughts;
}

// ---------------------------------------------------------------------------------------------

function defaultPaths(): string[] {
  const out: string[] = [];
  for (const v of ['QWEN_DATA_DIR', 'QWEN_RUNTIME_DIR', 'QWEN_HOME']) out.push(...(envPaths(v) ?? []));
  if (!out.length) out.push(join(homeDir(), '.qwen'));
  return [...new Set(out.map(normalizePath))];
}

async function load(opts: LoadOptions): Promise<ParseResult> {
  const warn = opts.warn ?? (() => {});
  const roots = (opts.paths?.qwen?.length ? opts.paths.qwen : defaultPaths()).map(normalizePath);
  const result: ParseResult = { tool: TOOL, events: [], sessions: [], historical: [], sources: [] };
  const events = new Map<string, UsageEvent>();
  const sessions = new Map<string, SessionInfo>();
  const seenUuids = new Set<string>();
  const seenFiles = new Set<string>();
  const inRange = (t: number) =>
    !(opts.since !== undefined && t < opts.since) && !(opts.until !== undefined && t > opts.until);

  for (const root of roots) {
    // accepts the Qwen dir or its projects/ dir
    const projects = (await exists(join(root, 'projects'))) ? join(root, 'projects') : root;
    const files = (
      await walkFiles(projects, (full, name) => name.endsWith('.jsonl') && /[\\/]chats[\\/]/.test(full.slice(projects.length)))
    ).filter((f) => !seenFiles.has(f));
    if (!files.length) continue;
    result.sources.push(root);
    files.forEach((f) => seenFiles.add(f));
    const parsed = await mapLimit(files, 8, async (file) => {
      if (opts.since !== undefined) {
        const st = await stat(file).catch(() => null);
        if (st && st.mtimeMs < opts.since) return null;
      }
      try {
        return (await readJsonlFile(file, liteRecord)) as LiteRecord[];
      } catch (err) {
        warn(`qwen: cannot read ${file}: ${(err as Error).message}`);
        return null;
      }
    });
    files.forEach((file, i) => {
      const records = parsed[i];
      if (records?.length) addSession(file, records, events, sessions, seenUuids, inRange, opts);
    });
  }

  result.events = [...events.values()].sort((a, b) => a.timestamp - b.timestamp);
  result.sessions = [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  return result;
}

function addSession(
  file: string,
  records: LiteRecord[],
  events: Map<string, UsageEvent>,
  sessions: Map<string, SessionInfo>,
  seenUuids: Set<string>,
  inRange: (ts: number) => boolean,
  opts: LoadOptions,
): void {
  const sessionId = records.find((r) => r.sessionId)?.sessionId ?? file.replace(/^.*[\\/]/, '').replace(/\.jsonl$/, '');
  const cwd = records.find((r) => r.cwd)?.cwd;
  const project = cwd ? normalizePath(cwd) : '';
  let parentSessionId: string | undefined;
  let title: string | undefined;
  let authType: string | undefined;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let version: string | undefined;
  const models = new Set<string>();
  const stamps: number[] = [];
  const pending: UsageEvent[] = [];

  for (const r of records) {
    if (r.subtype === 'custom_title' && r.title) title = r.title;
    if (r.subtype === 'parent_session' && r.parentSessionId) parentSessionId ??= r.parentSessionId;
    if (r.authType) authType = r.authType;
    if (r.version) version = r.version;
    // a record copied into a resumed / forked file counts once
    if (r.uuid) {
      if (seenUuids.has(r.uuid)) continue;
      seenUuids.add(r.uuid);
    }
    if (r.type === 'system') continue;
    if (r.ts) stamps.push(r.ts);
    if (r.type === 'user' && !r.subtype && !r.sidechain) userMessages++;
    if (r.type === 'tool_result') toolCalls++;
    if (r.type !== 'assistant') continue;
    assistantMessages++;
    const u = r.usage;
    if (!u) continue;
    const cacheRead = Math.min(u.cached, u.prompt);
    const input = Math.max(0, u.prompt - u.cached);
    const output = qwenOutputTokens(u, authType);
    if (input + output + cacheRead === 0) continue;
    const model = r.model ?? 'unknown';
    models.add(model);
    const ts = r.ts;
    const id = `qwen:${sessionId}:${r.uuid ?? `${ts}:${pending.length}`}`;
    if (!ts || !inRange(ts) || events.has(id)) continue;
    pending.push({
      tool: TOOL,
      id,
      timestamp: ts,
      sessionId,
      rootSessionId: sessionId,
      isSubagent: r.sidechain,
      project,
      model,
      ...(/^(qwen|qwq)/i.test(model.replace(/^.*\//, '')) ? { provider: 'alibaba' } : {}),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      reasoningTokens: Math.min(u.thoughts, output),
      costUSD: 0,
    });
  }
  const rootSessionId = parentSessionId ?? sessionId;
  for (const ev of pending) {
    ev.rootSessionId = rootSessionId;
    if (parentSessionId) ev.isSubagent = true;
    events.set(ev.id, ev);
  }

  if (sessions.has(sessionId)) return;
  const first = stamps.reduce((a, b) => (a === 0 || b < a ? b : a), 0);
  const last = stamps.reduce((a, b) => (b > a ? b : a), 0);
  if (!first) return;
  if (opts.since !== undefined && last < opts.since) return;
  if (opts.until !== undefined && first > opts.until) return;
  const info: SessionInfo = {
    tool: TOOL,
    sessionId,
    rootSessionId,
    isSubagent: !!parentSessionId,
    project,
    startedAt: first,
    endedAt: last,
    activeMs: computeActiveMs(stamps),
    userMessages,
    assistantMessages,
    toolCalls,
    turns: userMessages,
    models: [...models],
  };
  if (title) info.title = title;
  if (version) info.version = version;
  sessions.set(sessionId, info);
}

export const qwenParser: ToolParser = {
  tool: TOOL,
  defaultPaths,
  load,
};
