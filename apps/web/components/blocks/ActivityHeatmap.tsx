"use client";

import { useId, useState } from "react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { formatCompact, formatNumber } from "@/lib/format";
import { ChartMark, ChartMarks } from "@/components/charts/chart-marks";
import { useWidth } from "@/components/charts/chart-utils";

export interface ActivityHeatmapProps {
  title: string;
  description?: string;
  // [weekday, Monday = 0][hour 0-23]
  tokens: number[][];
  events: number[][];
  max: number;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const STEPS = [22, 40, 58, 78, 100];
const LEFT = 34;
const TOP = 18;
const GAP = 2;

const pad = (h: number) => String(h).padStart(2, "0");
const hourRange = (h: number) => `${pad(h)}:00–${pad((h + 1) % 24)}:00`;

function binOf(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0;
  return Math.min(STEPS.length, Math.max(1, Math.ceil(Math.sqrt(v / max) * STEPS.length)));
}

function binFill(bin: number): string {
  return bin === 0 ? "var(--surface-2)" : `color-mix(in oklab, var(--heat) ${STEPS[bin - 1]}%, var(--surface))`;
}

export function ActivityHeatmap({ title, description, tokens, events, max }: ActivityHeatmapProps) {
  const [wrapRef, width] = useWidth<HTMLDivElement>(640);
  const [active, setActive] = useState<string | null>(null);
  const descId = useId();
  const cellW = Math.max(6, (width - LEFT) / 24);
  const cellH = Math.min(26, Math.max(14, cellW * 0.8));
  const height = TOP + 7 * cellH;
  const labelEvery = cellW < 18 ? 6 : 3;

  const parsed = active ? active.split(":").map(Number) : null;
  const ad = parsed?.[0];
  const ah = parsed?.[1];
  const activeVal = ad !== undefined && ah !== undefined ? tokens[ad]?.[ah] ?? 0 : 0;

  if (max <= 0) {
    return (
      <div role="img" aria-label={`${title}: no activity in this range`} className="grid h-40 place-items-center rounded-[var(--radius)] border border-dashed border-line text-sm text-fg-3">
        No activity in this range.
      </div>
    );
  }

  const tipX = ah !== undefined ? LEFT + cellW * (ah + 0.5) : 0;
  const tipY = ad !== undefined ? TOP + cellH * (ad + 1) + 4 : 0;
  const flip = tipX > width * 0.6;

  return (
    <div className="heatmap" style={{ "--heat": "light-dark(#5a48c8, #9a8ff0)" } as React.CSSProperties}>
      <div ref={wrapRef} className="relative" onPointerLeave={() => setActive(null)}>
        <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={title} aria-describedby={description ? descId : undefined} className="block select-none overflow-visible">
          {description && <desc id={descId}>{description}</desc>}
          <g aria-hidden="true">
            {HOURS.filter((h) => h % labelEvery === 0).map((h) => (
              <text key={h} x={LEFT + cellW * h} y={11} fontSize={11} fill="var(--chart-tick)" className="tabular">
                {pad(h)}
              </text>
            ))}
            {DAYS.map((d, i) => (
              <text key={d} x={0} y={TOP + cellH * (i + 0.5)} dy="0.32em" fontSize={11} fill="var(--chart-tick)">
                {d}
              </text>
            ))}
          </g>
          <ChartMarks onActiveChange={setActive}>
            {DAYS.map((d, di) =>
              HOURS.map((h) => {
                const v = tokens[di]?.[h] ?? 0;
                const n = events[di]?.[h] ?? 0;
                const key = `${di}:${h}`;
                const x = LEFT + cellW * h;
                const y = TOP + cellH * di;
                return (
                  <ChartMark
                    key={key}
                    value={key}
                    role="img"
                    aria-label={`${DAY_NAMES[di]} ${hourRange(h)}: ${formatCompact(v)} tokens, ${formatNumber(n)} events`}
                    className="chart-mark outline-none"
                    onPointerEnter={() => setActive(key)}
                  >
                    <rect className="chart-hit" x={x} y={y} width={cellW} height={cellH} fill="transparent" rx={3} />
                    <rect
                      x={x + GAP / 2}
                      y={y + GAP / 2}
                      width={Math.max(1, cellW - GAP)}
                      height={Math.max(1, cellH - GAP)}
                      rx={2}
                      fill={binFill(binOf(v, max))}
                      stroke={active === key ? "var(--text)" : "none"}
                      strokeWidth={1.5}
                    />
                  </ChartMark>
                );
              }),
            )}
          </ChartMarks>
        </svg>
        {active && ad !== undefined && ah !== undefined && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-10 min-w-36 rounded-[var(--radius)] border border-line bg-surface px-2.5 py-2 text-xs shadow-lg"
            style={{ top: tipY, ...(flip ? { right: width - tipX - cellW / 2 } : { left: tipX - cellW / 2 }) }}
          >
            <div className="mb-1 text-fg-2">
              {DAY_NAMES[ad]} · <span className="tabular">{hourRange(ah)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <span className="tabular text-sm font-semibold text-fg">{formatCompact(activeVal)}</span>
              <span className="text-fg-3">tokens</span>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <span className="tabular text-fg">{formatNumber(events[ad]?.[ah] ?? 0)}</span>
              <span className="text-fg-3">events</span>
            </div>
          </div>
        )}
      </div>
      <HeatLegend max={max} />
      <Collapsible className="mt-2">
        <CollapsibleTrigger className="chart-table-trigger">Table view</CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-2 max-h-80 overflow-auto rounded-[var(--radius)] border border-line">
            <table className="w-full border-collapse text-xs">
              <caption className="sr-only">{title}, tokens per hour</caption>
              <thead className="sticky top-0 bg-surface-2 text-fg-2">
                <tr>
                  <th scope="col" className="sticky left-0 bg-surface-2 px-2 py-1.5 text-start font-medium">
                    Day
                  </th>
                  {HOURS.map((h) => (
                    <th key={h} scope="col" className="tabular px-1.5 py-1.5 text-end font-medium">
                      <span className="sr-only">{hourRange(h)}</span>
                      <span aria-hidden="true">{pad(h)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAYS.map((d, di) => (
                  <tr key={d} className="border-t border-line">
                    <th scope="row" className="sticky left-0 bg-surface px-2 py-1 text-start font-normal text-fg-2">
                      {d}
                    </th>
                    {HOURS.map((h) => (
                      <td key={h} className="tabular px-1.5 py-1 text-end">
                        {tokens[di]?.[h] ? formatCompact(tokens[di]![h]!) : <span className="text-fg-3">0</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function HeatLegend({ max }: { max: number }) {
  const bounds = STEPS.map((_, i) => max * ((i + 1) / STEPS.length) ** 2);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2">
      <span>Tokens per hour</span>
      <ul aria-label="Color scale" className="flex items-center gap-1">
        <li className="flex items-center gap-1">
          <span aria-hidden="true" className="tool-swatch" style={{ "--swatch": binFill(0) } as React.CSSProperties} />
          <span className="tabular me-1">0</span>
        </li>
        {bounds.map((b, i) => (
          <li key={b} className="flex items-center">
            <span aria-hidden="true" className="tool-swatch" style={{ "--swatch": binFill(i + 1) } as React.CSSProperties} />
            <span className="sr-only">
              {formatCompact(i === 0 ? 0 : bounds[i - 1]!)} to {formatCompact(b)}
            </span>
          </li>
        ))}
        <li className="tabular ms-1">{formatCompact(max)}</li>
      </ul>
    </div>
  );
}
