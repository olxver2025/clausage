import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport,
  buildBlocks,
  dateKey,
  endOfDay,
  mcpServerOf,
  mcpServerStats,
  mergeToolCallsByName,
  startOfDay,
  sumTotals,
  toolCallStats,
  weekKey,
  weekKeyFromDate,
  type BlockMeta,
  type SessionMeta,
} from './aggregate.js';
import { computeActiveMs, envPaths, normalizePath, readJsonlLines } from './parsers/util.js';
import type { DailyAggregate, SessionInfo, ToolId, UsageEvent } from './types.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

let n = 0;
function ev(iso: string, over: Partial<UsageEvent> = {}): UsageEvent {
  n++;
  return {
    tool: 'claude-code',
    id: `t:${n}`,
    timestamp: Date.parse(iso),
    sessionId: 's1',
    rootSessionId: 's1',
    isSubagent: false,
    project: '/p/a',
    model: 'm1',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 100,
    cacheWriteTokens: 20,
    cacheWrite1hTokens: 0,
    reasoningTokens: 1,
    costUSD: 0.5,
    ...over,
  };
}

test('dateKey is timezone aware', () => {
  const ts = Date.parse('2026-03-01T03:30:00Z');
  assert.equal(dateKey(ts, 'UTC'), '2026-03-01');
  assert.equal(dateKey(ts, 'America/New_York'), '2026-02-28');
  assert.equal(dateKey(ts, 'Asia/Tokyo'), '2026-03-01');
  assert.equal(dateKey(Date.parse('2026-03-01T16:00:00Z'), 'Asia/Tokyo'), '2026-03-02');
});

test('startOfDay/endOfDay in zones incl. DST', () => {
  assert.equal(startOfDay('20260301', 'UTC'), Date.parse('2026-03-01T00:00:00Z'));
  assert.equal(startOfDay('2026-07-01', 'Europe/Berlin'), Date.parse('2026-06-30T22:00:00Z'));
  assert.equal(startOfDay('2026-01-15', 'Europe/Berlin'), Date.parse('2026-01-14T23:00:00Z'));
  assert.equal(endOfDay('2026-01-15', 'UTC'), Date.parse('2026-01-15T23:59:59.999Z'));
  // US DST start 2026-03-08: day starts at EST offset
  assert.equal(startOfDay('2026-03-08', 'America/New_York'), Date.parse('2026-03-08T05:00:00Z'));
  assert.equal(endOfDay('2026-03-08', 'America/New_York'), Date.parse('2026-03-09T03:59:59.999Z'));
});

test('weekKey honours start of week', () => {
  // 2026-11-13 is a Friday
  assert.equal(weekKeyFromDate('2026-11-13', 'monday'), '2026-11-09');
  assert.equal(weekKeyFromDate('2026-11-13', 'sunday'), '2026-11-08');
  assert.equal(weekKeyFromDate('2026-11-09', 'monday'), '2026-11-09');
  assert.equal(weekKey(Date.parse('2026-11-16T02:00:00Z'), 'America/Los_Angeles', 'monday'), '2026-11-09');
});

test('daily report buckets by timezone and totals add up', () => {
  const events = [
    ev('2026-03-01T03:30:00Z'),
    ev('2026-03-01T12:00:00Z', { tool: 'codex', model: 'gpt' }),
    ev('2026-03-02T01:00:00Z'),
  ];
  const utc = buildReport('daily', events, [], { timezone: 'UTC' });
  assert.deepEqual(
    utc.rows.map((r) => r.key),
    ['2026-03-01', '2026-03-02'],
  );
  assert.equal(utc.rows[0]!.events, 2);
  assert.deepEqual(utc.rows[0]!.tools, ['claude-code', 'codex']);
  assert.equal(utc.rows[0]!.breakdown.length, 2);
  const ny = buildReport('daily', events, [], { timezone: 'America/New_York', order: 'desc' });
  assert.deepEqual(
    ny.rows.map((r) => r.key),
    ['2026-03-01', '2026-02-28'],
  );
  assert.equal(ny.timezone, 'America/New_York');
  assert.equal(utc.totals.totalTokens, 3 * 135);
  assert.equal(utc.totals.costUSD, 1.5);
  assert.equal(utc.totals.reasoningTokens, 3);
});

