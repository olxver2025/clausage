import type { ToolId } from "@clausage/core";

export const SUBSCRIPTION_PRICES_CHECKED = "2026-11-15";
export interface SubscriptionPlan {
  id: string;
  name: string;
  monthlyUSD: number | null;
  annualUSD?: number;
  source: string;
  note?: string;
}
const openai = "https://learn.chatgpt.com/docs/pricing";
const claude = "https://claude.com/pricing";
const grok = "https://x.ai/pricing";
const google = "https://gemini.google/us/subscriptions/?hl=en";
const opencode = "https://opencode.ai/docs/console/go/";
const copilot = "https://github.com/features/copilot/plans";

export const SUBSCRIPTION_PLANS: Partial<Record<ToolId, SubscriptionPlan[]>> = {
  codex: [
    { id: "chatgpt-free", name: "ChatGPT Free", monthlyUSD: 0, source: openai },
    { id: "chatgpt-go", name: "ChatGPT Go", monthlyUSD: 8, source: openai },
    { id: "chatgpt-plus", name: "ChatGPT Plus", monthlyUSD: 20, source: openai },
    { id: "chatgpt-pro-100", name: "ChatGPT Pro 100", monthlyUSD: 100, source: openai },
    { id: "chatgpt-pro-200", name: "ChatGPT Pro 200", monthlyUSD: 200, source: openai },
    { id: "chatgpt-pro-500", name: "ChatGPT Pro 500", monthlyUSD: 500, source: openai },
    { id: "chatgpt-business", name: "ChatGPT Business", monthlyUSD: 25, annualUSD: 240, source: openai, note: "Per seat; at least 2 seats. Extra credits cost more." },
    { id: "chatgpt-enterprise", name: "ChatGPT Enterprise", monthlyUSD: null, source: openai },
    { id: "chatgpt-edu", name: "ChatGPT Edu", monthlyUSD: null, source: openai },
  ],
  "claude-code": [
    { id: "claude-free", name: "Claude Free", monthlyUSD: 0, source: claude, note: "Claude Code is not included in Free." },
    { id: "claude-pro", name: "Claude Pro", monthlyUSD: 20, annualUSD: 200, source: claude },
    { id: "claude-max", name: "Claude Max (5×)", monthlyUSD: 100, source: claude },
    { id: "claude-ultra", name: "Claude Ultra (10× weekly)", monthlyUSD: 200, source: claude },
    { id: "claude-team-standard", name: "Claude Team Standard", monthlyUSD: 25, annualUSD: 240, source: claude, note: "Per seat; at least 2 seats." },
    { id: "claude-team-premium", name: "Claude Team Premium", monthlyUSD: 125, annualUSD: 1200, source: claude, note: "Per seat; at least 2 seats." },
    { id: "claude-enterprise", name: "Claude Enterprise", monthlyUSD: null, source: claude, note: "$20/seat/month annually, 20-seat minimum, plus API usage. Enter your total monthly cost." },
    { id: "claude-education", name: "Claude Education", monthlyUSD: null, source: claude },
  ],
  grok: [
    { id: "grok-free", name: "Grok Free", monthlyUSD: 0, source: grok },
    { id: "grok-plus", name: "Grok Plus", monthlyUSD: 8, source: grok },
    { id: "grok-premium", name: "Grok Premium", monthlyUSD: 30, source: grok },
    { id: "grok-super", name: "Grok Super", monthlyUSD: 100, source: grok },
    { id: "grok-ultra", name: "Grok Ultra", monthlyUSD: 200, source: grok },
    { id: "grok-teams", name: "Grok Teams", monthlyUSD: null, source: grok, note: "From $30/seat/month; enter the price of your seat." },
    { id: "grok-enterprise", name: "Grok Enterprise", monthlyUSD: null, source: grok },
  ],
  gemini: [
    { id: "google-free", name: "Google Free", monthlyUSD: 0, source: google },
    { id: "google-plus", name: "Google AI Plus", monthlyUSD: 4.99, source: google, note: "Check your plan’s Gemini CLI eligibility; app benefits differ." },
    { id: "google-pro", name: "Google AI Pro", monthlyUSD: 19.99, source: google },
    { id: "google-ultra-5", name: "Google AI Ultra 5×", monthlyUSD: 99.99, source: google },
    { id: "google-ultra-20", name: "Google AI Ultra 20×", monthlyUSD: 199.99, source: google },
    { id: "google-enterprise", name: "Gemini Enterprise / Code Assist", monthlyUSD: null, source: "https://docs.cloud.google.com/gemini/docs/codeassist/sunset", note: "Code Assist Standard and Enterprise are no longer sold. Enter your existing contract cost; Gemini Enterprise app plans do not establish CLI entitlement." },
  ],
  opencode: [
    { id: "opencode-go", name: "OpenCode Go", monthlyUSD: 10, source: opencode },
    { id: "opencode-go-plus", name: "OpenCode Go Plus", monthlyUSD: 40, source: opencode },
    { id: "opencode-go-teams", name: "OpenCode Go Teams", monthlyUSD: 20, source: opencode, note: "Per member." },
  ],
  copilot: [
    { id: "copilot-free", name: "Copilot Free", monthlyUSD: 0, source: copilot },
    { id: "copilot-pro", name: "Copilot Pro", monthlyUSD: 10, source: copilot },
    { id: "copilot-pro-plus", name: "Copilot Pro+", monthlyUSD: 39, source: copilot },
    { id: "copilot-max", name: "Copilot Max", monthlyUSD: 100, source: copilot },
    { id: "copilot-business", name: "Copilot Business / Enterprise", monthlyUSD: null, source: copilot, note: "Priced through sales; enter your seat cost." },
  ],
};

