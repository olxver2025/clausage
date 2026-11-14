"use client";

import type { CostMode, ToolId } from "@clausage/core";
import { Button } from "@ui-sdk/react/button";
import { DateInput } from "@ui-sdk/react/date-input";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue } from "@ui-sdk/react/select";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";
import { refreshUsage } from "@/app/actions";
import { COST_MODE_LABELS, COST_MODES, RANGE_LABELS, RANGE_PRESETS, todayIn, type RangePreset } from "@/lib/filters";
import { TOOL_IDS, TOOL_SHORT_LABELS, TOOL_LABELS, isToolId, toolColor } from "@/lib/tools";
import { useFilters, usePendingTransition, useUrlState } from "./navigation";

const modeItems = COST_MODES.map((m) => ({ value: m, label: COST_MODE_LABELS[m] }));

export function FilterBar() {
  const { filters, setFilters } = useFilters();
  const [pending, startTransition] = usePendingTransition();

  const [tools, setTools] = useUrlState<string[]>(filters.allTools ? [...TOOL_IDS] : filters.tools, filters.allTools ? "all" : filters.tools.join(","));
  const [range, setRange] = useUrlState<RangePreset>(filters.range);
  const [mode, setMode] = useUrlState<CostMode>(filters.mode);
  const [since, setSince] = useUrlState<string | null>(filters.since ?? null);
  const [until, setUntil] = useUrlState<string | null>(filters.until ?? null);

  const today = todayIn(filters.tz);

  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2" role="search" aria-label="Filters">
      <Field className="filter-field">
        <FieldLabel>Range</FieldLabel>
        <SegmentedControl
          value={range}
          onValueChange={(next) => {
            if (!next) return;
            const r = next as RangePreset;
            setRange(r);
            if (r === "custom") {
              const s = filters.since ?? today;
              setSince(s);
              setUntil(filters.until ?? today);
              setFilters({ range: "custom", since: s, until: filters.until ?? today });
            } else {
              setFilters({ range: r });
            }
          }}
        >
          <SegmentedControlIndicator />
          {RANGE_PRESETS.map((r) => (
            <SegmentedControlItem key={r} value={r}>
              {RANGE_LABELS[r]}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </Field>

      {range === "custom" && (
        <>
          <Field className="filter-field">
            <FieldLabel>Since</FieldLabel>
            <DateInput
              value={since}
              max={until ?? today}
              onValueChange={(v) => {
                setSince(v);
                if (v) setFilters({ range: "custom", since: v, until });
              }}
            />
          </Field>
          <Field className="filter-field">
            <FieldLabel>Until</FieldLabel>
            <DateInput
              value={until}
              min={since ?? undefined}
              onValueChange={(v) => {
                setUntil(v);
                if (v) setFilters({ range: "custom", since, until: v });
              }}
            />
          </Field>
        </>
      )}

      <div className="filter-field">
        <span aria-hidden="true" className="filter-label">
          Tools
        </span>
        <ToggleGroup
          aria-label="Tools"
          multiple
          value={tools}
          onValueChange={(next) => {
            const picked = next.filter(isToolId) as ToolId[];
            const value = picked.length ? picked : [...TOOL_IDS];
            setTools(value);
            setFilters({ tools: value });
          }}
        >
          {TOOL_IDS.map((t) => (
            <Toggle key={t} value={t} className="tool-toggle" aria-label={TOOL_LABELS[t]}>
              <span aria-hidden="true" className="tool-swatch" style={{ "--swatch": toolColor(t) } as React.CSSProperties} />
              {TOOL_SHORT_LABELS[t]}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>

      <Field className="filter-field">
        <FieldLabel>Cost</FieldLabel>
        <Select
          items={modeItems}
          value={mode}
          onValueChange={(next) => {
            if (!next) return;
            setMode(next as CostMode);
            setFilters({ mode: next as CostMode });
          }}
        >
          <SelectTrigger className="min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modeItems.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
                <SelectItemIndicator />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Button
        className="refresh-button"
        data-pending={pending ? "" : undefined}
        pendingAnnouncement="Refreshing usage"
        onClick={() =>
          new Promise<void>((resolve) => {
            startTransition(async () => {
              await refreshUsage();
              resolve();
            });
          })
        }
      >
        Refresh
      </Button>
    </div>
  );
}

export function FilterBarFallback() {
  return <div aria-hidden="true" className="h-[3.25rem]" />;
}