test('historical aggregates merge into daily/monthly/models with flag', () => {
  const hist: DailyAggregate[] = [
    {
      tool: 'claude-code',
      date: '2026-02-10',
      model: 'm-old',
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      source: 'stats-cache',
      costUSD: 2,
    },
  ];
  const events = [ev('2026-02-20T10:00:00Z')];
  const d = buildReport('daily', events, [], { timezone: 'UTC', historical: hist });
  assert.equal(d.rows.length, 2);
  assert.equal(d.rows[0]!.key, '2026-02-10');
  assert.equal(d.rows[0]!.meta?.historical, true);
  assert.equal(d.rows[1]!.meta?.historical, undefined);
  assert.equal(d.totals.totalTokens, 10 + 135);
  assert.equal(d.totals.costUSD, 2.5);
  const m = buildReport('monthly', events, [], { timezone: 'UTC', historical: hist });
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0]!.key, '2026-02');
  assert.equal(m.rows[0]!.meta?.historical, true);
  const models = buildReport('models', events, [], { historical: hist });
  assert.deepEqual(
    models.rows.map((r) => r.key),
    ['m-old', 'm1'],
  );
  const projects = buildReport('projects', events, [], { historical: hist });
  assert.equal(projects.rows.length, 1);
  assert.equal(projects.totals.totalTokens, 135);
});

test('blocks: floor to hour, 5h windows, gaps, active detection and projection', () => {
  const events = [
    ev('2026-05-01T10:17:00Z'),
    ev('2026-05-01T11:00:00Z'),
    ev('2026-05-01T15:10:00Z'), // > start+5h (15:00) -> new block 15:00
    ev('2026-05-01T23:30:00Z'), // gap > 5h -> new block 23:00
    ev('2026-05-02T00:30:00Z'),
    ev('2026-05-01T10:30:00Z', { tool: 'codex' }),
  ];
  const now = Date.parse('2026-05-02T01:00:00Z');
  const rows = buildBlocks(events, { now });
  const cc = rows.filter((r) => (r.meta as unknown as BlockMeta).tool === 'claude-code');
  assert.deepEqual(
    cc.map((r) => (r.meta as unknown as BlockMeta).startTime),
    ['2026-05-01T10:00:00.000Z', '2026-05-01T15:00:00.000Z', '2026-05-01T23:00:00.000Z'],
  );
  assert.deepEqual(
    cc.map((r) => r.events),
    [2, 1, 2],
  );
  const last = cc[2]!.meta as unknown as BlockMeta;
  assert.equal(last.isActive, true);
  assert.equal(last.endTime, '2026-05-02T04:00:00.000Z');
  assert.ok(last.gapBeforeMs && last.gapBeforeMs > 5 * 3600_000);
  assert.ok(last.burnRate);
  assert.equal(last.burnRate!.tokensPerMinute, 270 / 60);
  assert.equal(last.projection!.remainingMinutes, 180);
  assert.equal(last.projection!.totalTokens, Math.round(270 + (270 / 60) * 180));
  assert.ok(Math.abs(last.burnRate!.costPerHour - 1) < 1e-9);
  assert.equal((cc[0]!.meta as unknown as BlockMeta).isActive, false);
  const codex = rows.filter((r) => (r.meta as unknown as BlockMeta).tool === 'codex');
  assert.equal(codex.length, 1);
  const rep = buildReport('blocks', events, [], { now, order: 'asc' });
  assert.equal(rep.rows.length, 4);
  assert.equal(rep.totals.events, 6);
});

test('blocks: custom session length', () => {
  const rows = buildBlocks([ev('2026-05-01T10:00:00Z'), ev('2026-05-01T11:30:00Z')], {
    sessionLengthHours: 1,
    now: 0,
  });
  assert.equal(rows.length, 2);
});

