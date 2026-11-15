import { getUsage, getDetectedSubscriptions } from "@/lib/data";
import { todayIn, type Filters } from "@/lib/filters";
import { SubscriptionValueCards } from "./SubscriptionValueCards";
import { TOOL_IDS } from "@/lib/tools";
import { valueUsage } from "@/lib/subscription-usage";

export async function SubscriptionValue({ filters, now }: { filters: Filters; now: number }) {
  const today = todayIn(filters.tz, now);
  const month = today.slice(0, 7);
  const [data, detected] = await Promise.all([
    getUsage({ ...filters, range: "custom", since: `${month}-01`, until: today, mode: "calculate" }),
    getDetectedSubscriptions(),
  ]);
  const usage = valueUsage(data.events, data.historical, TOOL_IDS.filter((tool) => filters.tools.includes(tool)), today, data.timezone);
  return <SubscriptionValueCards detected={detected} usage={usage} today={today} filtered={Boolean(filters.project || filters.machines.length || !filters.subagents)} pricingSource={data.pricing.source} />;
}
