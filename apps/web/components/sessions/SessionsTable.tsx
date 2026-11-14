"use client";
import { dtf } from "@/lib/format";

import type { ToolId } from "@clausage/core";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { Input, InputClear, InputGroup } from "@ui-sdk/react/input";
import {
  Pagination,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationList,
  PaginationNext,
  PaginationPrevious,
} from "@ui-sdk/react/pagination";
import { ToolDot } from "@/components/charts/Legend";
import { formatCost, formatDateTime, formatDuration, formatNumber, formatTokens } from "@/lib/format";
import { TOOL_LABELS, TOOL_SHORT_LABELS } from "@/lib/tools";
import { baseName, shortId } from "./links";
import "./sessions.css";

export interface SessionListRow {
  id: string;
  tool: ToolId;
  sessionId: string;
  title: string | null;
  project: string;
  startedAt: number;
  endedAt: number;
  activeMs: number;
  turns: number;
  userMessages: number;
  toolCalls: number;
  subagents: number;
  models: string[];
  totalTokens: number;
  costUSD: number;
  costUnknown: boolean;
  href: string;
}

type SortKey = "tool" | "title" | "project" | "startedAt" | "endedAt" | "activeMs" | "turns" | "toolCalls" | "subagents" | "models" | "totalTokens" | "costUSD";

interface Column {
  key: SortKey;
  header: string;
  numeric?: boolean;
  hide?: string;
  value: (r: SessionListRow) => string | number;
  cell: (r: SessionListRow, tz: string) => ReactNode;
}

const PAGE_SIZE = 25;

const COLUMNS: Column[] = [
  {
    key: "tool",
    header: "Tool",
    hide: "@max-5xl:hidden",
    value: (r) => TOOL_LABELS[r.tool],
    cell: (r) => (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <ToolDot tool={r.tool} />
        {TOOL_SHORT_LABELS[r.tool]}
      </span>
    ),
  },
  {
    key: "title",
    header: "Session",
    value: (r) => r.title ?? r.sessionId,
    cell: (r) => (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="@5xl:hidden">
          <ToolDot tool={r.tool} />
          <span className="sr-only">{TOOL_LABELS[r.tool]}: </span>
        </span>
        <Link href={r.href} className="session-link block max-w-[12rem] truncate sm:max-w-[18rem] 2xl:max-w-[24rem]" title={r.title ?? r.sessionId}>
          {r.title ?? <span className="tabular">{shortId(r.sessionId)}</span>}
        </Link>
      </span>
    ),
  },
  {
    key: "project",
    header: "Project",
    hide: "@max-3xl:hidden",
    value: (r) => baseName(r.project).toLowerCase(),
    cell: (r) => (
      <span className="block max-w-[10rem] truncate text-fg-2" title={r.project || undefined}>
        {baseName(r.project)}
      </span>
    ),
  },
  {
    key: "startedAt",
    header: "Started",
    hide: "@max-[84rem]:hidden",
    numeric: true,
    value: (r) => r.startedAt,
    cell: (r, tz) => <ShortDate ts={r.startedAt} tz={tz} className="text-fg-2" />,
  },
  {
    key: "endedAt",
    header: "Last active",
    hide: "@max-4xl:hidden",
    numeric: true,
    value: (r) => r.endedAt,
    cell: (r, tz) => <ShortDate ts={r.endedAt} tz={tz} />,
  },
  { key: "activeMs", header: "Active", numeric: true, hide: "@max-xl:hidden", value: (r) => r.activeMs, cell: (r) => formatDuration(r.activeMs) },
  {
    key: "turns",
    header: "Turns / msgs",
    numeric: true,
    hide: "@max-5xl:hidden",
    value: (r) => r.turns,
    cell: (r) => (
      <span className="whitespace-nowrap" title={`${formatNumber(r.turns)} turns, ${formatNumber(r.userMessages)} user messages`}>
        {formatNumber(r.turns)}
        <span className="text-fg-3"> / {formatNumber(r.userMessages)}</span>
      </span>
    ),
  },
  { key: "toolCalls", header: "Tool calls", numeric: true, hide: "@max-6xl:hidden", value: (r) => r.toolCalls, cell: (r) => formatNumber(r.toolCalls) },
  { key: "subagents", header: "Subagents", numeric: true, hide: "@max-7xl:hidden", value: (r) => r.subagents, cell: (r) => (r.subagents ? formatNumber(r.subagents) : <span className="text-fg-3">0</span>) },
  {
    key: "models",
    header: "Models",
    hide: "@max-[96rem]:hidden",
    value: (r) => r.models[0] ?? "",
    cell: (r) =>
      r.models.length ? (
        <span className="block max-w-[12rem] truncate text-fg-2" title={r.models.join(", ")}>
          {r.models[0]}
          {r.models.length > 1 && <span className="text-fg-3"> +{r.models.length - 1}</span>}
        </span>
      ) : (
        <span className="text-fg-3">–</span>
      ),
  },
  { key: "totalTokens", header: "Tokens", numeric: true, hide: "@max-lg:hidden", value: (r) => r.totalTokens, cell: (r) => formatTokens(r.totalTokens) },
  {
    key: "costUSD",
    header: "Cost",
    numeric: true,
    value: (r) => r.costUSD,
    cell: (r) => (
      <span className="whitespace-nowrap font-medium" title={r.costUnknown ? "Some requests had no price" : undefined}>
        {formatCost(r.costUSD)}
        {r.costUnknown && <span className="text-warning">*</span>}
      </span>
    ),
  },
];