test('session report groups subagents under root session', () => {
  const events = [
    ev('2026-05-01T10:00:00Z', { sessionId: 'root', rootSessionId: 'root' }),
    ev('2026-05-01T10:05:00Z', { sessionId: 'sub1', rootSessionId: 'root', isSubagent: true }),
    ev('2026-05-01T12:00:00Z', { sessionId: 'other', rootSessionId: 'other', tool: 'grok' as ToolId }),
  ];
  const base = {
    tool: 'claude-code' as ToolId,
    project: '/p/a',
    userMessages: 2,
    assistantMessages: 3,
    toolCalls: 4,
    turns: 2,
    models: ['m1'],
  };
  const sessions: SessionInfo[] = [
    {
      ...base,
      sessionId: 'root',
      rootSessionId: 'root',
      isSubagent: false,
      title: 'Hello',
      toolCallsByName: { Bash: 3, Read: 1 },
      startedAt: Date.parse('2026-05-01T09:59:00Z'),
      endedAt: Date.parse('2026-05-01T10:06:00Z'),
      activeMs: 60_000,
    },
    {
      ...base,
      sessionId: 'sub1',
      rootSessionId: 'root',
      isSubagent: true,
      userMessages: 0,
      toolCallsByName: { Bash: 2, mcp__github__create_pr: 2 },
      startedAt: Date.parse('2026-05-01T10:04:00Z'),
      endedAt: Date.parse('2026-05-01T10:05:00Z'),
      activeMs: 1000,
    },
  ];
  const r = buildReport('session', events, sessions, { order: 'desc' });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0]!.key, 'grok:other');
  const root = r.rows[1]!;
  const meta = root.meta as unknown as SessionMeta;
  assert.equal(root.events, 2);
  assert.equal(meta.subagents, 1);
  assert.equal(meta.toolCalls, 8);
  // subagent calls are folded into the root row too
  assert.deepEqual(meta.toolCallsByName, { Bash: 5, Read: 1, mcp__github__create_pr: 2 });
  assert.equal(meta.userMessages, 2);
  assert.equal(meta.title, 'Hello');
  // max(root's own 60s, idle-gap estimate over all requests in the tree: 10:00 -> 10:05 = 5 min)
  assert.equal(meta.activeMs, 300_000);
  assert.equal(meta.startedAt, Date.parse('2026-05-01T09:59:00Z'));
  const other = r.rows[0]!.meta as unknown as SessionMeta;
  assert.equal(other.activeMs, 0);
  assert.equal(other.toolCallsByName, undefined);
  assert.ok(!('toolCallsByName' in other));
});

test('tool call stats: per name across sessions, MCP servers', () => {
  const sessions: Array<{ toolCallsByName?: Record<string, number> }> = [
    { toolCallsByName: { Bash: 4, Read: 2, mcp__github__create_pr: 1, 'mcp__claude-in-chrome__navigate': 2 } },
    { toolCallsByName: { Bash: 1, Edit: 2, mcp__github__list_issues: 3, mcp__github__create_pr: 1 } },
    { toolCallsByName: { Zero: 0 } },
    {},
  ];
  assert.deepEqual(toolCallStats(sessions), [
    { name: 'Bash', calls: 5, sessions: 2 },
    { name: 'mcp__github__list_issues', calls: 3, sessions: 1 },
    { name: 'Edit', calls: 2, sessions: 1 },
    { name: 'Read', calls: 2, sessions: 1 },
    { name: 'mcp__claude-in-chrome__navigate', calls: 2, sessions: 1 },
    { name: 'mcp__github__create_pr', calls: 2, sessions: 2 },
  ]);
  assert.deepEqual(toolCallStats([]), []);
  assert.equal(mcpServerOf('mcp__github__create_pr'), 'github');
  assert.equal(mcpServerOf('mcp__claude-in-chrome__computer'), 'claude-in-chrome');
  assert.equal(mcpServerOf('mcp__solo'), 'solo');
  assert.equal(mcpServerOf('mcp__'), undefined);
  assert.equal(mcpServerOf('Bash'), undefined);
  assert.deepEqual(mcpServerStats(sessions), [
    { server: 'github', calls: 5, tools: 2, sessions: 2 },
    { server: 'claude-in-chrome', calls: 2, tools: 1, sessions: 1 },
  ]);
  assert.equal(mergeToolCallsByName([{}, { toolCallsByName: {} }]), undefined);
  // names that are also Object.prototype keys are plain counts
  assert.deepEqual(mergeToolCallsByName([{ toolCallsByName: { constructor: 1 } }, { toolCallsByName: { constructor: 2 } }]), { constructor: 3 });
});

