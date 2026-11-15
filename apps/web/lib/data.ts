import "server-only";
import { cache as reactCache } from "react";
import { detectSubscriptions } from "./subscriptions";
import { connection } from "next/server";
import {
  buildReport,
  cacheEfficiency,
  createUsageWorker,
  dailySeries,
  dailySpikes,
  forecastMonth,
  sessionSpikes,
  endOfDay,
  limitStatus,
  loadLimitConfig,
  loadSyncConfig,
  reportedWindows,
  PARSERS,
  resolveTimezone,
  startOfDay,
  type BuildReportOptions,
  type CacheEfficiency,
  type CacheGroup,
  type MonthForecast,
  type Spike,
  type CodexRateLimits,
  type LimitConfig,
  type ToolLimitStatus,
  type LoadUsageOptions,
  type LoadUsageResult,
  type ModelPricing,
  type PricingTable,
  type Report,
  type ReportKind,
  type SyncConfig,
  type SyncStatus,
  type ToolId,
  type UsageWorker,
} from "@clausage/core";
import { addDays, parseFilters, todayIn, type Filters, type SearchParamsRecord } from "./filters";

export type { Filters } from "./filters";

const TTL_MS = 30_000;
const MAX_ENTRIES = 24;

export interface PricingInfo {
  source: "live" | "cache" | "embedded";
  fetchedAt?: string;
  models: number;
}

export interface UsageData extends Omit<LoadUsageResult, "pricing"> {
  pricing: PricingInfo;
  /** deduplicated warnings, in first-seen order */
  uniqueWarnings: string[];
  /** epoch ms when the logs were parsed */
  loadedAt: number;
  /** resolved IANA zone used for date boundaries */
  timezone: string;
  /** the load options' epoch range, for display */
  sinceMs?: number;
  untilMs?: number;
}

interface Entry {
  at: number;
  promise: Promise<UsageData>;
}

const globalCache = globalThis as unknown as {
  __clausageUsageCache?: Map<string, Entry>;
  __clausageRateCache?: { at: number; promise: Promise<CodexRateLimits | null> };
  __clausageWorker?: UsageWorker;
  __clausageWorkerVersion?: number;
  __clausageSyncConfig?: { at: number; config: SyncConfig };
  __clausageLimitConfig?: { at: number; config: LimitConfig };
};
const cache: Map<string, Entry> = (globalCache.__clausageUsageCache ??= new Map());

/**
 * Logs are read and parsed in a worker thread (one per server process, surviving dev reloads).
 * Besides keeping the server responsive, this is what keeps dev mode usable: React records every
 * promise and file read a Server Component waits on, and a load done on this thread made that
 * bookkeeping take minutes. Through the worker a load is a single awaited message.
 */
/** Bump when the worker's result shape changes, so dev servers replace a running worker. */
const WORKER_VERSION = 8;

function usageWorker(): UsageWorker {
  const existing = globalCache.__clausageWorker;
  // A worker started by an older build (kept on globalThis across dev reloads) runs old core code.
  if (existing && globalCache.__clausageWorkerVersion !== WORKER_VERSION) {
    void existing.terminate().catch(() => {});
    globalCache.__clausageWorker = undefined;
  }
  globalCache.__clausageWorkerVersion = WORKER_VERSION;
  return (globalCache.__clausageWorker ??= createUsageWorker());
}

/** This computer's sync config, re-read at most every few seconds (it's a tiny local file). */
export function syncConfig(): SyncConfig {
  const now = Date.now();
  const hit = globalCache.__clausageSyncConfig;
  if (hit && now - hit.at < 5_000) return hit.config;
  const config = loadSyncConfig();
  globalCache.__clausageSyncConfig = { at: now, config };
  return config;
}

/** Usage-limit settings (config.json), re-read at most every few seconds. */
export function limitConfig(): LimitConfig {
  const now = Date.now();
  const hit = globalCache.__clausageLimitConfig;
  if (hit && now - hit.at < 5_000) return hit.config;
  const config = loadLimitConfig();
  globalCache.__clausageLimitConfig = { at: now, config };
  return config;
}

