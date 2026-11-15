"use client";

import type { ToolId, ToolLimitConfig } from "@clausage/core";
import { Button } from "@ui-sdk/react/button";
import { NumberInput, NumberInputControl, NumberInputGroup } from "@ui-sdk/react/number-input";
import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue } from "@ui-sdk/react/select";
import { useState, useTransition } from "react";
import { saveToolLimits, type ActionResult } from "@/app/actions";
import { ToolIcon } from "@/components/icons/BrandIcon";
import { formatCompact } from "@/lib/format";
import { TOOL_LABELS } from "@/lib/tools";

export interface LimitSettingsTool {
  tool: ToolId;
  config: ToolLimitConfig;
  /** the tool reports its own limits (Codex) */
  reported: boolean;
  /** largest 5-hour block and largest 7-day total in the last 30 days, as a reference */
  largestBlock: number;
  largestWeek: number;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayItems = [{ value: "rolling", label: "Rolling 7 days" }, ...DAYS.map((d, i) => ({ value: String(i), label: `Resets ${d}` }))];
const hourItems = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }));

export function LimitSettings({ tools }: { tools: LimitSettingsTool[] }) {
  return (
    <>
      {tools.map((t) => (t.reported ? <ReportedRow key={t.tool} tool={t.tool} /> : <ToolLimitRow key={t.tool} {...t} />))}
    </>
  );
}

function ReportedRow({ tool }: { tool: ToolId }) {
  return (
    <div className="setting-row">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ToolIcon tool={tool} size="1rem" />
        {TOOL_LABELS[tool]}
      </div>
      <p className="text-xs text-fg-3 sm:text-end">
        {tool === "claude-code" ? "Real limits from your Claude account (above). Nothing to set." : `Reported by ${TOOL_LABELS[tool]} with every response. Nothing to set.`}
      </p>
    </div>
  );
}

function TokenField({ label, value, onChange, hint }: { label: string; value: number | null; onChange: (v: number | null) => void; hint?: string }) {
  return (
    <label className="grid gap-1 text-xs text-fg-2">
      {label}
      <NumberInput
        value={value}
        onValueChange={(v) => onChange(v && v > 0 ? v : null)}
        min={0}
        step={1_000_000}
        largeStep={10_000_000}
        format={{ maximumFractionDigits: 0 }}
        aria-label={label}
      >
        <NumberInputGroup>
          <NumberInputControl placeholder="No limit" className="w-36" />
        </NumberInputGroup>
      </NumberInput>
      {hint && <span className="text-[0.6875rem] text-fg-3">{hint}</span>}
    </label>
  );
}

function ToolLimitRow({ tool, config, largestBlock, largestWeek }: LimitSettingsTool) {
  const [five, setFive] = useState<number | null>(config.fiveHourTokens ?? null);
  const [week, setWeek] = useState<number | null>(config.weeklyTokens ?? null);
  const [day, setDay] = useState<string>(config.weeklyResetDay !== undefined ? String(config.weeklyResetDay) : "rolling");
  const [hour, setHour] = useState<string>(String(config.weeklyResetHour ?? 9));
  const [result, setResult] = useState<ActionResult | null>(null);
  const [, startTransition] = useTransition();

  const next: ToolLimitConfig = {
    ...(five ? { fiveHourTokens: five } : {}),
    ...(week ? { weeklyTokens: week } : {}),
    ...(day !== "rolling" ? { weeklyResetDay: Number(day), weeklyResetHour: Number(hour) } : {}),
  };
  const dirty = JSON.stringify(next) !== JSON.stringify(stripEmpty(config));

  return (
    <div className="setting-row" data-stacked="">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <ToolIcon tool={tool} size="1rem" />
          {TOOL_LABELS[tool]}
        </span>
        {result && (
          <span role="status" className={`text-xs ${result.ok ? "text-fg-3" : "text-critical"}`}>
            {result.ok ? result.message : result.error}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <TokenField label="Tokens per 5 hours" value={five} onChange={setFive} hint={largestBlock ? `Largest block: ${formatCompact(largestBlock)}` : undefined} />
        <TokenField label="Tokens per week" value={week} onChange={setWeek} hint={largestWeek ? `Largest 7 days: ${formatCompact(largestWeek)}` : undefined} />
        <div className="grid gap-1 text-xs text-fg-2">
          <span id={`reset-${tool}`}>Weekly reset</span>
          <div className="flex gap-2">
            <Select items={dayItems} value={day} onValueChange={(v) => v && setDay(String(v))}>
              <SelectTrigger className="min-w-36" aria-labelledby={`reset-${tool}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dayItems.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {day !== "rolling" && (
              <Select items={hourItems} value={hour} onValueChange={(v) => v && setHour(String(v))}>
                <SelectTrigger className="min-w-20" aria-label="Reset hour">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hourItems.map((h) => (
                    <SelectItem key={h.value} value={h.value}>
                      {h.label}
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <span className="text-[0.6875rem] text-fg-3">In the dashboard’s timezone</span>
        </div>
        <Button
          className="mb-5"
          disabled={!dirty}
          onClick={() =>
            new Promise<void>((resolve) => {
              startTransition(async () => {
                setResult(await saveToolLimits(tool, Object.keys(next).length ? next : null));
                resolve();
              });
            })
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function stripEmpty(c: ToolLimitConfig): ToolLimitConfig {
  return {
    ...(c.fiveHourTokens ? { fiveHourTokens: c.fiveHourTokens } : {}),
    ...(c.weeklyTokens ? { weeklyTokens: c.weeklyTokens } : {}),
    ...(c.weeklyResetDay !== undefined ? { weeklyResetDay: c.weeklyResetDay, weeklyResetHour: c.weeklyResetHour ?? 0 } : {}),
  };
}