export interface Subscription {
  planId: string;
  billing: "monthly" | "annual";
  overrideUSD?: number;
}
export type Subscriptions = Partial<Record<ToolId, Subscription>>;

export function findPlan(tool: ToolId, id: string): SubscriptionPlan | undefined {
  return SUBSCRIPTION_PLANS[tool]?.find((p) => p.id === id);
}

export function monthlyPrice(tool: ToolId, subscription: Subscription): number | null {
  if (subscription.overrideUSD !== undefined) return subscription.overrideUSD;
  const plan = findPlan(tool, subscription.planId);
  if (!plan) return null;
  return subscription.billing === "annual" ? (plan.annualUSD === undefined ? null : plan.annualUSD / 12) : plan.monthlyUSD;
}

export function parseSubscriptions(value: unknown): Subscriptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Subscriptions = {};
  for (const tool of ["codex", "claude-code", "grok", "gemini", "opencode", "hermes", "openclaw", "pi", "amp", "qwen", "copilot", "aider"] as const) {
    const s = (value as Record<string, unknown>)[tool];
    if (!s || typeof s !== "object") continue;
    const { planId, billing, overrideUSD } = s as Record<string, unknown>;
    if (typeof planId !== "string" || (!["custom", "auto", "none"].includes(planId) && !findPlan(tool, planId))) continue;
    if (overrideUSD !== undefined && (typeof overrideUSD !== "number" || !Number.isFinite(overrideUSD) || overrideUSD < 0)) continue;
    result[tool] = { planId, billing: billing === "annual" ? "annual" : "monthly", ...(overrideUSD !== undefined ? { overrideUSD: overrideUSD as number } : {}) };
  }
  return result;
}

export function subscriptionValue(inferenceUSD: number, monthlyUSD: number) {
  return {
    multiple: monthlyUSD > 0 ? inferenceUSD / monthlyUSD : null,
    differenceUSD: inferenceUSD - monthlyUSD,
    recovered: monthlyUSD > 0 ? Math.min(1, inferenceUSD / monthlyUSD) : null,
  };
}

export interface DetectedSubscription {
  planType: string;
  reportedAt?: number;
  planIds: string[];
}
export type DetectedSubscriptions = Partial<Record<ToolId, DetectedSubscription>>;

export function detectSubscriptions(statuses: Array<{ tool: ToolId; planType?: string; reportedAt?: number }>): DetectedSubscriptions {
  const detected: DetectedSubscriptions = {};
  const aliases: Partial<Record<ToolId, Record<string, string[]>>> = {
    codex: {
      free: ["chatgpt-free"], go: ["chatgpt-go"], plus: ["chatgpt-plus"],
      pro: ["chatgpt-pro-100", "chatgpt-pro-200", "chatgpt-pro-500"],
      pro_100: ["chatgpt-pro-100"], pro_200: ["chatgpt-pro-200"], pro_500: ["chatgpt-pro-500"],
      team: ["chatgpt-business"], business: ["chatgpt-business"], enterprise: ["chatgpt-enterprise"], edu: ["chatgpt-edu"],
    },
    "claude-code": {
      free: ["claude-free"], pro: ["claude-pro"],
      max: ["claude-max"], max_5x: ["claude-max"], max_20x: ["claude-ultra"], ultra: ["claude-ultra"],
      default_claude_pro: ["claude-pro"], default_claude_max_5x: ["claude-max"], default_claude_max_20x: ["claude-ultra"],
      team: ["claude-team-standard", "claude-team-premium"], enterprise: ["claude-enterprise"],
    },
  };
  for (const s of statuses) {
    if (!s.planType) continue;
    const key = s.planType.trim().toLowerCase().replace(/[\s-]+/g, "_");
    const exact = SUBSCRIPTION_PLANS[s.tool]?.find((p) => p.id.replace(/-/g, "_") === key);
    detected[s.tool] = { planType: s.planType, reportedAt: s.reportedAt, planIds: exact ? [exact.id] : aliases[s.tool]?.[key] ?? [] };
  }
  return detected;
}

export function resolveSubscription(tool: ToolId, saved: Subscription | undefined, detected: DetectedSubscription | undefined) {
  if (saved?.planId === "none") return null;
  if (saved && saved.planId !== "auto") {
    return { name: findPlan(tool, saved.planId)?.name ?? "Custom subscription", monthlyUSD: monthlyPrice(tool, saved), automatic: false, range: null, subscription: saved };
  }
  if (!detected) return null;
  const plans = detected.planIds.map((id) => findPlan(tool, id)).filter((p): p is SubscriptionPlan => Boolean(p));
  const prices = plans.map((p) => p.monthlyUSD).filter((p): p is number => p !== null);
  const exact = plans.length === 1 ? plans[0] : undefined;
  const subscription: Subscription = { planId: "auto", billing: saved?.billing ?? "monthly", overrideUSD: saved?.overrideUSD };
  const price = saved?.overrideUSD ?? (exact ? monthlyPrice(tool, { ...subscription, planId: exact.id }) : null);
  return {
    name: exact?.name ?? `${tool === "codex" ? "ChatGPT" : tool === "claude-code" ? "Claude" : "Account"} ${detected.planType}`,
    monthlyUSD: price,
    automatic: true,
    range: price === null && prices.length === plans.length && prices.length > 1 ? [Math.min(...prices), Math.max(...prices)] as const : null,
    subscription,
  };
}
