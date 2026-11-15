import { FastModeIcon } from "@/components/icons/FastModeIcon";
import { usagePricing, type ModelBreakdown, type ToolId } from "@clausage/core";
import type { Metadata } from "next";
import { Suspense } from "react";
import { DataTable, type DataColumn, type DataRow } from "@/components/charts/DataTable";
import { Legend, ToolName } from "@/components/charts/Legend";
import { ShareBars, type ShareItem } from "@/components/charts/ShareBars";
import { ModelOrgIcon } from "@/components/icons/BrandIcon";
import { modeDetails, hasFastUsage } from "@/components/models-projects/mode-breakdown";
import { Badge, formatRate, ShareCell } from "@/components/models-projects/cells";
import { PageHeader, Panel } from "@/components/Panel";
import { PanelSkeleton } from "@/components/Skeleton";
import { cacheEfficiencyFor, getFilters, getUsage, lookupPricing, reportFrom } from "@/lib/data";
import { CacheEfficiencyPanel } from "@/components/models-projects/CacheEfficiency";
import { describeRange, filtersToQuery } from "@/lib/filters";
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

  const entries = report.rows;
  const totalCost = report.totals.costUSD;

  const rows: DataRow[] = entries.map((b) => {
    const model = b.key;
    const priceFor = (part: ModelBreakdown) => {
      const base = lookupPricing(data, model, part.tool);
      return base && usagePricing(base, model, part.speed);
    };
    const prices = b.breakdown.map(priceFor);
    const price = prices[0];
    const varies = prices.some((p) => p?.input !== price?.input || p?.output !== price?.output || p?.cacheRead !== price?.cacheRead || p?.cacheWrite !== price?.cacheWrite);
    const share = totalCost > 0 ? b.costUSD / totalCost : 0;
    const rate = b.totalTokens > 0 ? (b.costUSD / b.totalTokens) * M : undefined;
    return {
      id: model,
      modeDetails: modeDetails(model, b.breakdown, priceFor),
      cells: {
        model: (
          <span className="flex max-w-[18rem] flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-1.5">
              <ModelOrgIcon model={model} size="0.875rem" />
              <span className="font-mono text-xs [overflow-wrap:anywhere] text-fg">{model}</span>
              {Boolean(b.meta?.costUnknown) && <Badge title="No price found for some or all of this model's usage; its cost is understated">unpriced</Badge>}
            </span>
            <span className="text-[0.6875rem] text-fg-3 sm:hidden">{b.tools.map((t) => TOOL_LABELS[t]).join(", ")}</span>
          </span>
        ),
        tool: <span className="flex flex-wrap gap-2">{b.tools.map((t) => <ToolName key={t} tool={t} />)}</span>,
        events: formatNumber(b.events),
        input: formatTokens(b.inputTokens),
        output: formatTokens(b.outputTokens),
        reasoning: b.reasoningTokens ? formatTokens(b.reasoningTokens) : "—",
        cacheWrite: formatTokens(b.cacheWriteTokens),
        cacheRead: formatTokens(b.cacheReadTokens),
        total: formatTokens(b.totalTokens),
        cost: formatCost(b.costUSD),
        share: <ShareCell share={share} tool={b.tools[0]!} />,
        rate: formatRate(rate),
        pricing: varies ? "Varies by mode or tool" : price ? (
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
        model,
        tool: b.tools.map((t) => TOOL_LABELS[t]).join(", "),
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
    model: `${formatNumber(report.rows.length)} models`,
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
    key: b.key,
    label: hasFastUsage(b.breakdown) ? <>{b.label} <FastModeIcon /></> : b.label,
    text: b.label,
    value: b.costUSD,
    tool: b.tools.length === 1 ? b.tools[0] : undefined,
    hint: b.tools.map((t) => TOOL_LABELS[t]).join(", "),
  }));
  const cache = cacheEfficiencyFor(data, "model");
  const cacheTotal = cacheEfficiencyFor(data, "total")[0];
  const chartTools: ToolId[] = TOOL_IDS.filter((tool) => entries.some((b) => b.tools.includes(tool) && b.costUSD > 0));

  return (
    <div className="flex flex-col gap-3">
      <Panel
        title="Cost by model"
        description={`${describeRange(filters)} · ${formatCost(totalCost)} across ${formatNumber(entries.length)} models`}
      >
        <Legend tools={chartTools} className="mb-3" />
        <ShareBars title="Cost by model" items={items} format={formatCost} limit={12} emptyMessage="No priced usage in this range." />
      </Panel>
      <CacheEfficiencyPanel rows={cache} total={cacheTotal} />
      <Panel
        title="All models"
        description="Token columns are disjoint: total = input + output + cache write + cache read. Reasoning is part of output."
        actions={<CsvLink href={`/api/usage${csvQuery(filtersToQuery(filters), "models")}`} />}
      >
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

function csvQuery(query: string, kind: string): string {
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  params.set("kind", kind);
  params.set("format", "csv");
  params.set("breakdown", "1");
  return `?${params.toString()}`;
}

function CsvLink({ href }: { href: string }) {
  return (
    <a href={href} download className="text-xs text-fg-2 underline-offset-2 hover:text-fg hover:underline">
      Download CSV
    </a>
  );
}
