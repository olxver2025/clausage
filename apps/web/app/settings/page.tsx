import type { ToolId } from "@clausage/core";
import type { Metadata } from "next";
import { Suspense } from "react";
import { ToolIcon } from "@/components/icons/BrandIcon";
import { PageHeader } from "@/components/Panel";
import { LiveSettings } from "@/components/settings/LiveSettings";
import { SettingRow, SettingsSection } from "@/components/settings/SettingRow";
import { SyncNowButton, SyncSettings } from "@/components/settings/SyncSettings";
import { requestNow } from "@/components/overview/stats";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { getDetectedSubscriptions, getSourcesSummary, getSyncStatus, getUsage, limitConfig, reportFrom } from "@/lib/data";
import { parseFilters } from "@/lib/filters";
import { LimitSettings } from "@/components/settings/LimitSettings";
import { ClaudeUsageSwitch } from "@/components/settings/ClaudeUsageSwitch";
import { installedSyncKeyPath, loadClaudeUsageConfig } from "@clausage/core";
import { formatRelative } from "@/lib/format";
import { TOOL_IDS, TOOL_LABELS } from "@/lib/tools";
import { SubscriptionSettings } from "@/components/settings/SubscriptionSettings";
import "./settings.css";

export const metadata: Metadata = { title: "Settings" };

const SECTIONS = [
  { id: "appearance", title: "Appearance" },
  { id: "live", title: "Live updates" },
  { id: "subscriptions", title: "Subscriptions" },
  { id: "limits", title: "Usage limits" },
  { id: "computers", title: "Computers" },
  { id: "tools", title: "Tools" },
] as const;

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="settings-layout">
        <nav aria-label="Settings sections" className="settings-index">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.title}
            </a>
          ))}
        </nav>
        <div className="settings-sections">
          <SettingsSection id="appearance" title="Appearance">
            <SettingRow title="Theme" description="Auto follows your system’s light or dark setting.">
              <ThemeToggle />
            </SettingRow>
          </SettingsSection>

          <SettingsSection id="live" title="Live updates" description="Open pages re-read your logs in the background and roll their numbers to the new totals.">
            <LiveSettings />
          </SettingsSection>

          <Suspense fallback={<SectionFallback id="subscriptions" title="Subscriptions" />}>
            <Subscriptions />
          </Suspense>

          <Suspense fallback={<SectionFallback id="limits" title="Usage limits" />}>
            <Limits />
          </Suspense>

          <Suspense fallback={<SectionFallback id="computers" title="Computers" />}>
            <Computers />
          </Suspense>

          <Suspense fallback={<SectionFallback id="tools" title="Tools" />}>
            <Tools />
          </Suspense>
        </div>
      </div>
    </>
  );
}