export function loadOptionsFor(filters: Filters): LoadUsageOptions {
  const timezone = resolveTimezone(filters.tz);
  return {
    sync: syncConfig(),
    machines: filters.machines,
    // Only tools the installed core can parse (the web app may list tools a stale core build lacks).
    tools: filters.tools.filter((t) => t in PARSERS),
    since: filters.since ? startOfDay(filters.since, timezone) : undefined,
    until: filters.until ? endOfDay(filters.until, timezone) : undefined,
    mode: filters.mode,
    includeSubagents: filters.subagents,
    project: filters.project,
    timezone,
  };
}

function keyFor(opts: LoadUsageOptions): string {
  return JSON.stringify([
    [...(opts.tools ?? [])].sort(),
    opts.since ?? null,
    opts.until ?? null,
    opts.mode ?? "auto",
    opts.includeSubagents !== false,
    opts.project ?? null,
    opts.timezone ?? null,
    [...(opts.machines ?? [])].sort(),
    opts.sync ? [opts.sync.machineName, opts.sync.folder ?? null] : null,
  ]);
}

const pricingTables = new WeakMap<UsageData, PricingTable>();

/** Resolve a model's price with the same table the usage data was costed with. */
export function lookupPricing(data: UsageData, model: string, tool?: ToolId): ModelPricing | null {
  return pricingTables.get(data)?.lookup(model, tool) ?? null;
}

/** Prompt-cache hit rate and savings at list prices, with the table the data was costed with. */
export function cacheEfficiencyFor(data: UsageData, group: CacheGroup): CacheEfficiency[] {
  const table = pricingTables.get(data);
  return table ? cacheEfficiency(data.events, table, group, { timezone: data.timezone }) : [];
}

export interface Insights {
  forecast: MonthForecast;
  /** unusual days in the selected range, newest first */
  days: Spike[];
  /** unusual sessions in the selected range, most unusual first */
  sessions: Spike[];
}

/**
 * Month-end forecast (always this month and the last weeks, whatever the page's range) and unusual
 * days and sessions within the page's range and filters.
 */
export async function getInsights(filters: Filters, now = Date.now()): Promise<Insights> {
  const today = todayIn(filters.tz, now);
  const [data, recent] = await Promise.all([
    getUsage(filters),
    getUsage({ ...filters, range: "custom", since: addDays(today, -45), until: today, fresh: false }),
  ]);
  const forecast = forecastMonth(recent.events, recent.historical, { timezone: recent.timezone, now });
  const days = dailySpikes(dailySeries(data.events, data.historical, { timezone: data.timezone }));
  const sessions = sessionSpikes(reportFrom(data, "session", filters, { breakdown: false }).rows);
  return { forecast, days, sessions };
}

async function load(opts: LoadUsageOptions, fresh: boolean): Promise<UsageData> {
  const res = await usageWorker().loadUsage(opts, { fresh, parseTtlMs: TTL_MS });
  const { pricing, ...rest } = res;
  const data: UsageData = {
    ...rest,
    pricing: { source: pricing.source, fetchedAt: pricing.fetchedAt, models: pricing.size },
    uniqueWarnings: [...new Set(res.warnings)],
    loadedAt: Date.now(),
    timezone: opts.timezone ?? resolveTimezone(),
    sinceMs: opts.since,
    untilMs: opts.until,
  };
  pricingTables.set(data, pricing);
  return hideBulk(data);
}

/**
 * Make the large arrays non-enumerable. Reads are unchanged, but React's dev-mode debug info
 * (which serializes the value of every promise a Server Component awaits) skips them instead of
 * shipping every event to the renderer, which took tens of seconds per page.
 */
function hideBulk(data: UsageData): UsageData {
  for (const key of ["events", "sessions", "historical"] as const) {
    Object.defineProperty(data, key, { value: data[key], enumerable: false, writable: true, configurable: true });
  }
  return data;
}

