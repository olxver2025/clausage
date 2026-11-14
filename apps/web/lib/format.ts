const LOCALE = "en-US";

const intFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 });
const usdFmt = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdCompactFmt = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: 1 });
const relFmt = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

const dtfCache = new Map<string, Intl.DateTimeFormat>();
/** Memoised Intl.DateTimeFormat: constructing one is slow and formatters run per row/bar. */
export function dtf(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(opts);
  let fmt = dtfCache.get(key);
  if (!fmt) dtfCache.set(key, (fmt = new Intl.DateTimeFormat(locale, opts)));
  return fmt;
}

function finite(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function formatNumber(n: number | null | undefined): string {
  return finite(n) ? intFmt.format(n) : "–";
}

export function formatCompact(n: number | null | undefined): string {
  if (!finite(n)) return "–";
  return Math.abs(n) < 1000 ? intFmt.format(n) : compactFmt.format(n);
}

export const formatTokens = formatCompact;

export function formatCost(usd: number | null | undefined): string {
  if (!finite(usd)) return "–";
  if (usd !== 0 && Math.abs(usd) < 0.01) return usd < 0 ? "-<$0.01" : "<$0.01";
  return usdFmt.format(usd);
}

export function formatCostCompact(usd: number | null | undefined): string {
  if (!finite(usd)) return "–";
  return Math.abs(usd) < 1000 ? formatCost(usd) : usdCompactFmt.format(usd);
}

export function formatPercent(ratio: number | null | undefined): string {
  return finite(ratio) ? pctFmt.format(ratio) : "–";
}

export function formatDelta(ratio: number | null | undefined): string {
  if (!finite(ratio)) return "–";
  const sign = ratio > 0 ? "+" : ratio < 0 ? "−" : "±";
  return `${sign}${pctFmt.format(Math.abs(ratio))}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!finite(ms) || ms < 0) return "–";
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return ms < 1000 ? "0m" : `${Math.round(ms / 1000)}s`;
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function toDate(input: number | string | Date): Date {
  return input instanceof Date ? input : new Date(input);
}

export function formatRelative(input: number | string | Date, now: number = Date.now()): string {
  const t = toDate(input).getTime();
  if (!Number.isFinite(t)) return "–";
  const diff = t - now;
  const abs = Math.abs(diff);
  const rtf = relFmt;
  if (abs < 45_000) return "just now";
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["minute", 60_000],
    ["hour", 3_600_000],
    ["day", 86_400_000],
    ["week", 604_800_000],
    ["month", 2_629_800_000],
    ["year", 31_557_600_000],
  ];
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let size = 60_000;
  for (const [u, s] of units) {
    if (abs >= s * 0.9) {
      unit = u;
      size = s;
    }
  }
  return rtf.format(Math.round(diff / size), unit);
}

export function formatDateTime(input: number | string | Date, timeZone?: string): string {
  const d = toDate(input);
  if (!Number.isFinite(d.getTime())) return "–";
  return dtf(LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(d);
}

export function formatTime(input: number | string | Date, timeZone?: string): string {
  const d = toDate(input);
  if (!Number.isFinite(d.getTime())) return "–";
  return dtf(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(d);
}

function parseKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(key);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1, 12));
}

export function formatDayKey(key: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const d = parseKey(key);
  if (!d) return key;
  return dtf(LOCALE, {
    weekday: opts.weekday ? "short" : undefined,
    month: "short",
    day: "numeric",
    year: opts.year ? "numeric" : undefined,
    timeZone: "UTC",
  }).format(d);
}

export function formatMonthKey(key: string): string {
  const d = parseKey(key);
  if (!d) return key;
  return dtf(LOCALE, { month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}

export function formatWeekKey(key: string): string {
  return `Week of ${formatDayKey(key)}`;
}

export function formatBucketKey(key: string, kind: "daily" | "weekly" | "monthly"): string {
  if (kind === "monthly") return formatMonthKey(key);
  if (kind === "weekly") return formatWeekKey(key);
  return formatDayKey(key);
}

export function shortPath(p: string, segments = 2): string {
  if (!p) return "(unknown)";
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= segments) return p;
  return `…/${parts.slice(-segments).join("/")}`;
}

/** Named formatters, for client chart props (functions can't cross from server components). */
export const FORMATTERS = {
  cost: formatCost,
  costCompact: formatCostCompact,
  compact: formatCompact,
  tokens: formatTokens,
  number: formatNumber,
  percent: formatPercent,
  duration: formatDuration,
} satisfies Record<string, (n: number) => string>;

export type ValueFormat = keyof typeof FORMATTERS;

export function formatValue(n: number, format: ValueFormat | ((n: number) => string) = "compact"): string {
  return typeof format === "function" ? format(n) : FORMATTERS[format](n);
}
