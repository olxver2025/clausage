import Link from "next/link";
import type { MonthForecast, Spike } from "@clausage/core";
import { Panel } from "@/components/Panel";
import { displayTitle, sessionHref, shortId } from "@/components/sessions/links";
import { getInsights } from "@/lib/data";
import { filtersToQuery, type Filters } from "@/lib/filters";
import { formatBucketKey, formatCost, formatPercent } from "@/lib/format";
import { TOOL_LABELS } from "@/lib/tools";

/** Forecast and unusual-activity panels; loads its own data so the rest of the page never waits on it. */
export async function Insights({ filters, now }: { filters: Filters; now: number }) {
  const { forecast, days, sessions } = await getInsights(filters, now);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Forecast f={forecast} />
      <Unusual days={days.slice(0, 5)} sessions={sessions.slice(0, 5)} filters={filters} />
    </div>
  );
}

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

function Forecast({ f }: { f: MonthForecast }) {
  const name = monthName(f.month);
  const scale = Math.max(f.highUSD, f.projectedUSD, f.toDateUSD) || 1;
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const noBasis = f.basisDays === 0;
  return (
    <Panel
      title={`${name} forecast`}
      description={
        noBasis
          ? "Needs at least a day of history before today"
          : `Spent so far plus ${formatCost(f.dailyRateUSD)}/day (your average over the last ${f.basisDays} day${f.basisDays === 1 ? "" : "s"}) for the rest of the month`
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
          <div>
            <div className="figure text-2xl font-semibold leading-tight text-fg">{formatCost(f.projectedUSD)}</div>
            <div className="text-xs text-fg-3">expected by month end</div>
          </div>
          {!noBasis && f.highUSD > f.lowUSD && (
            <div className="text-xs text-fg-2">
              range <span className="figure">{formatCost(f.lowUSD)}</span> – <span className="figure">{formatCost(f.highUSD)}</span>
              <span className="text-fg-3"> (quieter and busier days)</span>
            </div>
          )}
        </div>
        <div
          role="img"
          aria-label={`${formatCost(f.toDateUSD)} spent of ${formatCost(f.projectedUSD)} expected; ${formatPercent(f.elapsed)} of the month has passed`}
          className="relative h-3 overflow-hidden rounded-[3px] bg-surface-2"
        >
          {!noBasis && f.highUSD > f.lowUSD && (
            <span className="absolute inset-y-0 bg-[color-mix(in_oklab,var(--accent)_22%,transparent)]" style={{ left: pct(f.lowUSD), width: `calc(${pct(f.highUSD)} - ${pct(f.lowUSD)})` }} />
          )}
          <span className="absolute inset-y-0 left-0 rounded-e-[2px] bg-accent" style={{ width: pct(f.toDateUSD) }} />
          <span aria-hidden="true" className="absolute inset-y-0 w-0.5 bg-fg" style={{ left: pct(f.projectedUSD) }} />
        </div>
        <dl className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <dt className="text-fg-3">So far</dt>
            <dd className="figure text-fg">{formatCost(f.toDateUSD)}</dd>
          </div>
          <div>
            <dt className="text-fg-3">Month elapsed</dt>
            <dd className="figure text-fg">{formatPercent(f.elapsed)}</dd>
          </div>
          <div>
            <dt className="text-fg-3">Daily rate</dt>
            <dd className="figure text-fg">{noBasis ? "—" : formatCost(f.dailyRateUSD)}</dd>
          </div>
        </dl>
        <p className="text-[0.6875rem] text-fg-3">API-equivalent estimate for the selected tools and computers, not a bill. Ignores the page’s date range.</p>
      </div>
    </Panel>
  );
}

function times(s: Spike): string {
  return s.ratio === Infinity ? "new" : `${s.ratio >= 10 ? Math.round(s.ratio) : s.ratio.toFixed(1)}×`;
}

function Unusual({ days, sessions, filters }: { days: Spike[]; sessions: Spike[]; filters: Filters }) {
  const empty = !days.length && !sessions.length;
  const query = filtersToQuery(filters);
  return (
    <Panel title="Unusual activity" description="Days and sessions far above your usual spend in this range (robust median rule)">
      {empty ? (
        <p className="text-sm text-fg-2">Nothing stands out. Every day and session is within your usual range.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {days.length > 0 && (
            <section aria-label="Unusual days">
              <h3 className="mb-1 text-xs font-medium text-fg-2">Days</h3>
              <ul className="flex flex-col divide-y divide-line">
                {days.map((d) => (
                  <li key={d.key} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                    <Link
                      href={`/sessions${filtersToQuery({ ...filters, range: "custom", since: d.key, until: d.key })}`}
                      className="underline decoration-line-strong underline-offset-2 hover:decoration-accent"
                    >
                      {formatBucketKey(d.key, "daily")}
                    </Link>
                    <span className="flex items-baseline gap-2 text-xs text-fg-3">
                      <span className="figure text-sm text-fg">{formatCost(d.value)}</span>
                      <span className="text-warning">{times(d)}</span> your usual {formatCost(d.baseline)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {sessions.length > 0 && (
            <section aria-label="Unusual sessions">
              <h3 className="mb-1 text-xs font-medium text-fg-2">Sessions</h3>
              <ul className="flex flex-col divide-y divide-line">
                {sessions.map((s) => (
                  <li key={s.key} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                    {s.session ? (
                      <Link
                        href={sessionHref(s.session.tool, s.session.sessionId, query)}
                        className="min-w-0 truncate underline decoration-line-strong underline-offset-2 hover:decoration-accent"
                        title={`${TOOL_LABELS[s.session.tool]} · ${s.session.sessionId}`}
                      >
                        {displayTitle(s.label, 60) ?? shortId(s.session.sessionId)}
                      </Link>
                    ) : (
                      <span className="min-w-0 truncate">{displayTitle(s.label, 60) ?? s.key}</span>
                    )}
                    <span className="flex shrink-0 items-baseline gap-2 text-xs text-fg-3">
                      <span className="figure text-sm text-fg">{formatCost(s.value)}</span>
                      <span className="text-warning">{times(s)}</span> usual {formatCost(s.baseline)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Panel>
  );
}
