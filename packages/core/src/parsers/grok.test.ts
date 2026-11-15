import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grokParser, splitTurnUsage } from './grok.js';

function envelope(sid: string, seq: number, ms: number, update: Record<string, unknown>, method = 'session/update') {
  return JSON.stringify({
    timestamp: Math.floor(ms / 1000),
    method,
    params: { sessionId: sid, update, _meta: { eventId: `${sid}-${seq}`, agentTimestampMs: ms, totalTokens: 999999 } },
  });
}

function usage(o: Partial<Record<string, number>>, modelUsage?: Record<string, unknown>) {
  const u: Record<string, unknown> = {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    modelCalls: 1,
    apiDurationMs: 0,
    ...o,
  };
  if (modelUsage) u.modelUsage = modelUsage;
  return u;
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'clausage-grok-'));
  const cwd = 'D:\\Synthetic\\proj';
  const group = join(home, 'sessions', encodeURIComponent(cwd));
  const sid = '00000000-0000-7000-8000-000000000001';
  const dir = join(group, sid);
  mkdirSync(dir, { recursive: true });
  // prompt history must never be read; put sentinel content there
  writeFileSync(join(group, 'prompt_history.jsonl'), '{"prompt":"SECRET"}\n');
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      info: { id: sid, cwd },
      generated_title: 'Synthetic title',
      session_summary: 'SECRET summary',
      created_at: '2026-01-01T00:00:00.000Z',
      last_active_at: '2026-01-01T00:10:00.000Z',
      current_model_id: 'grok-test',
    }),
  );
  const t0 = Date.parse('2026-01-01T00:00:10.000Z');
  const u1 = usage(
    { inputTokens: 1000, cachedReadTokens: 200, outputTokens: 10, reasoningTokens: 30, modelCalls: 2, apiDurationMs: 1500, costUsdTicks: 50_000_000 },
    {
      'grok-test': usage({ inputTokens: 1000, cachedReadTokens: 200, outputTokens: 10, reasoningTokens: 30, modelCalls: 2, apiDurationMs: 1500, costUsdTicks: 50_000_000 }),
    },
  );
  // turn 2: two models, only a top-level cost -> split proportionally
  const u2 = usage(
    { inputTokens: 300, outputTokens: 0, modelCalls: 2, costUsdTicks: 30_000_000 },
    {
      'grok-a': usage({ inputTokens: 200 }),
      'grok-b': usage({ inputTokens: 100 }),
    },
  );
  const lines = [
    envelope(sid, 1, t0, { sessionUpdate: 'user_message_chunk', content: { text: 'SECRET' }, _meta: { promptIndex: 0, modelId: 'grok-test' } }),
    envelope(sid, 2, t0 + 1000, { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Run SECRET-CMD', _meta: { 'x.ai/tool': { name: 'run_command' } } }),
    envelope(sid, 3, t0 + 1500, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', _meta: { 'x.ai/tool': { name: 'run_command' } } }),
    envelope(sid, 4, t0 + 2000, { sessionUpdate: 'tool_call', toolCallId: 'tc2', title: 'y' }),
    envelope(sid, 5, t0 + 5000, { sessionUpdate: 'turn_completed', prompt_id: 'p1', stop_reason: 'end_turn', elapsed_ms: 4000, usage: u1 }, '_x.ai/session/update'),
    envelope(sid, 6, t0 + 60000, { sessionUpdate: 'user_message_chunk', content: { text: 'SECRET' }, _meta: { promptIndex: 1 } }),
    envelope(sid, 7, t0 + 61000, { sessionUpdate: 'turn_completed', prompt_id: 'p2', stop_reason: 'end_turn', elapsed_ms: 1000, usage: u2 }, '_x.ai/session/update'),
    envelope(sid, 8, t0 + 62000, { sessionUpdate: 'turn_completed', prompt_id: 'p3', stop_reason: 'cancelled', elapsed_ms: 500 }, '_x.ai/session/update'),
    '{"partial": ',
  ];
  writeFileSync(join(dir, 'updates.jsonl'), lines.join('\n'));

  // a fork that copies p1 (same prompt_id) must not double count
  const fork = join(group, '00000000-0000-7000-8000-000000000002');
  mkdirSync(fork);
  writeFileSync(
    join(fork, 'summary.json'),
    JSON.stringify({ info: { id: '00000000-0000-7000-8000-000000000002', cwd }, parent_session_id: sid, current_model_id: 'grok-test' }),
  );
  writeFileSync(
    join(fork, 'updates.jsonl'),
    envelope('f', 1, t0 + 100000, { sessionUpdate: 'turn_completed', prompt_id: 'p1', usage: u1 }, '_x.ai/session/update') + '\n',
  );
  return home;
}

test('grok parser: per-turn per-model events with normalised tokens', async () => {
  const home = makeHome();
  try {
    const r = await grokParser.load({ paths: { grok: [home] } });
    assert.equal(r.tool, 'grok');
    assert.equal(r.sources.length, 1);
    assert.equal(r.events.length, 3);
    const e1 = r.events.find((e) => e.model === 'grok-test')!;
    assert.equal(e1.inputTokens, 800);
    assert.equal(e1.cacheReadTokens, 200);
    assert.equal(e1.outputTokens, 40); // output + reasoning
    assert.equal(e1.reasoningTokens, 30);
    assert.equal(e1.recordedCostUSD, 0.005);
    assert.equal(e1.durationMs, 1500);
    assert.equal(e1.provider, 'xai');
    assert.equal(e1.project.endsWith('proj'), true);
    const a = r.events.find((e) => e.model === 'grok-a')!;
    const b = r.events.find((e) => e.model === 'grok-b')!;
    assert.ok(Math.abs(a.recordedCostUSD! - 0.002) < 1e-12);
    assert.ok(Math.abs(b.recordedCostUSD! - 0.001) < 1e-12);
    assert.equal(new Set(r.events.map((e) => e.id)).size, 3);

    const s = r.sessions.find((x) => x.sessionId.endsWith('01'))!;
    assert.equal(s.title, 'Synthetic title');
    assert.equal(s.userMessages, 2);
    assert.equal(s.toolCalls, 2);
    // tc2 carries no tool name: counted in toolCalls only; titles (which may hold arguments) are never kept
    assert.deepEqual(s.toolCallsByName, { run_command: 1 });
    assert.ok(!JSON.stringify(r).includes('SECRET'));
    assert.equal(s.turns, 3);
    assert.equal(s.assistantMessages, 4);
    assert.equal(s.activeMs, 5500);
    assert.deepEqual(s.models.sort(), ['grok-a', 'grok-b', 'grok-test']);
    assert.equal(s.startedAt, Date.parse('2026-01-01T00:00:00.000Z'));
    assert.equal(JSON.stringify(r).includes('SECRET'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('splitTurnUsage falls back to top-level usage', () => {
  const parts = splitTurnUsage({ inputTokens: 10, outputTokens: 2, costUsdTicks: 1e10 }, 'grok-x');
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.model, 'grok-x');
  assert.equal(parts[0]!.u.costUsdTicks, 1e10);
});

test('missing home yields empty result', async () => {
  const r = await grokParser.load({ paths: { grok: [join(tmpdir(), 'clausage-grok-does-not-exist')] } });
  assert.equal(r.events.length, 0);
  assert.equal(r.sources.length, 0);
});

test('fork that sorts before its parent does not steal the copied turns', async () => {
  const home = mkdtempSync(join(tmpdir(), 'clausage-grok-fork-'));
  try {
    const group = join(home, 'sessions', encodeURIComponent('D:\\Synthetic\\fork'));
    const t0 = Date.parse('2026-02-01T10:00:00.000Z');
    const u = usage({ inputTokens: 100, outputTokens: 5, costUsdTicks: 1e8 });
    const mk = (sid: string, summary: Record<string, unknown>, lines: string[]) => {
      mkdirSync(join(group, sid), { recursive: true });
      writeFileSync(join(group, sid, 'summary.json'), JSON.stringify({ info: { id: sid }, current_model_id: 'grok-test', ...summary }));
      writeFileSync(join(group, sid, 'updates.jsonl'), lines.join('\r\n'));
    };
    // 'a-fork' lists before 'b-parent' on disk
    mk('b-parent', { created_at: '2026-02-01T10:00:00.000Z' }, [
      envelope('b-parent', 1, t0 + 1000, { sessionUpdate: 'turn_completed', prompt_id: 'p1', usage: u }),
    ]);
    mk('a-fork', { parent_session_id: 'b-parent', created_at: '2026-02-01T11:00:00.000Z' }, [
      envelope('a-fork', 1, t0 + 1000, { sessionUpdate: 'turn_completed', prompt_id: 'p1', usage: u }),
      envelope('a-fork', 2, t0 + 3_600_000, { sessionUpdate: 'turn_completed', prompt_id: 'p2', usage: u }),
    ]);
    const r = await grokParser.load({ paths: { grok: [home] } });
    assert.equal(r.events.length, 2);
    assert.equal(r.events.find((e) => e.id.endsWith(':p1:grok-test'))!.sessionId, 'b-parent');
    assert.equal(r.events.find((e) => e.id.endsWith(':p2:grok-test'))!.sessionId, 'a-fork');
    assert.equal(r.sessions.find((s) => s.sessionId === 'b-parent')!.turns, 1);
    assert.equal(r.sessions.find((s) => s.sessionId === 'a-fork')!.turns, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('turn_completed without any timestamp never lands at the epoch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'clausage-grok-nots-'));
  try {
    const dir = join(home, 'sessions', encodeURIComponent('D:\\Synthetic\\nots'), 's-nots');
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      method: '_x.ai/session/update',
      params: { sessionId: 's-nots', update: { sessionUpdate: 'turn_completed', prompt_id: 'p1', usage: usage({ inputTokens: 7 }) }, _meta: {} },
    });
    writeFileSync(join(dir, 'updates.jsonl'), line + '\n{"params":{"update":{"sessionUpdate":"turn_compl');
    const r = await grokParser.load({ paths: { grok: [home] } });
    assert.equal(r.events.length, 1);
    assert.ok(r.events[0]!.timestamp > Date.parse('2020-01-01'));
    assert.equal(r.sessions.length, 1);
    assert.ok(r.sessions[0]!.project.endsWith('nots'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