function SectionFallback({ id, title }: { id: string; title: string }) {
  return (
    <SettingsSection id={id} title={title}>
      <p className="settings-note text-fg-3">Loading…</p>
    </SettingsSection>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function Computers() {
  const status = await getSyncStatus();
  const { config, local, remotes, warnings } = status;
  const now = requestNow();
  return (
    <SettingsSection
      id="computers"
      title="Computers"
      description="Add up usage from all your computers. Totals combine every machine; sessions and projects are grouped by the computer they ran on."
    >
      <SyncSettings keyPath={installedSyncKeyPath()} machineName={config.machineName} folder={config.folder ?? ""} publish={config.publish !== false} />
      {config.folder && (
        <div>
          <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-1">
            <h3 className="text-sm font-medium">In the sync folder</h3>
            <SyncNowButton />
          </div>
          <ul className="machine-list">
            <li>
              <span className="font-medium text-fg">
                {config.machineName} <span className="font-normal text-fg-3">· this computer</span>
              </span>
              <span className="status-pill" data-tone={config.publish !== false && local ? "good" : undefined}>
                {config.publish === false ? "Not shared" : local ? `Shared ${formatRelative(local.exportedAt, now)} · ${formatBytes(local.bytes)}` : "Not written yet"}
              </span>
            </li>
            {remotes.map((m) => (
              <li key={m.machineId}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium text-fg">{m.machineName}</span>
                  <span className="flex gap-1">
                    {m.tools.map((t: ToolId) => (
                      <ToolIcon key={t} tool={t} label size="0.8125rem" />
                    ))}
                  </span>
                </span>
                <span className="status-pill tabular-nums" data-tone={now - m.exportedAt < 86_400_000 ? "good" : undefined}>
                  Synced {formatRelative(m.exportedAt, now)} · {m.events.toLocaleString("en-US")} requests
                </span>
              </li>
            ))}
          </ul>
          {remotes.length === 0 && (
            <p className="settings-note text-pretty text-fg-3">
              No other computers found yet. Set up the same shared folder on each computer and wait for your folder service to transfer the files. The folder path may differ on each computer.
            </p>
          )}
          {warnings.map((w) => (
            <p key={w} className="settings-note text-warning">
              {w}
            </p>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

async function Limits() {
  const [summary, data] = await Promise.all([getSourcesSummary(), getUsage(parseFilters({ range: "30d" }))]);
  const config = limitConfig();
  const claudeUsage = loadClaudeUsageConfig();
  const reported = new Set((data.limits ?? []).filter((l) => l.tool !== "claude-code").map((l) => l.tool));
  if (claudeUsage.enabled) reported.add("claude-code");
  const largestBlock = new Map<ToolId, number>();
  for (const row of reportFrom(data, "blocks", parseFilters({ range: "30d" }), { breakdown: false, limits: true }).rows) {
    const t = (row.meta as { tool: ToolId }).tool;
    largestBlock.set(t, Math.max(largestBlock.get(t) ?? 0, row.totalTokens));
  }
  const largestWeek = new Map<ToolId, number>();
  const byTool = new Map<ToolId, Array<[number, number]>>();
  for (const e of data.events) {
    let l = byTool.get(e.tool);
    if (!l) byTool.set(e.tool, (l = []));
    l.push([e.timestamp, e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens]);
  }
  for (const [t, list] of byTool) {
    // largest rolling 7-day total (two-pointer over time-sorted events)
    list.sort((a, b) => a[0] - b[0]);
    let lo = 0;
    let sum = 0;
    let best = 0;
    for (const [ts, n] of list) {
      sum += n;
      while (list[lo]![0] < ts - 7 * 86_400_000) sum -= list[lo++]![1];
      best = Math.max(best, sum);
    }
    largestWeek.set(t, best);
  }
  const tools = TOOL_IDS.filter((t) => summary.sources[t]?.length || config[t]).map((t) => ({
    tool: t,
    config: config[t] ?? {},
    reported: reported.has(t),
    largestBlock: largestBlock.get(t) ?? 0,
    largestWeek: largestWeek.get(t) ?? 0,
  }));
  return (
    <SettingsSection
      id="limits"
      title="Usage limits"
      description="Token limits to track each tool’s 5-hour and weekly windows against on Blocks & limits. Providers don’t publish limits as token counts, so use your own pace: the largest block and week below are a starting point."
    >
      {summary.sources["claude-code"]?.length ? <ClaudeUsageSwitch enabled={claudeUsage.enabled} /> : null}
      {tools.length ? <LimitSettings tools={tools} /> : <p className="settings-note text-fg-3">No tools found on this computer.</p>}
    </SettingsSection>
  );
}

async function Tools() {
  const { sources } = await getSourcesSummary();
  const found = TOOL_IDS.filter((t) => sources[t]?.length).length;
  return (
    <SettingsSection
      id="tools"
      title="Tools"
      description={`${found} of ${TOOL_IDS.length} agents found on this computer. Set a tool’s data-directory environment variable to read logs from somewhere else.`}
    >
      <ul className="tool-grid">
        {TOOL_IDS.map((t) => {
          const dirs = sources[t] ?? [];
          return (
            <li key={t} className="tool-row" data-found={dirs.length ? "" : undefined}>
              <span className="flex w-full items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-medium text-fg">
                  <ToolIcon tool={t} size="1rem" color={dirs.length ? undefined : "var(--text-3)"} />
                  <span className={dirs.length ? "" : "text-fg-3"}>{TOOL_LABELS[t]}</span>
                </span>
                <span className="status-pill" data-tone={dirs.length ? "good" : undefined}>
                  {dirs.length ? "Found" : "Not found"}
                </span>
              </span>
              {dirs.length > 0 && <span className="font-mono text-[0.6875rem] break-all text-fg-3">{dirs.join(", ")}</span>}
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}

async function Subscriptions() {
  const detected = await getDetectedSubscriptions();
  return (
    <SettingsSection id="subscriptions" title="Subscriptions" description="Your account’s reported plan automatically powers the value comparison on Overview. Overrides are optional when your bill differs from the list price.">
      <SubscriptionSettings detected={detected} />
    </SettingsSection>
  );
}
