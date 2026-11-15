import type { CapacityEstimate, ToolLimitStatus, WindowStatus } from "@clausage/core";
import Link from "next/link";
import type { CSSProperties } from "react";
import { ToolIcon } from "@/components/icons/BrandIcon";
import { formatCompact, formatCost, formatDateTime, formatDuration, formatRelative, formatTime } from "@/lib/format";
import { TOOL_LABELS, toolColor } from "@/lib/tools";
import { UsageResets } from "./UsageResets";

const WINDOW_LABEL = { five_hour: "5-hour window", weekly: "Weekly" } as const;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface ClaudeUsageNote {
  enabled: boolean;
  error?: string;
}

export function UsageLimits({ tools, now, timeZone, claude }: { tools: ToolLimitStatus[]; now: number; timeZone: string; claude?: ClaudeUsageNote }) {
  if (!tools.length) {
    return <p className="panel px-3 py-4 text-sm text-fg-3 sm:px-4">No tool activity in the last week.</p>;
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {tools.map((t) => (
        <LimitCard key={t.tool} status={t} now={now} timeZone={timeZone} claude={t.tool === "claude-code" ? claude : undefined} />
      ))}
    </div>
  );
}

function LimitCard({ status, now, timeZone, claude }: { status: ToolLimitStatus; now: number; timeZone: string; claude?: ClaudeUsageNote }) {
  const reported = status.fiveHour?.source === "reported" || status.weekly?.source === "reported" || status.fiveHour?.reportedAt !== undefined;
  const reportedAt = status.fiveHour?.reportedAt ?? status.weekly?.reportedAt;
  const configured = Boolean(status.config?.fiveHourTokens || status.config?.weeklyTokens);
  return (
    <article className="panel flex min-w-0 flex-col gap-4 p-3 sm:p-4" aria-labelledby={`limits-${status.tool}`}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 id={`limits-${status.tool}`} className="flex items-center gap-2 text-sm font-semibold">
          <ToolIcon tool={status.tool} size="1rem" />
          {TOOL_LABELS[status.tool]}
          {status.planType && <span className="rounded-[4px] border border-line px-1.5 py-px text-[0.6875rem] font-medium text-fg-2">{capitalize(status.planType)}</span>}
        </h3>
        <span className="text-xs text-fg-3">
          {reported && reportedAt !== undefined ? (
            <>
              {status.tool === "claude-code" ? "From your Claude account" : `Reported by ${TOOL_LABELS[status.tool]}`} {formatRelative(reportedAt, now)}
            </>
          ) : status.tool === "claude-code" && !claude?.enabled && !configured ? (
            <Link href="/settings#limits" className="underline decoration-line-strong underline-offset-2 hover:text-fg">
              Show real limits
            </Link>
          ) : configured ? (
            <Link href="/settings#limits" className="underline decoration-line-strong underline-offset-2 hover:text-fg">
              Your limits
            </Link>
          ) : (
            <Link href="/settings#limits" className="underline decoration-line-strong underline-offset-2 hover:text-fg">
              Set limits to track %
            </Link>
          )}
        </span>
      </header>
      {status.fiveHour ? (
        <WindowRow w={status.fiveHour} capacity={status.fiveHourCapacity} tool={status.tool} now={now} timeZone={timeZone} />
      ) : (
        <EmptyWindow label={WINDOW_LABEL.five_hour} text="No active window. The next one starts with your next request." />
      )}
      {status.weekly && <WindowRow w={status.weekly} capacity={status.weeklyCapacity} tool={status.tool} now={now} timeZone={timeZone} />}
      {status.extra.map((w) => (
        <WindowRow key={w.label} w={w} tool={status.tool} now={now} timeZone={timeZone} />
      ))}
      {claude?.error && (
        <p role="status" className="text-xs text-warning">
          Couldn’t get Claude’s limits: {claude.error}
        </p>
      )}
      <Hits status={status} now={now} timeZone={timeZone} />
      <UsageResets status={status} now={now} timeZone={timeZone} />
    </article>
  );
}

function EmptyWindow({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-fg-2">{label}</div>
      <p className="mt-1 text-xs text-fg-3">{text}</p>
    </div>
  );
}

