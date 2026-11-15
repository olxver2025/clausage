"use client";

import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { useState, useTransition } from "react";
import { setClaudeUsage, type ActionResult } from "@/app/actions";
import { ToolIcon } from "@/components/icons/BrandIcon";

export function ClaudeUsageSwitch({ enabled }: { enabled: boolean }) {
  const [on, setOn] = useState(enabled);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [, startTransition] = useTransition();
  return (
    <div className="setting-row">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ToolIcon tool="claude-code" size="1rem" />
          Real Claude limits from your account
        </div>
        <p className="mt-0.5 max-w-[36rem] text-xs leading-relaxed text-pretty text-fg-3">
          Claude Code doesn’t save its limits on disk. With this on, clausage uses your Claude Code login (from the Keychain) to ask Anthropic for the same
          numbers as <code className="font-mono">/usage</code>, plus available resets and their expiry dates, at most once a minute. The login is only sent to Anthropic and never stored; an expired login
          is never renewed by clausage. Anthropic’s usage service is unofficial and may change.
        </p>
        {result && (
          <p role="status" className={`mt-1 text-xs ${result.ok ? "text-fg-2" : "text-critical"}`}>
            {result.ok ? result.message : result.error}
          </p>
        )}
      </div>
      <Switch
        aria-label="Real Claude limits from your account"
        checked={on}
        onCheckedChange={(v) => {
          setOn(v);
          startTransition(async () => {
            const r = await setClaudeUsage(v);
            setResult(r);
            if (!r.ok) setOn(!v);
          });
        }}
      >
        <SwitchThumb />
      </Switch>
    </div>
  );
}
