import "server-only";
import { connection } from "next/server";
import {
  buildReport,
  endOfDay,
  loadUsage,
  readCodexRateLimits,
  resolveTimezone,
  startOfDay,
  type BuildReportOptions,
  type CodexRateLimits,
  type LoadUsageOptions,
  type LoadUsageResult,
  type ModelPricing,
  type ParseResult,
  type PricingTable,
  type Report,
  type ReportKind,
  type ToolId,
} from "@clausage/core";
import { parseFilters, type Filters, type SearchParamsRecord } from "./filters";

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
};
const cache: Map<string, Entry> = (globalCache.__clausageUsageCache ??= new Map());

// Raw parses are shared by every filter combination, so a new filter only re-filters and re-costs.
let parseCache: { at: number; map: Map<ToolId, Promise<ParseResult>> } | undefined;
function sharedParseCache(fresh: boolean): Map<ToolId, Promise<ParseResult>> {
  const now = Date.now();
  if (fresh || !parseCache || now - parseCache.at >= TTL_MS) parseCache = { at: now, map: new Map() };
  return parseCache.map;
}

export function loadOptionsFor(filters: Filters): LoadUsageOptions {
  const timezone = resolveTimezone(filters.tz);
  return {
    tools: filters.tools,
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
  ]);
}

const pricingTables = new WeakMap<UsageData, PricingTable>();

/** Resolve a model's price with the same table the usage data was costed with. */
export function lookupPricing(data: UsageData, model: string, tool?: ToolId): ModelPricing | null {
  return pricingTables.get(data)?.lookup(model, tool) ?? null;
}

async function load(opts: LoadUsageOptions): Promise<UsageData> {
  const res = await loadUsage(opts);
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

  const promise = load({ ...opts, parseCache: sharedParseCache(filters.fresh) });
  cache.set(key, { at: now, promise });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  for (const k of cache.keys()) {
    if (cache.size <= MAX_ENTRIES) break;
    if (k !== key) cache.delete(k);
  }
  return promise;
}

export function clearUsageCache(): void {
  cache.clear();
  parseCache = undefined;
  globalCache.__clausageRateCache = undefined;
}

export async function getFilters(searchParams: Promise<SearchParamsRecord> | SearchParamsRecord): Promise<Filters> {
  const params = await searchParams;
  await connection();
  return parseFilters(params);
}

export type ReportOptions = Pick<BuildReportOptions, "order" | "breakdown" | "sessionLengthHours" | "startOfWeek">;

const HISTORICAL_KINDS: ReadonlySet<ReportKind> = new Set(["daily", "weekly", "monthly", "models", "tools"]);

export function reportFrom(data: UsageData, kind: ReportKind, filters: Filters, opts: ReportOptions = {}): Report {
  const report = buildReport(kind, data.events, data.sessions, {
    timezone: filters.tz,
    historical: HISTORICAL_KINDS.has(kind) ? data.historical : undefined,
    ...opts,
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
  const promise = readCodexRateLimits().catch(() => null);
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
