import type { ToolLimitStatus } from "@clausage/core";
import { formatDateTime, formatRelative } from "@/lib/format";

function resetLabel(label: string): string {
  const modelLaunch = label.match(/^new model launch:\s*one\s+(?:more\s+)?(.+?)\s+reset\b/i);
  if (modelLaunch) return `${modelLaunch[1]} reset`;
  return label.replace(/^(one\s+)?full limit reset\s*\([^)]*\)$/i, "Full limit reset");
}

export function UsageResets({ status, now, timeZone }: { status: ToolLimitStatus; now: number; timeZone: string }) {
  if (!["codex", "claude-code", "grok"].includes(status.tool)) return null;
  const grants = status.resets?.grants?.filter((g) => g.remaining > 0 && (g.expiresAt === undefined || g.expiresAt > now));
  const expired = status.resets?.grants?.reduce((n, g) => n + (g.expiresAt !== undefined && g.expiresAt <= now ? g.remaining : 0), 0) ?? 0;
  const available = Math.max(0, (status.resets?.availableCount ?? 0) - expired);
  return (
    <section className="grid gap-1.5 border-t border-line pt-3" aria-label="Usage resets">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-xs font-medium text-fg-2">Saved resets</h4>
        {status.resetsReportedAt !== undefined && <span className="text-xs text-fg-3">Checked {formatRelative(status.resetsReportedAt, now)}</span>}
      </div>
      <p className="text-sm font-medium text-fg">
        {status.resets ? `${available} saved reset${available === 1 ? "" : "s"} available` : "Reset availability unknown"}
      </p>
      {grants && grants.length > 0 && <ul className="mt-1 divide-y divide-line rounded-[var(--radius)] border border-line">
        {grants.map((g) => <li key={g.id} className="grid gap-1 px-3 py-2.5 text-xs leading-relaxed">
          <span className="text-fg-2">{resetLabel(g.label)}{g.remaining > 1 && ` × ${g.remaining}`}</span>
          {(g.expiresAt !== undefined || g.usableNow === false) && <span className="text-fg-3">
            {g.expiresAt !== undefined && <>Expires <span className="tabular">{formatDateTime(g.expiresAt, timeZone)}</span></>}
            {g.expiresAt !== undefined && g.usableNow === false && " · "}
            {g.usableNow === false && "Not usable right now"}
          </span>}
        </li>)}
      </ul>}
      {status.resetError && <p className="text-xs leading-relaxed text-warning">{status.resetError}</p>}
      {!status.resets && !status.resetError && <p className="text-xs leading-relaxed text-fg-3">
        {status.tool === "grok" ? "Grok’s saved resets aren’t exposed by the local usage logs." : "The account hasn’t reported saved resets. Unknown does not mean none."}
      </p>}
    </section>
  );
}
