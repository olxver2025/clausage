import { mcpServerStats, toolCallStats, type SessionMeta } from "@clausage/core";
import { ShareBars, type ShareItem } from "@/components/charts/ShareBars";
import { formatNumber } from "@/lib/format";

type WithToolCalls = Pick<SessionMeta, "toolCalls" | "toolCallsByName">;

export interface ToolCallSummary {
  /** all calls, named or not */
  calls: number;
  /** sessions that made at least one call */
  sessions: number;
  /** calls whose tool name is known */
  named: number;
}

export function toolCallSummary(sessions: WithToolCalls[]): ToolCallSummary {
  let calls = 0;
  let named = 0;
  let withCalls = 0;
  for (const s of sessions) {
    calls += s.toolCalls || 0;
    if (s.toolCalls > 0) withCalls++;
    for (const n of Object.values(s.toolCallsByName ?? {})) named += n;
  }
  return { calls, sessions: withCalls, named };
}

/** Cost per tool call: the cost of the sessions that made calls, divided by their calls. */
export function costPerCall(sessions: Array<WithToolCalls & { costUSD: number }>): number | null {
  let cost = 0;
  let calls = 0;
  for (const s of sessions) {
    if (!(s.toolCalls > 0)) continue;
    cost += s.costUSD;
    calls += s.toolCalls;
  }
  return calls > 0 ? cost / calls : null;
}

/** Bar list of tool calls by tool name (names only, never arguments). */
export function ToolCallBars({
  title,
  sessions,
  limit,
  showSessions = false,
}: {
  title: string;
  sessions: WithToolCalls[];
  limit?: number;
  /** add "in N sessions" under each name (for lists across sessions) */
  showSessions?: boolean;
}) {
  const { calls, named } = toolCallSummary(sessions);
  const items: ShareItem[] = toolCallStats(sessions).map((s) => ({
    key: s.name,
    label: <span title={s.name}>{s.name}</span>,
    text: s.name,
    value: s.calls,
    hint: showSessions ? `${formatNumber(s.sessions)} ${s.sessions === 1 ? "session" : "sessions"}` : undefined,
  }));
  const empty = calls > 0 ? "This tool's logs do not record tool names." : "No tool calls recorded.";
  return (
    <>
      <ShareBars title={title} items={items} format={formatNumber} total={Math.max(calls, named)} limit={limit} emptyMessage={empty} />
      {items.length > 0 && named < calls && (
        <p className="mt-2 text-xs text-fg-3">{calls - named === 1 ? "1 call without a recorded tool name is" : `${formatNumber(calls - named)} calls without a recorded tool name are`} not listed.</p>
      )}
    </>
  );
}

/** One line per MCP server (tool names `mcp__<server>__<tool>`), or nothing when there are none. */
export function McpServerLine({ sessions }: { sessions: WithToolCalls[] }) {
  const servers = mcpServerStats(sessions);
  if (!servers.length) return null;
  return (
    <p className="mt-3 text-xs text-fg-3">
      <span className="text-fg-2">MCP servers: </span>
      {servers.slice(0, 6).map((s, i) => (
        <span key={s.server}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          <span className="text-fg">{s.server}</span> <span className="tabular">{formatNumber(s.calls)}</span>
        </span>
      ))}
      {servers.length > 6 && <span> · +{servers.length - 6} more</span>}
    </p>
  );
}
