import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { sumTotals, type ModelBreakdown, type ToolId } from "@clausage/core";
import { modeDetails } from "@/components/models-projects/mode-breakdown";
import { ModelOrgIcon } from "@/components/icons/BrandIcon";
import { DataTable, type DataColumn, type DataRow } from "@/components/charts/DataTable";
import { KpiTile } from "@/components/charts/KpiTile";
import { ToolName } from "@/components/charts/Legend";
import { PageHeader, Panel } from "@/components/Panel";
import { PanelSkeleton } from "@/components/Skeleton";
import { baseName, displayTitle, safeDecode, shortId } from "@/components/sessions/links";
import { getSessionDetail, type SessionDetail } from "@/components/sessions/session-detail";
import { SessionTimeline } from "@/components/sessions/SessionTimeline";
import { McpServerLine, ToolCallBars } from "@/components/sessions/ToolCalls";
import { getFilters } from "@/lib/data";
import { filtersToQuery } from "@/lib/filters";
import { formatCost, formatDateTime, formatDuration, formatNumber, formatPercent, formatTokens } from "@/lib/format";
import { isToolId, TOOL_LABELS } from "@/lib/tools";
import "@/components/sessions/sessions.css";

export const metadata: Metadata = { title: "Session" };

type Props = PageProps<"/sessions/[tool]/[id]">;

export default function SessionPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <Content params={params} searchParams={searchParams} />
    </Suspense>
  );
}

function DetailSkeleton() {
  return (
    <>
      <PageHeader title="Session" />
      <PanelSkeleton height={420} label="Loading session" />
    </>
  );
}

