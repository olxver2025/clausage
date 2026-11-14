import type { ToolId } from "@clausage/core";

export const TOOL_IDS = ["claude-code", "codex", "grok", "opencode"] as const satisfies readonly ToolId[];

export const TOOL_LABELS: Record<ToolId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  opencode: "OpenCode",
};

export const TOOL_SHORT_LABELS: Record<ToolId, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
};

export const TOOL_COLOR_VARS: Record<ToolId, string> = {
  "claude-code": "--tool-claude-code",
  codex: "--tool-codex",
  grok: "--tool-grok",
  opencode: "--tool-opencode",
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
};

export function parseToolId(value: string): ToolId | undefined {
  return ALIASES[value.trim().toLowerCase()];
}

export function toolLabel(tool: string): string {
  return isToolId(tool) ? TOOL_LABELS[tool] : tool;
}
