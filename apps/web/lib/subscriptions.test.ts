import { expect, test } from "vitest";
import { monthlyPrice, parseSubscriptions, SUBSCRIPTION_PLANS, subscriptionValue } from "./subscriptions";

test("$300 inference covers a $100 monthly subscription three times", () => {
  expect(subscriptionValue(300, 100)).toEqual({ multiple: 3, differenceUSD: 200, recovered: 1 });
  expect(subscriptionValue(25, 100)).toEqual({ multiple: 0.25, differenceUSD: -75, recovered: 0.25 });
  expect(subscriptionValue(300, 0)).toEqual({ multiple: null, differenceUSD: 300, recovered: null });
});

test("annual billing uses the exact annual invoice and custom prices take precedence", () => {
  expect(monthlyPrice("claude-code", { planId: "claude-pro", billing: "annual" })).toBe(200 / 12);
  expect(monthlyPrice("codex", { planId: "chatgpt-business", billing: "annual" })).toBe(20);
  expect(monthlyPrice("codex", { planId: "chatgpt-pro-100", billing: "monthly", overrideUSD: 90 })).toBe(90);
  expect(monthlyPrice("codex", { planId: "chatgpt-enterprise", billing: "monthly" })).toBeNull();
  expect(monthlyPrice("codex", { planId: "chatgpt-plus", billing: "annual" })).toBeNull();
  expect(monthlyPrice("pi", { planId: "custom", billing: "monthly", overrideUSD: 0 })).toBe(0);
});

test("stored selections reject unsupported plans and invalid money", () => {
  for (const value of [null, [], "bad", { codex: { planId: "invented" } }, { codex: { planId: "claude-pro" } }]) expect(parseSubscriptions(value)).toEqual({});
  for (const price of [-1, Infinity, NaN, "100"]) expect(parseSubscriptions({ codex: { planId: "custom", overrideUSD: price } })).toEqual({});
  expect(parseSubscriptions({ codex: { planId: "chatgpt-pro-100", billing: "monthly" }, unknown: {} })).toEqual({ codex: { planId: "chatgpt-pro-100", billing: "monthly" } });
});

test("catalog prices are valid and every plan has an official source", () => {
  const ids = new Set<string>();
  for (const plans of Object.values(SUBSCRIPTION_PLANS)) for (const p of plans) {
    expect(ids.has(p.id)).toBe(false);
    ids.add(p.id);
    expect(p.source).toMatch(/^https:\/\//);
    if (p.monthlyUSD !== null) expect(p.monthlyUSD).toBeGreaterThanOrEqual(0);
    if (p.annualUSD !== undefined) expect(p.annualUSD).toBeGreaterThan(0);
  }
  expect(SUBSCRIPTION_PLANS.codex?.filter((p) => p.id.startsWith("chatgpt-pro-")).map((p) => p.monthlyUSD)).toEqual([100, 200, 500]);
});

test("maps Claude Max to $100 and Ultra to $200 while keeping broad ChatGPT Pro unresolved", async () => {
  const { detectSubscriptions, resolveSubscription } = await import("./subscriptions");
  const detected = detectSubscriptions([{ tool: "codex", planType: "plus" }, { tool: "claude-code", planType: "max" }]);
  expect(resolveSubscription("codex", undefined, detected.codex)).toMatchObject({ name: "ChatGPT Plus", monthlyUSD: 20, automatic: true });
  expect(resolveSubscription("claude-code", undefined, detected["claude-code"])).toMatchObject({ name: "Claude Max (5×)", monthlyUSD: 100, range: null, automatic: true });
  const ultra = detectSubscriptions([{ tool: "claude-code", planType: "ultra" }]);
  expect(resolveSubscription("claude-code", undefined, ultra["claude-code"])).toMatchObject({ name: "Claude Ultra (10× weekly)", monthlyUSD: 200, range: null, automatic: true });
  const specific = detectSubscriptions([{ tool: "codex", planType: "pro-100" }, { tool: "claude-code", planType: "default_claude_max_5x" }]);
  expect(resolveSubscription("codex", undefined, specific.codex)?.monthlyUSD).toBe(100);
  expect(resolveSubscription("claude-code", undefined, specific["claude-code"])?.monthlyUSD).toBe(100);
  expect(resolveSubscription("codex", undefined, detectSubscriptions([{ tool: "codex", planType: "pro" }]).codex)?.range).toEqual([100, 500]);
});

test("explicit overrides and opt-outs take precedence over detected accounts", async () => {
  const { detectSubscriptions, resolveSubscription } = await import("./subscriptions");
  const detected = detectSubscriptions([{ tool: "codex", planType: "plus" }]).codex;
  expect(resolveSubscription("codex", { planId: "auto", billing: "monthly", overrideUSD: 18 }, detected)).toMatchObject({ monthlyUSD: 18, automatic: true });
  expect(resolveSubscription("codex", { planId: "none", billing: "monthly" }, detected)).toBeNull();
  expect(resolveSubscription("codex", { planId: "chatgpt-pro-100", billing: "monthly" }, detected)).toMatchObject({ monthlyUSD: 100, automatic: false });
  expect(resolveSubscription("codex", undefined, undefined)).toBeNull();
  expect(resolveSubscription("codex", undefined, detectSubscriptions([{ tool: "codex", planType: "new_plan" }]).codex)).toMatchObject({ monthlyUSD: null, range: null });
});