/** Parsed, costed usage for the filters. Cached in-process for 30s per filter set; `filters.fresh` bypasses it. */
export async function getUsage(filters: Filters): Promise<UsageData> {
  await connection();
  const opts = loadOptionsFor(filters);
  const key = keyFor(opts);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && !filters.fresh && now - hit.at < TTL_MS) return hit.promise;

  const promise = load(opts, filters.fresh);
  cache.set(key, { at: now, promise });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  // Expired entries are never served again; drop them so they don't hold a copy of every event.
  for (const [k, e] of cache) if (now - e.at >= TTL_MS) cache.delete(k);
  for (const k of cache.keys()) {
    if (cache.size <= MAX_ENTRIES) break;
    if (k !== key) cache.delete(k);
  }
  return promise;
}

export function clearUsageCache(): void {
  cache.clear();
  globalCache.__clausageSyncConfig = undefined;
  globalCache.__clausageLimitConfig = undefined;
  globalCache.__clausageWorker?.clear();
  globalCache.__clausageRateCache = undefined;
}

export async function getFilters(searchParams: Promise<SearchParamsRecord> | SearchParamsRecord): Promise<Filters> {
  const params = await searchParams;
  await connection();
  return parseFilters(params);
}

export type ReportOptions = Pick<BuildReportOptions, "order" | "breakdown" | "sessionLengthHours" | "startOfWeek"> & {
  /** anchor blocks to reported limit windows and add limit usage (blocks only) */
  limits?: boolean;
};

const HISTORICAL_KINDS: ReadonlySet<ReportKind> = new Set(["daily", "weekly", "monthly", "models", "tools"]);

export function reportFrom(data: UsageData, kind: ReportKind, filters: Filters, opts: ReportOptions = {}): Report {
  const { limits, ...rest } = opts;
  const report = buildReport(kind, data.events, data.sessions, {
    timezone: filters.tz,
    historical: HISTORICAL_KINDS.has(kind) ? data.historical : undefined,
    ...rest,
    ...(limits && kind === "blocks" ? { blockLimits: blockLimitsFor(data) } : {}),
  });
  report.warnings = data.uniqueWarnings;
  return report;
}

export async function getReport(kind: ReportKind, filters: Filters, opts: ReportOptions = {}): Promise<Report> {
  return reportFrom(await getUsage(filters), kind, filters, opts);
}

/** The time-series report for `filters.group` (daily, weekly or monthly). */
export function getTimeSeriesReport(filters: Filters, opts: ReportOptions = {}): Promise<Report> {
  return getReport(filters.group, filters, opts);
}
export const getSessionsReport = (f: Filters, o: ReportOptions = {}) => getReport("session", f, { order: "desc", ...o });
export const getModelsReport = (f: Filters, o: ReportOptions = {}) => getReport("models", f, o);
export const getProjectsReport = (f: Filters, o: ReportOptions = {}) => getReport("projects", f, o);
export const getToolsReport = (f: Filters, o: ReportOptions = {}) => getReport("tools", f, o);
export const getBlocksReport = (f: Filters, o: ReportOptions = {}) => getReport("blocks", f, { order: "desc", ...o });

/** Latest Codex rate-limit snapshot (cached 30s). Never includes balances. */
export async function getCodexRateLimits(fresh = false): Promise<CodexRateLimits | null> {
  await connection();
  const now = Date.now();
  const hit = globalCache.__clausageRateCache;
  if (hit && !fresh && now - hit.at < TTL_MS) return hit.promise;
  const promise = usageWorker().readCodexRateLimits().catch(() => null);
  globalCache.__clausageRateCache = { at: now, promise };
  return promise;
}

export interface SourcesSummary {
  sources: Record<ToolId, string[]>;
  pricing: PricingInfo;
  warnings: string[];
  loadedAt: number;
  timezone: string;
}

