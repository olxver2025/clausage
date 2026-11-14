import type { ToolId } from "@clausage/core";
import type { ReactNode } from "react";
import { formatPercent, formatValue as fmt, type ValueFormat } from "@/lib/format";
import { toolColor } from "@/lib/tools";
import { ToolDot } from "./Legend";

export interface ShareItem {
  key: string;
  label: ReactNode;
  /** plain-text label for the accessible name, when `label` is not a string */
  text?: string;
  value: number;
  /** colors the bar with the tool's token; otherwise the neutral series ink */
  tool?: ToolId;
  /** secondary text under the label, e.g. a path or a model's tools */
  hint?: ReactNode;
}

export interface ShareBarsProps {
  /** accessible name of the list */
  title: string;
  items: ShareItem[];
  /** a named format, or a function when rendered from a server component (default "compact") */
  format?: ValueFormat | ((n: number) => string);
  /** denominator for the share; defaults to the sum of all items */
  total?: number;
  /** show at most this many rows; the rest fold into "Other" */
  limit?: number;
  showShare?: boolean;
  emptyMessage?: string;
  className?: string;
}

export function ShareBars({ title, items, format = "compact", total, limit, showShare = true, emptyMessage = "No data.", className = "" }: ShareBarsProps) {
  const formatValue = (n: number) => fmt(n, format);
  const sorted = [...items].filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  let rows = sorted;
  if (limit && sorted.length > limit) {
    const rest = sorted.slice(limit - 1);
    rows = [...sorted.slice(0, limit - 1), { key: "__other", label: `Other (${rest.length})`, value: rest.reduce((s, r) => s + r.value, 0) }];
  }
  const sum = total ?? sorted.reduce((s, r) => s + r.value, 0);
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || max <= 0) return <p className={`text-sm text-fg-3 ${className}`}>{emptyMessage}</p>;

  return (
    <ul aria-label={title} className={`flex flex-col gap-2 ${className}`}>
      {rows.map((r) => {
        const share = sum > 0 ? r.value / sum : 0;
        const name = r.text ?? (typeof r.label === "string" ? r.label : r.key);
        return (
          <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
            <span className="sr-only">{`${name}: ${formatValue(r.value)}${showShare ? `, ${formatPercent(share)}` : ""}`}</span>
            <div aria-hidden="true" className="flex min-w-0 items-center gap-1.5 text-xs">
              {r.tool && <ToolDot tool={r.tool} />}
              <span className="truncate text-fg">{r.label}</span>
              {r.hint && <span className="truncate text-fg-3">{r.hint}</span>}
            </div>
            <div aria-hidden="true" className="flex items-baseline gap-2 text-xs">
              <span className="tabular font-medium text-fg">{formatValue(r.value)}</span>
              {showShare && <span className="tabular w-12 text-end text-fg-3">{formatPercent(share)}</span>}
            </div>
            <div aria-hidden="true" className="col-span-2 h-2.5">
              <div
                className="h-full rounded-e-[4px]"
                style={{ width: `${Math.max(0.5, (r.value / max) * 100)}%`, background: r.tool ? toolColor(r.tool) : "var(--text-3)" }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
