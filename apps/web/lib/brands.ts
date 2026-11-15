import type { ToolId } from "@clausage/core";
import type { BrandId } from "@/components/icons/brand-svgs";

/** Tool marks from lobe-icons; a tool without one (Aider) gets a letter mark. */
export const TOOL_BRANDS: Partial<Record<ToolId, BrandId>> = {
  "claude-code": "claude",
  codex: "codex",
  grok: "grok",
  opencode: "opencode",
  hermes: "hermes",
  openclaw: "openclaw",
  pi: "pi",
  gemini: "geminicli",
  amp: "amp",
  qwen: "qwen",
  copilot: "githubcopilot",
};

export type OrgId =
  | "anthropic"
  | "openai"
  | "xai"
  | "google"
  | "deepseek"
  | "qwen"
  | "moonshot"
  | "zai"
  | "mistral"
  | "meta"
  | "minimax"
  | "nous"
  | "openrouter";

export const ORG_LABELS: Record<OrgId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  google: "Google",
  deepseek: "DeepSeek",
  qwen: "Qwen (Alibaba)",
  moonshot: "Moonshot AI",
  zai: "Z.ai",
  mistral: "Mistral AI",
  meta: "Meta",
  minimax: "MiniMax",
  nous: "Nous Research",
  openrouter: "OpenRouter",
};

// Model-name patterns, checked after any "provider/" prefix is stripped.
const MODEL_PATTERNS: Array<[RegExp, OrgId]> = [
  [/^(claude|anthropic)|(^|[-.])(opus|sonnet|haiku|fable)([-.]|$)/, "anthropic"],
  [/^(gpt|o\d|chatgpt|codex|text-|davinci|openai)/, "openai"],
  [/^grok/, "xai"],
  [/^(gemini|gemma|palm|bison)/, "google"],
  [/^deepseek/, "deepseek"],
  [/^(qwen|qwq)/, "qwen"],
  [/^(kimi|moonshot)/, "moonshot"],
  [/^(glm|chatglm|zai)/, "zai"],
  [/^(mistral|mixtral|codestral|devstral|magistral|ministral|pixtral)/, "mistral"],
  [/^(llama|meta)/, "meta"],
  [/^(minimax|abab)/, "minimax"],
  [/^hermes/, "nous"],
];

const PROVIDER_ORGS: Record<string, OrgId> = {
  anthropic: "anthropic",
  openai: "openai",
  "azure-openai": "openai",
  xai: "xai",
  google: "google",
  gemini: "google",
  "vertex-ai": "google",
  deepseek: "deepseek",
  alibaba: "qwen",
  dashscope: "qwen",
  qwen: "qwen",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  zai: "zai",
  "z-ai": "zai",
  zhipu: "zai",
  mistral: "mistral",
  "meta-llama": "meta",
  meta: "meta",
  minimax: "minimax",
  nousresearch: "nous",
  nous: "nous",
};

/**
 * The organisation behind a model, from its name (and the tool-reported provider as a fallback).
 * Router-style names ("openrouter/anthropic/claude-…", "bedrock/…") resolve to the model's maker.
 */
export function modelOrg(model: string, provider?: string): OrgId | undefined {
  const parts = model.toLowerCase().split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const name = parts[i]!.replace(/^(us|eu|apac|global)\./, "").replace(/^(anthropic|meta|mistral|deepseek|qwen)\./, "$1-");
    for (const [re, org] of MODEL_PATTERNS) if (re.test(name)) return org;
    const asProvider = PROVIDER_ORGS[name];
    if (asProvider) return asProvider;
  }
  const p = provider?.toLowerCase();
  if (p && PROVIDER_ORGS[p]) return PROVIDER_ORGS[p];
  if (p === "openrouter" || parts[0] === "openrouter") return "openrouter";
  return undefined;
}
