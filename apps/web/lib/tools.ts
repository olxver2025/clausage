import type { ToolId } from "@clausage/core";

export const TOOL_IDS = [
  "claude-code",
  "codex",
  "grok",
  "opencode",
  "hermes",
  "openclaw",
  "pi",
  "gemini",
  "amp",
  "qwen",
  "copilot",
  "aider",
] as const satisfies readonly ToolId[];

export const TOOL_LABELS: Record<ToolId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  opencode: "OpenCode",
  hermes: "Hermes Agent",
  openclaw: "OpenClaw",
  pi: "Pi",
  gemini: "Gemini CLI",
  amp: "Amp",
  qwen: "Qwen Code",
  copilot: "Copilot CLI",
  aider: "Aider",
};

export const TOOL_SHORT_LABELS: Record<ToolId, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  pi: "Pi",
  gemini: "Gemini",
  amp: "Amp",
  qwen: "Qwen",
  copilot: "Copilot",
  aider: "Aider",
};

export const TOOL_COLOR_VARS: Record<ToolId, string> = {
  "claude-code": "--tool-claude-code",
  codex: "--tool-codex",
  grok: "--tool-grok",
  opencode: "--tool-opencode",
  hermes: "--tool-hermes",
  openclaw: "--tool-openclaw",
  pi: "--tool-pi",
  gemini: "--tool-gemini",
  amp: "--tool-amp",
  qwen: "--tool-qwen",
  copilot: "--tool-copilot",
  aider: "--tool-aider",
};

export function toolColor(tool: ToolId): string {
  return `var(${TOOL_COLOR_VARS[tool]})`;
}

export function isToolId(value: unknown): value is ToolId {
  return typeof value === "string" && (TOOL_IDS as readonly string[]).includes(value);
}

const ALIASES: Record<string, ToolId> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  cc: "claude-code",
  codex: "codex",
  grok: "grok",
  "grok-build": "grok",
  opencode: "opencode",
  oc: "opencode",
  hermes: "hermes",
  "hermes-agent": "hermes",
  openclaw: "openclaw",
  clawdbot: "openclaw",
  moltbot: "openclaw",
  pi: "pi",
  "pi-agent": "pi",
  gemini: "gemini",
  "gemini-cli": "gemini",
  amp: "amp",
  ampcode: "amp",
  qwen: "qwen",
  "qwen-code": "qwen",
  copilot: "copilot",
  "copilot-cli": "copilot",
  "github-copilot": "copilot",
  aider: "aider",
};

export function parseToolId(value: string): ToolId | undefined {
  return ALIASES[value.trim().toLowerCase()];
}

export function toolLabel(tool: string): string {
  return isToolId(tool) ? TOOL_LABELS[tool] : tool;
}
