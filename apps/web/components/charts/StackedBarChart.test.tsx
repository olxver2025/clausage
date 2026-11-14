import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { StackedBarChart } from "./StackedBarChart";

const data = [
  { key: "2026-11-01", label: "Nov 1", values: { "claude-code": 1.5, codex: 0.25 } },
  { key: "2026-11-02", label: "Nov 2", values: { codex: 2 } },
  { key: "2026-11-03", label: "Nov 3", values: {} },
];

test("the chart, each column and the table view carry accessible labels", async () => {
  const user = userEvent.setup();
  render(<StackedBarChart title="Cost over time" description="Daily cost by tool." data={data} format="cost" />);

  const chart = screen.getByRole("group", { name: "Cost over time" });
  expect(chart.querySelector("desc")?.textContent).toBe("Daily cost by tool.");
  expect(chart.getAttribute("aria-describedby")).toBe(chart.querySelector("desc")?.id);

  const bars = screen.getAllByRole("img");
  expect(bars).toHaveLength(3);
  expect(bars[0]!.getAttribute("aria-label")).toBe("Nov 1: $1.75 total, Claude Code $1.50, Codex $0.25");
  expect(bars[1]!.getAttribute("aria-label")).toBe("Nov 2: $2.00 total, Codex $2.00");
  expect(bars.map((b) => b.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);

  act(() => bars[0]!.focus());
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(bars[1]);
  await user.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(bars[0]);

  expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);
  await user.click(screen.getByRole("button", { name: "Table view" }));
  expect(screen.getByRole("table", { name: "Cost over time" })).toBeTruthy();
});

test("an empty chart is a single labelled image", () => {
  render(<StackedBarChart title="Cost over time" data={[]} />);
  expect(screen.getByRole("img", { name: "Cost over time: No usage in this range." })).toBeTruthy();
});
