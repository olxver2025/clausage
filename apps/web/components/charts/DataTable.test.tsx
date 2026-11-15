import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { DataTable, type DataColumn, type DataRow } from "./DataTable";

const columns: DataColumn[] = [
  { key: "model", header: "Model" },
  { key: "cost", header: "Cost", numeric: true },
  { key: "note", header: "Note", sortable: false },
];

const rows: DataRow[] = [
  { id: "a", cells: { model: "beta", cost: "$2.00", note: "x" }, sort: { cost: 2 } },
  { id: "b", cells: { model: "alpha", cost: "$10.00", note: "y" }, sort: { cost: 10 } },
  { id: "c", cells: { model: "gamma", cost: "$0.50", note: "z" }, sort: { cost: 0.5 } },
];

const firstColumn = () =>
  within(screen.getByRole("table", { name: "Models" }))
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0]!.textContent);

const header = (name: string) => screen.getByRole("columnheader", { name: new RegExp(`^${name}`) });

test("sortable headers sort the rows and set aria-sort", async () => {
  const user = userEvent.setup();
  render(<DataTable caption="Models" columns={columns} rows={rows} defaultSort={{ key: "cost", dir: "desc" }} />);

  expect(header("Cost").getAttribute("aria-sort")).toBe("descending");
  expect(header("Model").hasAttribute("aria-sort")).toBe(false);
  expect(firstColumn()).toEqual(["alpha", "beta", "gamma"]);

  await user.click(screen.getByRole("button", { name: "Cost" }));
  expect(header("Cost").getAttribute("aria-sort")).toBe("ascending");
  expect(firstColumn()).toEqual(["gamma", "beta", "alpha"]);

  await user.click(screen.getByRole("button", { name: "Model" }));
  expect(header("Model").getAttribute("aria-sort")).toBe("ascending");
  expect(header("Cost").hasAttribute("aria-sort")).toBe(false);
  expect(firstColumn()).toEqual(["alpha", "beta", "gamma"]);

  screen.getByRole("button", { name: "Model" }).focus();
  await user.keyboard("{Enter}");
  expect(header("Model").getAttribute("aria-sort")).toBe("descending");
  expect(firstColumn()).toEqual(["gamma", "beta", "alpha"]);
});

test("a column marked sortable: false has no sort button", () => {
  render(<DataTable caption="Models" columns={columns} rows={rows} />);
  expect(screen.queryByRole("button", { name: "Note" })).toBeNull();
  expect(header("Note").textContent).toBe("Note");
});

test("an empty table says so", () => {
  render(<DataTable caption="Models" columns={columns} rows={[]} emptyMessage="Nothing here." />);
  expect(screen.getByText("Nothing here.")).toBeTruthy();
});

test("only models with recorded fast usage expose the mode breakdown", async () => {
  const { modeDetails } = await import("../models-projects/mode-breakdown");
  const part = { tool: "codex" as const, model: "A", events: 1, inputTokens: 20, outputTokens: 0,
    reasoningTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 20, costUSD: 1 };
  const parts = [undefined, "standard", "ultrafast"].map((speed) => ({ ...part, speed }));
  const plain = modeDetails("B", [...parts.slice(0, 2), { ...part, speed: "fast", events: 0 }]);
  const user = userEvent.setup();
  render(<DataTable caption="Models" columns={columns} rows={[
    { id: "a", cells: { model: "A", cost: "$3" }, modeDetails: modeDetails("A", parts) },
    { id: "b", cells: { model: "B" }, modeDetails: plain },
  ]} />);
  expect(screen.queryByRole("button", { name: "Usage by mode for B" })).toBeNull();
  const toggle = screen.getByRole("button", { name: "Usage by mode for A" });
  expect(toggle.querySelector("svg[aria-hidden=true]")).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await user.click(toggle);
  const details = screen.getByRole("table", { name: "A usage by mode" });
  for (const name of ["Standard", "Ultrafast", "Unreported"]) {
    expect(within(details).getByRole("rowheader", { name })).toBeTruthy();
  }
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("table", { name: "A usage by mode" })).toBeNull();
});
