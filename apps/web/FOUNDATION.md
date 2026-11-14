# Web foundation (for page builders)

Next.js 16 (`cacheComponents` off: its dev-mode Date tracking made the Overview render take 25s+), React 19, Tailwind v4, ui-sdk. Read `AGENTS.md` first.
Dev: `npm run dev -w web` (port 3456). Checks: `npm run build -w web`, `npx tsc --noEmit -p apps/web`, `npx eslint .` in `apps/web`.

## Page pattern (Suspense around data sections)

Pages only replace their own content. The shell (sidebar, FilterBar, footer) is in `app/layout.tsx`.
Anything that reads `searchParams` or local data must sit inside `<Suspense>`, or the build fails with "blocking route".

```tsx
import { Suspense } from "react";
import { PageHeader, Panel } from "@/components/Panel";
import { PanelSkeleton } from "@/components/Skeleton";
import { getFilters, getModelsReport } from "@/lib/data";

export const metadata = { title: "Models" }; // renders "Models · clausage"

export default function Page({ searchParams }: PageProps<"/models">) {
  return (
    <>
      <PageHeader title="Models" />
      <Suspense fallback={<PanelSkeleton />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Content({ searchParams }: { searchParams: PageProps<"/models">["searchParams"] }) {
  const filters = await getFilters(searchParams);
  const report = await getModelsReport(filters);
  return <Panel title="By model">…</Panel>;
}
```

- `PageProps<"/route">` and `LayoutProps` are global types that Next generates (run a build or dev once).
- Server components can't pass functions to client components. Client charts take named formats (`format="cost"`), not formatter functions. `DataTable` takes rendered cells.
- Several reports on one page share one parse: `const data = await getUsage(filters)`, then call `reportFrom(data, kind, filters)` for each.
- Never render prompt or message text. Core doesn't expose it. Session titles are fine.

## lib/data.ts (server only)

| Export | Signature / notes |
|---|---|
| `getFilters(searchParams)` | `Promise<Filters>`. Awaits the params, then `connection()`. Always use this in pages, not `parseFilters`, so `Date.now()` runs at request time. |
| `getUsage(filters)` | `Promise<UsageData>`: `LoadUsageResult` without the `PricingTable` class, plus `pricing: {source, fetchedAt?, models}`, `uniqueWarnings`, `loadedAt`, `timezone` (resolved IANA zone), `sinceMs`, `untilMs`. Cached in-process for 30s per option set (tools, since, until, mode, subagents, project, tz). Concurrent callers share one promise. `filters.fresh` (`?fresh=1`) skips the cache. |
| `reportFrom(data, kind, filters, opts?)` | Synchronous `Report`. Historical aggregates are merged for daily/weekly/monthly/models/tools. `report.warnings = data.uniqueWarnings`. `opts: { order, breakdown, sessionLengthHours, startOfWeek }`. |
| `getReport(kind, filters, opts?)` | `getUsage` followed by `reportFrom`. |
| `getTimeSeriesReport(f)` | Report kind is `filters.group` (daily, weekly or monthly). |
| `getSessionsReport`, `getModelsReport`, `getProjectsReport`, `getToolsReport`, `getBlocksReport` | `(filters, opts?)`. Sessions and blocks default to `order: "desc"`. Row `meta` is core's `SessionMeta` / `BlockMeta`; projects have `meta.sessions`. |
| `getCodexRateLimits(fresh?)` | `CodexRateLimits \| null` (primary and secondary windows: `used_percent`, `window_minutes`, `resets_at` in epoch seconds; `plan_type`). Cached for 30s. Never includes balances. |
| `getSourcesSummary()` | `{sources, pricing, warnings, loadedAt, timezone}` for all tools and all time. Used by the footer. |
| `clearUsageCache()` | Called by the Refresh server action (`app/actions.ts` → `refreshUsage()`, which clears the cache and calls `refresh()`). |
| `loadOptionsFor(filters)` | Converts `Filters` to `LoadUsageOptions` (day boundaries in the report timezone). |

