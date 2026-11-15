import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildBlocks, type BlockMeta } from './aggregate.js';
import { estimateCapacity, limitStatus, loadLimitConfig, reportedWindows, saveLimitConfig, weekStart } from './limits.js';
import type { LimitSnapshot, ToolId, UsageEvent } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

function ev(tool: ToolId, ts: number, tokens: number, cost = 0): UsageEvent {
  return {
    tool,
    id: `${tool}:${ts}`,
    timestamp: ts,
    sessionId: 's',
    rootSessionId: 's',
    isSubagent: false,
    project: '',
    model: 'm',
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    costUSD: cost,
  };
}

function snap(ts: number, pct: number, resetsAt: number, weekPct = 10, weekReset = resetsAt + 100 * HOUR): LimitSnapshot {
  return {
    tool: 'codex',
    timestamp: ts,
    primary: { usedPercent: pct, windowMinutes: 300, resetsAt },
    secondary: { usedPercent: weekPct, windowMinutes: 10080, resetsAt: weekReset },
    planType: 'plus',
  };
}

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);

test('reported windows: current %, reset, projection and capacity', () => {
  const reset = T0 + 5 * HOUR;
  const events = [ev('codex', T0 + 10 * MIN, 10_000_000, 2), ev('codex', T0 + 60 * MIN, 10_000_000, 2)];
  // reset times jitter by a second between reports
  const limits = [snap(T0 + 11 * MIN, 10, reset), snap(T0 + 61 * MIN, 20, reset + 1000)];
  const now = T0 + 2 * HOUR;
  const [codex] = limitStatus({ events, limits, now, tools: ['codex'] });
  assert.equal(codex!.planType, 'plus');
  assert.equal(codex!.fiveHour!.usedPercent, 20);
  assert.equal(codex!.fiveHour!.source, 'reported');
  assert.equal(codex!.fiveHour!.endMs, reset + 1000);
  assert.equal(codex!.fiveHour!.tokens, 20_000_000);
  // 20% in 2h of a 5h window → 50% by reset, no limit hit projected
  assert.ok(Math.abs(codex!.fiveHour!.projectedPercent! - 50) < 1);
  assert.equal(codex!.fiveHour!.projectedLimitAt, undefined);
  assert.equal(codex!.fiveHourCapacity!.tokens, 100_000_000);
  assert.equal(codex!.fiveHourCapacity!.windows, 1, 'jittery reset times are one window');
});

test('an ended reported window waits for the next request', () => {
  const reset = T0 + 5 * HOUR;
  const [codex] = limitStatus({ events: [ev('codex', T0, 1000)], limits: [snap(T0, 50, reset)], now: T0 + 8 * HOUR, tools: ['codex'] });
  assert.equal(codex!.fiveHour!.expired, true);
  assert.equal(codex!.fiveHour!.usedPercent, undefined);
});

test('configured limits: active block, rolling and fixed weeks, pace to the limit', () => {
  const events = [ev('claude-code', T0 + 5 * MIN, 50_000_000), ev('claude-code', T0 + 55 * MIN, 50_000_000)];
  const now = T0 + HOUR;
  const [claude] = limitStatus({
    events,
    now,
    config: { 'claude-code': { fiveHourTokens: 200_000_000, weeklyTokens: 1_000_000_000 } },
    tools: ['claude-code'],
    timezone: 'UTC',
  });
  const five = claude!.fiveHour!;
  assert.equal(five.startMs, T0, 'block starts at the hour of the first request');
  assert.equal(five.usedPercent, 50);
  assert.equal(five.source, 'configured');
  // 50% in 1h → 100% after 2h
  assert.equal(five.projectedLimitAt, T0 + 2 * HOUR);
  assert.equal(claude!.weekly!.rolling, true);
  assert.equal(claude!.weekly!.usedPercent, 10);

  const [fixed] = limitStatus({ events, now, config: { 'claude-code': { weeklyResetDay: 1, weeklyResetHour: 8 } }, tools: ['claude-code'], timezone: 'UTC' });
  // T0 is Tuesday 2026-11-10 09:00 UTC → the week started Monday 2026-11-09 08:00 UTC
  assert.equal(fixed!.weekly!.startMs, Date.UTC(2026, 10, 9, 8));
  assert.equal(fixed!.weekly!.endMs, Date.UTC(2026, 10, 16, 8));
  assert.equal(weekStart(Date.UTC(2026, 10, 9, 7), 1, 8, 'UTC'), Date.UTC(2026, 10, 2, 8), 'before the reset hour it is last week');
});

test('blocks are anchored to reported windows and carry limit usage', () => {
  const reset = T0 + 5 * HOUR + 34 * MIN;
  const events = [ev('codex', T0 + 33 * MIN, 5), ev('codex', T0 + 40 * MIN, 5), ev('codex', T0 + 7 * HOUR, 5)];
  const limits = [snap(T0 + 41 * MIN, 30, reset), snap(T0 + 50 * MIN, 64, reset)];
  const rows = buildBlocks(events, { now: T0 + 10 * HOUR, limits: { anchors: reportedWindows(limits), hits: [{ tool: 'codex', timestamp: T0 + 45 * MIN }] } });
  const metas = rows.map((r) => r.meta as unknown as BlockMeta);
  assert.equal(metas.length, 2);
  assert.equal(metas[0]!.startTime, new Date(T0 + 33 * MIN).toISOString(), 'opening request a moment before the window joins it');
  assert.equal(metas[0]!.endTime, new Date(reset).toISOString());
  assert.deepEqual(metas[0]!.limit, { percent: 64, source: 'reported', hit: true });
  assert.equal(metas[1]!.anchored, undefined);
  assert.equal(estimateCapacity(events, limits, 'primary', T0 + 10 * HOUR)!.windows, 1);
});

test('limit config round-trips through config.json', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clausage-limits-'));
  const prev = process.env.CLAUSAGE_CONFIG_DIR;
  process.env.CLAUSAGE_CONFIG_DIR = dir;
  try {
    saveLimitConfig('claude-code', { fiveHourTokens: 1e8, weeklyResetDay: 4, weeklyResetHour: 9 });
    assert.deepEqual(loadLimitConfig(), { 'claude-code': { fiveHourTokens: 1e8, weeklyResetDay: 4, weeklyResetHour: 9 } });
    saveLimitConfig('claude-code', { fiveHourTokens: -5 } as never);
    assert.deepEqual(loadLimitConfig(), {});
  } finally {
    if (prev === undefined) delete process.env.CLAUSAGE_CONFIG_DIR;
    else process.env.CLAUSAGE_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
