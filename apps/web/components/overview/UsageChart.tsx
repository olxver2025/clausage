"use client";

import { useState } from "react";
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { StackedBarChart } from "@/components/charts/StackedBarChart";
import { GroupControl } from "@/components/shell/GroupControl";
import type { StackedDatum } from "@/lib/series";

type Metric = "cost" | "tokens";

export interface UsageChartProps {
  cost: StackedDatum[];
  tokens: StackedDatum[];
  /** "day", "week" or "month", for the accessible name */
  unit: string;
  estimated: number;
}

export function UsageChart({ cost, tokens, unit, estimated }: UsageChartProps) {
  const [metric, setMetric] = useState<Metric>("cost");
  const isCost = metric === "cost";
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedControl
          aria-label="Chart metric"
          value={metric}
          onValueChange={(next) => {
            if (next) setMetric(next as Metric);
          }}
        >
          <SegmentedControlIndicator />
          <SegmentedControlItem value="cost">Cost</SegmentedControlItem>
          <SegmentedControlItem value="tokens">Tokens</SegmentedControlItem>
        </SegmentedControl>
        <GroupControl label="Chart granularity" />
      </div>
      <StackedBarChart
        title={`${isCost ? "Cost" : "Tokens"} per ${unit} by tool`}
        data={isCost ? cost : tokens}
        format={isCost ? "cost" : "tokens"}
        height={240}
      />
      {estimated > 0 && (
        <p className="mt-2 text-xs text-fg-3">
          <span aria-hidden="true">* </span>
          {estimated === 1 ? "1 period includes" : `${estimated} periods include`} estimated usage from Claude Code&apos;s stats cache, which keeps daily totals but no per-request detail.
        </p>
      )}
    </div>
  );
}