/** Data sources, pricing and warnings for an unfiltered load (all tools, all time). */
export async function getSourcesSummary(): Promise<SourcesSummary> {
  await connection();
  const data = await getUsage(parseFilters({ range: "all" }));
  return {
    sources: data.sources,
    pricing: data.pricing,
    warnings: data.uniqueWarnings,
    loadedAt: data.loadedAt,
    timezone: data.timezone,
  };
}

/** Sync folder status: this computer's snapshot and the other computers found. */
export async function getSyncStatus(): Promise<SyncStatus> {
  await connection();
  return usageWorker().syncStatus(syncConfig());
}

/** Write this computer's snapshot now. */
export async function publishSnapshot(): Promise<SyncStatus> {
  globalCache.__clausageSyncConfig = undefined;
  const config = syncConfig();
  if (!config.folder) throw new Error("Choose a sync folder first.");
  return config.publish === false ? usageWorker().syncStatus(config) : usageWorker().syncPublish(config);
}

function blockLimitsFor(data: UsageData) {
  const config = limitConfig();
  const fiveHourTokens: Partial<Record<ToolId, number>> = {};
  for (const [tool, c] of Object.entries(config)) if (c?.fiveHourTokens) fiveHourTokens[tool as ToolId] = c.fiveHourTokens;
  return { anchors: reportedWindows(data.limits), fiveHourTokens, hits: data.limitHits ?? [] };
}

/**
 * Current 5-hour and weekly limit status per tool. Uses the last 35 days regardless of the page's
 * date range (the current windows, and the history the window-size estimate needs), with the page's
 * tool and computer filters.
 */
export interface ClaudeUsageState {
  enabled: boolean;
  /** why the last fetch failed, in plain words */
  error?: string;
  fetchedAt?: number;
}

export async function getLimitStatus(filters: Filters): Promise<{ tools: ToolLimitStatus[]; now: number; timezone: string; claude: ClaudeUsageState }> {
  const now = Date.now();
  const today = todayIn(filters.tz, now);
  const localName = loadSyncConfig().machineName;
  const localSelected = !filters.machines.length || filters.machines.includes(localName);
  const [recent, claudeResult, codexResult] = await Promise.all([
    getUsage({ ...filters, range: "custom", since: addDays(today, -35), until: today, project: undefined, subagents: true, mode: "auto" }),
    localSelected && filters.tools.includes("claude-code") ? usageWorker()
      .claudeUsage(false)
      .catch((err: Error) => ({ ok: false as const, code: "network" as const, error: err.message, at: now })) : null,
    localSelected && filters.tools.includes("codex") ? usageWorker().codexUsage(false)
      .catch(() => ({ ok: false as const, error: "Couldn’t check Codex account resets." })) : null,
  ]);
  // the fresh fetch may be newer than the history the cached parse has
  const limits = [...(recent.limits ?? [])];
  if (claudeResult?.ok) limits.push({ ...claudeResult.snapshot, machine: localName });
  if (codexResult?.ok) limits.push({ ...codexResult.snapshot, machine: localName });
  const claude: ClaudeUsageState = claudeResult
    ? claudeResult.ok
      ? { enabled: true, fetchedAt: claudeResult.snapshot.timestamp }
      : { enabled: true, error: claudeResult.error }
    : { enabled: false };
  const asOf = Date.now();
  const tools = limitStatus({
    events: recent.events,
    limits,
    limitHits: recent.limitHits,
    config: limitConfig(),
    now: asOf,
    timezone: recent.timezone,
    ...(filters.allTools ? {} : { tools: filters.tools }),
  });
  const codex = tools.find((t) => t.tool === "codex");
  if (codex && codexResult && !codexResult.ok) codex.resetError = codexResult.error;
  return { tools, now: asOf, timezone: recent.timezone, claude };
}

export const getDetectedSubscriptions = reactCache(async () => {
  const status = await getLimitStatus(parseFilters({ range: "30d" }));
  return detectSubscriptions(status.tools);
});