Additive core change: `@clausage/core` now also exports `readCodexRateLimits`, `CodexRateLimits` and `CodexRateWindow`.

## GET /api/usage

`/api/usage?kind=daily|weekly|monthly|session|blocks|models|projects|tools` returns the `Report` JSON plus `filters`. Filter params are the same as the pages (below). Extra params: `order=asc|desc`, `breakdown=0`, `sessionLength=<hours>`, `fresh=1`.
`kind=sources` returns the footer summary. `kind=limits` returns `{ codex: CodexRateLimits | null }`. An unknown kind returns 400.

## lib/filters.ts (works on server and client)

URL params: `tools=claude-code,codex` (aliases `claude`, `cc`, `grok`, `oc`; leave out for all tools), `range=7d|30d|90d|all|custom` (default `30d`), `since` and `until` (`YYYY-MM-DD` or `YYYYMMDD`; either one alone implies `custom`), `tz` (IANA zone, `UTC` or `local`), `mode=auto|calculate|display`, `group=daily|weekly|monthly`, `project=<substring>`, `subagents=0`, `fresh=1`.

```ts
interface Filters {
  tools: ToolId[]; allTools: boolean; range: RangePreset; since?: string; until?: string; // resolved YYYY-MM-DD
  tz: string; mode: CostMode; group: Group; project?: string; subagents: boolean; fresh: boolean;
}
```

- `parseFilters(record | URLSearchParams, now?)`: the default range is resolved to `since`.
- `applyFilterPatch(params, patch)`: returns new params and drops defaults and `fresh`.
- `filtersToQuery(filters, extra?)`: `'?…'` or `''`, for links that keep the filters (e.g. `/sessions${filtersToQuery(f, { id })}`).
- `previousPeriod(filters)`: the equally long period just before the range, as `Filters`. Pass it to `getUsage` for KPI deltas. Returns `undefined` for open ranges.
- `rangeDays(filters)`, `describeRange(filters)` ("Last 30 days"), `todayIn(tz)`, `addDays(date, n)`, `normalizeDate`.
- Constants: `RANGE_PRESETS`, `RANGE_LABELS`, `COST_MODES`, `COST_MODE_LABELS` (`display` is labeled "Recorded only"), `GROUPS`.

## lib/series.ts (chart data, pure)

- `StackedDatum = { key, label, short?, values: Partial<Record<ToolId, number>> }`. `short` is the x-axis tick text.
- `stackedSeries(report, metric, label?)`: per-tool values from each row's breakdown.
- `fillDailyGaps(data, since, until, label?)`: adds a zero entry for each missing day. Use it for daily series.
- `toolValues(row, metric)`, `sumValues(values)`, `toolsPresent(data)`.
- `Metric`: `costUSD | totalTokens | inputTokens | outputTokens | cacheReadTokens | cacheWriteTokens | reasoningTokens | events`. `METRIC_LABELS`.

## lib/format.ts

`formatNumber` (1,234), `formatCompact` / `formatTokens` (1.2M; full digits under 1,000), `formatCost` ($1,234.56; <$0.01), `formatCostCompact` ($1.2K at 1,000 and above), `formatPercent` (12.3%), `formatDelta` (+12.3% / −4%), `formatDuration` (2h 38m, 3d 4h, 45s), `formatRelative` ("3 hours ago", "in 2 hours"), `formatDateTime(ts, tz?)`, `formatTime`, `formatDayKey("2026-11-03", {weekday, year})` (Nov 3), `formatMonthKey` (Nov 2026), `formatWeekKey` (Week of Nov 3), `formatBucketKey(key, group)`, `shortPath(path, segments=2)` (…/repo/app).
For client props: `ValueFormat = "cost" | "costCompact" | "compact" | "tokens" | "number" | "percent" | "duration"`, `FORMATTERS[format]`, `formatValue(n, format)`.

