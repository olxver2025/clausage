import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectUsageResets } from './usage-resets.js';
import { estimateCapacity, limitStatus } from './limits.js';
import type { LimitSnapshot, ResetAvailability, UsageEvent } from './types.js';

const T = Date.UTC(2026, 10, 15, 10);
const H = 3_600_000;
const grants = (remaining: number, expiry = T + 24 * H): ResetAvailability => ({ availableCount: remaining, grants: [{ id: 'g', label: 'Full reset', remaining, expiresAt: expiry }] });
const snap = (hour: number, pct: number, resets?: ResetAvailability, rest: Partial<LimitSnapshot> = {}): LimitSnapshot => ({
  tool: 'claude-code', accountKey: 'account-a', timestamp: T + hour * H,
  primary: { usedPercent: pct, resetsAt: T + 5 * H, windowMinutes: 300 },
  secondary: { usedPercent: pct, resetsAt: T + 168 * H, windowMinutes: 10080 },
  ...(resets ? { resets } : {}), ...rest,
});

test('unexpected usage drops check grant counters and group windows into one reset', () => {
  const history = [snap(0, 90, grants(1)), snap(1, 5, grants(0))];
  const [reset] = detectUsageResets(history, T + 2 * H);
  assert.equal(reset!.evidence, 'confirmed');
  assert.deepEqual(reset!.windows.map((w) => [w.key, w.before, w.after]), [['primary', 90, 5], ['secondary', 90, 5]]);
  const [status] = limitStatus({ events: [], limits: history, now: T + 2 * H });
  assert.equal(status!.resets!.availableCount, 0);
  assert.equal(status!.resetEvents.length, 1);
  assert.equal(detectUsageResets([...history, history[1]!], T + 2 * H).length, 1);
});

test('disappearance before expiry is likely use; expiration and missing data remain unconfirmed', () => {
  assert.equal(detectUsageResets([snap(0, 90, grants(1)), snap(1, 0, { availableCount: 0, grants: [] })], T + 2 * H)[0]!.evidence, 'likely');
  assert.equal(detectUsageResets([snap(0, 90, grants(1, T + H / 2)), snap(1, 0, { availableCount: 0, grants: [] })], T + 2 * H)[0]!.evidence, 'unconfirmed');
  assert.equal(detectUsageResets([snap(0, 90), snap(1, 0)], T + 2 * H)[0]!.evidence, 'unconfirmed');
});

test('scheduled refreshes, jitter, plan and account changes do not count as saved resets', () => {
  const first = snap(0, 90, grants(1), { secondary: undefined });
  for (const next of [
    snap(5, 0, grants(0), { secondary: undefined }),
    snap(5 - 1 / 60, 0, grants(0), { secondary: undefined }),
    snap(1, 85, grants(0), { secondary: undefined }),
    snap(1, 0, grants(0), { accountKey: 'account-b', secondary: undefined }),
    snap(1, 0, grants(0), { planType: 'new-plan', secondary: undefined }),
    snap(1, 0, grants(0), { machine: 'other-computer', secondary: undefined }),
  ]) assert.deepEqual(detectUsageResets([first, next], T + 6 * H), []);
  assert.deepEqual(detectUsageResets([snap(0, 90), snap(3, 0)], T + H), []);
});

test('model windows are detected and raw rollout reports do not duplicate account polls', () => {
  const extra = (pct: number) => [{ key: 'seven_day_fable', label: 'Weekly · Fable', window: { usedPercent: pct, windowMinutes: 10080, resetsAt: T + 100 * H } }];
  const history = [snap(0, 90, grants(1), { extra: extra(90) }), snap(1, 0, grants(0), { extra: extra(0) })];
  const raw = history.map((s) => ({ ...s, accountKey: undefined, timestamp: s.timestamp + 1000 }));
  const resets = detectUsageResets([...history, ...raw], T + 2 * H);
  assert.equal(resets.length, 1);
  assert.equal(resets[0]!.windows.length, 3);
});

test('reset windows do not inflate capacity estimates', () => {
  const event: UsageEvent = { tool: 'claude-code', id: 'e', timestamp: T + H / 2, sessionId: 's', rootSessionId: 's', isSubagent: false,
    project: '', model: 'm', inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, costUSD: 1 };
  assert.equal(estimateCapacity([event], [snap(0, 90), snap(1, 10)], 'primary', T + 2 * H), undefined);
  assert.equal(estimateCapacity([event], [snap(0, 10), snap(1, 20)], 'primary', T + 2 * H)!.tokens, 500);
});
