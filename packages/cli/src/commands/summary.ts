import {
  TOOL_LABELS,
  buildReport,
  dateKey,
  monthKey,
  sumTotals,
  weekKey,
  weekKeyFromDate,
  type TokenTotals,
  type ToolId,
} from '@clausage/core';
import type { CliOptions } from '../args.js';
import { loadData, noData, printJson, printWarnings } from '../context.js';
import { c, fmtDuration, fmtInt, fmtShort, fmtUSD, shortModel, toolName } from '../format.js';
import { Table } from '../table.js';

interface ToolSummary extends TokenTotals {
  tool: ToolId;
  label: string;
  sessions: number;
  activeMs: number;
  firstSeen: number | null;
  lastSeen: number | null;
}

export async function runSummary(opts: CliOptions): Promise<void> {
  const data = await loadData(opts);
  const tz = opts.timezone;
  const now = Date.now();
  const today = dateKey(now, tz);
  const week = weekKey(now, tz, opts.startOfWeek);
  const month = monthKey(now, tz);

  const ev = data.events;
  const hist = data.historical;
  const periods = {
    today: sumTotals([...ev.filter((e) => dateKey(e.timestamp, tz) === today), ...hist.filter((h) => h.date === today)]),
    thisWeek: sumTotals([
      ...ev.filter((e) => weekKey(e.timestamp, tz, opts.startOfWeek) === week),
      ...hist.filter((h) => weekKeyFromDate(h.date, opts.startOfWeek) === week),
    ]),
    thisMonth: sumTotals([...ev.filter((e) => monthKey(e.timestamp, tz) === month), ...hist.filter((h) => h.date.startsWith(month))]),
    allTime: sumTotals([...ev, ...hist]),
  };

  const toolsReport = buildReport('tools', ev, data.sessions, { timezone: tz, historical: hist });
  const modelsReport = buildReport('models', ev, data.sessions, { timezone: tz, historical: hist });
  const sessionRows = buildReport('session', ev, data.sessions, { timezone: tz, breakdown: false }).rows;
  const tools: ToolSummary[] = toolsReport.rows.map((r) => {
    const tool = r.key as ToolId;
    const roots = data.sessions.filter((s) => s.tool === tool && !s.isSubagent);
    const ts = ev.filter((e) => e.tool === tool).map((e) => e.timestamp);
    const { key: _k, label: _l, tools: _t, models: _m, breakdown: _b, meta: _x, ...totals } = r;
    return {
      ...totals,
      tool,
      label: TOOL_LABELS[tool] ?? tool,
      sessions: new Set(roots.map((s) => s.sessionId)).size || new Set(ev.filter((e) => e.tool === tool).map((e) => e.rootSessionId)).size,
      activeMs: sessionRows
        .filter((row) => (row.meta as { tool?: string } | undefined)?.tool === tool)
        .reduce((a, row) => a + (Number((row.meta as { activeMs?: number } | undefined)?.activeMs) || 0), 0),
      firstSeen: ts.length ? Math.min(...ts) : null,
      lastSeen: ts.length ? Math.max(...ts) : null,
    };
  });

  const result = {
    kind: 'summary',
    generatedAt: new Date(now).toISOString(),
    timezone: tz,
    periods: { today: { key: today, ...periods.today }, thisWeek: { key: week, ...periods.thisWeek }, thisMonth: { key: month, ...periods.thisMonth }, allTime: periods.allTime },
    tools,
    topModels: modelsReport.rows.slice(0, 10),
    pricing: { source: data.pricing.source, models: data.pricing.size },
    sources: data.sources,
    warnings: data.uniqueWarnings,
  };
  if (opts.json) return printJson(result);
  printWarnings(data.uniqueWarnings, opts);
  if (!ev.length && !hist.length) return noData(opts);

  process.stdout.write(`\n ${c.bold('clausage summary')} ${c.dim(`(${tz}, prices: ${data.pricing.source})`)}\n\n`);

  const p = new Table([
    { header: 'Period' },
    { header: 'Tokens', align: 'right' },
    { header: 'Cost (USD)', align: 'right' },
    { header: 'Requests', align: 'right' },
  ]);
  const prow = (label: string, t: TokenTotals) => p.push([label, fmtShort(t.totalTokens), fmtUSD(t.costUSD), fmtInt(t.events)]);
  prow(`Today ${c.dim(today)}`, periods.today);
  prow(`This week ${c.dim(week)}`, periods.thisWeek);
  prow(`This month ${c.dim(month)}`, periods.thisMonth);
  p.push([c.yellow('All time'), c.yellow(fmtShort(periods.allTime.totalTokens)), c.yellow(fmtUSD(periods.allTime.costUSD)), c.yellow(fmtInt(periods.allTime.events))], {
    separatorBefore: true,
  });
  process.stdout.write(p.render() + '\n\n');

  const t = new Table([
    { header: 'Tool' },
    { header: 'Sessions', align: 'right' },
    { header: 'Active time', align: 'right' },
    { header: 'Input', align: 'right' },
    { header: 'Output', align: 'right' },
    { header: 'Cache R/W', align: 'right' },
    { header: 'Total', align: 'right' },
    { header: 'Cost (USD)', align: 'right' },
  ]);
  for (const s of tools) {
    t.push([
      toolName(s.tool),
      fmtInt(s.sessions),
      fmtDuration(s.activeMs),
      fmtShort(s.inputTokens),
      fmtShort(s.outputTokens),
      `${fmtShort(s.cacheReadTokens)} / ${fmtShort(s.cacheWriteTokens)}`,
      fmtShort(s.totalTokens),
      fmtUSD(s.costUSD),
    ]);
  }
  process.stdout.write(t.render() + '\n\n');

  const m = new Table([
    { header: 'Top models' },
    { header: 'Tools' },
    { header: 'Total', align: 'right' },
    { header: 'Cost (USD)', align: 'right' },
    { header: 'Share', align: 'right' },
  ]);
  const totalCost = periods.allTime.costUSD || 1;
  for (const r of modelsReport.rows.slice(0, 5)) {
    m.push([
      shortModel(r.key),
      r.tools.map((x) => toolName(x)).join(', '),
      fmtShort(r.totalTokens),
      fmtUSD(r.costUSD) + (r.meta?.costUnknown ? c.yellow('*') : ''),
      `${((r.costUSD / totalCost) * 100).toFixed(1)}%`,
    ]);
  }
  process.stdout.write(m.render() + '\n');
  if (hist.length) process.stdout.write(c.dim('Includes historical aggregates (e.g. Claude stats-cache) for days without transcripts.\n'));
}
