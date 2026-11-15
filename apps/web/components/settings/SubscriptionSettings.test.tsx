import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { beforeEach, expect, test } from "vitest";
import { SubscriptionSettings } from "./SubscriptionSettings";
import { SubscriptionValueCards } from "../subscriptions/SubscriptionValueCards";

beforeEach(() => {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
});

function renderSettings() {
  return render(<><SubscriptionSettings /><SubscriptionValueCards today="2026-11-15" pricingSource="embedded" filtered={false} usage={[{ tool: "codex", todayUSD: 300, monthUSD: 900, unpriced: 0, estimated: false }]} /></>);
}

test("agent selects a subscription, overrides its cost, and updates the value card", async () => {
  const agent = createAgent();
  renderSettings();
  await act(async () => {});
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} needs a name`).toBeTruthy();
  expect(entries.map((e) => e.label)).toContain("Codex subscription");
  const result = await act(async () => agent.act({ steps: [{ ref: "Codex subscription", action: "setValue", args: ["chatgpt-pro-100"] }] }));
  expect(result.ok, result.error?.message).toBe(true);
  expect(await screen.findByText("9× your monthly fee in inference")).toBeTruthy();
  expect(screen.getByText("$300.00")).toBeTruthy();
  const override = await act(async () => agent.act({ steps: [{ ref: "Codex monthly cost override", action: "setValue", args: ["50"] }] }));
  expect(override.ok, override.error?.message).toBe(true);
  expect(screen.getByText("18× your monthly fee in inference")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("clausage-subscriptions-v1")!).codex.overrideUSD).toBe(50);
});

test("keyboard can select a plan and removing it restores the setup prompt", async () => {
  renderSettings();
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "Codex subscription" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const pro = await screen.findByRole("option", { name: "ChatGPT Pro 100 · $100.00/mo" });
  await user.click(pro);
  expect(await screen.findByText("9× your monthly fee in inference")).toBeTruthy();
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: "Not subscribed / API billing" }));
  expect(screen.getByText(/No subscription was reported/)).toBeTruthy();
});

test("custom prices stay unknown until entered and free plans avoid infinite multipliers", async () => {
  const agent = createAgent();
  renderSettings();
  await act(async () => agent.act({ steps: [{ ref: "Codex subscription", action: "setValue", args: ["custom"] }] }));
  expect(screen.getByText("Monthly price not reported; set a price override in Settings")).toBeTruthy();
  await act(async () => agent.act({ steps: [{ ref: "Codex monthly cost override", action: "setValue", args: ["0"] }] }));
  expect(screen.getByText("No subscription fee")).toBeTruthy();
});

test("annual billing and cross-tab price updates change the comparison", async () => {
  const agent = createAgent();
  renderSettings();
  await act(async () => agent.act({ steps: [
    { ref: "Codex subscription", action: "setValue", args: ["chatgpt-business"] },
    { ref: "Codex billing", action: "setValue", args: ["annual"] },
  ] }));
  expect(screen.getByText("45× your monthly fee in inference")).toBeTruthy();
  expect(screen.getByText("$20.00/month · annual billing averaged")).toBeTruthy();
  await act(async () => {
    localStorage.setItem("clausage-subscriptions-v1", JSON.stringify({ codex: { planId: "chatgpt-pro-200", billing: "monthly" } }));
    window.dispatchEvent(new StorageEvent("storage", { key: "clausage-subscriptions-v1" }));
  });
  expect(screen.getByText("4.5× your monthly fee in inference")).toBeTruthy();
});

test("incomplete estimates and filtered coverage are clearly labelled", () => {
  render(<SubscriptionValueCards today="2026-11-15" pricingSource="embedded" filtered usage={[{ tool: "codex", todayUSD: 0, monthUSD: 0, unpriced: 2, estimated: true }]} />);
  act(() => {
    localStorage.setItem("clausage-subscriptions-v1", JSON.stringify({ codex: { planId: "chatgpt-pro-100", billing: "monthly" } }));
    window.dispatchEvent(new StorageEvent("storage", { key: "clausage-subscriptions-v1" }));
  });
  expect(screen.getByText(/2 requests have no known price/)).toBeTruthy();
  expect(screen.getByText(/Includes estimated historical usage/)).toBeTruthy();
  expect(screen.getByText(/this is only part of your usage/)).toBeTruthy();
});

test("reported account plans power the value cards without manual setup", async () => {
  const { detectSubscriptions } = await import("@/lib/subscriptions");
  const detected = detectSubscriptions([{ tool: "codex", planType: "plus" }]);
  render(<><SubscriptionSettings detected={detected} /><SubscriptionValueCards detected={detected} today="2026-11-15" pricingSource="cache" filtered={false} usage={[{ tool: "codex", todayUSD: 300, monthUSD: 300, unpriced: 0, estimated: false }]} /></>);
  expect(screen.getByText("15× your monthly fee in inference")).toBeTruthy();
  expect(screen.getByText(/Detected from Codex account metadata/)).toBeTruthy();
  expect(localStorage.getItem("clausage-subscriptions-v1")).toBeNull();
});

test("Claude Max automatically compares inference against its $100 monthly fee", async () => {
  const { detectSubscriptions } = await import("@/lib/subscriptions");
  const detected = detectSubscriptions([{ tool: "claude-code", planType: "max" }]);
  render(<SubscriptionValueCards detected={detected} today="2026-11-15" pricingSource="cache" filtered={false} usage={[{ tool: "claude-code", todayUSD: 300, monthUSD: 300, unpriced: 0, estimated: false }]} />);
  expect(screen.getByText("$100.00/month")).toBeTruthy();
  expect(screen.getByText("3× your monthly fee in inference")).toBeTruthy();
  expect(screen.queryByText(/exact tier not reported/)).toBeNull();
});
