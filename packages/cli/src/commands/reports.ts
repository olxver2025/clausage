import {
  buildReport,
  type Report,
  type TokenTotals,
  type UsageRow,
} from '@clausage/core';
import type { CliOptions } from '../args.js';
import { loadData, noData, printDelimitedReport, printJson, printWarnings } from '../context.js';
import { c, fmtInt, fmtUSD, shortModel, terminalWidth, toolName, truncate, truncateStart } from '../format.js';
import { Table, type Column } from '../table.js';

export type PeriodKind = 'daily' | 'weekly' | 'monthly' | 'models' | 'projects' | 'tools';

const FIRST_COLUMN: Record<PeriodKind, string> = {
  daily: 'Date',
  weekly: 'Week',
  monthly: 'Month',
  models: 'Model',
  projects: 'Project',
  tools: 'Tool',
};

function modelsCell(models: string[], max = 4): string {
  const short = [...new Set(models.map(shortModel))];
  const shown = short.slice(0, max).map((m) => `- ${m}`);
  if (short.length > max) shown.push(c.dim(`+${short.length - max} more`));
  return shown.join('\n');
}

function costCell(row: { costUSD: number; meta?: Record<string, unknown> }): string {
  const s = fmtUSD(row.costUSD);
  return row.meta?.costUnknown ? s + c.yellow('*') : s;
}

function keyCell(kind: PeriodKind, row: UsageRow): string {
  let s: string;
  if (kind === 'tools') s = toolName(row.key as never);
  else if (kind === 'projects') s = truncateStart(row.label, 48);
  else if (kind === 'models') s = truncate(row.key, 48);
  else s = row.label;
  if (row.meta?.historical) s += c.dim(' †');
  return s;
}

interface Layout {
  columns: Column[];
  cells: (first: string, tools: string, models: string, t: TokenTotals & { meta?: Record<string, unknown> }) => string[];
}

function layouts(kind: PeriodKind): { full: Layout; compact: Layout } {
  const first: Column = { header: FIRST_COLUMN[kind], align: 'left' };
  const showTools = kind !== 'tools';
  const showModels = kind !== 'models';
  const full: Layout = {
    columns: [
      first,
      ...(showTools ? [{ header: 'Tools' } as Column] : []),
      ...(showModels ? [{ header: 'Models' } as Column] : []),
      { header: 'Input', align: 'right' },
      { header: 'Output', align: 'right' },
      { header: 'Cache Write', align: 'right' },
      { header: 'Cache Read', align: 'right' },
      { header: 'Total Tokens', align: 'right' },
      { header: 'Cost (USD)', align: 'right' },
    ],
    cells: (f, tools, models, t) => [
      f,
      ...(showTools ? [tools] : []),
      ...(showModels ? [models] : []),
      fmtInt(t.inputTokens),
      fmtInt(t.outputTokens),
      fmtInt(t.cacheWriteTokens),
      fmtInt(t.cacheReadTokens),
      fmtInt(t.totalTokens),
      costCell(t),
    ],
  };
  const compact: Layout = {
    columns: [
      first,
      ...(showTools ? [{ header: 'Tools' } as Column] : []),
      ...(showModels ? [{ header: 'Models' } as Column] : []),
      { header: 'Total Tokens', align: 'right' },
      { header: 'Cost (USD)', align: 'right' },
    ],
    cells: (f, tools, models, t) => [
      f,
      ...(showTools ? [tools] : []),
      ...(showModels ? [models] : []),
      fmtInt(t.totalTokens),
      costCell(t),
    ],
  };
  return { full, compact };
}

function buildTable(kind: PeriodKind, report: Report, layout: Layout, breakdown: boolean): Table {
  const table = new Table(layout.columns);
  for (const row of report.rows) {
    const tools = row.tools.map((t) => toolName(t)).join('\n');
    table.push(layout.cells(keyCell(kind, row), tools, modelsCell(row.models), row));
    if (breakdown && (row.breakdown.length > 1 || row.breakdown.some((b) => b.speed))) {
      for (const b of row.breakdown) {
        const label = kind === 'models' ? `  └─ ${toolName(b.tool)}` : `  └─ ${shortModel(b.model)}`;
        table.push(layout.cells(b.speed ? `${label} · ${b.speed}` : label, kind === 'models' ? '' : toolName(b.tool), '', b), { style: c.dim });
      }
    }
  }
  table.push(layout.cells('Total', '', '', report.totals), { separatorBefore: true, style: (s) => c.yellow(s) });
  return table;
}

export function renderPeriodTable(kind: PeriodKind, report: Report, opts: CliOptions): string {
  const { full, compact } = layouts(kind);
  let table = buildTable(kind, report, full, opts.breakdown);
  let isCompact = opts.compact;
  if (!isCompact && process.stdout.isTTY && table.width() > terminalWidth()) isCompact = true;
  if (isCompact) table = buildTable(kind, report, compact, opts.breakdown);
  const notes: string[] = [];
  if (isCompact && !opts.compact) notes.push('Compact view (terminal too narrow); widen the terminal or use --json for all columns.');
  if (report.rows.some((r) => r.meta?.historical))
    notes.push('† includes historical aggregates (e.g. Claude stats-cache; UTC days, approximate token split).');
  if (report.rows.some((r) => r.meta?.costUnknown)) notes.push('* some models have no known price; cost may be understated.');
  return table.render() + (notes.length ? '\n' + notes.map((n) => c.dim(n)).join('\n') : '');
}

const TITLES: Record<PeriodKind, string> = {
  daily: 'Daily usage',
  weekly: 'Weekly usage',
  monthly: 'Monthly usage',
  models: 'Usage by model',
  projects: 'Usage by project',
  tools: 'Usage by tool',
};

export async function runPeriodReport(kind: PeriodKind, opts: CliOptions): Promise<void> {
  const data = await loadData(opts);
  const report = buildReport(kind, data.events, data.sessions, {
    timezone: opts.timezone,
    order: opts.order,
    breakdown: true,
    historical: data.historical,
    startOfWeek: opts.startOfWeek,
  });
  report.warnings = data.uniqueWarnings;
  if (opts.json) return printJson(report);
  if (printDelimitedReport(report, opts)) return;
  printWarnings(data.uniqueWarnings, opts);
  if (!report.rows.length) return noData(opts);
  const scope = opts.tools ? opts.tools.map((t) => toolName(t)).join(', ') : 'all tools';
  const extra = kind === 'projects' && opts.project ? `, project ~ "${opts.project}"` : '';
  process.stdout.write(`\n ${c.bold(TITLES[kind])} ${c.dim(`(${scope}${extra}, ${report.timezone})`)}\n\n`);
  process.stdout.write(renderPeriodTable(kind, report, opts) + '\n');
  if (kind === 'projects' && report.rows.some((r) => r.key === '')) {
    process.stdout.write(c.dim('(unknown) = events without a recorded working directory\n'));
  }
}

