"use client";

import { useSyncExternalStore } from "react";
import { parseSubscriptions, type Subscriptions, type Subscription } from "./subscriptions";
import type { ToolId } from "@clausage/core";

const KEY = "clausage-subscriptions-v1";
const EMPTY: Subscriptions = {};
let current: Subscriptions | undefined;
const listeners = new Set<() => void>();

function snapshot(): Subscriptions {
  if (current) return current;
  try {
    current = parseSubscriptions(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    current = {};
  }
  return current;
}

function onStorage(e: StorageEvent) {
  if (e.key === KEY || e.key === null) {
    current = undefined;
    for (const notify of listeners) notify();
  }
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    current = undefined;
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function setSubscription(tool: ToolId, subscription?: Subscription): void {
  const next = { ...snapshot() };
  if (subscription) next[tool] = subscription;
  else delete next[tool];
  current = parseSubscriptions(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Keep the selection for this tab when browser storage is unavailable.
  }
  for (const notify of listeners) notify();
}

export function useSubscriptions(): Subscriptions {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}
