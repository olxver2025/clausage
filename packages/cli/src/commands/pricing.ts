import { loadPricing } from '@clausage/core';
import { UsageError, type CliOptions } from '../args.js';
import { printJson } from '../context.js';
import { c } from '../format.js';
import { Table } from '../table.js';

const perM = (v: number | undefined) => (v === undefined ? c.dim('-') : `$${(v * 1e6).toFixed(v * 1e6 < 1 ? 4 : 2)}`);

export async function runPricing(opts: CliOptions): Promise<void> {
  const models = opts.positionals;
  if (!models.length) throw new UsageError('Usage: clausage pricing <model> [<model>...] [--tool <tool>]');
  const warnings: string[] = [];
  const table = await loadPricing({ offline: opts.offline, refresh: opts.refreshPricing, warn: (m) => warnings.push(m) });
  const tool = opts.tools?.[0];
  const results = models.map((model) => {
    const r = table.resolve(model, tool, undefined, Date.now());
    return { model, tool: tool ?? null, match: r?.match ?? null, pricing: r?.pricing ?? null };
  });
  if (opts.json) return printJson({ source: table.source, fetchedAt: table.fetchedAt ?? null, size: table.size, results, warnings });
  for (const w of warnings) process.stderr.write(c.yellow('warning: ') + c.dim(w) + '\n');
  process.stdout.write(c.dim(`Pricing source: ${table.source}${table.fetchedAt ? ` (fetched ${table.fetchedAt})` : ''}, ${table.size} models. USD per 1M tokens.\n`));
  for (const r of results) {
    if (!r.pricing) {
      process.stdout.write(`\n${c.bold(r.model)}: ${c.red('no price found')} ${c.dim('(cost is counted as $0 unless the tool recorded one)')}\n`);
      continue;
    }
    const p = r.pricing;
    process.stdout.write(`\n${c.bold(r.model)} → ${c.cyan(p.key)} ${c.dim(`(${r.match})`)}\n`);
    const t = new Table([
      { header: 'Tier' },
      { header: 'Input', align: 'right' },
      { header: 'Output', align: 'right' },
      { header: 'Cache Read', align: 'right' },
      { header: 'Cache Write 5m', align: 'right' },
      { header: 'Cache Write 1h', align: 'right' },
    ]);
    t.push(['base', perM(p.input), perM(p.output), perM(p.cacheRead), perM(p.cacheWrite), perM(p.cacheWrite1h)]);
    for (const tier of p.tiers ?? []) {
      t.push([`> ${Math.round(tier.threshold / 1000)}k prompt`, perM(tier.input), perM(tier.output), perM(tier.cacheRead), perM(tier.cacheWrite), c.dim('-')]);
    }
    process.stdout.write(t.render() + '\n');
  }
}
