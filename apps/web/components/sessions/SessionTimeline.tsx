"use client";
import { dtf } from "@/lib/format";

import type { ToolId } from "@clausage/core";
import { useId, useMemo, useState, type PointerEvent } from "react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { ChartMark, ChartMarks } from "@/components/charts/chart-marks";
import { niceTicks, roundedTopPath, useWidth } from "@/components/charts/chart-utils";
import { formatCost, formatCostCompact, formatDuration, formatNumber, formatTokens } from "@/lib/format";
import { toolColor } from "@/lib/tools";

export interface SessionTimelineProps {
  title: string;
  tool: ToolId;
  timeZone: string;
  /** per request, oldest first */
  ts: number[];
  tokens: number[];
  cost: number[];
  /** 1 when the request came from a subagent */
  sub: number[];
}

interface Bin {
  index: number;
  start: number;
  end: number;
  requests: number;
  tokens: number;
  subTokens: number;
  cost: number;
  cumulative: number;
}

const BAR_H = 140;
const GAP_H = 18;
const LINE_H = 96;
const AXIS_H = 22;
const TOP = 8;
const RIGHT = 6;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STEPS = [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];

function buildBins(ts: number[], tokens: number[], cost: number[], sub: number[], count: number): Bin[] {
  if (!ts.length) return [];
  const t0 = ts[0]!;
  const t1 = ts[ts.length - 1]!;
  const span = Math.max(t1 - t0, MINUTE);
  const n = Math.max(1, Math.min(count, ts.length === 1 ? 1 : count));
  const width = span / n;
  const bins: Bin[] = Array.from({ length: n }, (_, i) => ({
    index: i,
    start: t0 + i * width,
    end: t0 + (i + 1) * width,
    requests: 0,
    tokens: 0,
    subTokens: 0,
    cost: 0,
    cumulative: 0,
  }));
  for (let i = 0; i < ts.length; i++) {
    const b = bins[Math.min(n - 1, Math.floor((ts[i]! - t0) / width))]!;
    b.requests += 1;
    b.tokens += tokens[i] ?? 0;
    b.cost += cost[i] ?? 0;
    if (sub[i]) b.subTokens += tokens[i] ?? 0;
  }
  let acc = 0;
  for (const b of bins) {
    acc += b.cost;
    b.cumulative = acc;
  }
  return bins;
}

function timeFormatter(timeZone: string, span: number, step: number) {
  const opts: Intl.DateTimeFormatOptions =
    step >= DAY
      ? { month: "short", day: "numeric", timeZone }
      : span > DAY
        ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }
        : { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone };
  const fmt = dtf("en-US", opts);
  return (t: number) => fmt.format(new Date(t));
}

