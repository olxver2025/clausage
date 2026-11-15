export type ToolId =
  | 'claude-code'
  | 'codex'
  | 'grok'
  | 'opencode'
  | 'hermes'
  | 'openclaw'
  | 'pi'
  | 'gemini'
  | 'amp'
  | 'qwen'
  | 'copilot'
  | 'aider';

export const TOOL_IDS: readonly ToolId[] = [
  'claude-code',
  'codex',
  'grok',
  'opencode',
  'hermes',
  'openclaw',
  'pi',
  'gemini',
  'amp',
  'qwen',
  'copilot',
  'aider',
];

export const TOOL_LABELS: Record<ToolId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  grok: 'Grok Build',
  opencode: 'OpenCode',
  hermes: 'Hermes Agent',
  openclaw: 'OpenClaw',
  pi: 'Pi',
  gemini: 'Gemini CLI',
  amp: 'Amp',
  qwen: 'Qwen Code',
  copilot: 'Copilot CLI',
  aider: 'Aider',
};

/**
 * One billable model response (or, for Grok, one turn per model). Token fields are
 * normalised to be DISJOINT so that
 *   totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
 * holds for every tool:
 * - inputTokens: uncached input only
 * - outputTokens: everything billed at the output rate (includes reasoning for all tools)
 * - reasoningTokens: informational subset of outputTokens
 * - cacheWriteTokens: all cache writes; cacheWrite1hTokens is the subset billed at the 1h rate
 */
export interface UsageEvent {
  tool: ToolId;
  /** globally unique key used for dedupe, prefixed by tool */
  id: string;
  /** epoch milliseconds */
  timestamp: number;
  sessionId: string;
  /** root session id when this event belongs to a subagent / fork; otherwise equal to sessionId */
  rootSessionId: string;
  isSubagent: boolean;
  /** absolute project directory (normalised, no \\?\ prefix) or '' if unknown */
  project: string;
  /** computer the usage was recorded on (set by the loader when sync is configured) */
  machine?: string;
  model: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  reasoningTokens: number;
  /** cost recorded by the tool itself, in USD, when available */
  recordedCostUSD?: number;
  /** filled in by applyCosts() */
  costUSD: number;
  /** true when no price was found and recordedCostUSD was unavailable */
  costUnknown?: boolean;
  /** model API latency for this event if known */
  durationMs?: number;
  /** service tier e.g. 'fast' / 'priority' if known */
  speed?: string;
  webSearchRequests?: number;
}

export interface SessionInfo {
  tool: ToolId;
  sessionId: string;
  rootSessionId: string;
  isSubagent: boolean;
  title?: string;
  project: string;
  /** computer the session ran on (set by the loader when sync is configured) */
  machine?: string;
  /** epoch ms */
  startedAt: number;
  /** epoch ms of last activity */
  endedAt: number;
  /**
   * Active time: sum of turn durations when the tool records them, otherwise the sum of gaps
   * between consecutive events that are shorter than the idle threshold (5 min).
   */
  activeMs: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  /**
   * Tool calls per tool name (e.g. `Bash`, `apply_patch`, `mcp__github__create_pr`), when the
   * tool's logs record names. Names only: arguments, inputs and outputs are never read.
   * `toolCalls` equals the sum of the values, or is larger when some calls carry no name.
   */
  toolCallsByName?: Record<string, number>;
  turns: number;
  models: string[];
  version?: string;
}

/** A source of historical aggregates that do not have per-event detail (e.g. Claude stats-cache.json). */
export interface DailyAggregate {
  tool: ToolId;
  /** YYYY-MM-DD in UTC as stored by the source */
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  messages?: number;
  sessions?: number;
  toolCalls?: number;
  source: string;
  /** computer the aggregate came from (set by the loader when sync is configured) */
  machine?: string;
  /** filled in by the loader (priced like an event); absent until costed */
  costUSD?: number;
  /** true when the loader could not price this aggregate */
  costUnknown?: boolean;
}

/** One usage-limit window as reported by a tool (e.g. Codex's 5-hour and weekly windows). */
export interface LimitWindow {
  /** 0-100 */
  usedPercent: number;
  windowMinutes: number;
  /** epoch ms when the window resets */
  resetsAt: number;
}

