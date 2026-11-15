"use client";

import { createAgent, registerTools } from "@ui-sdk/react/agent";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { COST_MODES, GROUPS, RANGE_PRESETS, type FilterPatch } from "@/lib/filters";
import { TOOL_IDS, parseToolId } from "@/lib/tools";
import { FILTER_KEYS, useFilters } from "./navigation";

export const REPORT_KINDS = ["daily", "weekly", "monthly", "session", "blocks", "models", "projects", "tools", "sources", "limits"] as const;

interface ModelContextTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: Record<string, unknown>) => unknown;
}

interface ModelContext {
  registerTool: (tool: ModelContextTool, options?: { signal?: AbortSignal }) => Promise<unknown>;
}

type Agent = ReturnType<typeof createAgent>;

let bridge: Agent | undefined;

/** The page's one ui-sdk agent bridge, created in the browser on first use. */
export function getAgent(): Agent {
  bridge ??= createAgent();
  return bridge;
}

/** Turns loosely typed tool input into a filter patch; unknown values are ignored. */
export function filterPatchFromInput(input: Record<string, unknown>): FilterPatch {
  const patch: FilterPatch = {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  if (Array.isArray(input.tools) || typeof input.tools === "string") {
    const raw = Array.isArray(input.tools) ? input.tools : String(input.tools).split(",");
    const ids = raw.map((t) => parseToolId(String(t))).filter((t): t is NonNullable<typeof t> => !!t);
    patch.tools = ids.length ? ids : [...TOOL_IDS];
  }
  const since = str(input.since);
  const until = str(input.until);
  const range = str(input.range);
  if (range && (RANGE_PRESETS as readonly string[]).includes(range)) patch.range = range as FilterPatch["range"];
  if (since || until) {
    patch.range = "custom";
    if (since) patch.since = since;
    if (until) patch.until = until;
  }
  const mode = str(input.mode);
  if (mode && (COST_MODES as readonly string[]).includes(mode)) patch.mode = mode as FilterPatch["mode"];
  const group = str(input.group);
  if (group && (GROUPS as readonly string[]).includes(group)) patch.group = group as FilterPatch["group"];
  const tz = str(input.tz);
  if (tz) patch.tz = tz;
  if ("project" in input) patch.project = str(input.project) ?? null;
  return patch;
}

/** Registers ui-sdk's snapshot/query/act plus clausage's own report and filter tools with WebMCP, when the browser has it. */
export function AgentBridge() {
  const params = useSearchParams();
  const { setFilters } = useFilters();
  const latest = useRef({ params, setFilters });
  useEffect(() => {
    latest.current = { params, setFilters };
  });

  useEffect(() => {
    const agent = getAgent();
    const unregister = registerTools(agent, { allow: () => true });
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context) return unregister;
    const controller = new AbortController();
    const tools: ModelContextTool[] = [
      {
        name: "get_usage_report",
        description:
          "Returns the clausage usage report JSON for the dashboard's current filters (tools, date range, timezone, cost mode). kind is one of daily, weekly, monthly, session, blocks, models, projects, tools, sources or limits. Costs are in USD; token counts are integers.",
        inputSchema: {
          type: "object",
          properties: { kind: { type: "string", enum: [...REPORT_KINDS] } },
          required: ["kind"],
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async (input) => {
          const kind = String(input.kind ?? "daily");
          if (!(REPORT_KINDS as readonly string[]).includes(kind)) return { error: `Unknown kind "${kind}". Use one of ${REPORT_KINDS.join(", ")}.` };
          const q = new URLSearchParams({ kind });
          for (const k of FILTER_KEYS) {
            const v = latest.current.params.get(k);
            if (v !== null) q.set(k, v);
          }
          const res = await fetch(`/api/usage?${q}`);
          return res.json();
        },
      },
      {
        name: "set_filters",
        description:
          "Changes the dashboard filters in the URL. tools: list of claude-code, codex, grok, opencode, hermes, openclaw, pi, gemini, amp, qwen, copilot, aider (empty for all). range: 7d, 30d, 90d, all or custom; since/until (YYYY-MM-DD) imply custom. mode: auto, calculate or display. group: daily, weekly or monthly. tz: an IANA zone, UTC or local. project: a path substring, or empty to clear.",
        inputSchema: {
          type: "object",
          properties: {
            tools: { type: "array", items: { type: "string", enum: [...TOOL_IDS] } },
            range: { type: "string", enum: [...RANGE_PRESETS] },
            since: { type: "string" },
            until: { type: "string" },
            mode: { type: "string", enum: [...COST_MODES] },
            group: { type: "string", enum: [...GROUPS] },
            tz: { type: "string" },
            project: { type: "string" },
          },
        },
        execute: (input) => {
          const patch = filterPatchFromInput(input ?? {});
          latest.current.setFilters(patch);
          return { ok: true, applied: patch };
        },
      },
    ];
    for (const tool of tools) context.registerTool(tool, { signal: controller.signal }).catch(() => {});
    return () => {
      controller.abort();
      unregister();
    };
  }, []);

  return null;
}
