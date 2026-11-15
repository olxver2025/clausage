import type { ModelBreakdown, ModelPricing } from "@clausage/core";
import { formatCost, formatNumber, formatTokens } from "@/lib/format";
import { TOOL_LABELS } from "@/lib/tools";
import { formatRate } from "./cells";

export function hasFastUsage(parts: ModelBreakdown[]) {
  return parts.some((part) => part.events > 0 && (part.speed === "fast" || part.speed === "ultrafast"));
}

const labels: Record<string, string> = { standard: "Standard", fast: "Fast", ultrafast: "Ultrafast", flex: "Flex" };
const order = ["standard", "fast", "ultrafast", "flex"];

export function modeDetails(model: string, parts: ModelBreakdown[], priceFor?: (part: ModelBreakdown) => ModelPricing | null) {
  if (!hasFastUsage(parts)) return undefined;
  const multiTool = new Set(parts.map((part) => part.tool)).size > 1;
  const rank = (speed?: string) => speed && order.includes(speed) ? order.indexOf(speed) : order.length;
  const sorted = [...parts].sort((a, b) => rank(a.speed) - rank(b.speed) || a.tool.localeCompare(b.tool));
  return {
    label: `Usage by mode for ${model}`,
    content: (
      <div className="overflow-x-auto px-3 py-2">
        <table className="w-full text-xs tabular">
          <caption className="sr-only">{model} usage by mode</caption>
          <thead className="text-fg-2"><tr>
            {["Mode", ...(multiTool ? ["Tool"] : []), "Requests", "Tokens", "Cost", ...(priceFor ? ["Input / 1M", "Output / 1M"] : [])].map((name, i) =>
              <th key={name} scope="col" className={`whitespace-nowrap px-2 py-1 font-medium ${i === 0 || name === "Tool" ? "text-start" : "text-end"}`}>{name}</th>)}
          </tr></thead>
          <tbody>{sorted.map((part) => {
            const price = priceFor?.(part);
            return <tr key={JSON.stringify([part.tool, part.speed])} className="border-t border-line">
              <th scope="row" className="px-2 py-1.5 text-start font-medium">{part.speed ? labels[part.speed] ?? part.speed : "Unreported"}</th>
              {multiTool && <td className="px-2">{TOOL_LABELS[part.tool]}</td>}
              <td className="px-2 text-end">{formatNumber(part.events)}</td>
              <td className="px-2 text-end" title={formatNumber(part.totalTokens)}>{formatTokens(part.totalTokens)}</td>
              <td className="px-2 text-end">{formatCost(part.costUSD)}</td>
              {priceFor && <><td className="px-2 text-end">{formatRate(price ? price.input * 1e6 : undefined)}</td>
                <td className="px-2 text-end">{formatRate(price ? price.output * 1e6 : undefined)}</td></>}
            </tr>;
          })}</tbody>
        </table>
      </div>
    ),
  };
}
