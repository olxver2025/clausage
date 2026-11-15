import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ToolLimitStatus } from "@clausage/core";
import { UsageResets } from "./UsageResets";

const now = Date.UTC(2026, 10, 15, 12);
const base: ToolLimitStatus = { tool: "codex", fiveHour: null, weekly: null, extra: [], hits: [], resetEvents: [] };

test("shows known availability and expiry separately from missing data", () => {
  const { rerender } = render(<UsageResets status={{ ...base, resets: { availableCount: 1, grants: [{ id: "g", label: "Full reset", remaining: 1, expiresAt: now + 86400_000 }] }, resetsReportedAt: now }} now={now} timeZone="UTC" />);
  expect(screen.getByRole("region", { name: "Usage resets" })).toBeTruthy();
  expect(screen.getByText("1 saved reset available")).toBeTruthy();
  expect(screen.getByText("Full reset")).toBeTruthy();
  expect(screen.getByText(/Expires/)).toBeTruthy();
  rerender(<UsageResets status={base} now={now} timeZone="UTC" />);
  expect(screen.getByText("Reset availability unknown")).toBeTruthy();
  expect(screen.queryByText("0 saved resets available")).toBeNull();
  rerender(<UsageResets status={{ ...base, resets: { availableCount: 0 } }} now={now} timeZone="UTC" />);
  expect(screen.getByText("0 saved resets available")).toBeTruthy();
});

test("Grok reports unavailable account data without inventing a zero balance", () => {
  render(<UsageResets status={{ ...base, tool: "grok" }} now={now} timeZone="UTC" />);
  expect(screen.getByText(/Grok’s saved resets aren’t exposed/)).toBeTruthy();
});

test("describes what each known grant resets without the promotional text", () => {
  render(<UsageResets status={{ ...base, resets: { availableCount: 4, grants: [
    { id: "a", label: "New model launch: one Fable reset for Max, Team Premium and Enterprise Premium", remaining: 1 },
    { id: "b", label: "New model launch: one more Fable reset at 6 months' tenure", remaining: 1 },
    { id: "c", label: "One full limit reset (November 2026)", remaining: 1 },
    { id: "d", label: "Other specific reset", remaining: 1 },
  ] } }} now={now} timeZone="UTC" />);
  expect(screen.getAllByText("Fable reset")).toHaveLength(2);
  expect(screen.getByText("Full limit reset")).toBeTruthy();
  expect(screen.getByText("Other specific reset")).toBeTruthy();
  expect(screen.queryByText(/New model launch/i)).toBeNull();
});
