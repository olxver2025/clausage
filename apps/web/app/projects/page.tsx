import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DataTable, type DataColumn, type DataRow } from "@/components/charts/DataTable";
import { StackedBarChart } from "@/components/charts/StackedBarChart";
import { ToolChips } from "@/components/models-projects/cells";
import { PageHeader, Panel } from "@/components/Panel";
import { PanelSkeleton } from "@/components/Skeleton";
import { GroupControl } from "@/components/shell/GroupControl";
import { getFilters, getUsage, reportFrom, type Filters } from "@/lib/data";
import { machineGroups, machineLabel } from "@/lib/machines";
import { describeRange, filtersToQuery } from "@/lib/filters";
import { formatBucketKey, formatCost, formatDateTime, formatNumber, formatRelative, formatTokens } from "@/lib/format";
import { fillDailyGaps, stackedSeries } from "@/lib/series";

export const metadata: Metadata = { title: "Projects" };

export default function ProjectsPage({ searchParams }: PageProps<"/projects">) {
  return (
    <>
      <PageHeader title="Projects" description="Usage grouped by working directory. Select a project to see its activity over time." />
      <Suspense fallback={<PanelSkeleton height={480} label="Loading projects" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const columns: DataColumn[] = [
  { key: "project", header: "Project" },
  { key: "tools", header: "Tools", sortable: false, hideBelow: "md" },
  { key: "sessions", header: "Sessions", numeric: true, hideBelow: "sm" },
  { key: "tokens", header: "Tokens", numeric: true, hideBelow: "sm" },
  { key: "cost", header: "Cost", numeric: true },
  { key: "last", header: "Last active", numeric: true, hideBelow: "lg" },
];

const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? "" : "s"}`;

function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? p;
}

const projectHref = (filters: Filters, project?: string) => `/projects${filtersToQuery({ ...filters, project }, {})}`;

async function Content({ searchParams }: { searchParams: PageProps<"/projects">["searchParams"] }) {
  const filters = await getFilters(searchParams);
  const data = await getUsage(filters);
  const report = reportFrom(data, "projects", filters);

  const groups = machineGroups(data.machines, report.rows.map((r) => r.meta?.machine as string | undefined));
  const lastActive = new Map<string, number>();
  for (const e of data.events) {
    const k = groups.length ? `${e.project || ""}@${e.machine ?? ""}` : e.project || "";
    if (e.timestamp > (lastActive.get(k) ?? 0)) lastActive.set(k, e.timestamp);
  }
  const now = data.loadedAt;

  const toRow = (row: (typeof report.rows)[number]): DataRow => {
    const path = (row.meta?.project as string | undefined) ?? row.key;
    const known = path !== "";
    const name = known ? basename(path) : "(unknown)";
    const last = lastActive.get(row.key);
    const sessions = Number(row.meta?.sessions ?? 0);
    const selected = filters.project === path;
    return {
      id: row.key || "__unknown",
      cells: {
        project: (
          <span className="flex min-w-0 flex-col gap-0.5">
            {known ? (
              <Link
                href={projectHref(filters, selected ? undefined : path)}
                aria-current={selected ? "true" : undefined}
                className="font-medium text-fg underline decoration-line-strong underline-offset-2 hover:decoration-accent aria-[current]:decoration-accent"
              >
                {name}
              </Link>
            ) : (
              <span className="font-medium text-fg-2">{name}</span>
            )}
            {known && <span className="font-mono text-[0.6875rem] break-all text-fg-3">{path}</span>}
            <span className="md:hidden">
              <ToolChips tools={row.tools} />
            </span>
          </span>
        ),
        tools: <ToolChips tools={row.tools} />,
        sessions: formatNumber(sessions),
        tokens: formatTokens(row.totalTokens),
        cost: formatCost(row.costUSD),
        last: last ? (
          <time dateTime={new Date(last).toISOString()} title={formatDateTime(last, data.timezone)} className="whitespace-nowrap">
            {formatRelative(last, now)}
          </time>
        ) : (
          "—"
        ),
      },
      sort: { project: name, sessions, tokens: row.totalTokens, cost: row.costUSD, last: last ?? null },
    };
  };
  const rows: DataRow[] = report.rows.map(toRow);

  const t = report.totals;
  const footer = {
    project: plural(report.rows.length, "project"),
    sessions: formatNumber(report.rows.reduce((s, r) => s + Number(r.meta?.sessions ?? 0), 0)),
    tokens: formatTokens(t.totalTokens),
    cost: formatCost(t.costUSD),
  };

  return (
    <div className="flex flex-col gap-3">
      {filters.project && <ProjectDetail filters={filters} />}
      {groups.length > 0 ? (
        groups.map((machine) => {
          const own = report.rows.filter((r) => (r.meta?.machine ?? "") === machine);
          const cost = own.reduce((n, r) => n + r.costUSD, 0);
          return (
            <Panel key={machine || "__unknown"} title={machineLabel(data.machines, machine)} description={`${formatCost(cost)} across ${plural(own.length, "project")}`}>
              <DataTable
                caption={`Usage per project on ${machine || "an unknown computer"}`}
                columns={columns}
                rows={own.map(toRow)}
                defaultSort={{ key: "cost", dir: "desc" }}
                maxHeight="40rem"
                emptyMessage="No usage in this range."
              />
            </Panel>
          );
        })
      ) : (
      <Panel
        title={filters.project ? "Matching projects" : "All projects"}
        description={`${describeRange(filters)} · ${formatCost(t.costUSD)} across ${plural(report.rows.length, "project")}`}
      >
        <DataTable
          caption="Usage per project"
          columns={columns}
          rows={rows}
          defaultSort={{ key: "cost", dir: "desc" }}
          maxHeight="40rem"
          footer={footer}
          emptyMessage={filters.project ? "No usage for this project in this range." : "No usage in this range."}
        />
      </Panel>
      )}
    </div>
  );
}

async function ProjectDetail({ filters }: { filters: Filters }) {
  const data = await getUsage(filters);
  const report = reportFrom(data, filters.group, filters);
  const label = (key: string) => formatBucketKey(key, filters.group);
  let series = stackedSeries(report, "costUSD", (r) => label(r.key));
  if (filters.group === "daily") series = fillDailyGaps(series, filters.since, filters.until, label);
  const project = filters.project!;
  const unit = filters.group === "daily" ? "day" : filters.group === "weekly" ? "week" : "month";

  return (
    <Panel
      title={basename(project)}
      description={
        <>
          <span className="font-mono break-all">{project}</span> · {formatCost(report.totals.costUSD)} · {formatTokens(report.totals.totalTokens)} tokens
        </>
      }
      actions={
        <>
          <Suspense>
            <GroupControl />
          </Suspense>
          <Link href={projectHref(filters, undefined)} className="text-xs text-fg-2 underline underline-offset-2 hover:text-fg">
            All projects
          </Link>
        </>
      }
    >
      <StackedBarChart title={`Cost per ${unit} by tool for ${basename(project)}`} data={series} format="cost" />
    </Panel>
  );
}
