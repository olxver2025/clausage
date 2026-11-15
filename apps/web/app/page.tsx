import type { Report, ToolId, UsageRow } from "@clausage/core";
import Link from "next/link";
import { Suspense } from "react";
import { DataTable, type DataColumn, type DataRow } from "@/components/charts/DataTable";
import { KpiTile } from "@/components/charts/KpiTile";
import { Ticker } from "@/components/charts/Ticker";
import { ToolDot } from "@/components/charts/Legend";
import { modeDetails } from "@/components/models-projects/mode-breakdown";
import { ModelOrgIcon } from "@/components/icons/BrandIcon";
import { TodayStrip } from "@/components/overview/TodayStrip";
import { TokenComposition } from "@/components/overview/TokenComposition";
import { ToolCard } from "@/components/overview/ToolCard";
import { UsageChart } from "@/components/overview/UsageChart";
import { dayStats, lastActiveByTool, periodStats, ratio, requestNow, sessionMeta, type PeriodStats } from "@/components/overview/stats";
import { PageHeader, Panel } from "@/components/Panel";
import { PanelSkeleton } from "@/components/Skeleton";
import { cacheEfficiencyFor, getFilters, getUsage, reportFrom, type UsageData } from "@/lib/data";
import { Insights } from "@/components/overview/Insights";
import { machineGroups, machineLabel } from "@/lib/machines";
import { describeRange, filtersToQuery, previousPeriod, rangeDays, todayIn, type Filters } from "@/lib/filters";
import { formatBucketKey, formatCost, formatDuration, formatNumber, formatPercent, formatTokens, shortPath } from "@/lib/format";
import { fillDailyGaps, sumValues, toolValues, type Metric, type StackedDatum } from "@/lib/series";
import { TOOL_LABELS } from "@/lib/tools";
import { SubscriptionValue } from "@/components/subscriptions/SubscriptionValue";

export const metadata = { title: "Overview" };

export default function OverviewPage({ searchParams }: PageProps<"/">) {
  return (
    <>
      <PageHeader title="Overview" />
      <Suspense fallback={<OverviewSkeleton />}>
        <Overview searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <PanelSkeleton height={44} label="Loading today…" />
      <PanelSkeleton height={96} label="Loading totals…" />
      <PanelSkeleton height={320} />
    </div>
  );
}

const UNIT = { daily: "day", weekly: "week", monthly: "month" } as const;

