import type { ToolId } from "@clausage/core";
import type { Metadata } from "next";
import { Suspense } from "react";
import { DataTable, type DataColumn, type DataRow } from "@/components/charts/DataTable";
import { Legend, ToolName } from "@/components/charts/Legend";
import { ShareBars, type ShareItem } from "@/components/charts/ShareBars";
import { Badge, formatRate, ShareCell } from "@/components/models-projects/cells";
import { PageHeader, Panel } from "@/components/Panel";
import { PanelSkeleton } from "@/components/Skeleton";
import { getFilters, getUsage, lookupPricing, reportFrom } from "@/lib/data";
import { describeRange } from "@/lib/filters";
import { formatCost, formatNumber, formatTokens } from "@/lib/format";
import { TOOL_IDS, TOOL_LABELS } from "@/lib/tools";

export const metadata: Metadata = { title: "Models" };

export default function ModelsPage({ searchParams }: PageProps<"/models">) {
  return (
    <>
      <PageHeader title="Models" description="Tokens, cost and resolved pricing per tool and model" />
      <Suspense fallback={<PanelSkeleton height={480} label="Loading models" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const M = 1_000_000;

const columns: DataColumn[] = [
  { key: "model", header: "Model" },
  { key: "tool", header: "Tool", hideBelow: "sm" },
  { key: "events", header: "Events", numeric: true, hideBelow: "2xl" },
  { key: "input", header: "Input", numeric: true, hideBelow: "md" },
  { key: "output", header: "Output", numeric: true, hideBelow: "md" },
  { key: "reasoning", header: "Reasoning", numeric: true, hideBelow: "2xl" },
  { key: "cacheWrite", header: "Cache write", numeric: true, hideBelow: "2xl" },
  { key: "cacheRead", header: "Cache read", numeric: true, hideBelow: "lg" },
  { key: "total", header: "Total", numeric: true },
  { key: "cost", header: "Cost", numeric: true },
  { key: "share", header: "Share", numeric: true, hideBelow: "sm" },
  { key: "rate", header: "$/1M eff.", numeric: true, hideBelow: "2xl" },
  { key: "pricing", header: "Pricing (per 1M)", sortable: false, hideBelow: "2xl" },
];

async function Content({ searchParams }: { searchParams: PageProps<"/models">["searchParams"] }) {
  const filters = await getFilters(searchParams);
  const data = await getUsage(filters);
  const report = reportFrom(data, "models", filters);

  const unknown = new Set<string>();
  for (const e of data.events) if (e.costUnknown) unknown.add(`${e.tool}|${e.model || "(unknown)"}`);
  for (const h of data.historical) if (h.costUnknown) unknown.add(`${h.tool}|${h.model || "(unknown)"}`);

  const entries = report.rows.flatMap((row) => row.breakdown.map((b) => ({ ...b, model: b.model || row.key })));
  const totalCost = report.totals.costUSD;

  const rows: DataRow[] = entries.map((b) => {
    const id = `${b.tool}|${b.model}`;
    const price = lookupPricing(data, b.model, b.tool);
    const share = totalCost > 0 ? b.costUSD / totalCost : 0;
    const rate = b.totalTokens > 0 ? (b.costUSD / b.totalTokens) * M : undefined;
    const unpriced = unknown.has(id);
    return {
      id,
      cells: {
        model: (
          <span className="flex min-w-[8rem] max-w-[18rem] flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs [overflow-wrap:anywhere] text-fg">{b.model}</span>
              {unpriced && <Badge title="No price found for some or all of this model's usage; its cost is understated">unpriced</Badge>}
            </span>
            <span className="text-[0.6875rem] text-fg-3 sm:hidden">{TOOL_LABELS[b.tool]}</span>
          </span>
        ),
        tool: <ToolName tool={b.tool} />,
        events: formatNumber(b.events),
        input: formatTokens(b.inputTokens),
        output: formatTokens(b.outputTokens),
        reasoning: b.reasoningTokens ? formatTokens(b.reasoningTokens) : "—",
        cacheWrite: formatTokens(b.cacheWriteTokens),
        cacheRead: formatTokens(b.cacheReadTokens),
        total: formatTokens(b.totalTokens),
        cost: formatCost(b.costUSD),
        share: <ShareCell share={share} tool={b.tool} />,
        rate: formatRate(rate),
        pricing: price ? (
          <span className="flex flex-col gap-0.5 text-[0.6875rem]">
            <span className="max-w-[18rem] font-mono [overflow-wrap:anywhere] text-fg-2">{price.key}</span>
            <span className="tabular whitespace-nowrap text-fg-3">
              in {formatRate(price.input * M)} · out {formatRate(price.output * M)}
              {price.cacheRead !== undefined && ` · cache r ${formatRate(price.cacheRead * M)}`}
              {price.cacheWrite !== undefined && ` · cache w ${formatRate(price.cacheWrite * M)}`}
            </span>
          </span>
        ) : (
          <span className="text-xs text-fg-3">{b.costUSD > 0 ? "recorded by tool" : "no price"}</span>
        ),
      },
      sort: {
        model: b.model,
        tool: TOOL_LABELS[b.tool],
        events: b.events,
        input: b.inputTokens,
        output: b.outputTokens,
        reasoning: b.reasoningTokens,
        cacheWrite: b.cacheWriteTokens,
        cacheRead: b.cacheReadTokens,
        total: b.totalTokens,
        cost: b.costUSD,
        share,
        rate: rate ?? null,
      },
    };
  });

  const t = report.totals;
  const footer = {
    model: `${formatNumber(entries.length)} models`,
    events: formatNumber(t.events),
    input: formatTokens(t.inputTokens),
    output: formatTokens(t.outputTokens),
    reasoning: formatTokens(t.reasoningTokens),
    cacheWrite: formatTokens(t.cacheWriteTokens),
    cacheRead: formatTokens(t.cacheReadTokens),
    total: formatTokens(t.totalTokens),
    cost: formatCost(t.costUSD),
    rate: formatRate(t.totalTokens > 0 ? (t.costUSD / t.totalTokens) * M : undefined),
  };

  const items: ShareItem[] = entries.map((b) => ({
    key: `${b.tool}|${b.model}`,
    label: b.model,
    text: `${b.model} (${TOOL_LABELS[b.tool]})`,
    value: b.costUSD,
    tool: b.tool,
    hint: TOOL_LABELS[b.tool],
  }));
  const chartTools: ToolId[] = TOOL_IDS.filter((tool) => entries.some((b) => b.tool === tool && b.costUSD > 0));

  return (
    <div className="flex flex-col gap-3">
      <Panel
        title="Cost by model"
        description={`${describeRange(filters)} · ${formatCost(totalCost)} across ${formatNumber(entries.length)} tool/model pairs`}
      >
        <Legend tools={chartTools} className="mb-3" />
        <ShareBars title="Cost by model" items={items} format={formatCost} limit={12} emptyMessage="No priced usage in this range." />
      </Panel>
      <Panel title="All models" description="Token columns are disjoint: total = input + output + cache write + cache read. Reasoning is part of output.">
        <DataTable
          caption="Usage and pricing per tool and model"
          columns={columns}
          rows={rows}
          defaultSort={{ key: "cost", dir: "desc" }}
          maxHeight="40rem"
          footer={footer}
          emptyMessage="No usage in this range."
        />
      </Panel>
    </div>
  );
}
