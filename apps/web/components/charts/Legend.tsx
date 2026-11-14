import type { ToolId } from "@clausage/core";
import { TOOL_LABELS, toolColor } from "@/lib/tools";

export interface LegendProps {
  tools: readonly ToolId[];
  /** "bar" draws square swatches, "line" short strokes, matching the marks */
  shape?: "bar" | "line";
  className?: string;
}

export function Legend({ tools, shape = "bar", className = "" }: LegendProps) {
  if (tools.length < 2) return null;
  return (
    <ul aria-label="Legend" className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2 ${className}`}>
      {tools.map((t) => (
        <li key={t} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={shape === "line" ? "tool-line-key" : "tool-swatch"} style={{ "--swatch": toolColor(t) } as React.CSSProperties} />
          {TOOL_LABELS[t]}
        </li>
      ))}
    </ul>
  );
}

export function ToolDot({ tool, shape = "bar" }: { tool: ToolId; shape?: "bar" | "line" }) {
  return <span aria-hidden="true" className={shape === "line" ? "tool-line-key" : "tool-swatch"} style={{ "--swatch": toolColor(tool) } as React.CSSProperties} />;
}

export function ToolName({ tool }: { tool: ToolId }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <ToolDot tool={tool} />
      {TOOL_LABELS[tool]}
    </span>
  );
}
