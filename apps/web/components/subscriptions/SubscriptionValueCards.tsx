"use client";

import Link from "next/link";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/react/popover";
import { Panel } from "@/components/Panel";
import { Ticker } from "@/components/charts/Ticker";
import { ToolIcon } from "@/components/icons/BrandIcon";
import { formatCost } from "@/lib/format";
import { useSubscriptions } from "@/lib/subscription-store";
import { resolveSubscription, subscriptionValue, type DetectedSubscriptions } from "@/lib/subscriptions";
import { TOOL_LABELS } from "@/lib/tools";
import type { ValueUsage } from "@/lib/subscription-usage";

const multiple = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });

export function SubscriptionValueCards({ usage, today, filtered, pricingSource, detected = {} }: { detected?: DetectedSubscriptions; usage: ValueUsage[]; today: string; filtered: boolean; pricingSource: string }) {
  const subscriptions = useSubscriptions();
  const selected = usage.flatMap((u) => {
    const resolved = resolveSubscription(u.tool, subscriptions[u.tool], detected[u.tool]);
    return resolved ? [{ ...u, resolved }] : [];
  });
  return (
    <Panel
      title="Your money’s worth"
      description={`Month to date · ${today}`}
      actions={<Link href="/settings#subscriptions" className="text-xs text-fg-2 underline-offset-2 hover:text-fg hover:underline">Subscriptions <span aria-hidden="true">→</span></Link>}
    >
      {selected.length === 0 ? (
        <p className="py-2 text-xs text-fg-3">No subscription was reported for these tools. Set a fallback in <Link href="/settings#subscriptions" className="text-fg-2 underline underline-offset-2">Settings</Link> to compare your usage with a monthly fee.</p>
      ) : (
        <div className="divide-y divide-line">
          {selected.map((u) => {
            const { resolved } = u;
            const sub = resolved.subscription;
            const fee = resolved.monthlyUSD;
            const value = fee === null ? null : subscriptionValue(u.monthUSD, fee);
            const range = resolved.range;
            return (
              <article key={u.tool} aria-label={resolved.name} className="py-3 first:pt-1 last:pb-1">
                <div className="grid gap-4 lg:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)] lg:items-center">
                  <div className="min-w-0">
                    <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                      <ToolIcon tool={u.tool} size="1rem" />
                      <span className="truncate">{resolved.name}</span>
                    </h3>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
                      <span className="tabular">{fee === null ? (range ? `${formatCost(range[0])}–${formatCost(range[1])}/month · exact tier not reported` : "Monthly price not reported; set a price override in Settings") : `${formatCost(fee)}/month${sub.billing === "annual" ? " · annual billing averaged" : ""}`}</span>
                      {resolved.automatic && <span className="rounded border border-line px-1 py-px text-[0.625rem] leading-tight">
                        <span aria-hidden="true">{sub.overrideUSD !== undefined ? "Price adjusted" : "Auto-detected"}</span>
                        <span className="sr-only">Detected from {TOOL_LABELS[u.tool]} account metadata</span>
                      </span>}
                    </div>
                  </div>
                  <dl className="grid grid-cols-3 gap-3 sm:gap-6">
                    <div className="min-w-0">
                      <dt className="min-h-9 text-xs text-fg-3 sm:min-h-0">Inference today</dt>
                      <dd className="figure mt-1 text-base font-semibold leading-tight sm:text-xl"><Ticker value={u.todayUSD} format="costCompact" /></dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="min-h-9 text-xs text-fg-3 sm:min-h-0">Inference this month</dt>
                      <dd className="figure mt-1 text-base font-semibold leading-tight sm:text-xl"><Ticker value={u.monthUSD} format="costCompact" /></dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="min-h-9 text-xs text-fg-3 sm:min-h-0">Value / monthly fee</dt>
                      <dd className={`figure mt-1 text-base font-semibold leading-tight sm:text-xl ${value?.multiple != null && value.multiple >= 1 ? "text-good" : "text-fg"}`}>
                        <span aria-hidden="true">{value?.multiple != null ? `${multiple(value.multiple)}×` : range ? `${multiple(u.monthUSD / range[1])}–${multiple(u.monthUSD / range[0])}×` : "—"}</span>
                        {value && <span className="sr-only">{value.multiple === null ? "No subscription fee" : `${multiple(value.multiple)}× your monthly fee in inference`}</span>}
                        {range && <span className="sr-only">{multiple(u.monthUSD / range[1])}–{multiple(u.monthUSD / range[0])}× your monthly fee · tier-dependent</span>}
                      </dd>
                      {value && fee !== null && fee > 0 && <p className="mt-1 text-[0.6875rem] text-fg-3">
                        <span aria-hidden="true">{value.differenceUSD >= 0 ? `${formatCost(value.differenceUSD)} above fee` : `${formatCost(-value.differenceUSD)} to break even`}</span>
                        <span className="sr-only">{value.differenceUSD >= 0 ? `${formatCost(value.differenceUSD)} above your full monthly fee` : `${formatCost(-value.differenceUSD)} of inference to cover your full monthly fee`}</span>
                      </p>}
                    </div>
                  </dl>
                </div>
                {(u.unpriced > 0 || u.estimated) && <p className="mt-2 text-xs text-warning">{u.unpriced > 0 ? `${u.unpriced} requests have no known price; value is understated. ` : ""}{u.estimated ? "Includes estimated historical usage." : ""}</p>}
              </article>
            );
          })}
        </div>
      )}
      <footer className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-2 text-[0.6875rem] text-fg-3">
        <p>API-equivalent estimate · compared with your full monthly fee{filtered ? " · this is only part of your usage" : ""}</p>
        <Popover>
          <PopoverTrigger className="text-[0.6875rem] text-fg-3 underline-offset-2 hover:text-fg hover:underline" data-variant="ghost">How it’s calculated</PopoverTrigger>
          <PopoverContent className="max-w-sm p-3 text-xs text-fg-2">
            <PopoverTitle className="mb-2 text-sm font-semibold text-fg">About this comparison</PopoverTitle>
            <p className="leading-relaxed">Estimated from logged tokens at model API rates ({pricingSource} prices), regardless of the dashboard cost mode or date range. The full monthly fee is used even partway through the month.</p>
            <p className="mt-2 leading-relaxed">This is a price comparison, not actual savings or provider costs. Chat, images and other unlogged benefits are excluded. API-key and extra paid usage may be included in logs.</p>
          </PopoverContent>
        </Popover>
      </footer>
    </Panel>
  );
}
