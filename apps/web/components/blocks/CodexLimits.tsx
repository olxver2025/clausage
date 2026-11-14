import type { CodexRateLimits, CodexRateWindow } from "@clausage/core";
import { Meter, MeterIndicator, MeterLabel, MeterTrack, MeterValue } from "@ui-sdk/react/meter";
import { formatDateTime, formatDuration, formatRelative } from "@/lib/format";

function windowName(w: CodexRateWindow, fallback: string): string {
  const m = w.window_minutes;
  if (!m) return fallback;
  if (m % 10080 === 0) return m === 10080 ? "Weekly window" : `${m / 10080}-week window`;
  if (m % 1440 === 0) return `${m / 1440}-day window`;
  if (m % 60 === 0) return `${m / 60}-hour window`;
  return `${formatDuration(m * 60_000)} window`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function CodexLimits({ limits, now, timeZone }: { limits: CodexRateLimits | null; now: number; timeZone: string }) {
  if (!limits) {
    return <p className="text-sm text-fg-3">No Codex rate-limit snapshot found. Codex records one with each response.</p>;
  }
  const windows = [
    { id: "primary", w: limits.primary, fallback: "Primary window" },
    { id: "secondary", w: limits.secondary, fallback: "Secondary window" },
  ].filter((x): x is { id: string; w: CodexRateWindow; fallback: string } => x.w !== null);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2">
        {limits.plan_type && (
          <span>
            Plan <span className="font-medium text-fg">{capitalize(limits.plan_type)}</span>
          </span>
        )}
        <span>
          Snapshot from <span className="tabular">{formatRelative(limits.timestamp, now)}</span>
        </span>
      </div>
      {windows.map(({ id, w, fallback }) => {
        const resetMs = w.resets_at ? w.resets_at * 1000 : undefined;
        const hasReset = resetMs !== undefined && resetMs <= now;
        const pct = Math.max(0, Math.min(100, w.used_percent));
        const level = pct >= 90 ? "critical" : pct >= 75 ? "warning" : null;
        return (
          <div key={id} className="min-w-0">
            <Meter value={pct} className="[&_[data-slot=meter-indicator]]:bg-(--fill)" style={{ "--fill": level ? `var(--${level})` : "var(--tool-codex)" } as React.CSSProperties}>
              <MeterLabel>{windowName(w, fallback)}</MeterLabel>
              <MeterValue>
                <span className="tabular text-fg">{Math.round(w.used_percent)}%</span> used
              </MeterValue>
              <MeterTrack>
                <MeterIndicator />
              </MeterTrack>
            </Meter>
            <p className="mt-1 text-xs text-fg-3">
              {level && <span className={`font-medium ${level === "critical" ? "text-critical" : "text-warning"}`}>{level === "critical" ? "Near limit" : "High usage"} · </span>}
              {resetMs === undefined ? (
                "Reset time not recorded"
              ) : hasReset ? (
                <>
                  Reset at <span className="tabular">{formatDateTime(resetMs, timeZone)}</span>, after this snapshot; current usage is likely lower
                </>
              ) : (
                <>
                  Resets <span className="tabular">{formatRelative(resetMs, now)}</span> · <span className="tabular">{formatDateTime(resetMs, timeZone)}</span>
                </>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}
