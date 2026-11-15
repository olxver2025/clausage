import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { nav, nextNavigationMock } from "@/test/next-navigation";

vi.mock("next/navigation", () => nextNavigationMock);
vi.mock("@/app/actions", () => ({ refreshUsage: vi.fn(async () => {}) }));

const { FilterBar } = await import("./FilterBar");
const { NavigationProvider } = await import("./navigation");
const { refreshUsage } = await import("@/app/actions");

const agent = createAgent();

function renderBar(query = "") {
  nav.reset(query);
  return render(
    <NavigationProvider>
      <FilterBar />
    </NavigationProvider>,
  );
}

const lastUrl = () => String(nav.replace.mock.lastCall?.[0] ?? "");
const lastQuery = () => new URLSearchParams(lastUrl().split("?")[1] ?? "");

describe("FilterBar", () => {
  beforeEach(() => vi.mocked(refreshUsage).mockClear());

  test("every control is named in the page's own markup", () => {
    renderBar();
    const bar = screen.getByRole("search", { name: "Filters" });
    const range = within(bar).getByRole("radiogroup", { name: "Range" });
    expect(within(range).getAllByRole("radio").map((r) => r.textContent)).toEqual(["7d", "30d", "90d", "All", "Custom"]);
    expect(within(range).getByRole("radio", { name: "30d" }).getAttribute("aria-checked")).toBe("true");
    const tools = within(bar).getByRole("group", { name: "Tools" });
    for (const name of ["Claude Code", "Codex", "Grok Build", "OpenCode"]) {
      const toggle = within(tools).getByRole("button", { name });
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      expect(toggle.hasAttribute("aria-disabled")).toBe(false);
    }
    expect(within(bar).getByRole("combobox", { name: "Cost" }).textContent).toBe("Auto");
    const refresh = within(bar).getByRole("button", { name: "Refresh" });
    expect(refresh.hasAttribute("aria-disabled")).toBe(false);
    expect(within(bar).queryByLabelText("Since")).toBeNull();
  });

  test("picking a range preset writes ?range and drops the default", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("radio", { name: "7d" }));
    expect(lastUrl()).toBe("/?range=7d");
    await user.click(screen.getByRole("radio", { name: "All" }));
    expect(lastQuery().get("range")).toBe("all");
  });

  test("Custom shows Since and Until fields and writes both dates", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("radio", { name: "Custom" }));
    const q = lastQuery();
    expect(q.get("range")).toBe("custom");
    expect(q.get("since")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(q.get("until")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.getAllByText("Since").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Until").length).toBeGreaterThan(0);
  });

  test("Space on each tool toggle removes that tool from ?tools", async () => {
    const user = userEvent.setup();
    renderBar();
    const all = ["claude-code", "codex", "grok", "opencode", "hermes", "openclaw", "pi", "gemini", "amp", "qwen", "copilot", "aider"];
    const names: Record<string, string> = {
      "Claude Code": "claude-code",
      Codex: "codex",
      "Grok Build": "grok",
      OpenCode: "opencode",
      "Hermes Agent": "hermes",
      OpenClaw: "openclaw",
      Pi: "pi",
      "Gemini CLI": "gemini",
      Amp: "amp",
      "Qwen Code": "qwen",
      "Copilot CLI": "copilot",
      Aider: "aider",
    };
    const expected = Object.fromEntries(Object.entries(names).map(([name, id]) => [name, all.filter((t) => t !== id).join(",")]));
    for (const [name, tools] of Object.entries(expected)) {
      nav.reset();
      const { unmount } = render(
        <NavigationProvider>
          <FilterBar />
        </NavigationProvider>,
      );
      const toggle = screen.getAllByRole("button", { name }).at(-1)!;
      act(() => toggle.focus());
      await user.keyboard(" ");
      expect(lastQuery().get("tools"), name).toBe(tools);
      unmount();
    }
  });

  test("turning the last tool off falls back to all tools", async () => {
    const user = userEvent.setup();
    renderBar("tools=codex");
    expect(screen.getByRole("button", { name: "Claude Code" }).getAttribute("aria-pressed")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Codex" }));
    expect(lastQuery().has("tools")).toBe(false);
  });

  test("choosing a cost mode writes ?mode", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("combobox", { name: "Cost" }));
    await user.click(await screen.findByRole("option", { name: "Recorded only" }));
    expect(lastQuery().get("mode")).toBe("display");
  });

  test("Refresh calls the server action", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refreshUsage).toHaveBeenCalledTimes(1);
  });

  test("an agent can find and change every filter", async () => {
    renderBar();
    const components = agent.snapshot().filter((entry) => !entry.offPage && entry.component !== "more");
    for (const entry of components) {
      expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
    }
    const labels = components.map((entry) => entry.label);
    for (const label of ["Range", "Tools", "Claude Code", "Codex", "Grok Build", "OpenCode", "Cost", "Refresh"]) {
      expect(labels, `${label} is missing from the snapshot`).toContain(label);
    }

    const result = await agent.act({
      steps: [
        { ref: "Range", action: "setValue", args: ["90d"] },
        { ref: "Cost", action: "setValue", args: ["Calculate"] },
        { ref: "OpenCode", action: "setPressed", args: [false] },
      ],
    });
    expect(result.ok, result.error?.message).toBe(true);
    const q = lastQuery();
    expect(q.get("range")).toBe("90d");
    expect(q.get("mode")).toBe("calculate");
    expect(q.get("tools")).toBe("claude-code,codex,grok,hermes,openclaw,pi,gemini,amp,qwen,copilot,aider");

    const refresh = await agent.act({ steps: [{ ref: "Refresh", action: "press" }] });
    expect(refresh.ok, refresh.error?.message).toBe(true);
    expect(refreshUsage).toHaveBeenCalledTimes(1);
  });
});