async function Content({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const { tool: rawTool, id: rawId } = await params;
  if (!isToolId(rawTool)) notFound();
  const tool: ToolId = rawTool;
  const filters = await getFilters(searchParams);
  const id = safeDecode(rawId);
  const detail = await getSessionDetail(filters, tool, id);
  if (!detail) notFound();

  const { meta, totals, main, subagents, timezone } = detail;
  const query = filtersToQuery(filters);
  const title = displayTitle(meta.title) ?? `Session ${shortId(meta.sessionId)}`;
  const wall = Math.max(0, meta.endedAt - meta.startedAt);
  const cacheBase = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const subCost = Math.max(0, totals.costUSD - main.costUSD);

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-xs text-fg-3">
        <Link href={`/sessions${query}`} className="session-link !font-normal !text-fg-2">
          Sessions
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="tabular">{shortId(meta.sessionId)}</span>
      </nav>
      <PageHeader title={title} description={<span className="inline-flex flex-wrap items-center gap-x-2"><ToolName tool={tool} /><span aria-hidden="true">·</span><span title={meta.project || undefined}>{baseName(meta.project)}</span></span>} />

      <div className="flex flex-col gap-3">
        <dl className="panel grid gap-x-6 gap-y-2 p-3 text-xs sm:grid-cols-2 sm:p-4 lg:grid-cols-3">
          <MetaItem label="Tool">{TOOL_LABELS[tool]}</MetaItem>
          <MetaItem label="Project">
            <span className="break-all">{meta.project || "(unknown)"}</span>
          </MetaItem>
          <MetaItem label="Session id">
            <span className="tabular break-all">{meta.sessionId}</span>
          </MetaItem>
          <MetaItem label="Started">
            <span className="tabular">{formatDateTime(meta.startedAt, timezone)}</span>
          </MetaItem>
          <MetaItem label="Last active">
            <span className="tabular">{formatDateTime(meta.endedAt, timezone)}</span>
          </MetaItem>
          <MetaItem label="Wall-clock span">
            <span className="tabular">{formatDuration(wall)}</span>
          </MetaItem>
          <MetaItem label="Models">{detail.models.join(", ") || "–"}</MetaItem>
          {meta.version && (
            <MetaItem label="Version">
              <span className="tabular">{meta.version}</span>
            </MetaItem>
          )}
          <MetaItem label="Timezone">{timezone}</MetaItem>
        </dl>

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiTile
            tool={tool}
            label="Cost"
            value={
              <>
                {formatCost(totals.costUSD)}
                {detail.costUnknown && <span className="text-warning" title="Some requests had no price">*</span>}
              </>
            }
            sub={subagents.length ? `${formatCost(subCost)} in subagents` : `${formatCost(totals.events ? totals.costUSD / totals.events : 0)} per request`}
          />
          <KpiTile
            label="Tokens"
            value={formatTokens(totals.totalTokens)}
            sub={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out · ${formatPercent(cacheBase ? totals.cacheReadTokens / cacheBase : null)} cached`}
          />
          <KpiTile label="Active time" value={formatDuration(meta.activeMs)} sub={`of ${formatDuration(wall)} wall-clock`} />
          <KpiTile
            label="Requests"
            value={formatNumber(totals.events)}
            sub={`${formatNumber(meta.turns)} turns · ${formatNumber(meta.userMessages)} msgs · ${formatNumber(meta.toolCalls)} tool calls`}
          />
        </div>

        {detail.costUnknown && (
          <p className="text-xs text-fg-2">
            <span className="text-warning" aria-hidden="true">* </span>
            Some requests used a model with no known price, so the cost is a lower bound.
          </p>
        )}

        <Panel title="Timeline" description="Every request in the session and its subagents, in the selected cost mode. Date filters do not apply here.">
          <SessionTimeline title={`Tokens and cumulative cost over time for ${title}`} tool={tool} timeZone={timezone} {...detail.timeline} />
        </Panel>

        <Panel title="By model">
          <ModelsTable detail={detail} />
        </Panel>

        <Panel
          title="Tool calls"
          description={
            meta.toolCalls > 0
              ? `${formatNumber(meta.toolCalls)} calls${subagents.length ? " incl. subagents" : ""} · ${formatCost(totals.costUSD / meta.toolCalls)} per call · tool names only`
              : undefined
          }
        >
          <ToolCallBars title="Tool calls by tool name" sessions={[meta]} limit={15} />
          <McpServerLine sessions={[meta]} />
        </Panel>

        <Panel title="Subagents" description={subagents.length ? `${formatNumber(subagents.length)} subagent sessions · main thread ${formatCost(main.costUSD)}` : undefined}>
          <SubagentsTable detail={detail} />
        </Panel>
      </div>
    </>
  );
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="filter-label">{label}</dt>
      <dd className="mt-0.5 text-[0.8125rem] text-fg">{children}</dd>
    </div>
  );
}

const MODEL_COLUMNS: DataColumn[] = [
  { key: "model", header: "Model" },
  { key: "events", header: "Requests", numeric: true, hideBelow: "sm" },
  { key: "input", header: "Input", numeric: true, hideBelow: "md" },
  { key: "output", header: "Output", numeric: true, hideBelow: "md" },
  { key: "cacheRead", header: "Cache read", numeric: true, hideBelow: "lg" },
  { key: "cacheWrite", header: "Cache write", numeric: true, hideBelow: "lg" },
  { key: "tokens", header: "Tokens", numeric: true },
  { key: "cost", header: "Cost", numeric: true },
  { key: "share", header: "Share", numeric: true, hideBelow: "sm" },
];

function ModelsTable({ detail }: { detail: SessionDetail }) {
  const total = detail.totals.costUSD;
  const byModel = new Map<string, ModelBreakdown[]>();
  for (const part of detail.breakdown) {
    const parts = byModel.get(part.model) ?? [];
    parts.push(part);
    byModel.set(part.model, parts);
  }
  const rows: DataRow[] = [...byModel].map(([model, parts]) => {
    const b = sumTotals(parts);
    return {
      id: model,
      modeDetails: modeDetails(model, parts),
      cells: {
        model: <span className="inline-flex items-center gap-1.5"><ModelOrgIcon model={model} size="0.875rem" />{model || "(unknown)"}</span>,
        events: formatNumber(b.events),
        input: formatTokens(b.inputTokens),
        output: formatTokens(b.outputTokens),
        cacheRead: formatTokens(b.cacheReadTokens),
        cacheWrite: formatTokens(b.cacheWriteTokens),
        tokens: formatTokens(b.totalTokens),
        cost: formatCost(b.costUSD),
        share: formatPercent(total ? b.costUSD / total : null),
      },
      sort: {
        model,
        events: b.events,
        input: b.inputTokens,
        output: b.outputTokens,
        cacheRead: b.cacheReadTokens,
        cacheWrite: b.cacheWriteTokens,
        tokens: b.totalTokens,
        cost: b.costUSD,
        share: b.costUSD,
      },
    };
  });
  return <DataTable caption="Usage by model in this session" columns={MODEL_COLUMNS} rows={rows} defaultSort={{ key: "cost", dir: "desc" }} emptyMessage="No model usage recorded." />;
}

const SUB_COLUMNS: DataColumn[] = [
  { key: "agent", header: "Subagent" },
  { key: "started", header: "Started", numeric: true, hideBelow: "md" },
  { key: "active", header: "Active", numeric: true, hideBelow: "sm" },
  { key: "events", header: "Requests", numeric: true, hideBelow: "lg" },
  { key: "toolCalls", header: "Tool calls", numeric: true, hideBelow: "lg" },
  { key: "models", header: "Models", hideBelow: "lg" },
  { key: "tokens", header: "Tokens", numeric: true },
  { key: "cost", header: "Cost", numeric: true },
];

function SubagentsTable({ detail }: { detail: SessionDetail }) {
  const rows: DataRow[] = detail.subagents.map((s) => ({
    id: s.sessionId,
    cells: {
      agent: (
        <span className="block max-w-[18rem] truncate" title={s.title ? `${s.title} (${s.sessionId})` : s.sessionId}>
          {s.title ?? <span className="tabular">{shortId(s.sessionId)}</span>}
        </span>
      ),
      started: <span className="whitespace-nowrap">{formatDateTime(s.startedAt, detail.timezone)}</span>,
      active: formatDuration(s.activeMs),
      events: formatNumber(s.events),
      toolCalls: formatNumber(s.toolCalls),
      models: <span className="text-fg-2">{s.models.join(", ") || "–"}{s.speeds.length > 0 && ` · ${s.speeds.join(", ")}`}</span>,
      tokens: formatTokens(s.totalTokens),
      cost: formatCost(s.costUSD),
    },
    sort: {
      agent: s.title ?? s.sessionId,
      started: s.startedAt,
      active: s.activeMs,
      events: s.events,
      toolCalls: s.toolCalls,
      models: s.models.join(","),
      tokens: s.totalTokens,
      cost: s.costUSD,
    },
  }));
  return (
    <DataTable
      caption="Subagent sessions"
      columns={SUB_COLUMNS}
      rows={rows}
      defaultSort={{ key: "started", dir: "asc" }}
      maxHeight="28rem"
      emptyMessage="This session did not start any subagents."
    />
  );
}
