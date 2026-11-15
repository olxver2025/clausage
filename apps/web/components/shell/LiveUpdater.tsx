"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { refreshUsage } from "@/app/actions";
import { LIVE_INTERVAL_LABELS, setLiveStatus, useLiveStatus, useSettings } from "@/lib/settings";

/**
 * Re-renders the current page with fresh usage on the interval chosen in Settings. Ticks run in
 * their own transition, so the page doesn't dim like a filter change does, and numbers roll to
 * their new values (Ticker). Unless the setting says otherwise, ticks pause while the tab is
 * hidden and catch up as soon as it's shown. A tick never starts while the last one is loading.
 */
export function LiveUpdater() {
  const { liveInterval, liveInBackground } = useSettings();
  const [busy, startTick] = useTransition();
  const busyRef = useRef(false);
  const lastRef = useRef(0);

  useEffect(() => {
    busyRef.current = busy;
    setLiveStatus({ busy });
  }, [busy]);

  useEffect(() => {
    const t = Date.now();
    lastRef.current = t;
    setLiveStatus({ lastAt: t });
  }, []);

  useEffect(() => {
    if (!liveInterval) return;
    const tick = () => {
      if (busyRef.current) return;
      if (!liveInBackground && document.visibilityState !== "visible") return;
      if (Date.now() - lastRef.current < liveInterval * 1000 - 250) return;
      lastRef.current = Date.now();
      startTick(async () => {
        await refreshUsage();
        const t = Date.now();
        lastRef.current = t;
        setLiveStatus({ lastAt: t });
      });
    };
    const id = setInterval(tick, Math.min(liveInterval * 1000, 5000));
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [liveInterval, liveInBackground]);

  return null;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

export function useNow(stepMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, stepMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [stepMs]);
  return now;
}

/** "Live · updated 12s ago" in the sidebar; links to Settings. */
export function LiveStatusLink() {
  const { liveInterval } = useSettings();
  const { busy, lastAt } = useLiveStatus();
  const now = useNow();
  const on = liveInterval > 0;
  const when = busy ? "updating…" : lastAt !== null && now !== null ? `updated ${ago(now - lastAt)}` : "";
  return (
    <Link href="/settings" className="live-status" title={on ? `Live updates every ${LIVE_INTERVAL_LABELS[liveInterval]}` : "Live updates are off"}>
      <span aria-hidden="true" className="live-dot" data-on={on ? "" : undefined} data-busy={busy ? "" : undefined} />
      <span className="truncate">
        {on ? "Live" : "Paused"}
        {when && <span className="text-fg-3"> · {when}</span>}
      </span>
    </Link>
  );
}
