"use client";

import type { ColorSchemeValue } from "@ui-sdk/core";
import { usePreference } from "@ui-sdk/react/preferences";
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { colorScheme } from "@/lib/theme";

const OPTIONS: Array<{ value: ColorSchemeValue; label: string }> = [
  { value: "system", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { value } = usePreference(colorScheme);
  return (
    <SegmentedControl
      aria-label="Theme"
      value={value}
      onValueChange={(next) => {
        if (next) colorScheme.set(next as ColorSchemeValue);
      }}
      className={className}
    >
      <SegmentedControlIndicator />
      {OPTIONS.map((o) => (
        <SegmentedControlItem key={o.value} value={o.value}>
          {o.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
