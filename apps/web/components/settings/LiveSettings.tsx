"use client";

import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue } from "@ui-sdk/react/select";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { ago, useNow } from "@/components/shell/LiveUpdater";
import { LIVE_INTERVAL_LABELS, LIVE_INTERVALS, setSettings, useLiveStatus, useSettings, type LiveInterval } from "@/lib/settings";
import { SettingRow } from "./SettingRow";

const items = LIVE_INTERVALS.map((s) => ({ value: String(s), label: s === 0 ? "Off" : `Every ${LIVE_INTERVAL_LABELS[s]}` }));

export function LiveSettings() {
  const settings = useSettings();
  const { busy, lastAt } = useLiveStatus();
  const now = useNow();
  const status = busy ? "Updating now…" : lastAt !== null && now !== null ? `Last updated ${ago(now - lastAt)}.` : null;
  return (
    <>
      <SettingRow
        title="Update interval"
        description={
          <>
            How often open pages re-read your logs. Only files that changed are parsed again.
            {status && <span className="tabular-nums"> {status}</span>}
          </>
        }
      >
        <Select
          items={items}
          value={String(settings.liveInterval)}
          onValueChange={(next) => {
            if (next !== null && next !== undefined) setSettings({ liveInterval: Number(next) as LiveInterval });
          }}
        >
          <SelectTrigger className="min-w-36" aria-label="Update interval">
            <span aria-hidden="true" className="live-dot" data-on={settings.liveInterval ? "" : undefined} data-busy={busy ? "" : undefined} />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
                <SelectItemIndicator />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow title="Animate number changes" description="Totals roll to their new value when an update brings in more usage.">
        <Switch aria-label="Animate number changes" checked={settings.animateNumbers} onCheckedChange={(v) => setSettings({ animateNumbers: v })}>
          <SwitchThumb />
        </Switch>
      </SettingRow>
      <SettingRow title="Update in background tabs" description="Off by default: hidden tabs pause and catch up the moment you come back.">
        <Switch
          aria-label="Update in background tabs"
          checked={settings.liveInBackground}
          disabled={!settings.liveInterval}
          onCheckedChange={(v) => setSettings({ liveInBackground: v })}
        >
          <SwitchThumb />
        </Switch>
      </SettingRow>
    </>
  );
}
