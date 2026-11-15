"use client";

import { FastModeIcon } from "@/components/icons/FastModeIcon";
import type { ReactNode } from "react";
import { Fragment, useMemo, useState } from "react";

export interface DataColumn {
  key: string;
  header: string;
  /** right-aligned, tabular figures, sorts descending first */
  numeric?: boolean;
  /** default true */
  sortable?: boolean;
  /** hide below this breakpoint to keep 375px layouts readable */
  hideBelow?: "sm" | "md" | "lg" | "xl" | "2xl";
  className?: string;
}

export interface DataRow {
  id: string;
  modeDetails?: { label: string; content: ReactNode };
  /** rendered cell per column key (strings, numbers or server-rendered elements) */
  cells: Record<string, ReactNode>;
  /** sort keys per column; falls back to the cell when it is a string or number */
  sort?: Record<string, string | number | null | undefined>;
}

export interface DataTableProps {
  /** table caption; visually hidden unless `showCaption` */
  caption: string;
  showCaption?: boolean;
  columns: DataColumn[];
  rows: DataRow[];
  defaultSort?: { key: string; dir: "asc" | "desc" };
  /** scroll inside this height with a sticky header, e.g. "32rem" */
  maxHeight?: string;
  emptyMessage?: string;
  /** a footer row, e.g. totals, keyed like `cells` */
  footer?: Record<string, ReactNode>;
  className?: string;
}

const HIDE: Record<NonNullable<DataColumn["hideBelow"]>, string> = {
  sm: "max-sm:hidden",
  md: "max-md:hidden",
  lg: "max-lg:hidden",
  xl: "max-xl:hidden",
  "2xl": "max-2xl:hidden",
};

function sortValue(row: DataRow, key: string): string | number | null {
  const s = row.sort?.[key];
  if (s !== undefined) return s;
  const c = row.cells[key];
  return typeof c === "string" || typeof c === "number" ? c : null;
}

export function DataTable({ caption, showCaption = false, columns, rows, defaultSort, maxHeight, emptyMessage = "No rows.", footer, className = "" }: DataTableProps) {
  const [sort, setSort] = useState(defaultSort ?? null);

  const [expanded, setExpanded] = useState<string | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      if (va === vb) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * factor;
      return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" }) * factor;
    });
  }, [rows, sort]);

  const toggle = (col: DataColumn) => {
    setSort((s) =>
      s?.key === col.key ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: col.key, dir: col.numeric ? "desc" : "asc" },
    );
  };

  const cellClass = (col: DataColumn) =>
    `px-3 py-1.5 ${col.numeric ? "tabular text-end" : "text-start"} ${col.hideBelow ? HIDE[col.hideBelow] : ""} ${col.className ?? ""}`;

  return (
    <div className={`overflow-auto rounded-[var(--radius)] border border-line bg-surface ${className}`} style={maxHeight ? { maxHeight } : undefined}>
      <table className="w-full border-collapse text-[0.8125rem]">
        <caption className={showCaption ? "px-3 py-2 text-start text-xs text-fg-2" : "sr-only"}>{caption}</caption>
        <thead className="sticky top-0 z-[1] bg-surface-2 text-xs text-fg-2">
          <tr>
            {columns.map((col) => {
              const sortable = col.sortable !== false;
              const dir = sort?.key === col.key ? sort.dir : null;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}
                  className={`${cellClass(col)} whitespace-nowrap font-medium shadow-[inset_0_-1px_0_var(--border)]`}
                >
                  {sortable ? (
                    <button type="button" onClick={() => toggle(col)} className={`data-table-sort inline-flex items-center gap-1 ${col.numeric ? "flex-row-reverse" : ""}`} data-sorted={dir ?? undefined}>
                      {col.header}
                      <span aria-hidden="true" className="w-2.5 text-[0.625rem]">
                        {dir === "asc" ? "▲" : dir === "desc" ? "▼" : ""}
                      </span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-fg-3">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sorted.map((row) => (
              <Fragment key={row.id}>
                <tr className="border-t border-line first:border-t-0 hover:bg-surface-hover">
                  {columns.map((col, index) => (
                    <td key={col.key} className={cellClass(col)}>
                      {index === 0 && row.modeDetails ? (
                        <button type="button" className="inline-flex items-center gap-1 text-start"
                          aria-label={row.modeDetails.label} aria-expanded={expanded === row.id}
                          onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                          {row.cells[col.key]}
                          <FastModeIcon />
                          <span aria-hidden="true" className="text-sm text-fg-3">{expanded === row.id ? "▴" : "▾"}</span>
                        </button>
                      ) : row.cells[col.key]}
                    </td>
                  ))}
                </tr>
                {row.modeDetails && expanded === row.id && <tr className="bg-surface-2">
                  <td colSpan={columns.length}>{row.modeDetails.content}</td>
                </tr>}
              </Fragment>
            ))
          )}
        </tbody>
        {footer && sorted.length > 0 && (
          <tfoot className="sticky bottom-0 bg-surface-2 font-medium">
            <tr className="shadow-[inset_0_1px_0_var(--border)]">
              {columns.map((col) => (
                <td key={col.key} className={cellClass(col)}>
                  {footer[col.key]}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
