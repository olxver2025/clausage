import { parseArgs } from 'node:util';
import {
  TOOL_IDS,
  WEEK_DAYS,
  endOfDay,
  resolveTimezone,
  startOfDay,
  type CostMode,
  type ToolId,
  type WeekDay,
} from '@clausage/core';

export const COMMANDS = [
  'daily',
  'weekly',
  'monthly',
  'session',
  'blocks',
  'models',
  'projects',
  'tools',
  'summary',
  'pricing',
  'web',
  'sync',
  'statusline',
  'export',
  'mcp',
  'help',
] as const;
export type Command = (typeof COMMANDS)[number];

const COMMAND_ALIASES: Record<string, Command> = {
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
  sessions: 'session',
  block: 'blocks',
  model: 'models',
  project: 'projects',
  tool: 'tools',
  dashboard: 'summary',
  price: 'pricing',
  status: 'statusline',
  'status-line': 'statusline',
  events: 'export',
  'mcp-server': 'mcp',
};

const TOOL_ALIASES: Record<string, ToolId> = {
  claude: 'claude-code',
  hermes: 'hermes',
  'hermes-agent': 'hermes',
  openclaw: 'openclaw',
  clawdbot: 'openclaw',
  moltbot: 'openclaw',
  pi: 'pi',
  'pi-agent': 'pi',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  amp: 'amp',
  ampcode: 'amp',
  qwen: 'qwen',
  'qwen-code': 'qwen',
  qwencode: 'qwen',
  copilot: 'copilot',
  'copilot-cli': 'copilot',
  'github-copilot': 'copilot',
  ghcp: 'copilot',
  aider: 'aider',
  'claude-code': 'claude-code',
  claudecode: 'claude-code',
  cc: 'claude-code',
  codex: 'codex',
  cx: 'codex',
  grok: 'grok',
  'grok-build': 'grok',
  grokbuild: 'grok',
  opencode: 'opencode',
  oc: 'opencode',
  'open-code': 'opencode',
};

export class UsageError extends Error {}

export function parseTool(s: string): ToolId {
  const t = TOOL_ALIASES[s.trim().toLowerCase()];
  if (!t) throw new UsageError(`Unknown tool "${s}". Use one of: claude, codex, grok, opencode, hermes, openclaw, pi, gemini, amp, qwen, copilot, aider`);
  return t;
}

export function parseTools(values: string[] | undefined): ToolId[] | undefined {
  if (!values || !values.length) return undefined;
  const out = new Set<ToolId>();
  for (const v of values) for (const part of v.split(',')) if (part.trim()) out.add(parseTool(part));
  return [...out];
}

function parseDate(s: string, flag: string): string {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s.trim());
  if (!m) throw new UsageError(`${flag} expects YYYYMMDD or YYYY-MM-DD, got "${s}"`);
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (dt.getUTCMonth() !== Number(mo) - 1) throw new UsageError(`${flag}: invalid date "${s}"`);
  return `${y}-${mo}-${d}`;
}

export interface CliOptions {
  command: Command;
  positionals: string[];
  since?: number;
  until?: number;
  sinceDate?: string;
  untilDate?: string;
  tools?: ToolId[];
  json: boolean;
  breakdown: boolean;
  mode: CostMode;
  offline: boolean;
  order: 'asc' | 'desc';
  timezone: string;
  compact: boolean;
  project?: string;
  subagents: boolean;
  paths?: Partial<Record<ToolId, string[]>>;
  refreshPricing: boolean;
  help: boolean;
  version: boolean;
  debug: boolean;
  color?: boolean;
  startOfWeek: WeekDay;
  sessionLength: number;
  active: boolean;
  recent: boolean;
  tokenLimit?: number | 'max';
  id?: string;
  port: number;
  /** ignore other computers' synced usage */
  local: boolean;
  /** sync command: folder to set ('' or 'off' turns sync off) */
  folder?: string;
  /** sync command: rename this computer */
  name?: string;
  /** output format for reports and export (json = --json) */
  format: OutputFormat;
  /** statusline: seconds to reuse computed figures (0 = always recompute) */
  cacheSeconds: number;
}

