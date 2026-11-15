import { loadSyncConfig, loadUsage, reportToDelimited, type LoadUsageResult, type Report } from '@clausage/core';
import type { CliOptions } from './args.js';
import { c } from './format.js';

export interface LoadedData extends LoadUsageResult {
  /** deduplicated warnings */
  uniqueWarnings: string[];
}

export async function loadData(
  opts: CliOptions,
  overrides: { since?: number | undefined; until?: number | undefined; ignoreRange?: boolean } = {},
): Promise<LoadedData> {
  const since = overrides.ignoreRange ? overrides.since : (overrides.since ?? opts.since);
  const until = overrides.ignoreRange ? overrides.until : (overrides.until ?? opts.until);
  const res = await loadUsage({
    tools: opts.tools,
    paths: opts.paths,
    since,
    until,
    offline: opts.offline,
    refreshPricing: opts.refreshPricing,
    mode: opts.mode,
    includeSubagents: opts.subagents,
    project: opts.project,
    timezone: opts.timezone,
    // other computers' usage from the sync folder, unless --local
    ...(opts.local ? {} : { sync: loadSyncConfig() }),
  });
  const uniqueWarnings = [...new Set(res.warnings)];
  return { ...res, uniqueWarnings };
}

/** Print warnings to stderr (collapsed unless --debug). */
export function printWarnings(warnings: string[], opts: CliOptions): void {
  if (!warnings.length) return;
  const limit = opts.debug ? Infinity : 3;
  const shown = warnings.slice(0, limit);
  for (const w of shown) process.stderr.write(c.yellow('warning: ') + c.dim(w) + '\n');
  if (warnings.length > shown.length) {
    process.stderr.write(c.dim(`… ${warnings.length - shown.length} more warning(s); use --debug to show all\n`));
  }
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function noData(opts: CliOptions, what = 'usage data'): void {
  const range = opts.sinceDate || opts.untilDate ? ` for ${opts.sinceDate ?? '…'} – ${opts.untilDate ?? '…'}` : '';
  process.stdout.write(c.yellow(`No ${what} found${range}.`) + '\n');
}

/** CSV / TSV / JSON Lines output of a report (`--format`); returns false for table and json. */
export function printDelimitedReport(report: Report, opts: CliOptions): boolean {
  if (opts.format !== 'csv' && opts.format !== 'tsv' && opts.format !== 'jsonl') return false;
  printWarnings(report.warnings, opts);
  process.stdout.write(reportToDelimited(report, opts.format, { breakdown: opts.breakdown }));
  return true;
}