test('sumTotals mixes events and totals', () => {
  const t = sumTotals([ev('2026-01-01T00:00:00Z'), sumTotals([ev('2026-01-01T00:00:00Z')])]);
  assert.equal(t.events, 2);
  assert.equal(t.totalTokens, 270);
});

test('util helpers', async () => {
  assert.equal(computeActiveMs([0, 60_000, 60_000 + 10 * 60_000, 60_000 + 11 * 60_000]), 120_000);
  assert.equal(normalizePath('\\\\?\\C:\\x\\y').toLowerCase(), path.resolve('C:\\x\\y').toLowerCase());
  assert.equal(normalizePath(''), '');
  process.env.CLAUSAGE_TEST_PATHS = 'a,b';
  assert.equal(envPaths('CLAUSAGE_TEST_PATHS')?.length, 2);
  delete process.env.CLAUSAGE_TEST_PATHS;
  assert.equal(envPaths('CLAUSAGE_TEST_PATHS'), undefined);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'clausage-util-'));
  const text = '{"a":1}\n\nnot json\n{"a":2}\r\n{"a":3';
  writeFileSync(path.join(dir, 'x.jsonl'), text);
  const got: unknown[] = [];
  for await (const v of readJsonlLines(path.join(dir, 'x.jsonl'))) got.push(v);
  assert.deepEqual(got, [{ a: 1 }, { a: 2 }]);
  const z = zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer };
  if (z.zstdCompressSync) {
    writeFileSync(path.join(dir, 'y.jsonl.zst'), z.zstdCompressSync(Buffer.from('{"b":1}\n{"b":2}\n')));
    const zs: unknown[] = [];
    for await (const v of readJsonlLines(path.join(dir, 'y.jsonl.zst'))) zs.push(v);
    assert.deepEqual(zs, [{ b: 1 }, { b: 2 }]);
  }
});

test('day boundaries when local midnight falls in a DST gap', () => {
  // America/Santiago: 2026-09-06 00:00 does not exist (clocks jump to 01:00, UTC-4 -> UTC-3)
  const s = startOfDay('2026-09-06', 'America/Santiago');
  assert.equal(new Date(s).toISOString(), '2026-09-06T04:00:00.000Z');
  assert.equal(dateKey(s, 'America/Santiago'), '2026-09-06');
  assert.equal(dateKey(s - 1, 'America/Santiago'), '2026-09-05');
  const e = endOfDay('2026-09-05', 'America/Santiago');
  assert.equal(e, s - 1);
  // fall-back day at midnight: 2026-04-04 23:00-23:59 happens twice; the day ends after the second
  assert.equal(new Date(endOfDay('2026-04-04', 'America/Santiago')).toISOString(), '2026-04-05T03:59:59.999Z');
  // ordinary DST days
  assert.equal(new Date(startOfDay('2026-10-25', 'Europe/London')).toISOString(), '2026-10-24T23:00:00.000Z');
  assert.equal(new Date(endOfDay('20261025', 'Europe/London')).toISOString(), '2026-10-25T23:59:59.999Z');
  assert.equal(new Date(endOfDay('2026-03-29', 'Europe/London')).toISOString(), '2026-03-29T22:59:59.999Z');
});

test('model breakdowns keep Fast, Ultrafast, confirmed standard and unreported usage separate', () => {
  const events = ['fast', 'priority', 'ultrafast', 'default', undefined].map((speed) =>
    ev('2026-11-15T10:00:00Z', { model: 'gpt-6-astra', tool: 'codex', speed }));
  const report = buildReport('models', events, []);
  assert.deepEqual(Object.fromEntries(report.rows[0]!.breakdown.map((b) => [b.speed ?? 'unreported', b.events])),
    { fast: 2, ultrafast: 1, standard: 1, unreported: 1 });
  assert.equal(report.totals.costUSD, 2.5);
});