## lib/tools.ts (client-safe; doesn't import core at runtime)

`TOOL_IDS` (canonical order: claude-code, codex, grok, opencode), `TOOL_LABELS` ("Grok Build"), `TOOL_SHORT_LABELS`, `TOOL_COLOR_VARS`, `toolColor(id)` → `var(--tool-…)`, `isToolId`, `parseToolId(alias)`, `toolLabel(str)`.
Don't use logos or brand marks. Tools appear as text plus their color swatch.

## Components

All of these work in server components, except the ones marked client (those are client components you can render from a server page with serializable props).

- **`Panel`** `{title, description?, actions?, level?: 2|3, className?, children}`: a card section with an h2.
- **`PageHeader`** `{title, description?, children?}`: the page's h1, with an optional right-hand slot.
- **`PanelSkeleton`** `{height?, label?}`: a Suspense fallback with `role="status"`.
- **`StackedBarChart`** (client) `{title, description?, data: StackedDatum[], tools?, format?: ValueFormat, axisFormat?, height?=220, showLegend?=true, showTable?=true, emptyMessage?, className?}`. Bars are stacked by tool in canonical order, with a 2px gap and a 4px rounded top. Bars are at most 24px wide and size to the container (ResizeObserver). Hovering or keyboard-focusing a column shows a tooltip that lists every tool. The marks share one tab stop and arrow keys move between columns (ui-sdk `createRovingFocus`, in `chart-marks.ts`). Each column has an aria-label with its values. A legend appears for 2 or more series, plus a collapsible "Table view". `title` is the accessible name; the visible heading comes from the surrounding `Panel`.
- **`Sparkline`** `{values, label, width?=96, height?=28, color?, markLast?=true, area?, className?}`: `role="img"`, a 1.5px line, and an accent end-dot.
- **`ShareBars`** `{title, items: ShareItem[], format?: ValueFormat | fn, total?, limit?, showShare?=true, emptyMessage?}`. `ShareItem = {key, label, text?, value, tool?, hint?}`. Horizontal share bars sorted by value, with the value and % at the end. Items past `limit` fold into "Other". The bar is colored by `tool` when set, otherwise neutral. Keep `label` non-interactive; put links elsewhere.
- **`KpiTile`** `{label, value: ReactNode, sub?, delta?: {ratio, goodWhen?: "up"|"down"|"neutral", label?}, spark?: number[], sparkLabel?, tool?}`. Cost going up is usually `goodWhen: "neutral"`; don't color spend as good or bad.
- **`DataTable`** (client) `{caption, showCaption?, columns: DataColumn[], rows: DataRow[], defaultSort?, maxHeight?, emptyMessage?, footer?}`.
  - `DataColumn = {key, header, numeric?, sortable?=true, hideBelow?: "sm"|"md"|"lg", className?}`.
  - `DataRow = {id, cells: Record<key, ReactNode>, sort?: Record<key, string|number|null>}`. Always pass `sort` values for numeric columns whose cells are formatted strings.
  - Column headers are sort buttons and the `th` carries `aria-sort`. The header is sticky inside `maxHeight`. Numeric columns are right-aligned with tabular figures. The table body scrolls horizontally on narrow screens.
- **`Legend`** `{tools, shape?: "bar"|"line"}`, **`ToolDot`** `{tool, shape?}`, **`ToolName`** `{tool}` (swatch and label).
- **`GroupControl`** (client) `{label?}`: Day / Week / Month bound to `?group=`. Render it inside `<Suspense>` because it reads the URL.
- Shell hooks in `components/shell/navigation.tsx` (client, inside `<Suspense>`):
  - `useFilters()` returns `{filters, setFilters(patch), pending}`. `setFilters` runs `router.replace` in a shared transition, so `PendingRegion` dims `<main>` while the change loads.
  - `useUrlState(urlValue, key?)` holds a control's local value that follows the URL.
  - `useFilterQuery()` returns the current filter query string.

