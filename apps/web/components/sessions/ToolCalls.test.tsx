import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { costPerCall, McpServerLine, ToolCallBars, toolCallSummary } from "./ToolCalls";

const sessions: Array<{ toolCalls: number; toolCallsByName?: Record<string, number> }> = [
  { toolCalls: 7, toolCallsByName: { Bash: 4, Read: 1, mcp__github__create_pr: 1 } },
  { toolCalls: 3, toolCallsByName: { Bash: 2, mcp__github__list_issues: 1 } },
  { toolCalls: 0 },
];

test("tool calls are listed by name with counts, shares and session counts", () => {
  render(<ToolCallBars title="Top tool calls" sessions={sessions} showSessions />);
  const items = screen.getByRole("list", { name: "Top tool calls" }).querySelectorAll("li");
  expect([...items].map((li) => li.querySelector(".sr-only")?.textContent)).toEqual([
    "Bash: 6, 60%",
    "Read: 1, 10%",
    "mcp__github__create_pr: 1, 10%",
    "mcp__github__list_issues: 1, 10%",
  ]);
  expect(screen.getByText("2 sessions")).toBeTruthy();
  // one call in the first session has no recorded name
  expect(screen.getByText("1 call without a recorded tool name is not listed.")).toBeTruthy();
});

test("sessions without names explain why the list is empty", () => {
  const { rerender } = render(<ToolCallBars title="Tool calls" sessions={[{ toolCalls: 5 }]} />);
  expect(screen.getByText("This tool's logs do not record tool names.")).toBeTruthy();
  rerender(<ToolCallBars title="Tool calls" sessions={[{ toolCalls: 0 }]} />);
  expect(screen.getByText("No tool calls recorded.")).toBeTruthy();
});

test("MCP servers are grouped from mcp__<server>__<tool> names", () => {
  const { container, rerender } = render(<McpServerLine sessions={sessions} />);
  expect(container.textContent).toBe("MCP servers: github 2");
  rerender(<McpServerLine sessions={[{ toolCalls: 1, toolCallsByName: { Bash: 1 } }]} />);
  expect(container.textContent).toBe("");
});

test("summary figures: calls, sessions with calls, cost per call", () => {
  expect(toolCallSummary(sessions)).toEqual({ calls: 10, sessions: 2, named: 9 });
  // the session without calls (and its cost) is left out of cost per call
  expect(costPerCall([{ toolCalls: 4, costUSD: 1 }, { toolCalls: 0, costUSD: 5 }])).toBe(0.25);
  expect(costPerCall([{ toolCalls: 0, costUSD: 5 }])).toBeNull();
});
