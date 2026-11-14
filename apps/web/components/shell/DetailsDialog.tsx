"use client";

import type { ToolId } from "@clausage/core";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@ui-sdk/react/dialog";
import { ToolName } from "@/components/charts/Legend";

export interface DetailsDialogProps {
  warnings: string[];
  sources: Array<{ tool: ToolId; label: string; dirs: string[] }>;
  pricing: string;
  models: number;
}

export function DetailsDialog({ warnings, sources, pricing, models }: DetailsDialogProps) {
  return (
    <Dialog>
      <DialogTrigger className="details-trigger" data-warnings={warnings.length ? "" : undefined}>
        {warnings.length ? `${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : "No warnings"}
      </DialogTrigger>
      <DialogContent>
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-sm font-semibold">Data sources and warnings</DialogTitle>
            <DialogDescription className="mt-0.5 text-xs text-fg-3">
              clausage reads token counts and metadata only, never prompt or response text.
            </DialogDescription>
          </div>
          <DialogClose>Close</DialogClose>
        </div>

        <h3 className="mb-1.5 text-xs font-semibold text-fg-2">Scanned directories</h3>
        <ul className="mb-4 flex flex-col gap-1.5 text-xs">
          {sources.map((s) => (
            <li key={s.tool} className="grid gap-0.5 sm:grid-cols-[9rem_1fr]">
              <ToolName tool={s.tool} />
              {s.dirs.length ? (
                <span className="tabular break-all text-fg-2">{s.dirs.join(", ")}</span>
              ) : (
                <span className="text-fg-3">not found</span>
              )}
            </li>
          ))}
        </ul>

        <h3 className="mb-1.5 text-xs font-semibold text-fg-2">Pricing</h3>
        <p className="mb-4 text-xs text-fg-2">
          {pricing}, {models.toLocaleString("en-US")} models.
        </p>

        <h3 className="mb-1.5 text-xs font-semibold text-fg-2">Warnings ({warnings.length})</h3>
        {warnings.length ? (
          <ul className="flex flex-col gap-1 text-xs text-fg-2">
            {warnings.map((w) => (
              <li key={w} className="tabular break-words border-s-2 border-warning ps-2">
                {w}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-fg-3">None.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
