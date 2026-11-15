import { createHash } from 'node:crypto';
import type { LimitSnapshot, LimitWindow, ResetAvailability, ToolId } from './types.js';

export function accountFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface UsageResetEvent {
  tool: ToolId;
  timestamp: number;
  /** A grant counter decreased, a balance likely fell, or no redemption evidence was available. */
  evidence: 'confirmed' | 'likely' | 'unconfirmed';
  windows: Array<{ key: string; label: string; before: number; after: number }>;
  machine?: string;
}

function valid(w: LimitWindow | undefined): w is LimitWindow {
  return !!w && [w.usedPercent, w.resetsAt, w.windowMinutes].every(Number.isFinite) && w.usedPercent >= 0 && w.windowMinutes > 0;
}

function redemption(before: ResetAvailability | undefined, after: ResetAvailability | undefined, timestamp: number): UsageResetEvent['evidence'] {
  if (!before || !after) return 'unconfirmed';
  for (const grant of before.grants ?? []) {
    const next = after.grants?.find((g) => g.id === grant.id);
    if (next && grant.remaining > next.remaining && (grant.expiresAt === undefined || grant.expiresAt > timestamp)) return 'confirmed';
  }
  // A disappearing credit can also have expired. Only count credits still valid at this report.
  const vanished = before.grants?.some((g) => g.remaining > 0 && g.expiresAt !== undefined &&
    g.expiresAt > timestamp && after.grants !== undefined && !after.grants.some((n) => n.id === g.id));
  return vanished && after.availableCount < before.availableCount ? 'likely' : 'unconfirmed';
}

/** Large drops before the prior window expires; timestamps are observations, not exact redemption times. */
export function detectUsageResets(snapshots: LimitSnapshot[], now = Date.now()): UsageResetEvent[] {
  const previous = new Map<string, { snapshot: LimitSnapshot; window: LimitWindow }>();
  const events = new Map<string, UsageResetEvent>();
  const sorted = [...snapshots].filter((s) => Number.isFinite(s.timestamp) && s.timestamp <= now).sort((a, b) => a.timestamp - b.timestamp);
  const accountStarts = new Map<string, number>();
  for (const s of sorted) if (s.accountKey) {
    const key = JSON.stringify([s.tool, s.machine ?? '']);
    if (!accountStarts.has(key)) accountStarts.set(key, s.timestamp);
  }
  for (const s of sorted) {
    // Account polls supersede unscoped rollout reports, which may include older logins.
    const accountStart = accountStarts.get(JSON.stringify([s.tool, s.machine ?? '']));
    if (!s.accountKey && accountStart !== undefined && s.timestamp >= accountStart) continue;
    const scope = JSON.stringify([s.tool, s.accountKey ?? '', s.machine ?? '']);
    const windows: Array<[string, string, LimitWindow | undefined]> = [
      ['primary', '5-hour', s.primary], ['secondary', 'Weekly', s.secondary],
      ...(s.extra ?? []).map((x): [string, string, LimitWindow] => [x.key, x.label, x.window]),
    ];
    for (const [key, label, w] of windows) {
      if (!valid(w)) continue;
      const id = `${scope}:${key}`;
      const prev = previous.get(id);
      if (prev && s.timestamp > prev.snapshot.timestamp && prev.snapshot.planType === s.planType &&
        prev.window.windowMinutes === w.windowMinutes && prev.window.resetsAt > s.timestamp + 5 * 60_000 &&
        prev.window.usedPercent - w.usedPercent >= 10) {
        const eventKey = `${scope}:${s.timestamp}`;
        const evidence = s.accountKey ? redemption(prev.snapshot.resets, s.resets, s.timestamp) : 'unconfirmed';
        const event = events.get(eventKey) ?? { tool: s.tool, timestamp: s.timestamp, evidence, windows: [], ...(s.machine ? { machine: s.machine } : {}) };
        if (evidence === 'confirmed' || (evidence === 'likely' && event.evidence === 'unconfirmed')) event.evidence = evidence;
        event.windows.push({ key, label, before: prev.window.usedPercent, after: w.usedPercent });
        events.set(eventKey, event);
      }
      if (!prev || s.timestamp > prev.snapshot.timestamp) previous.set(id, { snapshot: s, window: w });
    }
  }
  return [...events.values()].sort((a, b) => b.timestamp - a.timestamp);
}