export const OUTPUT_FORMATS = ['table', 'json', 'csv', 'tsv', 'jsonl'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function parseCli(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    options: {
      since: { type: 'string', short: 's' },
      until: { type: 'string', short: 'u' },
      tool: { type: 'string', short: 't', multiple: true },
      json: { type: 'boolean', short: 'j' },
      breakdown: { type: 'boolean', short: 'b' },
      mode: { type: 'string', short: 'm' },
      offline: { type: 'boolean', short: 'O' },
      order: { type: 'string', short: 'o' },
      timezone: { type: 'string', short: 'z' },
      compact: { type: 'boolean' },
      project: { type: 'string', short: 'p' },
      subagents: { type: 'boolean', default: true },
      local: { type: 'boolean' },
      folder: { type: 'string' },
      name: { type: 'string' },
      path: { type: 'string', multiple: true },
      'refresh-pricing': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      debug: { type: 'boolean', short: 'd' },
      color: { type: 'boolean' },
      'start-of-week': { type: 'string' },
      'session-length': { type: 'string' },
      active: { type: 'boolean', short: 'a' },
      recent: { type: 'boolean', short: 'r' },
      'token-limit': { type: 'string' },
      id: { type: 'string' },
      port: { type: 'string', short: 'P' },
      format: { type: 'string', short: 'f' },
      cache: { type: 'string' },
    },
  });

  let command: Command = 'daily';
  const pos = [...positionals];
  if (pos.length) {
    const first = pos[0]!.toLowerCase();
    const resolved = (COMMANDS as readonly string[]).includes(first) ? (first as Command) : COMMAND_ALIASES[first];
    if (resolved) {
      command = resolved;
      pos.shift();
    } else if (TOOL_ALIASES[first]) {
      // ccusage-style: `clausage codex daily`
      pos.shift();
      values.tool = [...(values.tool ?? []), first];
      const second = pos[0]?.toLowerCase();
      const r2 = second && ((COMMANDS as readonly string[]).includes(second) ? (second as Command) : COMMAND_ALIASES[second]);
      if (r2) {
        command = r2;
        pos.shift();
      }
    } else {
      throw new UsageError(`Unknown command "${pos[0]}". Run "clausage --help".`);
    }
  }

  const timezone = (() => {
    try {
      return resolveTimezone(values.timezone);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  })();

  const mode = (values.mode ?? 'auto') as CostMode;
  if (!['auto', 'calculate', 'display'].includes(mode)) throw new UsageError('--mode must be auto, calculate or display');
  const order = (values.order ?? 'asc') as 'asc' | 'desc';
  if (order !== 'asc' && order !== 'desc') throw new UsageError('--order must be asc or desc');

  const sinceDate = values.since ? parseDate(values.since, '--since') : undefined;
  const untilDate = values.until ? parseDate(values.until, '--until') : undefined;

  let paths: Partial<Record<ToolId, string[]>> | undefined;
  for (const p of values.path ?? []) {
    const eq = p.indexOf('=');
    if (eq <= 0) throw new UsageError(`--path expects tool=dir, got "${p}"`);
    const tool = parseTool(p.slice(0, eq));
    const dirs = p
      .slice(eq + 1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    paths ??= {};
    (paths[tool] ??= []).push(...dirs);
  }

  const sow = (values['start-of-week'] ?? 'monday').toLowerCase() as WeekDay;
  if (!WEEK_DAYS.includes(sow)) throw new UsageError(`--start-of-week must be one of ${WEEK_DAYS.join(', ')}`);

  const sessionLength = values['session-length'] ? Number(values['session-length']) : 5;
  if (!Number.isFinite(sessionLength) || sessionLength <= 0) throw new UsageError('--session-length must be a positive number of hours');

  let tokenLimit: number | 'max' | undefined;
  if (values['token-limit']) {
    if (values['token-limit'] === 'max') tokenLimit = 'max';
    else {
      tokenLimit = Number(values['token-limit'].replace(/[_,]/g, ''));
      if (!Number.isFinite(tokenLimit) || tokenLimit <= 0) throw new UsageError('--token-limit expects a number or "max"');
    }
  }

  const port = values.port === undefined ? 3456 : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError('--port must be a port number (1-65535)');

  let format = (values.format ?? (values.json ? 'json' : 'table')).toLowerCase() as OutputFormat;
  if (!OUTPUT_FORMATS.includes(format)) throw new UsageError(`--format must be one of ${OUTPUT_FORMATS.join(', ')}`);
  if (values.json && values.format && format !== 'json') throw new UsageError('--json and --format disagree; use one');
  if (command === 'export' && format === 'table') format = 'csv';

  const cacheSeconds = values.cache === undefined ? 30 : Number(values.cache);
  if (!Number.isFinite(cacheSeconds) || cacheSeconds < 0) throw new UsageError('--cache expects seconds (0 or more)');

  const tools = parseTools(values.tool);
  if (tools) for (const t of tools) if (!TOOL_IDS.includes(t)) throw new UsageError(`Unknown tool ${t}`);

  return {
    command,
    positionals: pos,
    sinceDate,
    untilDate,
    since: sinceDate ? startOfDay(sinceDate, timezone) : undefined,
    until: untilDate ? endOfDay(untilDate, timezone) : undefined,
    tools,
    json: format === 'json',
    format,
    cacheSeconds,
    breakdown: Boolean(values.breakdown),
    mode,
    offline: Boolean(values.offline),
    order,
    timezone,
    compact: Boolean(values.compact),
    project: values.project,
    subagents: values.subagents !== false,
    paths,
    refreshPricing: Boolean(values['refresh-pricing']),
    help: Boolean(values.help) || command === 'help',
    version: Boolean(values.version),
    debug: Boolean(values.debug),
    color: values.color,
    startOfWeek: sow,
    sessionLength,
    active: Boolean(values.active),
    recent: Boolean(values.recent),
    tokenLimit,
    id: values.id,
    port,
    local: Boolean(values.local),
    folder: values.folder,
    name: values.name,
  };
}
