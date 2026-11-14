import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { nav, nextNavigationMock } from "@/test/next-navigation";

vi.mock("next/navigation", () => nextNavigationMock);
vi.mock("@/app/actions", () => ({ refreshUsage: vi.fn(async () => {}) }));

const { AgentBridge, filterPatchFromInput, getAgent } = await import("./AgentBridge");
const { FilterBar } = await import("./FilterBar");
const { NavigationProvider } = await import("./navigation");
const { StackedBarChart } = await import("@/components/charts/StackedBarChart");

type Tool = { name: string; annotations?: { readOnlyHint?: boolean }; execute: (input: Record<string, unknown>) => unknown };
const tools = new Map<string, Tool>();
let signals: AbortSignal[] = [];

beforeEach(() => {
  tools.clear();
  signals = [];
  Object.assign(document, {
    modelContext: {
      registerTool: async (tool: Tool, options?: { signal?: AbortSignal }) => {
        tools.set(tool.name, tool);
        if (options?.signal) signals.push(options.signal);
      },
    },
  });
});

afterEach(() => {
  delete (document as { modelContext?: unknown }).modelContext;
  vi.unstubAllGlobals();
});

function renderApp(query = "") {
  nav.reset(query);
  return render(
    <NavigationProvider>
      <FilterBar />
      <StackedBarChart title="Cost over time" data={[{ key: "d1", label: "Nov 1", values: { codex: 1 } }]} format="cost" />
      <AgentBridge />
    </NavigationProvider>,
  );
}

test("registers ui-sdk's tools plus the report and filter tools, and removes them on unmount", async () => {
  const { unmount } = renderApp();
  await act(async () => {});
  expect([...tools.keys()].sort()).toEqual(["act", "get_usage_report", "query", "set_filters", "snapshot"]);
  expect(tools.get("get_usage_report")!.annotations?.readOnlyHint).toBe(true);
  expect(tools.get("set_filters")!.annotations?.readOnlyHint).not.toBe(true);
  unmount();
  expect(signals.length).toBeGreaterThan(0);
  expect(signals.every((s) => s.aborted)).toBe(true);
});

test("every component on the shell is named for agents", async () => {
  renderApp();
  await act(async () => {});
  const entries = getAgent()
    .snapshot()
    .filter((entry) => !entry.offPage && entry.component !== "more");
  expect(entries.map((e) => e.component)).toContain("segmented-control");
  expect(entries.map((e) => e.component)).not.toContain("chart-marks");
  for (const entry of entries) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
});

test("set_filters patches the URL", async () => {
  renderApp("range=7d");
  await act(async () => {});
  const result = await act(async () => tools.get("set_filters")!.execute({ tools: ["codex", "claude"], mode: "calculate", group: "weekly", bogus: 1 }));
  expect(result).toMatchObject({ ok: true });
  const q = new URLSearchParams(String(nav.replace.mock.lastCall?.[0]).split("?")[1]);
  expect(q.get("tools")).toBe("claude-code,codex");
  expect(q.get("mode")).toBe("calculate");
  expect(q.get("group")).toBe("weekly");
  expect(q.get("range")).toBe("7d");
});

test("get_usage_report fetches /api/usage with the current filters", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ kind: "models", rows: [] })));
  vi.stubGlobal("fetch", fetchMock);
  renderApp("tools=codex&range=90d&project=x");
  await act(async () => {});
  const result = await tools.get("get_usage_report")!.execute({ kind: "models" });
  expect(result).toEqual({ kind: "models", rows: [] });
  const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]), "http://localhost");
  expect(url.pathname).toBe("/api/usage");
  expect(Object.fromEntries(url.searchParams)).toEqual({ kind: "models", tools: "codex", range: "90d", project: "x" });
  expect(await tools.get("get_usage_report")!.execute({ kind: "nope" })).toMatchObject({ error: expect.stringContaining("Unknown kind") });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("filterPatchFromInput ignores unknown values and dates imply custom", () => {
  expect(filterPatchFromInput({ range: "5y", mode: "free", since: "2026-01-01" })).toEqual({ range: "custom", since: "2026-01-01" });
  expect(filterPatchFromInput({ tools: [] })).toEqual({ tools: ["claude-code", "codex", "grok", "opencode"] });
  expect(filterPatchFromInput({ project: "" })).toEqual({ project: null });
});
