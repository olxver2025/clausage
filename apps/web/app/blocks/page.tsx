import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ActiveBlockCard } from "@/components/blocks/ActiveBlockCard";
import { ActivityHeatmap } from "@/components/blocks/ActivityHeatmap";
import { activityHeatmap, blockTimeline, requestTime, summarizeBlocks } from "@/components/blocks/blocks-data";
import { BlocksTable } from "@/components/blocks/BlocksTable";
import { UsageLimits } from "@/components/blocks/UsageLimits";
import { KpiTile } from "@/components/charts/KpiTile";
import { PageHeader, Panel } from "@/components/Panel";
import { PanelSkeleton } from "@/components/Skeleton";
import { getFilters, getLimitStatus, getUsage, reportFrom } from "@/lib/data";
import "./blocks.css";
import { describeRange } from "@/lib/filters";
import { formatCompact, formatCost, formatDuration, formatRelative, formatTime } from "@/lib/format";

export const metadata: Metadata = { title: "Blocks & limits" };

type SearchParams = PageProps<"/blocks">["searchParams"];

const BLOCK_HOURS = 5;
const RECENT_BLOCKS = 60;

export default function Page({ searchParams }: PageProps<"/blocks">) {
  return (
    <>
      <PageHeader
        title="Blocks & limits"
        description={`Usage against each tool's 5-hour and weekly limits, and ${BLOCK_HOURS}-hour blocks (the provider's reported windows where it reports them)`}
      />
      <div className="grid gap-4">
        <Suspense fallback={<PanelSkeleton height={200} label="Loading usage limits…" />}>
          <LimitsContent searchParams={searchParams} />
        </Suspense>
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
  const blocks = summarizeBlocks(reportFrom(data, "blocks", filters, { order: "desc", sessionLengthHours: BLOCK_HOURS, limits: true }));
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

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiTile label="Blocks" value={blocks.length.toLocaleString("en-US")} sub={range} />
        <KpiTile label="Avg tokens per block" value={formatCompact(blocks.length ? totalTokens / blocks.length : 0)} sub={`Largest ${formatCompact(largest)}`} />
        <KpiTile label="Avg cost per block" value={formatCost(blocks.length ? totalCost / blocks.length : 0)} sub={`${formatCost(totalCost)} total`} />
        <KpiTile label="Avg active span" value={formatDuration(avgMs)} sub="First to last request" />
      </div>

      <Panel
        title="Recent blocks"
        description={`Newest first, up to ${RECENT_BLOCKS} · 5h limit is the share of the 5-hour limit each block used (reported, or of your limit) · idle stretches of ${BLOCK_HOURS}h or more between blocks`}
      >
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

async function LimitsContent({ searchParams }: { searchParams: SearchParams }) {
  const filters = await getFilters(searchParams);
  const { tools, now, timezone, claude } = await getLimitStatus(filters);
  const hits = tools.reduce((n, t) => n + t.hits.filter((h) => now - h.timestamp < 35 * 86_400_000).length, 0);
  return (
    <section aria-labelledby="limits-heading" className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="limits-heading" className="text-sm font-semibold">
          Usage limits
        </h2>
        <span className="text-xs text-fg-3">
          {hits ? `${hits} limit hit${hits === 1 ? "" : "s"} in the last 35 days · ` : ""}
          <Link href="/settings#limits" className="underline decoration-line-strong underline-offset-2 hover:text-fg">
            Limit settings
          </Link>
        </span>
      </div>
      <UsageLimits tools={tools} now={now} timeZone={timezone} claude={claude} />
    </section>
  );
}