function WindowRow({ w, capacity, tool, now, timeZone }: { w: WindowStatus; capacity?: CapacityEstimate; tool: ToolLimitStatus["tool"]; now: number; timeZone: string }) {
  const label = w.label ?? (w.rolling ? "Last 7 days" : WINDOW_LABEL[w.kind]);
  const pct = w.usedPercent;
  const usage = (
    <span className="tabular">
      {formatCompact(w.tokens)} tokens · {formatCost(w.costUSD)}
    </span>
  );

  if (w.expired && w.tokens === 0) {
    return <EmptyWindow label={label} text={`No active window. The last one reset ${formatRelative(w.startMs, now)}; the next starts with your next request.`} />;
  }

  const level = pct === undefined ? null : pct >= 100 ? "critical" : pct >= 80 || (w.projectedLimitAt !== undefined && pct >= 50) ? "warning" : null;
  const fill = level ? `var(--${level})` : toolColor(tool);
  const projected = w.projectedPercent !== undefined && pct !== undefined ? Math.min(100, Math.max(pct, w.projectedPercent)) : undefined;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-fg-2">{label}</span>
        <span className="text-xs text-fg-3">
          {pct !== undefined ? (
            <>
              <span className={`figure text-base font-semibold ${level === "critical" ? "text-critical" : "text-fg"}`}>{Math.round(pct)}%</span> used
            </>
          ) : (
            usage
          )}
        </span>
      </div>
      {pct !== undefined && (
        <div
          role="meter"
          aria-label={`${label} limit used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.round(pct))}
          aria-valuetext={`${Math.round(pct)}% used${w.projectedPercent !== undefined ? `, ${Math.round(w.projectedPercent)}% projected by reset` : ""}`}
          className="limit-track mt-1.5"
          style={{ "--fill": fill } as CSSProperties}
        >
          {projected !== undefined && projected > pct && <span className="limit-projected" style={{ width: `${projected}%` }} />}
          <span className="limit-fill" style={{ width: `${Math.min(100, Math.max(1, pct))}%` }} />
        </div>
      )}
      <p className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-fg-3">
        {pct !== undefined && usage}
        {!w.rolling && w.endMs > now && (
          <span>
            Resets {formatRelative(w.endMs, now)} <span className="tabular">({w.kind === "weekly" ? formatDateTime(w.endMs, timeZone) : formatTime(w.endMs, timeZone)})</span>
          </span>
        )}
        {w.expired && <span>Not reported yet for this window</span>}
        {w.projectedLimitAt !== undefined ? (
          <span className="font-medium text-warning">
            At this pace the limit is reached {formatRelative(w.projectedLimitAt, now)} (
            <span className="tabular">{w.kind === "weekly" ? formatDateTime(w.projectedLimitAt, timeZone) : formatTime(w.projectedLimitAt, timeZone)}</span>)
          </span>
        ) : (
          w.projectedPercent !== undefined && pct !== undefined && pct < 100 && <span>On pace for {Math.round(w.projectedPercent)}% by reset</span>
        )}
        {w.source === "configured" && w.limitTokens && <span>of your {formatCompact(w.limitTokens)} limit</span>}
      </p>
      {capacity && (
        <p className="mt-1 text-xs text-fg-3">
          A full window ≈ <span className="tabular text-fg-2">{formatCompact(capacity.tokens)}</span> tokens (≈{" "}
          <span className="tabular text-fg-2">{formatCost(capacity.costUSD)}</span> at API prices), from {capacity.windows} window{capacity.windows === 1 ? "" : "s"} so far
        </p>
      )}
      {!w.rolling && w.kind === "five_hour" && w.source !== "reported" && (
        <p className="mt-1 text-xs text-fg-3">
          Started <span className="tabular">{formatTime(w.startMs, timeZone)}</span> · {formatDuration(Math.max(0, now - w.startMs))} in
        </p>
      )}
    </div>
  );
}

function Hits({ status, now, timeZone }: { status: ToolLimitStatus; now: number; timeZone: string }) {
  const recent = status.hits.filter((h) => now - h.timestamp < 35 * 86_400_000);
  if (!recent.length) return <p className="text-xs text-fg-3">No limit hits in the last 35 days.</p>;
  const last = recent[0]!;
  return (
    <p className="text-xs text-fg-2">
      <span className="font-medium text-critical">
        Limit reached {recent.length} time{recent.length === 1 ? "" : "s"}
      </span>{" "}
      in the last 35 days · last <span className="tabular">{formatDateTime(last.timestamp, timeZone)}</span>
      {last.resetsAt && <> (reset {formatTime(last.resetsAt, timeZone)})</>}
      {last.machine && <> on {last.machine}</>}
    </p>
  );
}
