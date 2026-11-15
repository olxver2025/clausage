"use client";

import { useSyncExternalStore } from "react";

/** Live-update intervals in seconds; 0 turns live updates off. */
export const LIVE_INTERVALS = [0, 10, 30, 60, 300] as const;
export type LiveInterval = (typeof LIVE_INTERVALS)[number];
export const LIVE_INTERVAL_LABELS: Record<LiveInterval, string> = { 0: "Off", 10: "10s", 30: "30s", 60: "1 min", 300: "5 min" };

export interface Settings {
  liveInterval: LiveInterval;
  /** roll numbers to their new value on a live update */
  animateNumbers: boolean;
  /** keep polling while the tab is in the background */
  liveInBackground: boolean;
}

export const DEFAULT_SETTINGS: Settings = { liveInterval: 30, animateNumbers: true, liveInBackground: false };

const STORAGE_KEY = "clausage-settings";
const listeners = new Set<() => void>();
let current: Settings | null = null;

function read(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    return {
      liveInterval: (LIVE_INTERVALS as readonly number[]).includes(Number(parsed.liveInterval))
        ? (Number(parsed.liveInterval) as LiveInterval)
        : DEFAULT_SETTINGS.liveInterval,
      animateNumbers: typeof parsed.animateNumbers === "boolean" ? parsed.animateNumbers : DEFAULT_SETTINGS.animateNumbers,
      liveInBackground: typeof parsed.liveInBackground === "boolean" ? parsed.liveInBackground : DEFAULT_SETTINGS.liveInBackground,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function snapshot(): Settings {
  return (current ??= read());
}

export function setSettings(patch: Partial<Settings>): void {
  current = { ...snapshot(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // storage blocked: the change lasts until the page reloads
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    current = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Per-browser dashboard settings (localStorage), shared across tabs. The server renders the defaults. */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_SETTINGS);
}

// ---- live-update status, shared between the updater (layout) and the controls that show it

export interface LiveStatus {
  busy: boolean;
  lastAt: number | null;
}

let status: LiveStatus = { busy: false, lastAt: null };
const statusListeners = new Set<() => void>();
const SERVER_STATUS: LiveStatus = { busy: false, lastAt: null };

export function setLiveStatus(next: Partial<LiveStatus>): void {
  status = { ...status, ...next };
  for (const l of statusListeners) l();
}

export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    (l) => {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    () => status,
    () => SERVER_STATUS,
  );
}