async function Overview({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const filters = await getFilters(searchParams);
  const now = requestNow();
  const today = todayIn(filters.tz, now);
  const prevFilters = previousPeriod(filters, now);
  const rangeHasToday = (!filters.since || filters.since <= today) && (!filters.until || filters.until >= today);
  const [data, prev, todayData] = await Promise.all([
    getUsage(filters),
    prevFilters ? getUsage(prevFilters).catch(() => undefined) : undefined,
    rangeHasToday ? undefined : getUsage({ ...filters, range: "custom", since: today, until: today, fresh: false }).catch(() => undefined),
  ]);

  const todayStats = dayStats((todayData ?? data).events, today, data.timezone);
  const todayStrip = <TodayStrip day={today} stats={todayStats} now={now} />;

  if (!data.events.length && !data.historical.length) {
    return (
      <div className="flex flex-col gap-3">
        {todayStrip}
        <Suspense fallback={<PanelSkeleton height={160} label="Loading subscription value…" />}><SubscriptionValue filters={filters} now={now} /></Suspense>
        <EmptyState filters={filters} sourceCount={Object.values(data.sources).reduce((n, list) => n + list.length, 0)} />
      </div>
    );
  }

  // Child components get small, precomputed props only: in dev, React serializes every server
  // component's props as debug info, and passing the raw usage data (every event) made this page
  // take tens of seconds to render.
  const { daily: dailyReport, sessionReport, ...stats } = periodStats(data, filters);
  const prevStats = prev ? totalsOf(periodStats(prev, prevFilters!)) : undefined;
  const days = rangeDays(filters, now);
  const until = filters.until ?? today;

  const dailyCost = fillDailyGaps(series(dailyReport, "costUSD", "daily"), filters.since, until, (k) => formatBucketKey(k, "daily"));
  const dailyTokens = fillDailyGaps(series(dailyReport, "totalTokens", "daily"), filters.since, until, (k) => formatBucketKey(k, "daily"));
  const ts = filters.group === "daily" ? dailyReport : reportFrom(data, filters.group, filters);
  const chartCost = filters.group === "daily" ? dailyCost : series(ts, "costUSD", filters.group);
  const chartTokens = filters.group === "daily" ? dailyTokens : series(ts, "totalTokens", filters.group);
  const estimatedPeriods = ts.rows.filter((r) => r.meta?.historical).length;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-3">
        {describeRange(filters)}
        {filters.since && ` · ${filters.since} – ${until}`}
        {!filters.allTools && ` · ${filters.tools.map((t) => TOOL_LABELS[t]).join(", ")}`}
      </p>
      {todayStrip}
      <Suspense fallback={<PanelSkeleton height={160} label="Loading subscription value…" />}><SubscriptionValue filters={filters} now={now} /></Suspense>
      <KpiRow stats={stats} prev={prevStats} days={days} cost={dailyCost} tokens={dailyTokens} cacheSavedUSD={cacheEfficiencyFor(data, "total")[0]?.savedUSD} />
      <Panel title="Usage over time" description={`Stacked by tool · ${formatCost(ts.totals.costUSD)} · ${formatTokens(ts.totals.totalTokens)} tokens`}>
        <UsageChart cost={chartCost} tokens={chartTokens} unit={UNIT[filters.group]} estimated={estimatedPeriods} />
      </Panel>
      <Suspense fallback={<PanelSkeleton height={220} label="Loading forecast…" />}>
        <Insights filters={filters} now={now} />
      </Suspense>
      <ToolCards {...toolSummaries(data, filters, sessionReport, dailyCost)} filters={filters} now={now} />
      <Computers data={data} filters={filters} />
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Token composition" description={`${formatTokens(stats.totalTokens)} tokens`} className="lg:col-span-2">
          <TokenComposition {...stats} />
        </Panel>
        <TopModels report={topRows(reportFrom(data, "models", filters))} filters={filters} />
        <TopProjects report={topRows(reportFrom(data, "projects", filters))} filters={filters} estimated={stats.estimatedDays > 0} />
      </div>
    </div>
  );
}

function series(report: Report, metric: Metric, group: Filters["group"]): StackedDatum[] {
  return report.rows.map((row: UsageRow) => {
    const base = formatBucketKey(row.key, group);
    const estimated = Boolean(row.meta?.historical);
    return {
      key: row.key,
      label: estimated ? `${base} (estimated)` : base,
      short: estimated ? `${base}*` : undefined,
      values: toolValues(row, metric),
    };
  });
}

type PeriodTotals = Omit<PeriodStats, "daily" | "sessionReport">;

function totalsOf(stats: PeriodStats): PeriodTotals {
  const { daily, sessionReport, ...totals } = stats;
  void daily;
  void sessionReport;
  return totals;
}

/** The first rows of a report plus its totals, for the "top 5" panels. */
interface TopRows {
  rows: UsageRow[];
  count: number;
  totalCost: number;
}

function topRows(report: Report, n = 5): TopRows {
  return { rows: report.rows.slice(0, n), count: report.rows.length, totalCost: report.totals.costUSD };
}

