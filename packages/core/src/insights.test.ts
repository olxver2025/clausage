import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheEfficiency, dailySeries, dailySpikes, forecastMonth, sessionSpikes } from './insights.js';
import { eventsToDelimited, reportToDelimited, toDelimited } from './export.js';
import { buildReport } from './aggregate.js';
import { PricingTable } from './pricing.js';
import type { Report, SessionInfo, UsageEvent } from './types.js';

let n = 0;
function ev(iso: string, over: Partial<UsageEvent> = {}): UsageEvent {
  n++;
  return {
    tool: 'claude-code',
    id: `i:${n}`,
    timestamp: Date.parse(iso),
    sessionId: 's1',
    rootSessionId: 's1',
    isSubagent: false,
    project: '/p/a',
    model: 'test-model',
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 900,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    costUSD: 1,
    ...over,
  };
}

// $1 / 1M input, $0.10 cache read, $1.25 cache write, $5 output
const pricing = new PricingTable(
  {
    'test-model': {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 5e-6,
      cache_read_input_token_cost: 1e-7,
      cache_creation_input_token_cost: 1.25e-6,
      litellm_provider: 'anthropic',
      mode: 'chat',
    },
  },
  'embedded',
);

test('cacheEfficiency: hit rate and savings against uncached input', () => {
  const rows = cacheEfficiency([ev('2026-11-01T10:00:00Z'), ev('2026-11-01T11:00:00Z', { cacheReadTokens: 0, cacheWriteTokens: 900 })], pricing, 'total');
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.promptTokens, 2000);
  assert.equal(r.hitRate, 0.45);
  assert.equal(r.writeRate, 0.45);
  // event 1: actual 100*1 + 900*0.1 + 10*5 = 240 µ$, uncached 1000*1 + 50 = 1050 µ$
  // event 2: actual 100 + 900*1.25 + 50 = 1275 µ$, uncached 1050 µ$
  assert.ok(Math.abs(r.costUSD - 1515e-6) < 1e-12);
  assert.ok(Math.abs(r.uncachedCostUSD - 2100e-6) < 1e-12);
  assert.ok(Math.abs(r.savedUSD - 585e-6) < 1e-12);
});

test('cacheEfficiency: unpriced models are kept out of the money figures', () => {
  const rows = cacheEfficiency([ev('2026-11-01T10:00:00Z', { model: 'nobody-knows-this-model-xyz' })], pricing, 'model');
  assert.equal(rows[0]!.unpricedPromptTokens, 1000);
  assert.equal(rows[0]!.uncachedCostUSD, 0);
  assert.equal(rows[0]!.hitRate, 0.9);
});

test('dailySeries zero-fills and dailySpikes flags only outliers', () => {
  const events: UsageEvent[] = [];
  for (let d = 1; d <= 14; d++) events.push(ev(`2026-10-${String(d).padStart(2, '0')}T12:00:00Z`, { costUSD: 5 + (d % 3) }));
  events.push(ev('2026-10-20T12:00:00Z', { costUSD: 60 }));
  const series = dailySeries(events, [], { timezone: 'UTC' });
  assert.equal(series.length, 20);
  assert.equal(series.find((p) => p.date === '2026-10-17')!.costUSD, 0);
  const spikes = dailySpikes(series);
  assert.deepEqual(spikes.map((s) => s.key), ['2026-10-20']);
  assert.ok(spikes[0]!.ratio > 9);
});

test('dailySpikes needs a baseline and ignores tiny days', () => {
  assert.deepEqual(dailySpikes(dailySeries([ev('2026-10-01T00:00:00Z'), ev('2026-10-02T00:00:00Z', { costUSD: 50 })], [], { timezone: 'UTC' })), []);
  const small: UsageEvent[] = [];
  for (let d = 1; d <= 10; d++) small.push(ev(`2026-10-${String(d).padStart(2, '0')}T12:00:00Z`, { costUSD: 0.01 }));
  small.push(ev('2026-10-11T12:00:00Z', { costUSD: 0.5 }));
  assert.deepEqual(dailySpikes(dailySeries(small, [], { timezone: 'UTC' })), []);
});

