import { ToolDot } from "@/components/charts/Legend";
import { formatCost, formatDayKey, formatDuration, formatNumber, formatRelative, formatTokens } from "@/lib/format";
import { TOOL_SHORT_LABELS, TOOL_LABELS } from "@/lib/tools";
import type { DayStats } from "./stats";

export function TodayStrip({ day, stats, now }: { day: string; stats: DayStats; now: number }) {
  return (
    <section aria-labelledby="today-heading" className="panel flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-2.5 text-xs sm:px-4">
      <h2 id="today-heading" className="flex items-baseline gap-1.5 text-sm font-semibold">
        Today
        <span className="text-xs font-normal text-fg-3">{formatDayKey(day, { weekday: true })}</span>
      </h2>
      {stats.requests === 0 ? (
        <p className="text-fg-3">No usage yet today.</p>
      ) : (
        <>
          <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <Item label="Cost" value={formatCost(stats.costUSD)} />
            <Item label="Tokens" value={formatTokens(stats.totalTokens)} />
            <Item label="Sessions" value={formatNumber(stats.sessions)} />
            <Item label="Active" value={formatDuration(stats.activeMs)} />
            {stats.lastAt !== undefined && <Item label="Last request" value={formatRelative(stats.lastAt, now)} plain />}
          </dl>
          <ul aria-label="Today's cost by tool" className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:ms-auto">
            {stats.byTool.map((t) => (
              <li key={t.tool} className="flex items-center gap-1.5">
                <ToolDot tool={t.tool} />
                <span className="sr-only">{TOOL_LABELS[t.tool]}</span>
                <span aria-hidden="true" className="text-fg-2">
                  {TOOL_SHORT_LABELS[t.tool]}
                </span>
                <span className="tabular font-medium text-fg">{formatCost(t.costUSD)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Item({ label, value, plain }: { label: string; value: string; plain?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-fg-3">{label}</dt>
      <dd className={`${plain ? "" : "tabular"} font-medium text-fg`}>{value}</dd>
    </div>
  );
}
