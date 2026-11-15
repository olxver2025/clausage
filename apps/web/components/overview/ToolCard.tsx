import type { ToolId } from "@clausage/core";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { Sparkline } from "@/components/charts/Sparkline";
import { Ticker } from "@/components/charts/Ticker";
import { ToolIcon } from "@/components/icons/BrandIcon";
import { formatDuration, formatNumber, formatPercent, formatRelative } from "@/lib/format";
import { TOOL_LABELS, toolColor } from "@/lib/tools";

export interface ToolCardProps {
  tool: ToolId;
  costUSD: number;
  totalTokens: number;
  sessions: number;
  activeMs: number;
  share: number | null;
  shareOf: "cost" | "tokens";
  topModel?: string;
  lastActive?: { at: number; estimated: boolean };
  spark: number[];
  sessionsHref: string;
  now: number;
}

export function ToolCard(p: ToolCardProps) {
  const label = TOOL_LABELS[p.tool];
  const empty = p.totalTokens <= 0 && p.costUSD <= 0;
  return (
    <section
      aria-labelledby={`tool-card-${p.tool}`}
      className="panel relative flex min-w-0 flex-col gap-2 overflow-hidden p-3 ps-4"
      style={{ "--swatch": toolColor(p.tool) } as CSSProperties}
    >
      <span aria-hidden="true" className="absolute inset-y-0 start-0 w-1 bg-[var(--swatch)]" />
      <header className="flex items-center justify-between gap-2">
        <h3 id={`tool-card-${p.tool}`} className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <ToolIcon tool={p.tool} size="1rem" />
          <span className="truncate">{label}</span>
        </h3>
        {p.share !== null && !empty && (
          <span className="tabular text-xs text-fg-3">
            {formatPercent(p.share)} <span className="sr-only">of total {p.shareOf}</span>
            <span aria-hidden="true">of {p.shareOf}</span>
          </span>
        )}
      </header>
      {empty ? (
        <p className="py-3 text-xs text-fg-3">No usage in this range.</p>
      ) : (
        <>
          <div className="flex items-end justify-between gap-2">
            <div className="figure text-xl font-semibold leading-tight">
              <Ticker value={p.costUSD} format="cost" />
            </div>
            <Sparkline values={p.spark} label={`${label} daily cost`} width={88} height={26} color={toolColor(p.tool)} />
          </div>
          {p.share !== null && (
            <div aria-hidden="true" className="h-1 w-full rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-[var(--swatch)]" style={{ width: `${Math.max(1, p.share * 100)}%` }} />
            </div>
          )}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <Stat label="Tokens">
              <Ticker value={p.totalTokens} format="tokens" />
            </Stat>
            <Stat label="Sessions">
              {formatNumber(p.sessions)}
              {p.activeMs > 0 && <span className="text-fg-3"> · {formatDuration(p.activeMs)}</span>}
            </Stat>
            <Stat label="Top model" wide>
              <span className="font-mono">{p.topModel ?? "—"}</span>
            </Stat>
            <Stat label="Last active" wide>
              {p.lastActive ? (
                <time dateTime={new Date(p.lastActive.at).toISOString()}>
                  {p.lastActive.estimated ? `${new Date(p.lastActive.at).toISOString().slice(0, 10)} (estimated)` : formatRelative(p.lastActive.at, p.now)}
                </time>
              ) : (
                "—"
              )}
            </Stat>
          </dl>
          <Link href={p.sessionsHref} className="mt-auto self-start text-xs text-fg-2 underline-offset-2 hover:text-fg hover:underline">
            {label} sessions <span aria-hidden="true">→</span>
          </Link>
        </>
      )}
    </section>
  );
}

function Stat({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-2 flex items-baseline justify-between gap-2" : ""}`}>
      <dt className="text-fg-3">{label}</dt>
      <dd className={`tabular truncate text-fg ${wide ? "text-end" : ""}`}>{children}</dd>
    </div>
  );
}
