"use client";

import type { ToolId } from "@clausage/core";
import { useId, useMemo, useState } from "react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { FORMATTERS, type ValueFormat } from "@/lib/format";
import { sumValues, toolsPresent, type StackedDatum } from "@/lib/series";
import { TOOL_LABELS, toolColor } from "@/lib/tools";
import { ChartMark, ChartMarks } from "./chart-marks";
import { niceTicks, roundedTopPath, useWidth } from "./chart-utils";
import { Legend } from "./Legend";

export interface StackedBarChartProps {
  /** accessible name of the chart; the visible heading is the caller's */
  title: string;
  description?: string;
  data: StackedDatum[];
  /** series order, bottom to top; defaults to the tools with data, in canonical order */
  tools?: ToolId[];
  /** tooltip, label and table format (default "compact") */
  format?: ValueFormat;
  /** y-axis tick format; defaults to the compact form of `format` */
  axisFormat?: ValueFormat;
  height?: number;
  showLegend?: boolean;
  /** collapsible table view under the chart (default true) */
  showTable?: boolean;
  emptyMessage?: string;
  className?: string;
}

const GAP = 2;
const MARGIN = { top: 8, right: 4, bottom: 22 };

export function StackedBarChart({
  title,
  description,
  data,
  tools,
  format = "compact",
  axisFormat,
  height = 220,
  showLegend = true,
  showTable = true,
  emptyMessage = "No usage in this range.",
  className = "",
}: StackedBarChartProps) {
  const [wrapRef, width] = useWidth<HTMLDivElement>(640);
  const formatValue = FORMATTERS[format];
  const formatAxis = FORMATTERS[axisFormat ?? (format === "cost" ? "costCompact" : format === "number" ? "compact" : format)];
  const [active, setActive] = useState<string | null>(null);
  const descId = useId();
  const series = useMemo(() => tools ?? toolsPresent(data), [tools, data]);
  const totals = useMemo(() => data.map((d) => sumValues(d.values)), [data]);
  const max = Math.max(0, ...totals);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const tickLabels = ticks.map(formatAxis);
  const left = Math.max(28, Math.max(...tickLabels.map((t) => t.length)) * 6.6 + 10);
  const innerW = Math.max(10, width - left - MARGIN.right);
  const innerH = Math.max(10, height - MARGIN.top - MARGIN.bottom);
  const n = data.length;
  const band = n ? innerW / n : innerW;
  const barW = Math.max(1, Math.min(24, band * 0.72, band - 1));
  const y = (v: number) => MARGIN.top + innerH - (v / top) * innerH;
  const maxLabels = Math.max(2, Math.floor(innerW / 64));
  const labelStep = Math.max(1, Math.ceil(n / maxLabels));

  const activeIndex = active === null ? -1 : data.findIndex((d) => d.key === active);
  const activeDatum = activeIndex >= 0 ? data[activeIndex] : undefined;

  const describe = (d: StackedDatum, total: number) =>
    `${d.label}: ${formatValue(total)} total` +
    series
      .filter((t) => (d.values[t] ?? 0) !== 0)
      .map((t) => `, ${TOOL_LABELS[t]} ${formatValue(d.values[t] ?? 0)}`)
      .join("");

  if (!n || max <= 0) {
    return (
      <div className={className}>
        <div role="img" aria-label={`${title}: ${emptyMessage}`} className="grid place-items-center rounded-[var(--radius)] border border-dashed border-line text-sm text-fg-3" style={{ height }}>
          {emptyMessage}
        </div>
      </div>
    );
  }

  const tipLeft = activeIndex >= 0 ? left + band * (activeIndex + 0.5) : 0;
  const flip = tipLeft > width * 0.6;

  return (
    <div className={className}>
      {showLegend && <Legend tools={series} className="mb-2" />}
      <div ref={wrapRef} className="relative" onPointerLeave={() => setActive(null)}>
        <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={title} aria-describedby={description ? descId : undefined} className="block overflow-visible select-none">
          {description && <desc id={descId}>{description}</desc>}
          <g aria-hidden="true">
            {ticks.map((t, i) => (
              <g key={t}>
                {i > 0 && <line x1={left} x2={left + innerW} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth={1} shapeRendering="crispEdges" />}
                <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tabular" fontSize={11} fill="var(--chart-tick)">
                  {tickLabels[i]}
                </text>
              </g>
            ))}
            {data.map((d, i) =>
              i % labelStep === 0 ? (
                <text key={d.key} x={left + band * (i + 0.5)} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--chart-tick)" className="tabular">
                  {d.short ?? d.label}
                </text>
              ) : null,
            )}
          </g>
          <ChartMarks onActiveChange={setActive}>
            {data.map((d, i) => {
              const cx = left + band * (i + 0.5);
              const x = cx - barW / 2;
              const dim = active !== null && active !== d.key;
              let acc = 0;
              const nonZero = series.filter((t) => (d.values[t] ?? 0) > 0);
              const topTool = nonZero[nonZero.length - 1];
              return (
                <ChartMark
                  key={d.key}
                  value={d.key}
                  role="img"
                  aria-label={describe(d, totals[i] ?? 0)}
                  className="chart-mark outline-none"
                  onPointerEnter={() => setActive(d.key)}
                >
                  <rect className="chart-hit" x={left + band * i} y={MARGIN.top} width={band} height={innerH} fill="transparent" />
                  {nonZero.map((t, si) => {
                    const v = d.values[t] ?? 0;
                    const y0 = y(acc);
                    acc += v;
                    const y1 = y(acc);
                    const gap = si > 0 ? GAP : 0;
                    const h = y0 - y1 - gap;
                    if (h <= 0.25) return null;
                    const fill = toolColor(t);
                    const opacity = dim ? 0.45 : 1;
                    return t === topTool ? (
                      <path key={t} d={roundedTopPath(x, y1, barW, h, 4)} fill={fill} opacity={opacity} />
                    ) : (
                      <rect key={t} x={x} y={y1} width={barW} height={h} fill={fill} opacity={opacity} />
                    );
                  })}
                </ChartMark>
              );
            })}
          </ChartMarks>
          <line aria-hidden="true" x1={left} x2={left + innerW} y1={y(0) + 0.5} y2={y(0) + 0.5} stroke="var(--chart-axis)" strokeWidth={1} />
        </svg>
        {activeDatum && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-1 z-10 min-w-40 rounded-[var(--radius)] border border-line bg-surface px-2.5 py-2 text-xs shadow-lg"
            style={flip ? { right: width - tipLeft + 10 } : { left: tipLeft + 10 }}
          >
            <div className="mb-1 text-fg-2">{activeDatum.label}</div>
            <div className="mb-1.5 flex items-baseline justify-between gap-4">
              <span className="tabular text-sm font-semibold text-fg">{formatValue(totals[activeIndex] ?? 0)}</span>
              <span className="text-fg-3">Total</span>
            </div>
            {series
              .filter((t) => (activeDatum.values[t] ?? 0) !== 0)
              .slice()
              .reverse()
              .map((t) => (
                <div key={t} className="flex items-center gap-2 py-px">
                  <span className="tool-line-key" style={{ "--swatch": toolColor(t) } as React.CSSProperties} />
                  <span className="tabular font-medium text-fg">{formatValue(activeDatum.values[t] ?? 0)}</span>
                  <span className="ms-auto ps-3 text-fg-2">{TOOL_LABELS[t]}</span>
                </div>
              ))}
          </div>
        )}
      </div>
      {showTable && <SeriesTable title={title} data={data} series={series} totals={totals} formatValue={formatValue} />}
    </div>
  );
}