function KpiRow({
  stats,
  prev,
  days,
  cost,
  tokens,
  cacheSavedUSD,
}: {
  stats: PeriodTotals;
  prev?: PeriodTotals;
  days?: number;
  cost: StackedDatum[];
  tokens: StackedDatum[];
  /** what prompt caching saved versus uncached input, at list prices */
  cacheSavedUSD?: number;
}) {
  const vs = days ? `vs prev ${days}d` : undefined;
  // Percentages past +999% read as noise; those show the multiple in the sub line instead.
  const big = (cur: number, before: number | undefined) => {
    const r = prev ? ratio(cur, before) : null;
    return r !== null && r >= 10 ? `▲ ${Math.round(r + 1)}× ${vs ?? ""}`.trim() : undefined;
  };
  const delta = (cur: number, before: number | undefined) =>
    prev && !big(cur, before) ? { ratio: ratio(cur, before), goodWhen: "neutral" as const, label: vs } : undefined;
  const sub = (cur: number, before: number | undefined, rest?: string) => [big(cur, before), rest].filter(Boolean).join(" · ") || undefined;
  const hitPts = stats.cacheHit !== null && prev?.cacheHit != null ? (stats.cacheHit - prev.cacheHit) * 100 : null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <KpiTile
        label="Total cost"
        value={<Ticker value={stats.costUSD} format="cost" />}
        delta={delta(stats.costUSD, prev?.costUSD)}
        sub={sub(stats.costUSD, prev?.costUSD, stats.estimatedDays > 0 ? `incl. ${stats.estimatedDays} estimated day${stats.estimatedDays === 1 ? "" : "s"}` : undefined)}
        spark={cost.map((d) => sumValues(d.values))}
        sparkLabel="Daily cost"
        className="col-span-2 lg:col-span-1"
      />
      <KpiTile
        label="Total tokens"
        value={<Ticker value={stats.totalTokens} format="tokens" />}
        delta={delta(stats.totalTokens, prev?.totalTokens)}
        sub={sub(stats.totalTokens, prev?.totalTokens)}
        spark={tokens.map((d) => sumValues(d.values))}
        sparkLabel="Daily tokens"
        className="col-span-2 lg:col-span-1"
      />
      <KpiTile
        label="Sessions"
        value={<Ticker value={stats.sessions} format="number" />}
        delta={delta(stats.sessions, prev?.sessions)}
        sub={sub(stats.sessions, prev?.sessions, stats.sessions > 0 ? `${formatCost(stats.costUSD / stats.sessions)} avg` : undefined)}
      />
      <KpiTile
        label="Active time"
        value={<Ticker value={stats.activeMs} format="duration" />}
        delta={delta(stats.activeMs, prev?.activeMs)}
        sub={sub(stats.activeMs, prev?.activeMs, stats.sessions > 0 ? `${formatDuration(stats.activeMs / stats.sessions)} per session` : undefined)}
      />
      <KpiTile
        label="Cache-hit ratio"
        className="col-span-2 lg:col-span-1"
        value={stats.cacheHit === null ? "—" : <Ticker value={stats.cacheHit} format="percent" />}
        sub={
          [
            cacheSavedUSD !== undefined && cacheSavedUSD > 0 ? `saved ${formatCost(cacheSavedUSD)}` : undefined,
            hitPts !== null ? `${hitPts >= 0 ? "+" : "−"}${Math.abs(hitPts).toFixed(1)} pts ${vs ?? ""}`.trim() : undefined,
          ]
            .filter(Boolean)
            .join(" · ") || "cache read ÷ all input"
        }
      />
    </div>
  );
}

interface ToolSummary {
  tool: ToolId;
  costUSD: number;
  totalTokens: number;
  sessions: number;
  activeMs: number;
  share: number | null;
  topModel?: string;
  lastActive?: { at: number; estimated: boolean };
  spark: number[];
}

function toolSummaries(
  data: UsageData,
  filters: Filters,
  sessionReport: Report,
  dailyCost: StackedDatum[],
): { tools: ToolSummary[]; shareOf: "cost" | "tokens" } {
  const tools = reportFrom(data, "tools", filters);
  const byTool = new Map(tools.rows.map((r) => [r.key as ToolId, r]));
  const sessions = new Map<ToolId, { count: number; activeMs: number }>();
  for (const row of sessionReport.rows) {
    const m = sessionMeta(row);
    const s = sessions.get(m.tool) ?? { count: 0, activeMs: 0 };
    s.count += 1;
    s.activeMs += m.activeMs || 0;
    sessions.set(m.tool, s);
  }
  const last = lastActiveByTool(data);
  const byCost = tools.totals.costUSD > 0;
  const total = byCost ? tools.totals.costUSD : tools.totals.totalTokens;
  const summaries = filters.tools.map((t): ToolSummary => {
    const row = byTool.get(t);
    const models = new Map<string, { model: string; costUSD: number; totalTokens: number }>();
    for (const b of row?.breakdown ?? []) {
      const sum = models.get(b.model) ?? { model: b.model, costUSD: 0, totalTokens: 0 };
      sum.costUSD += b.costUSD;
      sum.totalTokens += b.totalTokens;
      models.set(b.model, sum);
    }
    const top = [...models.values()].sort((a, b) => b.costUSD - a.costUSD || b.totalTokens - a.totalTokens)[0];
    const value = row ? (byCost ? row.costUSD : row.totalTokens) : 0;
    return {
      tool: t,
      costUSD: row?.costUSD ?? 0,
      totalTokens: row?.totalTokens ?? 0,
      sessions: sessions.get(t)?.count ?? 0,
      activeMs: sessions.get(t)?.activeMs ?? 0,
      share: total > 0 ? value / total : null,
      topModel: top?.model || undefined,
      lastActive: last[t],
      spark: dailyCost.map((d) => d.values[t] ?? 0),
    };
  });
  return { tools: summaries, shareOf: byCost ? "cost" : "tokens" };
}

