import type { CSSProperties } from "react";
import { formatPercent, formatTokens } from "@/lib/format";

// One violet ordinal ramp, kept off the tool hues; validated with the dataviz checker (>=3:1 on surface, both modes).
const PARTS = [
  { key: "inputTokens", label: "Input", color: "light-dark(#8f83ea, #6a5ad9)" },
  { key: "outputTokens", label: "Output", color: "light-dark(#6f61dc, #8679e4)" },
  { key: "cacheWriteTokens", label: "Cache write", color: "light-dark(#5040c4, #a69ded)" },
  { key: "cacheReadTokens", label: "Cache read", color: "light-dark(#35288a, #c8c2f6)" },
] as const;

export interface TokenCompositionProps {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
}

export function TokenComposition(props: TokenCompositionProps) {
  const total = PARTS.reduce((s, p) => s + props[p.key], 0);
  if (total <= 0) return <p className="text-sm text-fg-3">No tokens in this range.</p>;
  const parts = PARTS.map((p) => ({ ...p, value: props[p.key], share: props[p.key] / total }));
  const summary = parts.map((p) => `${p.label} ${formatTokens(p.value)} (${formatPercent(p.share)})`).join(", ");

  return (
    <div>
      <div role="img" aria-label={`Token composition: ${summary}`} className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
        {parts.map((p) =>
          p.value > 0 ? (
            <div
              key={p.key}
              title={`${p.label}: ${formatTokens(p.value)} (${formatPercent(p.share)})`}
              className="h-full min-w-0.5 first:rounded-s-full last:rounded-e-full"
              style={{ flexGrow: p.value, flexBasis: 0, background: p.color }}
            />
          ) : null,
        )}
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 sm:grid-cols-2 lg:grid-cols-4 gap-y-2 text-xs">
        {parts.map((p) => (
          <div key={p.key} className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className="tool-swatch shrink-0" style={{ "--swatch": p.color } as CSSProperties} />
            <dt className="truncate text-fg-2">{p.label}</dt>
            <dd className="ms-auto flex items-baseline gap-1.5">
              <span className="tabular font-medium text-fg">{formatTokens(p.value)}</span>
              <span className="tabular w-11 text-end text-fg-3">{formatPercent(p.share)}</span>
            </dd>
          </div>
        ))}
      </dl>
      {props.reasoningTokens > 0 && (
        <p className="mt-2 text-xs text-fg-3">
          Output includes <span className="tabular">{formatTokens(props.reasoningTokens)}</span> reasoning tokens.
        </p>
      )}
    </div>
  );
}
