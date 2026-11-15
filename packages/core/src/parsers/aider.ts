/**
 * Aider (Aider-AI/aider) usage parser. See docs/formats/aider.md.
 *
 * Aider keeps no per-request usage on disk by default. The one structured local source is its
 * opt-in analytics log: `aider --analytics-log <file>` (or `AIDER_ANALYTICS_LOG=<file>`) appends
 * one JSON object per analytics event, `{event, properties, user_id, time}` (`time` in epoch
 * seconds). After each reply Aider logs `message_send` with
 *   properties: {main_model, weak_model, editor_model, edit_format, prompt_tokens,
 *                completion_tokens, total_tokens, cost, total_cost}
 * where `cost` is Aider's own USD estimate for that message (from LiteLLM prices) and `main_model`
 * is the LiteLLM model name (`provider/REDACTED` for models unknown to LiteLLM).
 *
 * Sources: `$AIDER_ANALYTICS_LOG` (comma-separated) and `~/.aider/analytics.jsonl` when present;
 * `--path aider=<file or dir>` reads that file, or every `*.jsonl` in that dir.
 *
 * Token mapping: `prompt_tokens` mixes cached and uncached input (Aider adds Anthropic cache
 * writes to it, OpenAI-style providers include cache hits), and cache reads / writes are not
 * logged separately, so all of it is counted as input. `completion_tokens` (includes reasoning) is
 * output. `cost` is the recorded cost. Sessions: each `launched` event starts a new session; the
 * log has no working directory, so the project is unknown.
 *
 * PRIVACY: lines are reduced to the event name, its time, the model name and the token / cost
 * numbers as they are read; `user_id` and every other property (e.g. exception text) are dropped.
 * `~/.aider/analytics.json` (the analytics id file), `.aider.chat.history.md`,
 * `.aider.input.history`, `.aider.conf.yml`, `.env` and caches are never opened.
 */
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { LoadOptions, ParseResult, SessionInfo, ToolParser, UsageEvent } from '../types.js';
import { computeActiveMs, envPaths, homeDir, normalizePath, readJsonlFile, walkFiles } from './util.js';

const TOOL = 'aider' as const;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v !== 'None' ? v : undefined;
}
function num(v: unknown): number {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(x) && x > 0 ? x : 0;
}

interface LiteLine {
  event: string;
  ts: number;
  model?: string;
  prompt: number;
  completion: number;
  cost: number;
}

function liteLine(v: unknown): LiteLine | undefined {
  if (!isObj(v)) return undefined;
  const event = str(v.event);
  const t = num(v.time);
  if (!event || !t) return undefined;
  const ts = t < 1e12 ? Math.round(t * 1000) : t;
  if (event !== 'message_send') return { event, ts, prompt: 0, completion: 0, cost: 0 };
  const p = isObj(v.properties) ? v.properties : {};
  return { event, ts, model: str(p.main_model), prompt: num(p.prompt_tokens), completion: num(p.completion_tokens), cost: num(p.cost) };
}

/** Provider from a LiteLLM-style `provider/model` name. */
function providerOf(model: string): string | undefined {
  const i = model.indexOf('/');
  if (i > 0) return model.slice(0, i).toLowerCase();
  if (/^claude/i.test(model)) return 'anthropic';
  if (/^(gpt|o\d)/i.test(model)) return 'openai';
  if (/^gemini/i.test(model)) return 'google';
  return undefined;
}

// ---------------------------------------------------------------------------------------------

function defaultPaths(): string[] {
  const out = envPaths('AIDER_ANALYTICS_LOG') ?? [];
  out.push(join(homeDir(), '.aider', 'analytics.jsonl'));
  return [...new Set(out.map(normalizePath))];
}

async function filesOf(p: string): Promise<string[]> {
  const st = await stat(p).catch(() => null);
  if (!st) return [];
  if (st.isFile()) return [p];
  // a directory: its JSONL logs (never analytics.json, the id file)
  return st.isDirectory() ? walkFiles(p, (_f, name) => name.endsWith('.jsonl')) : [];
}