test('sessionSpikes finds the expensive session', () => {
  const events: UsageEvent[] = [];
  const sessions: SessionInfo[] = [];
  for (let i = 0; i < 10; i++) {
    const id = `s${i}`;
    events.push(ev('2026-10-05T12:00:00Z', { sessionId: id, rootSessionId: id, costUSD: i === 9 ? 80 : 3 + (i % 2) }));
    sessions.push({ tool: 'claude-code', sessionId: id, rootSessionId: id, isSubagent: false, project: '/p', startedAt: 0, endedAt: 0, activeMs: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, turns: 0, models: [] });
  }
  const rows = buildReport('session', events, sessions, { timezone: 'UTC' }).rows;
  assert.deepEqual(sessionSpikes(rows).map((s) => s.key), ['claude-code:s9']);
});

test('forecastMonth projects month-to-date plus the recent daily rate', () => {
  const events: UsageEvent[] = [];
  // $10 a day from Nov 1 to Nov 14
  for (let d = 1; d <= 14; d++) events.push(ev(`2026-11-${String(d).padStart(2, '0')}T12:00:00Z`, { costUSD: 10 }));
  const now = Date.parse('2026-11-15T00:00:00Z');
  const f = forecastMonth(events, [], { timezone: 'UTC', now });
  assert.equal(f.month, '2026-11');
  assert.equal(f.toDateUSD, 140);
  assert.equal(f.dailyRateUSD, 10);
  assert.equal(f.basisDays, 14);
  assert.ok(Math.abs(f.projectedUSD - 300) < 1e-9);
  assert.equal(f.daysInMonth, 30);
  assert.ok(f.lowUSD <= f.projectedUSD && f.projectedUSD <= f.highUSD);
});

test('forecastMonth with no history projects what is already spent', () => {
  const f = forecastMonth([], [], { timezone: 'UTC', now: Date.parse('2026-11-15T00:00:00Z') });
  assert.equal(f.projectedUSD, 0);
  assert.equal(f.basisDays, 0);
});

test('toDelimited quotes, escapes and neutralises formulas', () => {
  const csv = toDelimited(['a', 'b'], [{ a: 'x,"y"', b: '=SUM(A1)' }, { a: 1.5, b: undefined }], 'csv');
  assert.equal(csv, 'a,b\r\n"x,""y""",\'=SUM(A1)\r\n1.5,\r\n');
  const tsv = toDelimited(['a'], [{ a: 'one\ttwo\nthree' }], 'tsv');
  assert.equal(tsv, 'a\none two three\n');
  assert.equal(toDelimited(['a', 'b'], [{ a: 1 }], 'jsonl'), '{"a":1,"b":null}\n');
});

test('reportToDelimited: one line per row, or per model with breakdown', () => {
  const events = [ev('2026-11-01T10:00:00Z'), ev('2026-11-01T11:00:00Z', { model: 'other-model', tool: 'codex' })];
  const report: Report = buildReport('daily', events, [], { timezone: 'UTC', breakdown: true });
  const flat = reportToDelimited(report, 'csv').trim().split('\r\n');
  assert.equal(flat.length, 2);
  assert.match(flat[0]!, /^key,label,tools,models,inputTokens/);
  const broken = reportToDelimited(report, 'csv', { breakdown: true }).trim().split('\r\n');
  assert.equal(broken.length, 3);
  assert.match(broken[0]!, /^key,label,model,tool,speed,/);
});

test('eventsToDelimited writes ISO timestamps and totals', () => {
  const out = eventsToDelimited([ev('2026-11-01T10:00:00Z')], 'jsonl');
  const row = JSON.parse(out) as Record<string, unknown>;
  assert.equal(row.timestamp, '2026-11-01T10:00:00.000Z');
  assert.equal(row.totalTokens, 1010);
  assert.equal(row.machine, null);
});
