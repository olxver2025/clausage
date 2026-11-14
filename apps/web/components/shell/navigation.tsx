"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, use, useCallback, useRef, useState, useTransition, type ReactNode, type RefObject, type TransitionStartFunction } from "react";
import { applyFilterPatch, parseFilters, type FilterPatch, type Filters } from "@/lib/filters";

type PendingQuery = { base: string; next: string } | null;

const PendingContext = createContext<{ transition: [boolean, TransitionStartFunction]; queryRef: RefObject<PendingQuery> } | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const transition = useTransition();
  const queryRef = useRef<PendingQuery>(null);
  return <PendingContext value={{ transition, queryRef }}>{children}</PendingContext>;
}

function useNavigationContext() {
  const ctx = use(PendingContext);
  if (!ctx) throw new Error("clausage navigation hooks need NavigationProvider");
  return ctx;
}

export function usePendingTransition(): [boolean, TransitionStartFunction] {
  return useNavigationContext().transition;
}

/** Holds the previous render at reduced opacity while a filter change or refresh loads. */
export function PendingRegion({ children, className = "" }: { children: ReactNode; className?: string }) {
  const [pending] = usePendingTransition();
  return (
    <div data-pending={pending ? "" : undefined} aria-busy={pending || undefined} className={`pending-region ${className}`}>
      {children}
    </div>
  );
}

/** Current filters from the URL, and a setter that patches them in the URL (a transition, so the page keeps its frame). */
export function useFilters(): { filters: Filters; setFilters: (patch: FilterPatch) => void; pending: boolean } {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const { transition, queryRef } = useNavigationContext();
  const [pending, startTransition] = transition;
  const filters = parseFilters(new URLSearchParams(params.toString()));
  const setFilters = useCallback(
    (patch: FilterPatch) => {
      const base = params.toString();
      // Changes made before the previous navigation lands build on it instead of the stale URL.
      const from = queryRef.current?.base === base ? queryRef.current.next : base;
      const next = applyFilterPatch(new URLSearchParams(from), patch).toString();
      queryRef.current = { base, next };
      startTransition(() => router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false }));
    },
    [params, pathname, router, startTransition, queryRef],
  );
  return { filters, setFilters, pending };
}

export const FILTER_KEYS = ["tools", "range", "since", "until", "tz", "mode", "group", "project", "subagents"] as const;

/** The current URL's filter params as a query string ('' or '?…'), for links that keep the filters. */
export function useFilterQuery(): string {
  const params = useSearchParams();
  const keep = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = params.get(k);
    if (v !== null) keep.set(k, v);
  }
  const s = keep.toString();
  return s ? `?${s}` : "";
}

/** Local state for a control bound to a URL value: follows the URL whenever `key` changes, and can run ahead of it while a navigation is pending. */
export function useUrlState<T>(urlValue: T, key: string = String(urlValue)): [T, (value: T) => void] {
  const [state, setState] = useState(urlValue);
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setState(urlValue);
  }
  return [state, setState];
}
