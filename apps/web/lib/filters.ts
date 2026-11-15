import { dtf } from "./format";
import type { CostMode, ToolId } from "@clausage/core";
import { TOOL_IDS, parseToolId } from "./tools";

export const RANGE_PRESETS = ["7d", "30d", "90d", "all", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const COST_MODES = ["auto", "calculate", "display"] as const satisfies readonly CostMode[];

export const COST_MODE_LABELS: Record<CostMode, string> = {
  auto: "Auto",
  calculate: "Calculate",
  display: "Recorded only",
};

export const GROUPS = ["daily", "weekly", "monthly"] as const;
export type Group = (typeof GROUPS)[number];

export const RANGE_LABELS: Record<RangePreset, string> = {
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  all: "All",
  custom: "Custom",
};

export const DEFAULT_RANGE: RangePreset = "30d";

export interface Filters {
  /** selected tools; always non-empty (all tools when the URL names none) */
  tools: ToolId[];
  /** true when the URL did not restrict tools */
  allTools: boolean;
  range: RangePreset;
  /** inclusive YYYY-MM-DD in the report timezone, resolved from the preset or the URL */
  since?: string;
  until?: string;
  /** IANA zone, 'UTC' or 'local' */
  tz: string;
  mode: CostMode;
  group: Group;
  project?: string;
  /** computers to include (by name); empty for all */
  machines: string[];
  subagents: boolean;
  fresh: boolean;
}

export type SearchParamsRecord = Record<string, string | string[] | undefined>;

type ParamSource = SearchParamsRecord | URLSearchParams;

function first(src: ParamSource, key: string): string | undefined {
  if (src instanceof URLSearchParams) return src.get(key) ?? undefined;
  const v = src[key];
  return Array.isArray(v) ? v[0] : v;
}

function all(src: ParamSource, key: string): string[] {
  if (src instanceof URLSearchParams) return src.getAll(key);
  const v = src[key];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

const DATE_RE = /^(\d{4})-?(\d{2})-?(\d{2})$/;

export function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = DATE_RE.exec(value.trim());
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? undefined : iso;
}

export function todayIn(tz: string, now: number = Date.now()): string {
  const zone = !tz || tz.toLowerCase() === "local" ? undefined : tz;
  try {
    return dtf("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validTz(tz: string | undefined): string {
  if (!tz) return "local";
  if (tz.toLowerCase() === "local" || tz.toUpperCase() === "UTC") return tz.toLowerCase() === "local" ? "local" : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "local";
  }
}

export function presetSince(range: RangePreset, tz: string, now?: number): string | undefined {
  const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 0;
  return days ? addDays(todayIn(tz, now), -(days - 1)) : undefined;
}

export function parseFilters(src: ParamSource, now?: number): Filters {
  const toolSet = new Set<ToolId>();
  for (const raw of all(src, "tools").concat(all(src, "tool"))) {
    for (const part of raw.split(",")) {
      const id = parseToolId(part);
      if (id) toolSet.add(id);
    }
  }
  const tools = TOOL_IDS.filter((t) => toolSet.has(t));
  const tz = validTz(first(src, "tz"));

  const sinceParam = normalizeDate(first(src, "since"));
  const untilParam = normalizeDate(first(src, "until"));
  const rangeParam = first(src, "range") as RangePreset | undefined;
  let range: RangePreset =
    rangeParam && (RANGE_PRESETS as readonly string[]).includes(rangeParam)
      ? rangeParam
      : sinceParam || untilParam
        ? "custom"
        : DEFAULT_RANGE;
  let since: string | undefined;
  let until: string | undefined;
  if (range === "custom") {
    since = sinceParam;
    until = untilParam;
    if (since && until && since > until) [since, until] = [until, since];
    if (!since && !until) range = "all";
  } else {
    since = presetSince(range, tz, now);
  }

  const modeParam = first(src, "mode");
  const mode: CostMode = (COST_MODES as readonly string[]).includes(modeParam ?? "") ? (modeParam as CostMode) : "auto";
  const groupParam = first(src, "group");
  const group: Group = (GROUPS as readonly string[]).includes(groupParam ?? "") ? (groupParam as Group) : "daily";
  const project = first(src, "project")?.trim() || undefined;
  const sub = first(src, "subagents");
  const fresh = first(src, "fresh");

  return {
    tools: tools.length ? tools : [...TOOL_IDS],
    allTools: tools.length === 0 || tools.length === TOOL_IDS.length,
    range,
    since,
    until,
    tz,
    mode,
    group,
    project,
    machines: (first(src, "machines") ?? "").split(",").map((m) => m.trim()).filter(Boolean),
    subagents: !(sub === "0" || sub === "false"),
    fresh: fresh === "1" || fresh === "true",
  };
}

export type FilterPatch = Partial<{
  tools: ToolId[] | null;
  range: RangePreset;
  since: string | null;
  until: string | null;
  tz: string | null;
  mode: CostMode | null;
  group: Group | null;
  project: string | null;
  machines: string[] | null;
  subagents: boolean | null;
}>;

/** Returns new search params with `patch` applied; drops defaults and `fresh` so URLs stay short. */
export function applyFilterPatch(current: URLSearchParams, patch: FilterPatch): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("fresh");
  next.delete("tool");
  const set = (key: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") next.delete(key);
    else next.set(key, value);
  };
  if ("tools" in patch) {
    const t = patch.tools ?? [];
    set("tools", t.length === 0 || t.length === TOOL_IDS.length ? null : TOOL_IDS.filter((id) => t.includes(id)).join(","));
  }
  if ("range" in patch && patch.range) {
    if (patch.range === "custom") {
      next.set("range", "custom");
    } else {
      set("range", patch.range === DEFAULT_RANGE ? null : patch.range);
      next.delete("since");
      next.delete("until");
    }
  }
  if ("since" in patch) set("since", patch.since);
  if ("until" in patch) set("until", patch.until);
  if ("tz" in patch) set("tz", patch.tz === "local" ? null : patch.tz);
  if ("mode" in patch) set("mode", patch.mode === "auto" ? null : patch.mode);
  if ("group" in patch) set("group", patch.group === "daily" ? null : patch.group);
  if ("project" in patch) set("project", patch.project);
  if ("machines" in patch) set("machines", patch.machines?.length ? patch.machines.join(",") : null);
  if ("subagents" in patch) set("subagents", patch.subagents === false ? "0" : null);
  return next;
}

/** Query string (with leading '?', or '') carrying the filters, e.g. for links between pages. */
export function filtersToQuery(f: Filters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (!f.allTools) p.set("tools", f.tools.join(","));
  if (f.range === "custom") {
    p.set("range", "custom");
    if (f.since) p.set("since", f.since);
    if (f.until) p.set("until", f.until);
  } else if (f.range !== DEFAULT_RANGE) {
    p.set("range", f.range);
  }
  if (f.tz !== "local") p.set("tz", f.tz);
  if (f.mode !== "auto") p.set("mode", f.mode);
  if (f.group !== "daily") p.set("group", f.group);
  if (f.project) p.set("project", f.project);
  if (f.machines?.length) p.set("machines", f.machines.join(","));
  if (!f.subagents) p.set("subagents", "0");
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * The equally long period right before the filters' range, for deltas; undefined for open ranges.
 * Pass the result to getUsage() like any Filters.
 */
export function previousPeriod(f: Filters, now?: number): Filters | undefined {
  const days = rangeDays(f, now);
  if (!f.since || !days || days <= 0) return undefined;
  return { ...f, range: "custom", since: addDays(f.since, -days), until: addDays(f.since, -1), fresh: false };
}

export function rangeDays(f: Pick<Filters, "since" | "until" | "tz">, now?: number): number | undefined {
  if (!f.since) return undefined;
  const until = f.until ?? todayIn(f.tz, now);
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${f.since}T00:00:00Z`)) / 86_400_000) + 1;
}

export function describeRange(f: Pick<Filters, "range" | "since" | "until">): string {
  if (f.range === "all") return "All time";
  if (f.range !== "custom") return `Last ${f.range.replace("d", " days")}`;
  if (f.since && f.until) return `${f.since} – ${f.until}`;
  if (f.since) return `Since ${f.since}`;
  if (f.until) return `Until ${f.until}`;
  return "All time";
}