function ToolCards({ tools, shareOf, filters, now }: { tools: ToolSummary[]; shareOf: "cost" | "tokens"; filters: Filters; now: number }) {
  return (
    <section aria-labelledby="by-tool-heading">
      <h2 id="by-tool-heading" className="sr-only">
        By tool
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tools.map(({ tool: t, ...summary }) => (
          <ToolCard
            key={t}
            tool={t}
            {...summary}
            shareOf={shareOf}
            sessionsHref={`/sessions${filtersToQuery({ ...filters, tools: [t], allTools: false })}`}
            now={now}
          />
        ))}
      </div>
    </section>
  );
}

function ViewAll({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className="text-xs text-fg-2 underline-offset-2 hover:text-fg hover:underline">
      {children} <span aria-hidden="true">→</span>
    </Link>
  );
}

function Tools({ tools }: { tools: ToolId[] }) {
  return (
    <span className="inline-flex shrink-0 gap-0.5">
      {tools.map((t) => (
        <ToolDot key={t} tool={t} />
      ))}
      <span className="sr-only">{tools.map((t) => TOOL_LABELS[t]).join(", ")}</span>
    </span>
  );
}

function TopModels({ report, filters }: { report: TopRows; filters: Filters }) {
  const total = report.totalCost;
  const columns: DataColumn[] = [
    { key: "model", header: "Model", sortable: false },
    { key: "cost", header: "Cost", numeric: true, sortable: false },
    { key: "tokens", header: "Tokens", numeric: true, sortable: false, hideBelow: "sm" },
    { key: "share", header: "Share", numeric: true, sortable: false },
  ];
  const rows: DataRow[] = report.rows.map((r) => ({
    id: r.key,
    modeDetails: modeDetails(r.key, r.breakdown),
    cells: {
      model: (
        <span className="flex min-w-0 items-center gap-1.5">
          <ModelOrgIcon model={r.key} size="0.875rem" />
          <span className="truncate font-mono" title={`${r.key} · ${r.tools.map((t) => TOOL_LABELS[t]).join(", ")}`}>
            {r.label}
          </span>
        </span>
      ),
      cost: formatCost(r.costUSD),
      tokens: formatTokens(r.totalTokens),
      share: total > 0 ? formatPercent(r.costUSD / total) : "—",
    },
  }));
  return (
    <Panel title="Top models" description={`${formatNumber(report.count)} models · by cost`} actions={<ViewAll href={`/models${filtersToQuery(filters)}`}>All models</ViewAll>}>
      <DataTable caption="Top 5 models by cost" columns={columns} rows={rows} emptyMessage="No models in this range." />
    </Panel>
  );
}

/** A projects-report row's directory (rows are keyed "path@machine" when several computers are synced). */
function projectPath(r: UsageRow): string {
  return (r.meta?.project as string | undefined) ?? r.key;
}

