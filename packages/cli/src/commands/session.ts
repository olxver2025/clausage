import { buildReport, toolCallStats, type SessionMeta, type UsageRow } from '@clausage/core';
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
  shortProject,
  terminalWidth,
  toolName,
  truncate,
} from '../format.js';
import { Table, type Column } from '../table.js';

/** Last 8 id characters: UUIDv7 / ses_ ids share time-ordered prefixes, the tail is random. */
function shortId(id: string): string {
  const clean = id.replace(/-/g, '');
  return clean.length > 8 ? clean.slice(-8) : clean;
}

/** Tool names come from log files: strip control characters before they reach the terminal. */
function safeName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

const TOOL_CALL_ROWS = 15;

/** Calls per tool name for one session (root plus folded subagents). Names only. */
function renderToolCalls(row: UsageRow): string {
  const m = row.meta as unknown as SessionMeta;
  const total = m.toolCalls || 0;
  const head = ` ${c.bold('Tool calls')} `;
  if (!total) return `${head}${c.dim('none recorded')}\n`;
  const stats = toolCallStats([m]);
  const perCall = row.costUSD > 0 ? c.dim(`, ${fmtUSD(row.costUSD / total)} per call`) : '';
  const out = `${head}${c.dim(`(${fmtInt(total)} calls`)}${perCall}${c.dim(')')}\n`;
  if (!stats.length) return out + ` ${c.dim("this tool's logs do not record tool names")}\n`;
  const table = new Table([{ header: 'Tool', maxWidth: 60 }, { header: 'Calls', align: 'right' }, { header: 'Share', align: 'right' }]);
  for (const st of stats.slice(0, TOOL_CALL_ROWS)) {
    table.push([safeName(st.name), fmtInt(st.calls), `${((st.calls / total) * 100).toFixed(1)}%`]);
  }
  const rest = stats.slice(TOOL_CALL_ROWS);
  if (rest.length) {
    const calls = rest.reduce((a, st) => a + st.calls, 0);
    table.push([c.dim(`${rest.length} more`), c.dim(fmtInt(calls)), c.dim(`${((calls / total) * 100).toFixed(1)}%`)]);
  }
  const named = stats.reduce((a, st) => a + st.calls, 0);
  if (named < total) table.push([c.dim('(unnamed)'), c.dim(fmtInt(total - named)), c.dim(`${(((total - named) / total) * 100).toFixed(1)}%`)]);
  return out + '\n' + table.render() + '\n';
}

export async function runSession(opts: CliOptions): Promise<void> {
  const data = await loadData(opts);
  const report = buildReport('session', data.events, data.sessions, {
    timezone: opts.timezone,
    order: opts.order,
    breakdown: true,
  });
  if (opts.id) {
    const needle = opts.id.toLowerCase();
    report.rows = report.rows.filter((r) => {
      const m = r.meta as unknown as SessionMeta;
      return r.key.toLowerCase().includes(needle);
    });
  }
  // hide sessions with neither usage nor any activity
  report.rows = report.rows.filter((r) => {
    const m = r.meta as unknown as SessionMeta;
    return r.totalTokens > 0 || m.userMessages > 0 || m.activeMs > 0;
  });
  report.warnings = data.uniqueWarnings;
  if (opts.json) return printJson(report);
  if (printDelimitedReport(report, opts)) return;
  printWarnings(data.uniqueWarnings, opts);
  if (!report.rows.length) return noData(opts, 'sessions');

  const width = terminalWidth();
  const compact = opts.compact || (process.stdout.isTTY && width < 110);
  const titleMax = compact ? 24 : Math.max(20, Math.min(48, width - 110));
  const columns: Column[] = [
    { header: 'Session' },
    { header: 'Tool' },
    ...(compact ? [] : [{ header: 'Project', maxWidth: 28 } as Column]),
    { header: 'Title', maxWidth: titleMax },
    { header: 'Last Active' },
    { header: 'Active time', align: 'right' },
    ...(compact ? [] : [{ header: 'Models' } as Column]),
    { header: 'Tokens', align: 'right' },
    { header: 'Cost', align: 'right' },
  ];
  const table = new Table(columns);
  let activeTotal = 0;
  for (const r of report.rows) {
    const m = r.meta as unknown as SessionMeta;
    activeTotal += m.activeMs || 0;
    const sid = shortId(m.sessionId) + (m.subagents ? c.dim(` +${m.subagents}`) : '');
    const title = m.title ? truncate(m.title.replace(/\s+/g, ' '), titleMax) : c.dim('-');
    const models = [...new Set(r.models.map(shortModel))];
    table.push([
      sid,
      [toolName(m.tool), ...new Set(r.breakdown.map((b) => b.speed).filter((s) => s === 'fast' || s === 'ultrafast'))].join(' · '),
      ...(compact ? [] : [shortProject(m.project)]),
      title,
      fmtDateTime(m.endedAt, report.timezone),
      fmtDuration(m.activeMs),
      ...(compact ? [] : [models.slice(0, 2).join('\n') + (models.length > 2 ? c.dim(`\n+${models.length - 2}`) : '')]),
      compact ? fmtShort(r.totalTokens) : fmtInt(r.totalTokens),
      fmtUSD(r.costUSD) + (r.meta?.costUnknown ? c.yellow('*') : ''),
    ]);
  }
  table.push(
    [
      `Total (${report.rows.length})`,
      '',
      ...(compact ? [] : ['']),
      '',
      '',
      fmtDuration(activeTotal),
      ...(compact ? [] : ['']),
      compact ? fmtShort(report.totals.totalTokens) : fmtInt(report.totals.totalTokens),
      fmtUSD(report.totals.costUSD),
    ],
    { separatorBefore: true, style: (s) => c.yellow(s) },
  );
  const scope = opts.tools ? opts.tools.map((t) => toolName(t)).join(', ') : 'all tools';
  process.stdout.write(`\n ${c.bold('Sessions')} ${c.dim(`(${scope}, ${report.timezone}; +N = subagents)`)}\n\n`);
  process.stdout.write(table.render() + '\n');
  if (opts.id && report.rows.length === 1) process.stdout.write('\n' + renderToolCalls(report.rows[0]!));
}
