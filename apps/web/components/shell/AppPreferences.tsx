"use client";

import { Preferences } from "@ui-sdk/react/preferences";
import { colorScheme } from "@/lib/theme";

export function AppPreferences({ children }: { children: React.ReactNode }) {
  return <Preferences preferences={[colorScheme]}>{children}</Preferences>;
}
