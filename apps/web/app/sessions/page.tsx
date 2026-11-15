import type { Metadata } from "next";
import { Suspense } from "react";
import type { SessionMeta } from "@clausage/core";
import { KpiTile } from "@/components/charts/KpiTile";
import { PageHeader, Panel } from "@/components/Panel";
import { PanelSkeleton } from "@/components/Skeleton";
import { SessionsTable, type SessionListRow } from "@/components/sessions/SessionsTable";
import { displayTitle, sessionHref } from "@/components/sessions/links";
import { costPerCall, McpServerLine, ToolCallBars, toolCallSummary } from "@/components/sessions/ToolCalls";
import { getFilters, getUsage, reportFrom } from "@/lib/data";
import { describeRange, filtersToQuery } from "@/lib/filters";
import { machineGroups, machineLabel } from "@/lib/machines";
import { formatCost, formatDuration, formatNumber, formatTokens } from "@/lib/format";

export const metadata: Metadata = { title: "Sessions" };

export default function SessionsPage({ searchParams }: PageProps<"/sessions">) {
  return (
    <>
      <PageHeader title="Sessions" description="Root sessions with their subagents folded in, most recently active first." />
      <Suspense fallback={<PanelSkeleton height={480} label="Loading sessions" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Content({ searchParams }: { searchParams: PageProps<"/sessions">["searchParams"] }) {
  const filters = await getFilters(searchParams);
  const data = await getUsage(filters);
  const report = reportFrom(data, "session", filters, { order: "desc", breakdown: false });
  const query = filtersToQuery(filters);

  const metas = report.rows.map((r) => r.meta as unknown as SessionMeta);
  const calls = toolCallSummary(metas);
  const perCall = costPerCall(report.rows.map((r) => ({ ...(r.meta as unknown as SessionMeta), costUSD: r.costUSD })));

  const rows: SessionListRow[] = report.rows.map((r) => {
    const m = r.meta as unknown as SessionMeta;
    return {
      id: r.key,
      tool: m.tool,
      sessionId: m.sessionId,
      title: displayTitle(m.title) ?? null,
      project: m.project || "",
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      activeMs: m.activeMs,
      turns: m.turns,
      userMessages: m.userMessages,
      toolCalls: m.toolCalls,
      subagents: m.subagents,
      models: r.models,
      totalTokens: r.totalTokens,
      costUSD: r.costUSD,
      costUnknown: Boolean(r.meta?.costUnknown),
      href: sessionHref(m.tool, m.sessionId, query),
      machine: m.machine,
    };
  });
  const groups = machineGroups(data.machines, rows.map((r) => r.machine));

  const count = rows.length;
  const cost = report.totals.costUSD;
  const active = rows.reduce((s, r) => s + (r.activeMs || 0), 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiTile label="Sessions" value={formatNumber(count)} sub={describeRange(filters)} />
        <KpiTile label="Cost" value={formatCost(cost)} sub={count ? `${formatCost(cost / count)} per session` : undefined} />
        <KpiTile label="Tokens" value={formatTokens(report.totals.totalTokens)} sub={`${formatNumber(report.totals.events)} requests`} />
        <KpiTile label="Active time" value={formatDuration(active)} sub={count ? `${formatDuration(active / count)} per session` : undefined} />
      </div>
      {calls.calls > 0 && (
        <Panel
          title="Top tool calls"
          description={`Tool names only, across the ${formatNumber(count)} sessions listed below, subagents included`}
        >
          <dl className="mb-3 grid grid-cols-3 gap-3 text-xs">
            <ToolCallFigure label="Tool calls" value={formatNumber(calls.calls)} />
            <ToolCallFigure label="Per session" value={formatAverage(count ? calls.calls / count : 0)} />
            <ToolCallFigure label="Cost per call" value={perCall === null ? "–" : formatCost(perCall)} title="Cost of the sessions that made tool calls, divided by their calls" />
          </dl>
          <ToolCallBars title="Top tool calls" sessions={metas} limit={10} showSessions />
          <McpServerLine sessions={metas} />
        </Panel>
      )}
      {groups.length > 0 ? (
        groups.map((machine) => {
          const own = rows.filter((r) => (r.machine ?? "") === machine);
          return (
            <Panel key={machine || "__unknown"} title={machineLabel(data.machines, machine)} description={`${formatNumber(own.length)} sessions · ${formatCost(own.reduce((n, r) => n + r.costUSD, 0))}`}>
              <SessionsTable rows={own} timeZone={data.timezone} />
            </Panel>
          );
        })
      ) : (
        <Panel title="All sessions" description={`${describeRange(filters)} · ${data.timezone}`}>
          <SessionsTable rows={rows} timeZone={data.timezone} />
        </Panel>
      )}
    </div>
  );
}

function ToolCallFigure({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="filter-label">{label}</dt>
      <dd className="figure mt-0.5 text-base font-semibold text-fg">{value}</dd>
    </div>
  );
}

/** One decimal for small averages (2.4 calls per session), whole numbers above 100. */
function formatAverage(n: number): string {
  return n >= 100 ? formatNumber(n) : n.toFixed(1).replace(/\.0$/, "");
}
