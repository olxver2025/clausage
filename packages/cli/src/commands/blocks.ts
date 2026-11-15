import { buildReport, loadLimitConfig, reportedWindows, sumTotals, type BlockMeta, type ToolId, type UsageRow } from '@clausage/core';
import type { CliOptions } from '../args.js';
import { loadData, noData, printDelimitedReport, printJson, printWarnings } from '../context.js';
import {
  c,
  fmtDateTime,
  fmtDuration,
  fmtInt,
  fmtShort,
  fmtUSD,
  shortModel,
  terminalWidth,
  toolName,
} from '../format.js';
import { Table, type Column } from '../table.js';

const meta = (r: UsageRow) => r.meta as unknown as BlockMeta;

function bar(ratio: number, width = 20): string {
  const r = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(r * width);
  const s = '█'.repeat(filled) + '░'.repeat(width - filled);
  const col = r >= 0.9 ? c.red : r >= 0.7 ? c.yellow : c.green;
  return col(s);
}

function burnColor(tpm: number): (s: string) => string {
  return tpm > 5000 ? c.red : tpm >= 2000 ? c.yellow : c.green;
}

export async function runBlocks(opts: CliOptions): Promise<void> {
  const now = Date.now();
  const since = opts.recent ? Math.max(opts.since ?? 0, now - 3 * 86_400_000) : opts.since;
  const data = await loadData(opts, { since });
  const report = buildReport('blocks', data.events, data.sessions, {
    timezone: opts.timezone,
    order: opts.order,
    breakdown: true,
    sessionLengthHours: opts.sessionLength,
    now,
    // the provider's reported 5-hour windows (Codex) and your configured 5-hour limits
    ...(opts.sessionLength === 5
      ? {
          blockLimits: {
            anchors: reportedWindows(data.limits),
            fiveHourTokens: Object.fromEntries(
              Object.entries(loadLimitConfig()).flatMap(([t, c]) => (c?.fiveHourTokens ? [[t as ToolId, c.fiveHourTokens]] : [])),
            ),
            hits: data.limitHits,
          },
        }
      : {}),
  });
  if (opts.active) {
    report.rows = report.rows.filter((r) => meta(r).isActive);
    report.totals = sumTotals(report.rows);
  }
  report.warnings = data.uniqueWarnings;

  let limit: number | undefined;
  if (opts.tokenLimit === 'max') limit = Math.max(0, ...report.rows.filter((r) => !meta(r).isActive).map((r) => r.totalTokens)) || undefined;
  else limit = opts.tokenLimit;

  if (opts.json) return printJson({ ...report, tokenLimit: limit ?? null });
  if (printDelimitedReport(report, opts)) return;
  printWarnings(data.uniqueWarnings, opts);
  if (!report.rows.length) return noData(opts, opts.active ? 'active billing block' : 'billing blocks');

  const tz = report.timezone;
  const width = terminalWidth();
  const compact = opts.compact || (process.stdout.isTTY && width < 120);
  const columns: Column[] = [
    { header: 'Block Start' },
    { header: 'Tool' },
    { header: 'Status' },
    ...(compact ? [] : [{ header: 'Models' } as Column]),
    ...(compact
      ? []
      : ([
          { header: 'Input', align: 'right' },
          { header: 'Output', align: 'right' },
          { header: 'Cache Write', align: 'right' },
          { header: 'Cache Read', align: 'right' },
        ] as Column[])),
    { header: 'Total Tokens', align: 'right' },
    ...(limit ? [{ header: '% Limit', align: 'right' } as Column] : []),
    { header: 'Cost (USD)', align: 'right' },
  ];
  const ncols = columns.length;
  const table = new Table(columns);
  const singleTool = new Set(report.rows.map((r) => meta(r).tool)).size === 1;
  const ordered = report.rows;
  for (const r of ordered) {
    const m = meta(r);
    if (singleTool && m.gapBeforeMs && opts.order === 'asc') {
      table.push([c.dim(`⌛ ${fmtDuration(m.gapBeforeMs)} gap`), ...Array(ncols - 1).fill('')], { style: c.dim });
    }
    const start = Date.parse(m.startTime);
    const status = m.isActive
      ? c.green(`ACTIVE, ${fmtDuration(Date.parse(m.endTime) - now)} left`)
      : fmtDuration(Date.parse(m.actualEndTime) - Date.parse(m.startTime));
    const models = [...new Set(r.models.map(shortModel))].map((x) => `- ${x}`).join('\n');
    const cells = [
      fmtDateTime(start, tz),
      toolName(m.tool),
      status,
      ...(compact ? [] : [models]),
      ...(compact ? [] : [fmtInt(r.inputTokens), fmtInt(r.outputTokens), fmtInt(r.cacheWriteTokens), fmtInt(r.cacheReadTokens)]),
      compact ? fmtShort(r.totalTokens) : fmtInt(r.totalTokens),
      ...(limit ? [`${((r.totalTokens / limit) * 100).toFixed(1)}%`] : []),
      fmtUSD(r.costUSD),
    ];
    table.push(cells);
    if (singleTool && m.gapBeforeMs && opts.order === 'desc') {
      table.push([c.dim(`⌛ ${fmtDuration(m.gapBeforeMs)} gap`), ...Array(ncols - 1).fill('')], { style: c.dim });
    }
  }
  const t = report.totals;
  table.push(
    [
      'Total',
      '',
      '',
      ...(compact ? [] : ['']),
      ...(compact ? [] : [fmtInt(t.inputTokens), fmtInt(t.outputTokens), fmtInt(t.cacheWriteTokens), fmtInt(t.cacheReadTokens)]),
      compact ? fmtShort(t.totalTokens) : fmtInt(t.totalTokens),
      ...(limit ? [''] : []),
      fmtUSD(t.costUSD),
    ],
    { separatorBefore: true, style: (s) => c.yellow(s) },
  );
  process.stdout.write(
    `\n ${c.bold('Billing blocks')} ${c.dim(`(${opts.sessionLength}h windows, ${tz}${opts.recent ? ', last 3 days' : ''})`)}\n\n`,
  );
  process.stdout.write(table.render() + '\n');

  for (const r of report.rows.filter((x) => meta(x).isActive)) {
    const m = meta(r);
    const start = Date.parse(m.startTime);
    const end = Date.parse(m.endTime);
    const elapsed = now - start;
    process.stdout.write(`\n ${c.bold(`Active block: ${toolName(m.tool)}`)} ${c.dim(`${fmtDateTime(start, tz)} → ${fmtDateTime(end, tz)}`)}\n`);
    process.stdout.write(`   Time     ${bar(elapsed / (end - start))} ${fmtDuration(elapsed)} elapsed, ${fmtDuration(end - now)} left\n`);
    if (m.burnRate) {
      const col = burnColor(m.burnRate.tokensPerMinuteIndicator);
      process.stdout.write(
        `   Burn     ${col(`${fmtInt(m.burnRate.tokensPerMinute)} tokens/min`)} ${c.dim(`(${fmtInt(m.burnRate.tokensPerMinuteIndicator)} in+out/min)`)}, ${fmtUSD(m.burnRate.costPerHour)}/hr\n`,
      );
    }
    if (m.projection) {
      process.stdout.write(
        `   Project  ${fmtInt(m.projection.totalTokens)} tokens, ${fmtUSD(m.projection.totalCost)} by block end\n`,
      );
      if (limit) {
        const ratio = m.projection.totalTokens / limit;
        process.stdout.write(`   Limit    ${bar(r.totalTokens / limit)} ${fmtInt(r.totalTokens)} / ${fmtInt(limit)}` + (ratio > 1 ? c.red('  projected to exceed limit') : '') + '\n');
      }
    }
  }
}
