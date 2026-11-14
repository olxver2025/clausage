"use client";

import { createColorScheme, createLocalStorage } from "@ui-sdk/core";

export const colorScheme = createColorScheme({
  storage: createLocalStorage("clausage-color-scheme"),
  global: true,
});
