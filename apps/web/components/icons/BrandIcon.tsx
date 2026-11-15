import type { ToolId } from "@clausage/core";
import type { CSSProperties } from "react";
import { modelOrg, ORG_LABELS, TOOL_BRANDS, type OrgId } from "@/lib/brands";
import { toolColor, toolLabel } from "@/lib/tools";
import { BRAND_SVGS, type BrandId } from "./brand-svgs";

export interface BrandIconProps {
  brand: BrandId;
  /** accessible name; leave out when a visible label sits next to the icon */
  label?: string;
  /** CSS size, default 1em */
  size?: string | number;
  color?: string;
  className?: string;
}

/** A monochrome brand mark (static, trusted SVG from brand-svgs.ts) drawn in currentColor. */
export function BrandIcon({ brand, label, size, color, className = "" }: BrandIconProps) {
  const svg = BRAND_SVGS[brand];
  const style: CSSProperties = { ...(size !== undefined ? { width: size, height: size } : {}), ...(color ? { color } : {}) };
  return (
    <svg
      viewBox={svg.viewBox}
      fill="currentColor"
      fillRule="evenodd"
      className={`brand-icon ${className}`}
      style={style}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      dangerouslySetInnerHTML={{ __html: svg.body }}
    />
  );
}

/** The tool's mark, in the tool's chart colour unless `color` says otherwise. */
export function ToolIcon({ tool, label, size, color, className }: { tool: ToolId; label?: boolean | string; size?: string | number; color?: string; className?: string }) {
  const name = label === true ? toolLabel(tool) : label || undefined;
  const brand = TOOL_BRANDS[tool];
  if (!brand) return <LetterMark letter={toolLabel(tool).charAt(0)} label={name} size={size} color={color ?? toolColor(tool)} className={className} />;
  return <BrandIcon brand={brand} label={name} size={size} color={color ?? toolColor(tool)} className={className} />;
}

/** Fallback for a tool with no lobe-icons mark: its initial in a rounded square, in currentColor. */
function LetterMark({ letter, label, size, color, className = "" }: { letter: string; label?: string; size?: string | number; color?: string; className?: string }) {
  const style: CSSProperties = { ...(size !== undefined ? { width: size, height: size } : {}), ...(color ? { color } : {}) };
  return (
    <svg
      viewBox="0 0 24 24"
      className={`brand-icon ${className}`}
      style={style}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <rect x="2" y="2" width="20" height="20" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="12" y="16.5" textAnchor="middle" fontSize="13" fontWeight="700" fill="currentColor" fontFamily="ui-sans-serif, system-ui, sans-serif">
        {letter.toUpperCase()}
      </text>
    </svg>
  );
}

/** The model provider's mark (Anthropic, OpenAI, xAI, Google…); nothing for unknown providers. */
export function ModelOrgIcon({ model, provider, size, className }: { model: string; provider?: string; size?: string | number; className?: string }) {
  const org = modelOrg(model, provider);
  if (!org) return null;
  return (
    <span className="inline-flex text-fg-2" title={ORG_LABELS[org]}>
      <BrandIcon brand={ORG_BRANDS[org]} color={ORG_COLORS[org]} label={ORG_LABELS[org]} size={size} className={className} />
    </span>
  );
}

const ORG_BRANDS: Record<OrgId, BrandId> = {
  anthropic: "claude",
  openai: "openai",
  xai: "xai",
  google: "gemini",
  deepseek: "deepseek",
  qwen: "qwen",
  moonshot: "kimi",
  zai: "zai",
  mistral: "mistral",
  meta: "meta",
  minimax: "minimax",
  nous: "nousresearch",
  openrouter: "openrouter",
};

const ORG_COLORS: Record<OrgId, string> = {
  anthropic: "var(--tool-claude-code)", openai: "light-dark(#087e63, #45bb96)",
  xai: "var(--tool-grok)", google: "light-dark(#356ac3, #81aaff)",
  deepseek: "light-dark(#435de0, #92a1ff)", qwen: "light-dark(#6e4bc3, #b19aff)",
  moonshot: "light-dark(#3569c5, #84adff)", zai: "light-dark(#4055ac, #92a4ff)",
  mistral: "light-dark(#b95013, #ffa660)", meta: "light-dark(#1769b6, #71b8ff)",
  minimax: "light-dark(#bd435a, #ff91a3)", nous: "var(--tool-hermes)",
  openrouter: "light-dark(#47728a, #94bdcf)",
};