const shortFormats = new Map<string, Intl.DateTimeFormat>();

function ShortDate({ ts, tz, className = "" }: { ts: number; tz: string; className?: string }) {
  let fmt = shortFormats.get(tz);
  if (!fmt) {
    fmt = dtf("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz });
    shortFormats.set(tz, fmt);
  }
  return (
    <time dateTime={new Date(ts).toISOString()} title={formatDateTime(ts, tz)} className={`whitespace-nowrap ${className}`}>
      {fmt.format(new Date(ts))}
    </time>
  );
}

function matches(r: SessionListRow, needle: string): boolean {
  return (
    (r.title ?? "").toLowerCase().includes(needle) ||
    r.project.toLowerCase().includes(needle) ||
    r.sessionId.toLowerCase().includes(needle)
  );
}

function replaceUrl(patch: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  window.history.replaceState(window.history.state, "", url);
}

export function SessionsTable({ rows, timeZone }: { rows: SessionListRow[]; timeZone: string }) {
  const params = useSearchParams();
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [page, setPage] = useState(() => Math.max(1, Number(params.get("page")) || 1));
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "endedAt", dir: "desc" });
  const deferredQuery = useDeferredValue(query);

  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return needle ? rows.filter((r) => matches(r, needle)) : rows;
  }, [rows, deferredQuery]);

  const sorted = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sort.key) ?? COLUMNS[0]!;
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * factor || b.endedAt - a.endedAt;
      return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" }) * factor || b.endedAt - a.endedAt;
    });
  }, [filtered, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const start = (current - 1) * PAGE_SIZE;
  const visible = sorted.slice(start, start + PAGE_SIZE);

  const changePage = (next: number) => {
    setPage(next);
    replaceUrl({ page: next > 1 ? String(next) : null });
  };

  const toggleSort = (col: Column) => {
    setSort((s) => (s.key === col.key ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: col.key, dir: col.numeric ? "desc" : "asc" }));
    changePage(1);
  };

  return (
    <div className="@container flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <InputGroup className="session-search">
          <Input
            type="search"
            aria-label="Search sessions by title, project or id"
            placeholder="Search title, project or id"
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              setPage(1);
              replaceUrl({ q: value || null, page: null });
            }}
          />
          <InputClear aria-label="Clear search">
            <span aria-hidden="true">×</span>
          </InputClear>
        </InputGroup>
        <p className="tabular text-xs text-fg-3" aria-live="polite">
          {sorted.length === 0
            ? "No sessions"
            : `${formatNumber(start + 1)}–${formatNumber(start + visible.length)} of ${formatNumber(sorted.length)}${sorted.length !== rows.length ? ` (filtered from ${formatNumber(rows.length)})` : ""}`}
        </p>
      </div>

      <div className="overflow-x-auto rounded-[var(--radius)] border border-line bg-surface">
        <table className="w-full border-collapse text-[0.8125rem]">
          <caption className="sr-only">Sessions, sorted by {COLUMNS.find((c) => c.key === sort.key)?.header} {sort.dir === "asc" ? "ascending" : "descending"}</caption>
          <thead className="bg-surface-2 text-xs text-fg-2">
            <tr>
              {COLUMNS.map((col) => {
                const dir = sort.key === col.key ? sort.dir : null;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}
                    className={`whitespace-nowrap px-2 py-1.5 font-medium sm:px-3 shadow-[inset_0_-1px_0_var(--border)] ${col.numeric ? "text-end" : "text-start"} ${col.hide ?? ""}`}
                  >
                    <button type="button" onClick={() => toggleSort(col)} className={`data-table-sort inline-flex items-center gap-1 ${col.numeric ? "flex-row-reverse" : ""}`} data-sorted={dir ?? undefined}>
                      {col.header}
                      <span aria-hidden="true" className="w-2.5 text-[0.625rem]">
                        {dir === "asc" ? "▲" : dir === "desc" ? "▼" : ""}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-fg-3">
                  {rows.length === 0 ? "No sessions in this range." : "No sessions match the search."}
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.id} className="border-t border-line first:border-t-0 hover:bg-surface-hover">
                  {COLUMNS.map((col) => (
                    <td key={col.key} className={`px-2 py-1.5 sm:px-3 ${col.numeric ? "tabular text-end" : "text-start"} ${col.hide ?? ""}`}>
                      {col.cell(r, timeZone)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <Pagination aria-label="Sessions pages" pageCount={pageCount} page={current} onPageChange={changePage} className="session-pagination">
          <PaginationList>
            {({ items }) => (
              <>
                <PaginationItem>
                  <PaginationPrevious>
                    <span data-slot="visually-hidden" className="sr-only">
                      Previous page
                    </span>
                  </PaginationPrevious>
                </PaginationItem>
                {items.map((item) => (
                  <PaginationItem key={item}>{typeof item === "number" ? <PaginationLink page={item} className="tabular" /> : <PaginationEllipsis />}</PaginationItem>
                ))}
                <PaginationItem>
                  <PaginationNext>
                    <span data-slot="visually-hidden" className="sr-only">
                      Next page
                    </span>
                  </PaginationNext>
                </PaginationItem>
              </>
            )}
          </PaginationList>
        </Pagination>
      )}
    </div>
  );
}
