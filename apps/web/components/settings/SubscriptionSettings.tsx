"use client";

import { Input } from "@ui-sdk/react/input";
import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue } from "@ui-sdk/react/select";
import { setSubscription, useSubscriptions } from "@/lib/subscription-store";
import { findPlan, resolveSubscription, SUBSCRIPTION_PLANS, SUBSCRIPTION_PRICES_CHECKED, type DetectedSubscriptions, type Subscription } from "@/lib/subscriptions";
import { TOOL_IDS, TOOL_LABELS } from "@/lib/tools";
import { formatCost } from "@/lib/format";
import { SettingRow } from "./SettingRow";

export function SubscriptionSettings({ detected = {} }: { detected?: DetectedSubscriptions }) {
  const subscriptions = useSubscriptions();
  return (
    <>
      <p className="settings-note text-fg-3">
        Plans are detected automatically from the same account metadata used by Blocks & limits. US list prices in USD, checked {SUBSCRIPTION_PRICES_CHECKED}; annual prices are divided by 12.
        Override the monthly cost for tax, discounts, regional pricing, or extra usage. Saved in this browser.
      </p>
      {TOOL_IDS.map((tool) => {
        const sub: Subscription = subscriptions[tool] ?? { planId: "auto", billing: "monthly" };
        const account = detected[tool];
        const resolved = resolveSubscription(tool, sub, account);
        const plan = findPlan(tool, sub.planId === "auto" && account?.planIds.length === 1 ? account.planIds[0] : sub.planId);
        const active = sub.planId !== "none" && (sub.planId !== "auto" || Boolean(account));
        const plans = SUBSCRIPTION_PLANS[tool] ?? [];
        const items = [
          { value: "auto", label: `Automatic${account ? ` · ${resolved?.name ?? account.planType}` : " · no plan reported"}` },
          { value: "none", label: "Not subscribed / API billing" },
          ...plans.map((p) => ({ value: p.id, label: `${p.name} · ${p.monthlyUSD === null ? "Custom pricing" : `${formatCost(p.monthlyUSD)}/mo`}` })),
          { value: "custom", label: "Custom subscription" },
        ];
        const price = resolved?.monthlyUSD ?? null;
        return (
          <SettingRow key={tool} title={TOOL_LABELS[tool]} stacked description={
            <>
              {sub.planId === "auto" && account ? `Detected plan: ${account.planType}. ${resolved?.range ? "The provider did not report the exact paid tier; showing a price and value range." : "Using this plan’s list price automatically."}` : plan?.note ?? (plans.length ? "Select the plan covering this tool’s logged usage." : "Uses your model provider’s billing. Enter a subscription only if it covers this tool.")}
              {plan && <> <a href={plan.source} target="_blank" rel="noreferrer" className="underline underline-offset-2">Official pricing ↗</a></>}
            </>
          }>
            <div className="flex w-full flex-wrap items-center gap-2">
              <Select items={items} value={sub.planId} onValueChange={(id) => {
                if (!id) return;
                setSubscription(tool, id === "auto" ? undefined : { planId: id, billing: "monthly" });
              }}>
                <SelectTrigger aria-label={`${TOOL_LABELS[tool]} subscription`} className="min-w-0 max-w-full sm:min-w-72"><SelectValue /></SelectTrigger>
                <SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}<SelectItemIndicator /></SelectItem>)}</SelectContent>
              </Select>
              {active && <>
                {plan?.annualUSD !== undefined && <Select
                  items={[{ value: "monthly", label: "Monthly billing" }, { value: "annual", label: `Annual · ${formatCost(plan.annualUSD)}/yr` }]}
                  value={sub.billing}
                  onValueChange={(billing) => { if (billing === "annual" || billing === "monthly") setSubscription(tool, { ...sub, billing }); }}
                >
                  <SelectTrigger aria-label={`${TOOL_LABELS[tool]} billing`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="monthly">Monthly billing<SelectItemIndicator /></SelectItem><SelectItem value="annual">Annual · {formatCost(plan.annualUSD)}/yr<SelectItemIndicator /></SelectItem></SelectContent>
                </Select>}
                <label className="flex items-center gap-2 text-xs text-fg-2">
                  USD/month
                  <Input
                    aria-label={`${TOOL_LABELS[tool]} monthly cost override`}
                    className="w-28"
                    type="number" min="0" step="0.01"
                    placeholder={price === null ? "Required" : String(Number(price.toFixed(2)))}
                    value={sub.overrideUSD === undefined ? "" : String(sub.overrideUSD)}
                    onValueChange={(value) => {
                      if (value === "") setSubscription(tool, { ...sub, overrideUSD: undefined });
                      else if (Number.isFinite(Number(value)) && Number(value) >= 0) setSubscription(tool, { ...sub, overrideUSD: Number(value) });
                    }}
                  />
                </label>
                <span className="text-xs text-fg-3">{price === null ? "Enter your monthly cost to compare." : `${formatCost(price)}/month used for comparison`}</span>
              </>}
            </div>
          </SettingRow>
        );
      })}
      <p className="settings-note text-fg-3">Only assign subscription-covered usage. Logs can also contain API-key or extra paid usage; clausage cannot separate those automatically. Shared subscriptions across tools should be entered once to avoid counting the fee twice.</p>
    </>
  );
}
