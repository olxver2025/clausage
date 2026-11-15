import { expect, test } from "vitest";
import type { DailyAggregate, UsageEvent } from "@clausage/core";
import { valueUsage } from "./subscription-usage";

const event = (date: string, costUSD: number, rest: Partial<UsageEvent> = {}) => ({ tool: "codex", timestamp: Date.parse(date), costUSD, ...rest }) as UsageEvent;

test("month totals include idle days, respect the timezone, and exclude other tools and months", () => {
  const events = [event("2026-10-31T23:30:00Z", 50), event("2026-11-14T23:30:00Z", 300), event("2026-11-15T14:00:00Z", 100), event("2026-11-16T12:00:00Z", 800), event("2026-11-15T12:00:00Z", 400, { tool: "grok" })];
  expect(valueUsage(events, [], ["codex"], "2026-11-15", "Europe/Paris")).toEqual([{ tool: "codex", todayUSD: 400, monthUSD: 450, unpriced: 0, estimated: false }]);
  expect(valueUsage(events, [], ["codex"], "2026-11-15", "UTC")[0]).toMatchObject({ todayUSD: 100, monthUSD: 400 });
});

test("unpriced requests and historical estimates remain visible", () => {
  const historical = [{ tool: "codex", date: "2026-11-01", costUSD: 100 }, { tool: "codex", date: "2026-11-15", costUSD: 25, costUnknown: true }, { tool: "codex", date: "2026-10-31", costUSD: 800 }] as DailyAggregate[];
  expect(valueUsage([event("2026-11-15T12:00:00Z", 0, { costUnknown: true })], historical, ["codex", "grok"], "2026-11-15", "UTC")).toEqual([
    { tool: "codex", todayUSD: 25, monthUSD: 125, unpriced: 2, estimated: true },
    { tool: "grok", todayUSD: 0, monthUSD: 0, unpriced: 0, estimated: false },
  ]);
});
