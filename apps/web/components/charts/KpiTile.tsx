import type { ToolId } from "@clausage/core";
import type { ReactNode } from "react";
import { formatDelta } from "@/lib/format";
import { ToolDot } from "./Legend";
import { Sparkline } from "./Sparkline";

export interface KpiDelta {
  /** change as a ratio: 0.12 = +12% */
  ratio: number | null | undefined;
  /** which direction is good; "neutral" keeps the delta in secondary ink */
  goodWhen?: "up" | "down" | "neutral";
  /** the comparison period, e.g. "vs previous 30 days" */
  label?: string;
}

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  /** secondary line under the value, e.g. "4.1M input · 0.3M output" */
  sub?: ReactNode;
  delta?: KpiDelta;
  /** trend values, oldest first */
  spark?: number[];
  sparkLabel?: string;
  tool?: ToolId;
  className?: string;
}

export function KpiTile({ label, value, sub, delta, spark, sparkLabel, tool, className = "" }: KpiTileProps) {
  return (
    <div className={`panel flex min-w-0 flex-col gap-1 p-3 ${className}`}>
      <div className="flex items-center gap-1.5 text-xs text-fg-2">
        {tool && <ToolDot tool={tool} />}
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="figure min-w-0 truncate text-xl font-semibold leading-tight text-fg">{value}</div>
        {spark && spark.length > 1 && <Sparkline values={spark} label={sparkLabel ?? `${label} trend`} width={72} height={24} />}
      </div>
      {(delta || sub) && (
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-fg-3">
          {delta && <DeltaText {...delta} />}
          {sub && <span className="min-w-0 truncate">{sub}</span>}
        </div>
      )}
    </div>
  );
}

function DeltaText({ ratio, goodWhen = "neutral", label }: KpiDelta) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    return label ? <span>no prior data {label}</span> : null;
  }
  const up = ratio > 0;
  const tone = goodWhen === "neutral" || ratio === 0 ? "text-fg-2" : up === (goodWhen === "up") ? "text-good" : "text-critical";
  return (
    <span className={`tabular font-medium ${tone}`}>
      <span aria-hidden="true">{up ? "▲" : ratio < 0 ? "▼" : "•"} </span>
      {formatDelta(ratio)}
      {label && <span className="font-normal text-fg-3"> {label}</span>}
    </span>
  );
}