ui-sdk rules (see the skill): import per component (`@ui-sdk/react/select`), give every control a name, style from `data-*` state, key lists by id, don't hand-roll roles ui-sdk ships. A Tooltip names a control; chart tooltips are a separate, hand-built feature. `web.css` is imported in `globals.css` (`layer(components)`); restyle ui-sdk parts in `@layer components`.

## Design tokens (`app/globals.css`)

Colors use `light-dark()`. The theme is ui-sdk's `createColorScheme` (`lib/theme.ts`): `data-color-scheme="system|light|dark"` on `<html>`, saved in localStorage key `clausage-color-scheme`, and applied before paint by the `Preferences` script. The toggle is `ThemeToggle`. Tailwind's `dark:` variant follows it.

| Token | Tailwind | Use |
|---|---|---|
| `--bg` | `bg-bg` | page |
| `--surface`, `--surface-2`, `--surface-hover` | `bg-surface`, `bg-surface-2`, `bg-surface-hover` | cards and chart surface; table header and muted fill; row hover |
| `--text`, `--text-2`, `--text-3` | `text-fg`, `text-fg-2`, `text-fg-3` | primary; secondary; muted (all ≥4.5:1 on surface and bg) |
| `--border`, `--border-strong` | `border-line`, `border-line-strong` | hairlines; control edges (≥3:1) |
| `--accent`, `--accent-fg` | `bg-accent`, `text-accent` | focus ring, selection, sparkline end-dot. Never a series color. |
| `--good`, `--warning`, `--critical` | `text-good`, … | status, always shown with an icon or text |
| `--tool-claude-code` `#eb6834`/`#d95926`, `--tool-codex` `#2a78d6`/`#3987e5`, `--tool-grok` `#16956a`/`#199e70`, `--tool-opencode` `#b98000`/`#c98500` | `bg-tool-codex`, … | series marks only. Never use them for text. Validated with the dataviz palette checker in both modes (CVD ΔE ≥ 8, ≥3:1 on surface). |
| `--chart-grid`, `--chart-axis`, `--chart-tick`, `--chart-crosshair` | | chart chrome |
| `--radius` (6px), `--font-ui` (Geist), `--font-num` (Geist Mono) | `font-sans`, `font-mono` | |

Utility classes: `.panel`, `.tabular` / `.num` (mono, tabular figures, for table and axis numbers), `.figure` (mono, proportional, for big standalone values), `.muted`, `.faint`, `.sr-only`, `.tool-swatch` / `.tool-line-key` (set `--swatch`).

Conventions:
- Layout must work at 375px. Use `grid gap-3 sm:grid-cols-2 xl:grid-cols-4` for KPI rows and `hideBelow` for wide tables.
- Text sizes are compact: body 14px, tables 13px, labels 12px.
- Charts: one y-axis only, a legend for 2 or more series, a table view, tooltip values that are also reachable as text, and series colors that follow the tool rather than its rank.

## Tests and agents

- `npm test -w web` runs vitest in jsdom (`vitest.config.mts`, `test/setup.ts` with the ui-sdk jsdom stubs and `__UI_SDK_STRICT__`). `test/next-navigation.ts` mocks `next/navigation`: `nav.reset(query)` sets the URL and `nav.replace` records navigations. Tests sit next to their components (`*.test.tsx`).
- `components/shell/AgentBridge.tsx` (mounted in the layout) creates the one ui-sdk agent bridge (`getAgent()`) and registers WebMCP tools: ui-sdk's `snapshot`/`query`/`act`, plus `get_usage_report` and `set_filters`. Name every new control so the agent test keeps passing. `ChartMarks` is `data-agent-hidden`, because agents read numbers from `get_usage_report`.
