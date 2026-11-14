import { getSourcesSummary } from "@/lib/data";
import { formatRelative } from "@/lib/format";
import { TOOL_IDS, TOOL_LABELS } from "@/lib/tools";
import { DetailsDialog } from "./DetailsDialog";

const PRICING_LABELS = { live: "downloaded now", cache: "cached", embedded: "embedded snapshot" } as const;

export async function SourcesFooter() {
  let summary;
  try {
    summary = await getSourcesSummary();
  } catch (err) {
    return <p className="text-xs text-critical">Could not read usage data: {(err as Error).message}</p>;
  }
  const { sources, pricing, warnings, loadedAt, timezone } = summary;
  const found = TOOL_IDS.filter((t) => sources[t]?.length);
  const pricingText = `LiteLLM prices, ${PRICING_LABELS[pricing.source]}${pricing.fetchedAt ? ` (${formatRelative(pricing.fetchedAt, loadedAt)})` : ""}`;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-3">
      <span>
        Sources:{" "}
        {found.length ? found.map((t) => `${TOOL_LABELS[t]} (${sources[t].length})`).join(", ") : "none found"}
      </span>
      <span>{pricingText}</span>
      <span>Timezone: {timezone}</span>
      <DetailsDialog
        warnings={warnings}
        sources={TOOL_IDS.map((t) => ({ tool: t, label: TOOL_LABELS[t], dirs: sources[t] ?? [] }))}
        pricing={pricingText}
        models={pricing.models}
      />
    </div>
  );
}

export function SourcesFooterFallback() {
  return <p className="text-xs text-fg-3">Scanning local logs…</p>;
}
