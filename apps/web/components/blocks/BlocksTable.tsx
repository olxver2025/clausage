import { ToolDot, ToolName } from "@/components/charts/Legend";
import { formatCompact, formatCost, formatDateTime, formatDuration, formatNumber, formatTime } from "@/lib/format";
import { TOOL_LABELS, toolColor } from "@/lib/tools";
import type { BlockSummary, TimelineItem } from "./blocks-data";

const th = "px-2 py-1.5 sm:px-3 font-medium whitespace-nowrap shadow-[inset_0_-1px_0_var(--border)]";
const td = "px-2 py-1.5 sm:px-3";

export function BlocksTable({ items, timeZone, caption }: { items: TimelineItem[]; timeZone: string; caption: string }) {
  if (items.length === 0) {
    return <p className="rounded-[var(--radius)] border border-dashed border-line px-3 py-6 text-center text-sm text-fg-3">No blocks in this range.</p>;
  }
  return (
    <div className="max-h-[32rem] overflow-auto rounded-[var(--radius)] border border-line bg-surface">
      <table className="w-full border-collapse text-[0.8125rem]">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-[1] bg-surface-2 text-xs text-fg-2">
          <tr>
            <th scope="col" className={`${th} text-start`}>
              Start
            </th>
            <th scope="col" className={`${th} text-start max-sm:hidden`}>
              Activity
            </th>
            <th scope="col" className={`${th} text-end max-sm:hidden`}>
              Duration
            </th>
            <th scope="col" className={`${th} text-start max-sm:hidden`}>
              Tool
            </th>
            <th scope="col" className={`${th} text-end max-md:hidden`}>
              Sessions
            </th>
            <th scope="col" className={`${th} text-start max-lg:hidden`}>
              Models
            </th>
            <th scope="col" className={`${th} text-end`}>
              Tokens
            </th>
            <th scope="col" className={`${th} text-end`}>
              Cost
            </th>
            <th scope="col" className={`${th} text-end`}>
              5h limit
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) =>
            item.kind === "gap" ? (
              <tr key={item.id} className="border-t border-line bg-bg/60">
                <td colSpan={9} className="px-3 py-1 text-xs text-fg-3">
                  <span aria-hidden="true">┆ </span>Idle <span className="tabular">{formatDuration(item.toMs - item.fromMs)}</span>
                  <span className="max-sm:hidden">
                    {" "}
                    · <span className="tabular">{formatDateTime(item.fromMs, timeZone)}</span> to <span className="tabular">{formatDateTime(item.toMs, timeZone)}</span>
                  </span>
                </td>
              </tr>
            ) : (
              <tr key={item.block.id} className="border-t border-line hover:bg-surface-hover">
                <th scope="row" className={`${td} text-start font-normal`}>
                  <span className="me-1.5 sm:hidden">
                    <ToolDot tool={item.block.tool} />
                    <span className="sr-only">{TOOL_LABELS[item.block.tool]}: </span>
                  </span>
                  <span className="tabular whitespace-nowrap">{formatDateTime(item.block.startMs, timeZone)}</span>{" "}
                  {item.block.isActive && <span className="ms-1 inline-block rounded-sm border border-line-strong px-1 text-[0.6875rem] font-medium text-good">Active</span>}
                </th>
                <td className={`${td} tabular whitespace-nowrap text-fg-2 max-sm:hidden`}>
                  {formatTime(item.block.firstMs, timeZone)}–{formatTime(item.block.lastMs, timeZone)}
                </td>
                <td className={`${td} tabular text-end max-sm:hidden`}>{formatDuration(item.block.lastMs - item.block.firstMs)}</td>
                <td className={`${td} max-sm:hidden`}>
                  <ToolName tool={item.block.tool} />
                </td>
                <td className={`${td} tabular text-end max-md:hidden`}>{formatNumber(item.block.sessions)}</td>
                <td className={`${td} max-w-56 truncate text-fg-2 max-lg:hidden`}>{item.block.models.join(", ") || "–"}</td>
                <td className={`${td} tabular text-end`}>{formatCompact(item.block.totalTokens)}</td>
                <td className={`${td} tabular text-end`}>{formatCost(item.block.costUSD)}</td>
                <td className={`${td} text-end`}>
                  <LimitCell block={item.block} />
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function LimitCell({ block }: { block: BlockSummary }) {
  if (block.limitPercent === null) {
    return block.limitHit ? <span className="text-xs font-medium text-critical">Limit hit</span> : <span className="text-fg-3">–</span>;
  }
  const pct = block.limitPercent;
  const tone = block.limitHit || pct >= 100 ? "var(--critical)" : pct >= 80 ? "var(--warning)" : toolColor(block.tool);
  const title = `${Math.round(pct)}% of the 5-hour limit${block.limitSource === "reported" ? " (reported)" : " (your limit)"}${block.limitHit ? ", limit reached" : ""}`;
  return (
    <span className="inline-flex items-center justify-end gap-2" title={title}>
      <span aria-hidden="true" className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-2 max-sm:hidden">
        <span className="block h-full rounded-full" style={{ width: `${Math.min(100, Math.max(2, pct))}%`, background: tone }} />
      </span>
      <span className={`tabular w-10 ${block.limitHit || pct >= 100 ? "font-medium text-critical" : ""}`}>{Math.round(pct)}%</span>
      <span className="sr-only">{title}</span>
    </span>
  );
}