function SeriesTable({
  title,
  data,
  series,
  totals,
  formatValue,
}: {
  title: string;
  data: StackedDatum[];
  series: ToolId[];
  totals: number[];
  formatValue: (n: number) => string;
}) {
  return (
    <Collapsible className="mt-2">
      <CollapsibleTrigger className="chart-table-trigger">Table view</CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-2 max-h-72 overflow-auto rounded-[var(--radius)] border border-line">
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">{title}</caption>
            <thead className="sticky top-0 bg-surface-2 text-fg-2">
              <tr>
                <th scope="col" className="px-2 py-1.5 text-start font-medium">
                  Period
                </th>
                {series.map((t) => (
                  <th key={t} scope="col" className="px-2 py-1.5 text-end font-medium">
                    {TOOL_LABELS[t]}
                  </th>
                ))}
                <th scope="col" className="px-2 py-1.5 text-end font-medium">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((d, i) => (
                <tr key={d.key} className="border-t border-line">
                  <th scope="row" className="px-2 py-1 text-start font-normal text-fg-2">
                    {d.label}
                  </th>
                  {series.map((t) => (
                    <td key={t} className="tabular px-2 py-1 text-end">
                      {formatValue(d.values[t] ?? 0)}
                    </td>
                  ))}
                  <td className="tabular px-2 py-1 text-end font-medium">{formatValue(totals[i] ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
