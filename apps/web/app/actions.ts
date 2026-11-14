"use server";

import { refresh } from "next/cache";
import { clearUsageCache } from "@/lib/data";

export async function refreshUsage(): Promise<void> {
  clearUsageCache();
  refresh();
}
