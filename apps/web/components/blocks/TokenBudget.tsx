"use client";

import type { ToolId } from "@clausage/core";
import { useSyncExternalStore } from "react";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Meter, MeterIndicator, MeterLabel, MeterTrack, MeterValue } from "@ui-sdk/react/meter";
import { NumberInput, NumberInputControl, NumberInputDecrement, NumberInputGroup, NumberInputIncrement } from "@ui-sdk/react/number-input";
import { formatCompact, formatNumber, formatPercent } from "@/lib/format";
import { TOOL_LABELS, toolColor } from "@/lib/tools";

export interface BudgetBlock {
  id: string;
  tool: ToolId;
  tokens: number;
  projectedTokens: number | null;
}

const KEY = "clausage-block-token-budget";
const listeners = new Set<() => void>();
let memory: number | null = null;

function read(): number | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return memory;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return memory;
  }
}

function write(value: number | null) {
  memory = value;
  try {
    if (value === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, String(value));
  } catch {}
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function TokenBudget({ blocks, largest }: { blocks: BudgetBlock[]; largest: number }) {
  const budget = useSyncExternalStore(subscribe, read, () => null);

  return (
    <div className="grid gap-4 md:grid-cols-[auto_minmax(0,1fr)]">
      <Field>
        <FieldLabel>Tokens per block</FieldLabel>
        <NumberInput value={budget} onValueChange={(v) => write(v && v > 0 ? v : null)} min={0} step={100_000} largeStep={1_000_000} format={{ maximumFractionDigits: 0 }} className="[&_[data-slot=number-input-control]]:w-32">
          <NumberInputGroup>
            <NumberInputDecrement aria-label="Decrease budget" />
            <NumberInputControl placeholder="e.g. 5,000,000" />
            <NumberInputIncrement aria-label="Increase budget" />
          </NumberInputGroup>
        </NumberInput>
        <FieldDescription>
          Saved in this browser.{largest > 0 && <> Largest block in range: <span className="tabular">{formatNumber(largest)}</span>.</>}
        </FieldDescription>
      </Field>
      <div className="grid min-w-0 content-start gap-3">
        {!budget ? (
          <p className="text-xs text-fg-3">Set a budget to see how much of it the active block uses.</p>
        ) : blocks.length === 0 ? (
          <p className="text-xs text-fg-3">No active block right now.</p>
        ) : (
          blocks.map((b) => {
            const projected = b.projectedTokens !== null ? b.projectedTokens / budget : null;
            const over = b.tokens >= budget;
            return (
              <div key={b.id} className="min-w-0">
                <Meter
                  value={b.tokens}
                  max={budget}
                  className="[&_[data-slot=meter-indicator]]:bg-(--fill)"
                  style={{ "--fill": toolColor(b.tool) } as React.CSSProperties}
                  getValueLabel={(v) => `${formatCompact(v)} of ${formatCompact(budget)} tokens, ${formatPercent(b.tokens / budget)}`}
                >
                  <MeterLabel>{TOOL_LABELS[b.tool]} active block</MeterLabel>
                  <MeterValue>
                    <span className="tabular text-fg">{formatCompact(b.tokens)}</span> / <span className="tabular">{formatCompact(budget)}</span> ·{" "}
                    <span className="tabular">{formatPercent(b.tokens / budget)}</span>
                  </MeterValue>
                  <MeterTrack>
                    <MeterIndicator />
                  </MeterTrack>
                </Meter>
                <p className="mt-1 text-xs text-fg-3">
                  {over ? (
                    <span className="font-medium text-critical">Over budget by {formatCompact(b.tokens - budget)}</span>
                  ) : (
                    <>
                      <span className="tabular">{formatCompact(budget - b.tokens)}</span> left
                    </>
                  )}
                  {projected !== null && (
                    <>
                      {" "}
                      · projected <span className={`tabular ${projected > 1 && !over ? "font-medium text-warning" : ""}`}>{formatPercent(projected)}</span> by block end
                    </>
                  )}
                </p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
