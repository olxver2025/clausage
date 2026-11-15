import { eventsToDelimited, EVENT_COLUMNS } from '@clausage/core';
import type { CliOptions } from '../args.js';
import { loadData, printWarnings } from '../context.js';

/**
 * `clausage export`: every normalised usage event (one billable response) as CSV (default), TSV,
 * JSON Lines or a JSON array, for spreadsheets and scripts. Honours the usual filters. Historical
 * aggregates have no per-event detail and are not included.
 */
export async function runExport(opts: CliOptions): Promise<number> {
  const data = await loadData(opts);
  printWarnings(data.uniqueWarnings, opts);
  const events = opts.order === 'desc' ? [...data.events].reverse() : data.events;
  if (opts.format === 'json') {
    const rows = JSON.parse(`[${eventsToDelimited(events, 'jsonl').trim().split('\n').filter(Boolean).join(',')}]`) as unknown[];
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }
  const format = opts.format === 'table' ? 'csv' : opts.format;
  process.stdout.write(eventsToDelimited(events, format));
  if (!events.length) process.stderr.write(`No usage events found (columns: ${EVENT_COLUMNS.length}).\n`);
  return 0;
}