export function SessionTimeline({ title, tool, timeZone, ts, tokens, cost, sub }: SessionTimelineProps) {
  const [wrapRef, width] = useWidth<HTMLDivElement>(720);
  const [active, setActive] = useState<number | null>(null);
  const descId = useId();
  const color = toolColor(tool);

  const binCount = Math.max(8, Math.min(160, Math.floor((width - 60) / 7)));
  const bins = useMemo(() => buildBins(ts, tokens, cost, sub, binCount), [ts, tokens, cost, sub, binCount]);
  const nonEmpty = bins.filter((b) => b.requests > 0);

  const full = dtf("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  const fmtFull = (t: number) => full.format(new Date(t));

  if (!bins.length) {
    return (
      <div role="img" aria-label={`${title}: no requests`} className="grid h-40 place-items-center rounded-[var(--radius)] border border-dashed border-line text-sm text-fg-3">
        No requests in this session.
      </div>
    );
  }

  const t0 = bins[0]!.start;
  const t1 = bins[bins.length - 1]!.end;
  const span = t1 - t0;
  const maxTokens = Math.max(0, ...bins.map((b) => b.tokens));
  const totalCost = bins[bins.length - 1]!.cumulative;
  const tokenTicks = niceTicks(maxTokens, 3);
  const costTicks = niceTicks(totalCost, 2);
  const tokenTop = tokenTicks[tokenTicks.length - 1] || 1;
  const costTop = costTicks[costTicks.length - 1] || 1;
  const tokenLabels = tokenTicks.map(formatTokens);
  const costLabels = costTicks.map(formatCostCompact);
  const left = Math.max(32, Math.max(...tokenLabels.map((t) => t.length), ...costLabels.map((t) => t.length)) * 6.6 + 10);
  const innerW = Math.max(10, width - left - RIGHT);
  const band = innerW / bins.length;
  const barW = Math.max(1, Math.min(24, band - (band > 4 ? 2 : 0.5)));
  const lineTop = TOP + BAR_H + GAP_H;
  const height = lineTop + LINE_H + AXIS_H;

  const yTok = (v: number) => TOP + BAR_H - (v / tokenTop) * BAR_H;
  const yCost = (v: number) => lineTop + LINE_H - (v / costTop) * LINE_H;
  const xMid = (i: number) => left + band * (i + 0.5);

  const maxTicks = Math.max(2, Math.floor(innerW / 96));
  const step = STEPS.find((s) => s >= span / maxTicks) ?? 30 * DAY;
  const fmtTick = timeFormatter(timeZone, span, step);
  const xTicks: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) xTicks.push(t);
  const xOf = (t: number) => left + ((t - t0) / (span || 1)) * innerW;

  const linePts = bins.map((b, i) => `${i === 0 ? "M" : "L"}${xMid(i).toFixed(2)},${yCost(b.cumulative).toFixed(2)}`).join("");
  const areaPath = `${linePts}L${xMid(bins.length - 1).toFixed(2)},${yCost(0)}L${xMid(0).toFixed(2)},${yCost(0)}Z`;
  const last = bins[bins.length - 1]!;

  const activeBin = active === null ? undefined : bins[active];

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * width;
    if (x < left || x > left + innerW) return setActive(null);
    setActive(Math.max(0, Math.min(bins.length - 1, Math.floor((x - left) / band))));
  };

  const describe = (b: Bin) =>
    `${fmtFull(b.start)}: ${formatNumber(b.requests)} requests, ${formatTokens(b.tokens)} tokens, ${formatCost(b.cost)}; ${formatCost(b.cumulative)} so far`;

  const tipX = activeBin ? xMid(activeBin.index) : 0;
  const flip = tipX > width * 0.6;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="tool-swatch" style={{ "--swatch": color } as React.CSSProperties} />
          Tokens per interval
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="tool-line-key" style={{ "--swatch": color } as React.CSSProperties} />
          Cumulative cost
        </span>
        <span className="text-fg-3">Interval {formatDuration(span / bins.length)}</span>
      </div>
      <div ref={wrapRef} className="relative" onPointerLeave={() => setActive(null)}>
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={title}
          aria-describedby={descId}
          className="block overflow-visible select-none"
          onPointerMove={onPointerMove}
        >
          <desc id={descId}>
            {`${formatNumber(ts.length)} requests from ${fmtFull(t0)} to ${fmtFull(t1)}. Top: tokens per ${formatDuration(span / bins.length)} interval. Bottom: cumulative cost, ending at ${formatCost(totalCost)}.`}
          </desc>
          <g aria-hidden="true">
            {tokenTicks.map((t, i) => (
              <g key={`tok-${t}`}>
                {i > 0 && <line x1={left} x2={left + innerW} y1={yTok(t)} y2={yTok(t)} stroke="var(--chart-grid)" shapeRendering="crispEdges" />}
                <text x={left - 8} y={yTok(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--chart-tick)" className="tabular">
                  {tokenLabels[i]}
                </text>
              </g>
            ))}
            {costTicks.map((t, i) => (
              <g key={`cost-${t}`}>
                {i > 0 && <line x1={left} x2={left + innerW} y1={yCost(t)} y2={yCost(t)} stroke="var(--chart-grid)" shapeRendering="crispEdges" />}
                <text x={left - 8} y={yCost(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--chart-tick)" className="tabular">
                  {costLabels[i]}
                </text>
              </g>
            ))}
            <text x={left} y={TOP - 1} fontSize={10} fill="var(--chart-tick)">
              Tokens
            </text>
            <text x={left} y={lineTop - 1} fontSize={10} fill="var(--chart-tick)">
              Cost so far
            </text>
            {xTicks.map((t) => (
              <text key={t} x={xOf(t)} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--chart-tick)" className="tabular">
                {fmtTick(t)}
              </text>
            ))}
            <line x1={left} x2={left + innerW} y1={yTok(0) + 0.5} y2={yTok(0) + 0.5} stroke="var(--chart-axis)" />
            <line x1={left} x2={left + innerW} y1={yCost(0) + 0.5} y2={yCost(0) + 0.5} stroke="var(--chart-axis)" />
            <path d={areaPath} fill={color} opacity={0.1} />
            <path d={linePts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {activeBin && (
              <>
                <line x1={tipX} x2={tipX} y1={TOP} y2={yCost(0)} stroke="var(--chart-crosshair)" strokeWidth={1} />
                <circle cx={tipX} cy={yCost(activeBin.cumulative)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
              </>
            )}
            {!activeBin && <circle cx={xMid(last.index)} cy={yCost(last.cumulative)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />}
          </g>
          <ChartMarks onActiveChange={(key) => setActive(key === null ? null : Number(key))}>
            {nonEmpty.map((b) => {
              const h = yTok(0) - yTok(b.tokens);
              const x = xMid(b.index) - barW / 2;
              const dim = active !== null && active !== b.index;
              return (
                <ChartMark key={b.index} value={String(b.index)} role="img" aria-label={describe(b)} className="chart-mark outline-none">
                  <rect className="chart-hit" x={left + band * b.index} y={TOP} width={band} height={BAR_H} fill="transparent" />
                  {h > 0.25 && <path d={roundedTopPath(x, yTok(b.tokens), barW, Math.max(h, 1), Math.min(4, barW / 2))} fill={color} opacity={dim ? 0.45 : 1} />}
                </ChartMark>
              );
            })}
          </ChartMarks>
        </svg>
        {activeBin && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-1 z-10 min-w-44 rounded-[var(--radius)] border border-line bg-surface px-2.5 py-2 text-xs shadow-lg"
            style={flip ? { right: width - tipX + 10 } : { left: tipX + 10 }}
          >
            <div className="mb-1 text-fg-2">
              {fmtFull(activeBin.start)} – {timeFormatter(timeZone, 0, 0)(activeBin.end)}
            </div>
            <TipRow value={formatTokens(activeBin.tokens)} label="Tokens" />
            {activeBin.subTokens > 0 && <TipRow value={formatTokens(activeBin.subTokens)} label="from subagents" muted />}
            <TipRow value={formatNumber(activeBin.requests)} label="Requests" />
            <TipRow value={formatCost(activeBin.cost)} label="Cost" />
            <div className="mt-1 flex items-center gap-2 border-t border-line pt-1">
              <span className="tool-line-key" style={{ "--swatch": color } as React.CSSProperties} />
              <span className="tabular font-semibold text-fg">{formatCost(activeBin.cumulative)}</span>
              <span className="ms-auto ps-3 text-fg-2">So far</span>
            </div>
          </div>
        )}
      </div>
      <Collapsible className="mt-2">
        <CollapsibleTrigger className="chart-table-trigger">Table view</CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-2 max-h-72 overflow-auto rounded-[var(--radius)] border border-line">
            <table className="w-full border-collapse text-xs">
              <caption className="sr-only">{title}</caption>
              <thead className="sticky top-0 bg-surface-2 text-fg-2">
                <tr>
                  <th scope="col" className="px-2 py-1.5 text-start font-medium">Interval start</th>
                  <th scope="col" className="px-2 py-1.5 text-end font-medium">Requests</th>
                  <th scope="col" className="px-2 py-1.5 text-end font-medium">Tokens</th>
                  <th scope="col" className="px-2 py-1.5 text-end font-medium">Cost</th>
                  <th scope="col" className="px-2 py-1.5 text-end font-medium">Cost so far</th>
                </tr>
              </thead>
              <tbody>
                {nonEmpty.map((b) => (
                  <tr key={b.index} className="border-t border-line">
                    <th scope="row" className="tabular px-2 py-1 text-start font-normal text-fg-2">{fmtFull(b.start)}</th>
                    <td className="tabular px-2 py-1 text-end">{formatNumber(b.requests)}</td>
                    <td className="tabular px-2 py-1 text-end">{formatTokens(b.tokens)}</td>
                    <td className="tabular px-2 py-1 text-end">{formatCost(b.cost)}</td>
                    <td className="tabular px-2 py-1 text-end font-medium">{formatCost(b.cumulative)}</td>
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

function TipRow({ value, label, muted = false }: { value: string; label: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-px">
      <span className={`tabular font-medium ${muted ? "text-fg-2" : "text-fg"}`}>{value}</span>
      <span className="text-fg-3">{label}</span>
    </div>
  );
}
