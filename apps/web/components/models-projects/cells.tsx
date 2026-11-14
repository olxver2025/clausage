import type { ToolId } from "@clausage/core";
import type { ReactNode } from "react";
import { ToolDot } from "@/components/charts/Legend";
import { formatPercent } from "@/lib/format";
import { TOOL_IDS, TOOL_LABELS, TOOL_SHORT_LABELS, toolColor } from "@/lib/tools";

export function ShareCell({ share, tool }: { share: number; tool: ToolId }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span aria-hidden="true" className="h-2 w-16 overflow-hidden rounded-[2px] bg-surface-2">
        <span className="block h-full rounded-e-[2px]" style={{ width: `${Math.max(1, Math.min(100, share * 100))}%`, background: toolColor(tool) }} />
      </span>
      <span className="w-12 text-end">{formatPercent(share)}</span>
    </span>
  );
}

export function Badge({ children, tone = "warning", title }: { children: ReactNode; tone?: "warning" | "neutral"; title?: string }) {
  const color = tone === "warning" ? "border-warning text-warning" : "border-line-strong text-fg-2";
  return (
    <span title={title} className={`inline-flex items-center rounded-[4px] border px-1.5 py-px text-[0.6875rem] font-medium leading-4 whitespace-nowrap ${color}`}>
      {children}
    </span>
  );
}

export function ToolChips({ tools }: { tools: readonly ToolId[] }) {
  const ordered = TOOL_IDS.filter((t) => tools.includes(t));
  return (
    <ul aria-label="Tools" className="flex flex-wrap gap-1">
      {ordered.map((t) => (
        <li key={t} title={TOOL_LABELS[t]} className="inline-flex items-center gap-1 rounded-[4px] border border-line bg-surface-2 px-1.5 py-px text-[0.6875rem] leading-4 text-fg-2">
          <ToolDot tool={t} />
          {TOOL_SHORT_LABELS[t]}
        </li>
      ))}
    </ul>
  );
}

export function formatRate(usdPerMillion: number | undefined): string {
  if (usdPerMillion === undefined || !Number.isFinite(usdPerMillion)) return "—";
  if (usdPerMillion === 0) return "$0";
  const digits = usdPerMillion < 1 ? 3 : 2;
  return `$${usdPerMillion.toFixed(digits).replace(/\.?0+$/, "")}`;
}