/** A tool's own report of how much of its usage limits is used, at one moment. */
export interface LimitSnapshot {
  tool: ToolId;
  /** epoch ms */
  timestamp: number;
  /** the short window (5 hours for Codex) */
  primary?: LimitWindow;
  /** the long window (weekly for Codex) */
  secondary?: LimitWindow;
  planType?: string;
  /** further windows the tool reports, e.g. a model-specific weekly limit */
  extra?: Array<{ key: string; label: string; window: LimitWindow }>;
  machine?: string;
  /** Non-reversible account fingerprint; prevents comparing different accounts. */
  accountKey?: string;
  /** Missing means the provider did not supply reset availability. */
  resets?: ResetAvailability;
}

export interface ResetGrant {
  id: string;
  label: string;
  remaining: number;
  expiresAt?: number;
  usableNow?: boolean;
}

export interface ResetAvailability {
  availableCount: number;
  /** Missing means only the total is known; an empty list means no detail rows. */
  grants?: ResetGrant[];
}

/** A request the provider refused because a usage limit was reached. */
export interface LimitHit {
  tool: ToolId;
  /** epoch ms */
  timestamp: number;
  /** which limit, when the tool says (e.g. 'primary', 'secondary', 'five_hour', 'weekly') */
  kind?: string;
  /** epoch ms when the tool said the limit resets */
  resetsAt?: number;
  machine?: string;
}

export interface LoadOptions {
  /** override data directories per tool; each tool also honours its own env vars */
  paths?: Partial<Record<ToolId, string[]>>;
  since?: number;
  until?: number;
  /** collect non-fatal warnings */
  warn?: (msg: string) => void;
}

export interface ParseResult {
  tool: ToolId;
  events: UsageEvent[];
  sessions: SessionInfo[];
  /** aggregates for periods where event-level data no longer exists */
  historical: DailyAggregate[];
  /** data dirs that were found and scanned */
  sources: string[];
  /** usage-limit snapshots reported by the tool, oldest first (only when the tool records them) */
  limits?: LimitSnapshot[];
  /** requests refused because a usage limit was reached */
  limitHits?: LimitHit[];
}

export interface ToolParser {
  tool: ToolId;
  /** default data roots, after env var overrides */
  defaultPaths(): string[];
  load(opts: LoadOptions): Promise<ParseResult>;
}

export interface ModelPricing {
  /** USD per token */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  /** long-context tier: when the request's total prompt tokens exceed threshold, whole request billed at these rates */
  tiers?: Array<{
    threshold: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  }>;
  /**
   * Service-tier variants (LiteLLM `*_priority` / `*_flex` fields), used when an event's `speed`
   * is 'priority'/'fast' or 'flex'. Rates missing from a variant fall back to the base rate
   * scaled by the variant's input/base-input ratio.
   */
  serviceTiers?: Partial<
    Record<
      'priority' | 'ultrafast' | 'flex',
      {
        input: number;
        output: number;
        cacheRead?: number;
        cacheWrite?: number;
        tiers?: Array<{ threshold: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;
      }
    >
  >;
  /** LiteLLM key that matched */
  key: string;
}

export type CostMode = 'auto' | 'calculate' | 'display';

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUSD: number;
  events: number;
}

export interface ModelBreakdown extends TokenTotals {
  speed?: string;
  model: string;
  tool: ToolId;
}

export interface UsageRow extends TokenTotals {
  /** bucket key: date 'YYYY-MM-DD', week 'YYYY-MM-DD' (week start), month 'YYYY-MM', session id, project path, model name, tool id, block start ISO */
  key: string;
  label: string;
  tools: ToolId[];
  models: string[];
  breakdown: ModelBreakdown[];
  /** extra fields per report type */
  meta?: Record<string, unknown>;
}

export interface Report {
  kind: 'daily' | 'weekly' | 'monthly' | 'session' | 'blocks' | 'models' | 'projects' | 'tools';
  rows: UsageRow[];
  totals: TokenTotals;
  generatedAt: string;
  timezone: string;
  warnings: string[];
}