function TopProjects({ report, filters, estimated }: { report: TopRows; filters: Filters; estimated: boolean }) {
  const columns: DataColumn[] = [
    { key: "project", header: "Project", sortable: false },
    { key: "cost", header: "Cost", numeric: true, sortable: false },
    { key: "sessions", header: "Sessions", numeric: true, sortable: false, hideBelow: "sm" },
    { key: "tokens", header: "Tokens", numeric: true, sortable: false, hideBelow: "md" },
  ];
  const rows: DataRow[] = report.rows.map((r) => ({
    id: r.key || "(unknown)",
    cells: {
      project: (
        <span className="flex min-w-0 items-center gap-1.5">
          <Tools tools={r.tools} />
          <span className="truncate font-mono" title={(r.meta?.project as string | undefined) ?? (r.key || undefined)}>
            {projectPath(r) ? shortPath(projectPath(r)) : "(unknown)"}
          </span>
          {typeof r.meta?.machine === "string" && r.key.includes("@") && <span className="truncate text-fg-3">{r.meta.machine}</span>}
        </span>
      ),
      cost: formatCost(r.costUSD),
      sessions: formatNumber(Number(r.meta?.sessions ?? 0)),
      tokens: formatTokens(r.totalTokens),
    },
  }));
  return (
    <Panel
      title="Top projects"
      description={`${formatNumber(report.count)} projects · by cost${estimated ? " · excludes estimated days" : ""}`}
      actions={<ViewAll href={`/projects${filtersToQuery(filters)}`}>All projects</ViewAll>}
    >
      <DataTable caption="Top 5 projects by cost" columns={columns} rows={rows} emptyMessage="No projects in this range." />
    </Panel>
  );
}

function EmptyState({ filters, sourceCount: found }: { filters: Filters; sourceCount: number }) {
  const allTime = `/${filtersToQuery({ ...filters, range: "all", since: undefined, until: undefined })}`;
  const allTools = `/${filtersToQuery({ ...filters, tools: [], allTools: true })}`;
  return (
    <Panel title="No usage in this range">
      <div className="flex flex-col gap-3 text-sm text-fg-2">
        <p>
          Nothing was recorded in the selected range ({describeRange(filters)})
          {!filters.allTools && ` in ${filters.tools.map((t) => TOOL_LABELS[t]).join(", ")}`}
          {filters.project && ` for projects matching “${filters.project}”`}.
        </p>
        <p className="text-xs text-fg-3">
          {found > 0
            ? `${found} data folder${found === 1 ? " was" : "s were"} scanned. The footer lists them.`
            : "No data folders were found for the selected tools. Run Claude Code, Codex, Grok Build or OpenCode at least once, or set the tool's data directory environment variable."}
        </p>
        <div className="flex flex-wrap gap-4 text-xs">
          {filters.range !== "all" && <ViewAll href={allTime}>Show all time</ViewAll>}
          {!filters.allTools && <ViewAll href={allTools}>Show all tools</ViewAll>}
        </div>
      </div>
    </Panel>
  );
}

/** Cost and tokens per computer; only shown when usage from more than one computer is synced. */
function Computers({ data, filters }: { data: UsageData; filters: Filters }) {
  const by = new Map<string, { cost: number; tokens: number; tools: Set<ToolId> }>();
  for (const x of [...data.events, ...data.historical]) {
    const k = x.machine ?? "";
    const m = by.get(k) ?? { cost: 0, tokens: 0, tools: new Set<ToolId>() };
    m.cost += x.costUSD ?? 0;
    m.tokens += x.inputTokens + x.outputTokens + x.cacheReadTokens + x.cacheWriteTokens;
    m.tools.add(x.tool);
    by.set(k, m);
  }
  const names = machineGroups(data.machines, by.keys());
  if (!names.length) return null;
  const total = [...by.values()].reduce((n, m) => n + m.cost, 0);
  const columns: DataColumn[] = [
    { key: "machine", header: "Computer", sortable: false },
    { key: "tools", header: "Tools", sortable: false, hideBelow: "sm" },
    { key: "cost", header: "Cost", numeric: true, sortable: false },
    { key: "tokens", header: "Tokens", numeric: true, sortable: false, hideBelow: "sm" },
    { key: "share", header: "Share", numeric: true, sortable: false },
  ];
  const rows: DataRow[] = names.map((name) => {
    const m = by.get(name)!;
    return {
      id: name || "__unknown",
      cells: {
        machine: (
          <Link href={`/sessions${filtersToQuery({ ...filters, machines: [name] })}`} className="font-medium underline decoration-line-strong underline-offset-2 hover:decoration-accent">
            {machineLabel(data.machines, name)}
          </Link>
        ),
        tools: <Tools tools={[...m.tools].sort()} />,
        cost: formatCost(m.cost),
        tokens: formatTokens(m.tokens),
        share: total > 0 ? formatPercent(m.cost / total) : "—",
      },
    };
  });
  return (
    <Panel title="By computer" description={`${names.length} computers · totals above include all of them`}>
      <DataTable caption="Usage per computer" columns={columns} rows={rows} />
    </Panel>
  );
}
