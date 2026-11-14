"use client";

import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { GROUPS, type Group } from "@/lib/filters";
import { useFilters, useUrlState } from "./navigation";

const LABELS: Record<Group, string> = { daily: "Day", weekly: "Week", monthly: "Month" };

/** Day / Week / Month switch bound to the `group` URL param. Render it inside a Suspense boundary. */
export function GroupControl({ label = "Group by" }: { label?: string }) {
  const { filters, setFilters } = useFilters();
  const [value, setValue] = useUrlState<Group>(filters.group);
  return (
    <SegmentedControl
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        if (!next) return;
        setValue(next as Group);
        setFilters({ group: next as Group });
      }}
    >
      <SegmentedControlIndicator />
      {GROUPS.map((g) => (
        <SegmentedControlItem key={g} value={g}>
          {LABELS[g]}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
