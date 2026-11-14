import type { Metadata } from "next";
import { Suspense } from "react";
import { ActiveBlockCard } from "@/components/blocks/ActiveBlockCard";
import { ActivityHeatmap } from "@/components/blocks/ActivityHeatmap";
import { activityHeatmap, blockTimeline, requestTime, summarizeBlocks } from "@/components/blocks/blocks-data";
import { BlocksTable } from "@/components/blocks/BlocksTable";
import { CodexLimits } from "@/components/blocks/CodexLimits";
import { TokenBudget } from "@/components/blocks/TokenBudget";
import { KpiTile } from "@/components/charts/KpiTile";
import { PageHeader, Panel } from "@/components/Panel";
import { PanelSkeleton } from "@/components/Skeleton";
import { getCodexRateLimits, getFilters, getUsage, reportFrom } from "@/lib/data";
import { describeRange } from "@/lib/filters";
import { formatCompact, formatCost, formatDuration, formatRelative, formatTime } from "@/lib/format";

export const metadata: Metadata = { title: "Blocks & limits" };

type SearchParams = PageProps<"/blocks">["searchParams"];

const BLOCK_HOURS = 5;
const RECENT_BLOCKS = 60;

export default function Page({ searchParams }: PageProps<"/blocks">) {
  return (
    <>
      <PageHeader title="Blocks & limits" description={`${BLOCK_HOURS}-hour billing blocks per tool, starting at the hour of the first request`} />
      <div className="grid gap-4">
        <Suspense fallback={<PanelSkeleton height={220} label="Loading blocks…" />}>
          <BlocksContent searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

async function BlocksContent({ searchParams }: { searchParams: SearchParams }) {
  const filters = await getFilters(searchParams);
  const data = await getUsage(filters);
  const now = requestTime();
  const tz = data.timezone;
  const blocks = summarizeBlocks(reportFrom(data, "blocks", filters, { order: "desc", sessionLengthHours: BLOCK_HOURS }));
  const active = blocks.filter((b) => b.isActive);
  const heat = activityHeatmap(data.events, tz);
  const timeline = blockTimeline(blocks, BLOCK_HOURS * 3_600_000);
  const recent: typeof timeline = [];
  let shown = 0;
  for (const item of timeline) {
    if (item.kind === "block" && ++shown > RECENT_BLOCKS) break;
    recent.push(item);
  }
  const range = describeRange(filters);
  const totalTokens = blocks.reduce((s, b) => s + b.totalTokens, 0);
  const totalCost = blocks.reduce((s, b) => s + b.costUSD, 0);
  const largest = blocks.reduce((m, b) => Math.max(m, b.totalTokens), 0);
  const avgMs = blocks.length ? blocks.reduce((s, b) => s + (b.lastMs - b.firstMs), 0) / blocks.length : 0;
  const last = blocks[0];

  return (
    <>
      <section aria-labelledby="active-heading" className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="active-heading" className="text-sm font-semibold">
            Active {active.length === 1 ? "block" : "blocks"}
          </h2>
          <span className="text-xs text-fg-3">As of {formatTime(now, tz)} · times in {tz}</span>
        </div>
        {active.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {active.map((b) => (
              <ActiveBlockCard key={b.id} block={b} now={now} timeZone={tz} />
            ))}
          </div>
        ) : (
          <p className="panel px-3 py-4 text-sm text-fg-3 sm:px-4">
            No active block.{last && <> The last one ({formatCompact(last.totalTokens)} tokens) ended {formatRelative(last.lastMs, now)}.</>}
          </p>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Token budget" description="A custom per-block token limit to pace yourself against">
          <TokenBudget blocks={active.map((b) => ({ id: b.id, tool: b.tool, tokens: b.totalTokens, projectedTokens: b.projectedTokens }))} largest={largest} />
        </Panel>
        <Panel title="Codex rate limits" description="From the latest Codex response that reported them">
          <Suspense fallback={<p className="text-xs text-fg-3">Reading Codex rate limits…</p>}>
            <CodexLimitsSection fresh={filters.fresh} timeZone={tz} />
          </Suspense>
        </Panel>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiTile label="Blocks" value={blocks.length.toLocaleString("en-US")} sub={range} />
        <KpiTile label="Avg tokens per block" value={formatCompact(blocks.length ? totalTokens / blocks.length : 0)} sub={`Largest ${formatCompact(largest)}`} />
        <KpiTile label="Avg cost per block" value={formatCost(blocks.length ? totalCost / blocks.length : 0)} sub={`${formatCost(totalCost)} total`} />
        <KpiTile label="Avg active span" value={formatDuration(avgMs)} sub="First to last request" />
      </div>

      <Panel title="Recent blocks" description={`Newest first, up to ${RECENT_BLOCKS} · idle stretches of ${BLOCK_HOURS}h or more shown between blocks`}>
        <BlocksTable items={recent} timeZone={tz} caption={`Recent billing blocks, ${range}`} />
      </Panel>

      <Panel title="Activity by hour" description={`Tokens by weekday and hour of day, all selected tools · ${range} · ${tz}`}>
        <ActivityHeatmap
          title="Tokens by weekday and hour"
          description={`Heatmap of ${formatCompact(heat.total)} tokens by weekday (rows, Monday first) and hour of day (columns) in ${tz}. Darker cells mean more tokens.`}
          tokens={heat.tokens}
          events={heat.events}
          max={heat.max}
        />
      </Panel>
    </>
  );
}

async function CodexLimitsSection({ fresh, timeZone }: { fresh: boolean; timeZone: string }) {
  const limits = await getCodexRateLimits(fresh);
  return <CodexLimits limits={limits} now={requestTime()} timeZone={timeZone} />;
}
