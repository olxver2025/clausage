import type { Metadata } from "next";
import { Suspense } from "react";
import type { SessionMeta } from "@clausage/core";
import { KpiTile } from "@/components/charts/KpiTile";
import { PageHeader, Panel } from "@/components/Panel";
import { PanelSkeleton } from "@/components/Skeleton";
import { SessionsTable, type SessionListRow } from "@/components/sessions/SessionsTable";
import { displayTitle, sessionHref } from "@/components/sessions/links";
import { getFilters, getUsage, reportFrom } from "@/lib/data";
import { describeRange, filtersToQuery } from "@/lib/filters";
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
    };
  });

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
      <Panel title="All sessions" description={`${describeRange(filters)} · ${data.timezone}`}>
        <SessionsTable rows={rows} timeZone={data.timezone} />
      </Panel>
    </div>
  );
}
