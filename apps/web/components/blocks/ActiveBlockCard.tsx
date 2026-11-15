import type { ReactNode } from "react";
import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack, ProgressValue } from "@ui-sdk/react/progress";
import { ToolName } from "@/components/charts/Legend";
import { formatCompact, formatCost, formatDuration, formatTime } from "@/lib/format";
import { TOOL_LABELS, toolColor } from "@/lib/tools";
import type { BlockSummary } from "./blocks-data";

export function ActiveBlockCard({ block, now, timeZone }: { block: BlockSummary; now: number; timeZone: string }) {
  const length = block.endMs - block.startMs;
  const elapsed = Math.min(length, Math.max(0, now - block.startMs));
  return (
    <article className="panel min-w-0 p-3 sm:p-4" aria-label={`${TOOL_LABELS[block.tool]} active block`}>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          <ToolName tool={block.tool} />
        </h3>
        <span className="tabular text-xs text-fg-3">
          {formatTime(block.startMs, timeZone)}–{formatTime(block.endMs, timeZone)}
        </span>
      </header>
      <Progress value={elapsed} max={length} className="[&_[data-slot=progress-indicator]]:bg-(--fill)" style={{ "--fill": toolColor(block.tool) } as React.CSSProperties}>
        <ProgressLabel>Block time elapsed</ProgressLabel>
        <ProgressValue>
          <span className="tabular">
            {formatDuration(elapsed)} / {formatDuration(length)}
          </span>
        </ProgressValue>
        <ProgressTrack>
          <ProgressIndicator />
        </ProgressTrack>
      </Progress>
      <p className="mt-1 text-xs text-fg-3">
        <span className="tabular">{formatDuration(length - elapsed)}</span> left · last activity at <span className="tabular">{formatTime(block.lastMs, timeZone)}</span>
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Stat label="Tokens so far" value={formatCompact(block.totalTokens)} />
        <Stat label="Cost so far" value={formatCost(block.costUSD)} />
        <Stat label="Sessions" value={String(block.sessions)} />
        <Stat label="Burn rate" value={block.tokensPerMinute !== null ? `${formatCompact(block.tokensPerMinute)}/min` : "–"} />
        <Stat label="Cost rate" value={block.costPerHour !== null ? `${formatCost(block.costPerHour)}/h` : "–"} />
        {block.limitPercent !== null && (
          <Stat
            label={block.limitSource === "reported" ? "5h limit used" : "Of your 5h limit"}
            value={`${Math.round(block.limitPercent)}%`}
            sub={block.limitHit ? <span className="font-medium text-critical">limit hit</span> : undefined}
          />
        )}
        <Stat
          label="Projected at end"
          value={block.projectedTokens !== null ? formatCompact(block.projectedTokens) : "–"}
          sub={block.projectedCost !== null ? formatCost(block.projectedCost) : undefined}
        />
      </dl>
    </article>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="m-0 flex flex-wrap items-baseline gap-x-1.5">
        <span className="figure text-base font-semibold text-fg">{value}</span>
        {sub && <span className="tabular text-xs text-fg-2">{sub}</span>}
      </dd>
    </div>
  );
}