async function load(opts: LoadOptions): Promise<ParseResult> {
  const warn = opts.warn ?? (() => {});
  const roots = (opts.paths?.aider?.length ? opts.paths.aider : defaultPaths()).map(normalizePath);
  const result: ParseResult = { tool: TOOL, events: [], sessions: [], historical: [], sources: [] };
  const events = new Map<string, UsageEvent>();
  const sessions = new Map<string, SessionInfo>();
  const seen = new Set<string>();
  const inRange = (t: number) =>
    !(opts.since !== undefined && t < opts.since) && !(opts.until !== undefined && t > opts.until);

  for (const root of roots) {
    const files = (await filesOf(root)).filter((f) => !seen.has(f));
    if (!files.length) continue;
    for (const file of files) {
      seen.add(file);
      if (opts.since !== undefined) {
        const st = await stat(file).catch(() => null);
        if (st && st.mtimeMs < opts.since) continue;
      }
      let lines: LiteLine[];
      try {
        lines = (await readJsonlFile(file, liteLine)) as LiteLine[];
      } catch (err) {
        warn(`aider: cannot read ${file}: ${(err as Error).message}`);
        continue;
      }
      if (lines.length) addFile(file, lines, events, sessions, inRange, opts);
    }
    result.sources.push(root);
  }

  result.events = [...events.values()].sort((a, b) => a.timestamp - b.timestamp);
  result.sessions = [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  return result;
}

function addFile(
  file: string,
  lines: LiteLine[],
  events: Map<string, UsageEvent>,
  sessions: Map<string, SessionInfo>,
  inRange: (ts: number) => boolean,
  opts: LoadOptions,
): void {
  const label = basename(file).replace(/\.jsonl$/, '');
  let cur: { id: string; stamps: number[]; sends: number; models: Set<string> } | undefined;
  const flush = () => {
    if (!cur || !cur.sends) return;
    const startedAt = Math.min(...cur.stamps);
    const endedAt = Math.max(...cur.stamps);
    if (opts.since !== undefined && endedAt < opts.since) return;
    if (opts.until !== undefined && startedAt > opts.until) return;
    sessions.set(cur.id, {
      tool: TOOL,
      sessionId: cur.id,
      rootSessionId: cur.id,
      isSubagent: false,
      project: '',
      startedAt,
      endedAt,
      activeMs: computeActiveMs(cur.stamps),
      userMessages: cur.sends,
      assistantMessages: cur.sends,
      toolCalls: 0,
      turns: cur.sends,
      models: [...cur.models],
    });
  };
  let index = 0;
  for (const l of lines) {
    index++;
    if (l.event === 'launched' || !cur) {
      flush();
      cur = { id: `${label}-${l.ts}`, stamps: [], sends: 0, models: new Set() };
    }
    cur.stamps.push(l.ts);
    if (l.event !== 'message_send') continue;
    cur.sends++;
    if (l.prompt + l.completion === 0) continue;
    const model = l.model ?? 'unknown';
    cur.models.add(model);
    const id = `aider:${cur.id}:${index}`;
    if (!inRange(l.ts) || events.has(id)) continue;
    const ev: UsageEvent = {
      tool: TOOL,
      id,
      timestamp: l.ts,
      sessionId: cur.id,
      rootSessionId: cur.id,
      isSubagent: false,
      project: '',
      model,
      inputTokens: l.prompt,
      outputTokens: l.completion,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      reasoningTokens: 0,
      costUSD: 0,
    };
    if (l.cost > 0) ev.recordedCostUSD = l.cost;
    const provider = providerOf(model);
    if (provider) ev.provider = provider;
    events.set(id, ev);
  }
  flush();
}

export const aiderParser: ToolParser = {
  tool: TOOL,
  defaultPaths,
  load,
};
