import { ToolDot } from "@/components/charts/Legend";
import { Ticker } from "@/components/charts/Ticker";
import type { ValueFormat } from "@/lib/format";
import { formatDayKey, formatRelative } from "@/lib/format";
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
            <Item label="Cost" value={stats.costUSD} format="cost" />
            <Item label="Tokens" value={stats.totalTokens} format="tokens" />
            <Item label="Sessions" value={stats.sessions} format="number" />
            <Item label="Active" value={stats.activeMs} format="duration" />
            {stats.lastAt !== undefined && <TextItem label="Last request" value={formatRelative(stats.lastAt, now)} />}
          </dl>
          <ul aria-label="Today's cost by tool" className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:ms-auto">
            {stats.byTool.map((t) => (
              <li key={t.tool} className="flex items-center gap-1.5">
                <ToolDot tool={t.tool} />
                <span className="sr-only">{TOOL_LABELS[t.tool]}</span>
                <span aria-hidden="true" className="text-fg-2">
                  {TOOL_SHORT_LABELS[t.tool]}
                </span>
                <Ticker value={t.costUSD} format="cost" className="font-medium text-fg" />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Item({ label, value, format }: { label: string; value: number; format: ValueFormat }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-fg-3">{label}</dt>
      <dd className="font-medium text-fg">
        <Ticker value={value} format={format} />
      </dd>
    </div>
  );
}

function TextItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-fg-3">{label}</dt>
      <dd className="font-medium text-fg">{value}</dd>
    </div>
  );
}
