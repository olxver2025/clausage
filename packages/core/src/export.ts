/**
 * Flat exports for spreadsheets and scripts: CSV / TSV / JSON Lines of report rows or raw events.
 * Shared by the CLI (`--format`, `clausage export`) and the dashboard API (`format=`).
 */
import type { Report, UsageEvent, UsageRow } from './types.js';

export type DelimitedFormat = 'csv' | 'tsv' | 'jsonl';

export const EXPORT_CONTENT_TYPES: Record<DelimitedFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8',
};

type Cell = string | number | boolean | null | undefined;

/** Costs to the micro-dollar, so float noise (0.0140264000000001) never reaches a spreadsheet. */
const money = (v: Cell): Cell => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);

function csvCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  // Spreadsheet formula injection: a leading = + - @ (or tab / CR) would be evaluated.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tsvCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  return (typeof v === 'string' && /^[=+\-@]/.test(s) ? `'${s}` : s).replace(/[\t\r\n]+/g, ' ');
}

/** Serialise records with a fixed column order. */
export function toDelimited(columns: string[], records: Array<Record<string, Cell>>, format: DelimitedFormat): string {
  if (format === 'jsonl') {
    return records.map((r) => JSON.stringify(Object.fromEntries(columns.map((c) => [c, r[c] ?? null])))).join('\n') + (records.length ? '\n' : '');
  }
  const cell = format === 'csv' ? csvCell : tsvCell;
  const sep = format === 'csv' ? ',' : '\t';
  const lines = [columns.map((c) => cell(c)).join(sep)];
  for (const r of records) lines.push(columns.map((c) => cell(r[c])).join(sep));
  return lines.join(format === 'csv' ? '\r\n' : '\n') + (format === 'csv' ? '\r\n' : '\n');
}

const TOKEN_COLUMNS = ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'reasoningTokens', 'totalTokens', 'costUSD', 'events'] as const;

/** Report-specific meta fields worth a column, by report kind. */
const META_COLUMNS: Partial<Record<Report['kind'], string[]>> = {
  session: ['tool', 'sessionId', 'machine', 'project', 'title', 'startedAt', 'endedAt', 'activeMs', 'turns', 'toolCalls', 'subagents'],
  blocks: ['tool', 'startTime', 'endTime', 'actualEndTime', 'isActive', 'sessions'],
  projects: ['sessions', 'machine'],
};

function metaValue(v: unknown): Cell {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.length;
  return undefined;
}

/**
 * One line per report row; with `breakdown`, one line per (row, model, tool, speed) instead, so a
 * pivot table can slice by model.
 */
export function reportToDelimited(report: Report, format: DelimitedFormat, opts: { breakdown?: boolean } = {}): string {
  const metaCols = (META_COLUMNS[report.kind] ?? [])
    .filter((c) => report.rows.some((r) => r.meta?.[c] !== undefined))
    // with a breakdown, `tool` is a per-line column of its own
    .filter((c) => !opts.breakdown || c !== 'tool');
  const columns = ['key', 'label', ...metaCols, ...(opts.breakdown ? ['model', 'tool', 'speed'] : ['tools', 'models']), ...TOKEN_COLUMNS];
  const records: Array<Record<string, Cell>> = [];
  const base = (r: UsageRow): Record<string, Cell> => {
    const out: Record<string, Cell> = { key: r.key, label: r.label };
    for (const c of metaCols) {
      const v = metaValue(r.meta?.[c]);
      // epoch-ms fields as ISO, so spreadsheets read them as dates
      out[c] = (c === 'startedAt' || c === 'endedAt') && typeof v === 'number' && v > 0 ? new Date(v).toISOString() : v;
    }
    return out;
  };
  for (const r of report.rows) {
    if (opts.breakdown && r.breakdown.length) {
      for (const b of r.breakdown) {
        const rec = base(r);
        rec.model = b.model;
        rec.tool = b.tool;
        rec.speed = b.speed;
        for (const k of TOKEN_COLUMNS) rec[k] = k === 'costUSD' ? money(b[k]) : b[k];
        records.push(rec);
      }
    } else {
      const rec = base(r);
      if (opts.breakdown) {
        rec.model = r.models.join(' ');
        rec.tool = r.tools.join(' ');
      } else {
        rec.tools = r.tools.join(' ');
        rec.models = r.models.join(' ');
      }
      for (const k of TOKEN_COLUMNS) rec[k] = k === 'costUSD' ? money(r[k]) : r[k];
      records.push(rec);
    }
  }
  return toDelimited(columns, records, format);
}

export const EVENT_COLUMNS = [
  'timestamp',
  'tool',
  'machine',
  'sessionId',
  'rootSessionId',
  'isSubagent',
  'project',
  'model',
  'provider',
  'speed',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'cacheWrite1hTokens',
  'reasoningTokens',
  'totalTokens',
  'costUSD',
  'recordedCostUSD',
  'costUnknown',
  'durationMs',
] as const;

/** Raw normalised events, one line each (ISO timestamps). No message text exists at this level. */
export function eventsToDelimited(events: UsageEvent[], format: DelimitedFormat): string {
  const records = events.map((e) => {
    const r: Record<string, Cell> = {};
    for (const c of EVENT_COLUMNS) {
      if (c === 'timestamp') r[c] = new Date(e.timestamp).toISOString();
      else if (c === 'totalTokens') r[c] = e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
      else if (c === 'costUSD' || c === 'recordedCostUSD') r[c] = money(e[c]);
      else r[c] = (e as unknown as Record<string, Cell>)[c];
    }
    return r;
  });
  return toDelimited([...EVENT_COLUMNS], records, format);
}
