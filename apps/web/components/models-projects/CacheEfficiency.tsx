import type { CacheEfficiency } from "@clausage/core";
import { DataTable, type DataColumn, type DataRow } from "@/components/charts/DataTable";
import { ModelOrgIcon } from "@/components/icons/BrandIcon";
import { Panel } from "@/components/Panel";
import { formatCost, formatPercent, formatTokens } from "@/lib/format";
import { toolColor } from "@/lib/tools";

/** Share of prompt tokens served from cache, as a meter plus the percentage. */
function HitCell({ rate, color }: { rate: number; color: string }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span aria-hidden="true" className="h-2 w-16 overflow-hidden rounded-[2px] bg-surface-2">
        <span className="block h-full rounded-e-[2px]" style={{ width: `${Math.max(rate > 0 ? 1 : 0, Math.min(100, rate * 100))}%`, background: color }} />
      </span>
      <span className="w-12 text-end">{formatPercent(rate)}</span>
    </span>
  );
}

function saved(usd: number): string {
  return usd < 0 ? `−${formatCost(-usd)}` : formatCost(usd);
}

const columns: DataColumn[] = [
  { key: "model", header: "Model" },
  { key: "prompt", header: "Prompt tokens", numeric: true, hideBelow: "md" },
  { key: "hit", header: "Cache hit", numeric: true },
  { key: "write", header: "Cache write", numeric: true, hideBelow: "lg" },
  { key: "uncached", header: "Cost uncached", numeric: true, hideBelow: "xl" },
  { key: "cost", header: "Cost", numeric: true, hideBelow: "sm" },
  { key: "saved", header: "Saved", numeric: true },
];

/**
 * Prompt caching per model: how much of each prompt was read from cache, and what that saved
 * compared with sending every prompt token as uncached input (net of cache-write premiums).
 */
export function CacheEfficiencyPanel({ rows, total }: { rows: CacheEfficiency[]; total?: CacheEfficiency }) {
  if (!total || total.promptTokens === 0) return null;
  const data: DataRow[] = rows.map((r) => ({
    id: r.key,
    cells: {
      model: (
        <span className="flex min-w-0 items-center gap-1.5">
          <ModelOrgIcon model={r.key} size="0.875rem" />
          <span className="truncate font-mono text-xs" title={r.key}>
            {r.key || "(unknown)"}
          </span>
        </span>
      ),
      prompt: formatTokens(r.promptTokens),
      hit: <HitCell rate={r.hitRate} color={toolColor(r.tools[0]!)} />,
      write: formatPercent(r.writeRate),
      uncached: r.uncachedCostUSD > 0 ? formatCost(r.uncachedCostUSD) : "—",
      cost: r.costUSD > 0 ? formatCost(r.costUSD) : "—",
      saved: r.uncachedCostUSD > 0 ? <span className={r.savedUSD < 0 ? "text-warning" : undefined}>{saved(r.savedUSD)}</span> : <span className="text-fg-3">no price</span>,
    },
    sort: { model: r.key, prompt: r.promptTokens, hit: r.hitRate, write: r.writeRate, uncached: r.uncachedCostUSD, cost: r.costUSD, saved: r.savedUSD },
  }));
  const pct = total.uncachedCostUSD > 0 ? total.savedUSD / total.uncachedCostUSD : null;
  return (
    <Panel
      title="Prompt cache"
      description={
        <>
          {formatPercent(total.hitRate)} of {formatTokens(total.promptTokens)} prompt tokens came from cache
          {total.uncachedCostUSD > 0 && (
            <>
              {" "}
              · caching saved {saved(total.savedUSD)}
              {pct !== null && ` (${formatPercent(pct)} of the uncached cost)`}
            </>
          )}
          . List prices; cache-write premiums are subtracted.
        </>
      }
    >
      <DataTable
        caption="Prompt-cache hit rate and savings per model"
        columns={columns}
        rows={data}
        defaultSort={{ key: "prompt", dir: "desc" }}
        maxHeight="24rem"
        footer={{
          model: "All models",
          prompt: formatTokens(total.promptTokens),
          hit: formatPercent(total.hitRate),
          write: formatPercent(total.writeRate),
          uncached: formatCost(total.uncachedCostUSD),
          cost: formatCost(total.costUSD),
          saved: saved(total.savedUSD),
        }}
      />
    </Panel>
  );
}
