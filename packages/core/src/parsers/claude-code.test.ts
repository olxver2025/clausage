import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeCodeParser, parseStatsCache } from './claude-code.js';

const SID = '11111111-2222-3333-4444-555555555555';

function assistant(o: {
  msgId?: string;
  reqId?: string;
  ts: string;
  model?: string;
  content?: unknown[];
  usage?: Record<string, unknown>;
  sidechain?: boolean;
  agentId?: string;
  costUSD?: number;
}) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: SID,
    cwd: 'C:\\work\\proj',
    version: '2.1.0',
    timestamp: o.ts,
    requestId: o.reqId,
    isSidechain: o.sidechain ?? false,
    agentId: o.agentId,
    costUSD: o.costUSD,
    message: {
      id: o.msgId,
      model: o.model ?? 'claude-opus-5-5',
      content: o.content ?? [],
      usage: o.usage ?? {
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
        output_tokens_details: { thinking_tokens: 7 },
        speed: 'standard',
      },
    },
  });
}

function setup(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'clausage-cc-'));
  const proj = path.join(root, 'projects', 'C--work-proj');
  mkdirSync(path.join(proj, SID, 'subagents', 'workflows', 'wf_x'), { recursive: true });
  const main = [
    JSON.stringify({ type: 'custom-title', customTitle: 'My title', sessionId: SID }),
    JSON.stringify({ type: 'user', sessionId: SID, timestamp: '2026-11-01T10:00:00.000Z', message: { content: 'SECRET PROMPT' } }),
    JSON.stringify({ type: 'user', isMeta: true, sessionId: SID, timestamp: '2026-11-01T10:00:00.500Z', message: { content: 'meta' } }),
    // request A split over two lines (thinking + tool_use) with identical usage
    assistant({ msgId: 'msg_A', reqId: 'req_A', ts: '2026-11-01T10:00:01.000Z', content: [{ type: 'thinking', thinking: 'x' }] }),
    assistant({ msgId: 'msg_A', reqId: 'req_A', ts: '2026-11-01T10:00:02.000Z', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash' }] }),
    JSON.stringify({ type: 'user', sessionId: SID, timestamp: '2026-11-01T10:00:03.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } }),
    // legacy recorded cost, no cache_creation split
    assistant({
      msgId: 'msg_B', reqId: 'req_B', ts: '2026-11-01T10:01:00.000Z', costUSD: 0.5,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    }),
    assistant({ msgId: 'msg_S', reqId: 'req_S', ts: '2026-11-01T10:01:30.000Z', model: '<synthetic>' }),
    // idle gap > 5 min
    assistant({ msgId: 'msg_C', reqId: 'req_C', ts: '2026-11-01T11:00:00.000Z' }),
    '{"type":"assistant","trunc', // partial line
  ].join('\n');
  writeFileSync(path.join(proj, `${SID}.jsonl`), main);
  const sub = [
    JSON.stringify({ type: 'agent-name', agentName: 'helper', sessionId: SID }),
    JSON.stringify({ type: 'user', isSidechain: true, agentId: 'abc', sessionId: SID, timestamp: '2026-11-01T10:00:05.000Z', message: { content: 'task' } }),
    assistant({ msgId: 'msg_D', reqId: 'req_D', ts: '2026-11-01T10:00:06.000Z', sidechain: true, agentId: 'abc', content: [{ type: 'tool_use', id: 'toolu_2' }, { type: 'tool_use', id: 'toolu_3' }] }),
    // copy of a parent request (forked history) must be deduped globally
    assistant({ msgId: 'msg_A', reqId: 'req_A', ts: '2026-11-01T10:00:01.000Z', sidechain: true, agentId: 'abc' }),
  ].join('\n');
  writeFileSync(path.join(proj, SID, 'subagents', 'workflows', 'wf_x', 'agent-abc.jsonl'), sub);
  writeFileSync(path.join(proj, SID, 'subagents', 'workflows', 'wf_x', 'journal.jsonl'), '{"type":"launched"}\n');
  writeFileSync(
    path.join(root, 'stats-cache.json'),
    JSON.stringify({
      version: 5,
      dailyActivity: [{ date: '2026-09-01', messageCount: 5, sessionCount: 1, toolCallCount: 2 }],
      dailyModelTokens: [
        { date: '2026-09-01', tokensByModel: { 'claude-x': 1000, 'claude-y': 10 } },
        { date: '2026-11-01', tokensByModel: { 'claude-x': 999999 } }, // covered by transcripts -> skipped
      ],
      modelUsage: {
        'claude-x': { inputTokens: 10, outputTokens: 90, cacheReadInputTokens: 800, cacheCreationInputTokens: 100 },
      },
    }),
  );
  return root;
}

test('claude-code parser: dedupe, mapping, sessions, historical', async () => {
  const root = setup();
  try {
    const r = await claudeCodeParser.load({ paths: { 'claude-code': [root] } });
    assert.equal(r.tool, 'claude-code');
    assert.deepEqual(r.sources, [path.resolve(root)]);
    const ids = r.events.map((e) => e.id).sort();
    assert.deepEqual(ids, ['claude-code:msg_A:req_A', 'claude-code:msg_B:req_B', 'claude-code:msg_C:req_C', 'claude-code:msg_D:req_D']);

    const a = r.events.find((e) => e.id.endsWith('msg_A:req_A'))!;
    assert.equal(a.inputTokens, 10);
    assert.equal(a.outputTokens, 100);
    assert.equal(a.cacheReadTokens, 1000);
    assert.equal(a.cacheWriteTokens, 300);
    assert.equal(a.cacheWrite1hTokens, 100);
    assert.equal(a.reasoningTokens, 7);
    assert.equal(a.speed, 'standard');
    assert.equal(a.sessionId, SID);
    assert.equal(a.isSubagent, false);
    assert.equal(a.project, path.resolve('C:\\work\\proj'));
    assert.equal(a.timestamp, Date.parse('2026-11-01T10:00:01.000Z'));

    const b = r.events.find((e) => e.id.endsWith('msg_B:req_B'))!;
    assert.equal(b.recordedCostUSD, 0.5);
    assert.equal(b.cacheWrite1hTokens, 0);
    assert.equal(b.reasoningTokens, 0);

    const d = r.events.find((e) => e.id.endsWith('msg_D:req_D'))!;
    assert.equal(d.sessionId, `${SID}:abc`);
    assert.equal(d.rootSessionId, SID);
    assert.equal(d.isSubagent, true);

    assert.equal(r.sessions.length, 2);
    const main = r.sessions.find((s) => s.sessionId === SID)!;
    assert.equal(main.title, 'My title');
    assert.equal(main.userMessages, 1);
    assert.equal(main.assistantMessages, 3);
    assert.equal(main.toolCalls, 1);
    assert.equal(main.version, '2.1.0');
    assert.deepEqual(main.models, ['claude-opus-5-5']);
    // 10:00:00 -> 10:01:30 active (all gaps < 5min), then idle gap to 11:00
    assert.equal(main.activeMs, 90_000);
    assert.equal(main.startedAt, Date.parse('2026-11-01T10:00:00.000Z'));
    assert.equal(main.endedAt, Date.parse('2026-11-01T11:00:00.000Z'));

    const sub = r.sessions.find((s) => s.isSubagent)!;
    assert.equal(sub.rootSessionId, SID);
    assert.equal(sub.title, 'helper');
    assert.equal(sub.userMessages, 0);
    assert.equal(sub.turns, 1);
    assert.equal(sub.toolCalls, 2);
    assert.equal(sub.assistantMessages, 1);

    // historical only for 2026-09-01
    assert.deepEqual([...new Set(r.historical.map((h) => h.date))], ['2026-09-01']);
    const x = r.historical.find((h) => h.model === 'claude-x')!;
    assert.equal(x.inputTokens + x.outputTokens + x.cacheReadTokens + x.cacheWriteTokens, 1000);
    assert.equal(x.inputTokens, 10);
    assert.equal(x.outputTokens, 90);
    assert.equal(x.cacheWriteTokens, 100);
    assert.equal(x.messages, 5);
    assert.equal(x.source, 'stats-cache');
    const y = r.historical.find((h) => h.model === 'claude-y')!;
    assert.equal(y.inputTokens, 10); // no modelUsage -> all as input
    assert.equal(y.messages, undefined);

    // privacy: no prompt text anywhere in the output
    assert.ok(!JSON.stringify(r).includes('SECRET PROMPT'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseStatsCache tolerates garbage', () => {
  assert.deepEqual(parseStatsCache(null, new Set()), []);
  assert.deepEqual(parseStatsCache({ dailyModelTokens: 'x' }, new Set()), []);
});

test('missing root yields empty result', async () => {
  const r = await claudeCodeParser.load({ paths: { 'claude-code': [path.join(tmpdir(), 'does-not-exist-clausage')] } });
  assert.equal(r.events.length, 0);
  assert.equal(r.sources.length, 0);
});

test('forked / resumed history stays with the original session regardless of file name order', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clausage-cc-fork-'));
  try {
    const proj = path.join(root, 'projects', 'D--x');
    mkdirSync(proj, { recursive: true });
    const FORK = 'aaaaaaaa-0000-0000-0000-000000000000'; // sorts before ORIG by name
    const ORIG = 'bbbbbbbb-0000-0000-0000-000000000000';
    const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
    const asst = (sid: string, n: number, ts: string, uuid: string) =>
      JSON.stringify({ type: 'assistant', sessionId: sid, uuid, cwd: 'D:/x', timestamp: ts, requestId: `r${n}`, message: { id: `m${n}`, model: 'claude-opus-5-5', usage, content: [{ type: 'tool_use', id: `toolu_${n}` }] } });
    const user = (sid: string, ts: string, uuid: string) =>
      JSON.stringify({ type: 'user', sessionId: sid, uuid, timestamp: ts, message: { content: 'x' } });
    writeFileSync(path.join(proj, `${ORIG}.jsonl`), [user(ORIG, '2026-11-01T10:00:00Z', 'u1'), asst(ORIG, 1, '2026-11-01T10:00:01Z', 'a1')].join('\n'));
    // fork copies the history verbatim (same uuids) and continues the next day; CRLF + truncated tail
    writeFileSync(
      path.join(proj, `${FORK}.jsonl`),
      [user(FORK, '2026-11-01T10:00:00Z', 'u1'), asst(FORK, 1, '2026-11-01T10:00:01Z', 'a1'), user(FORK, '2026-11-02T10:00:00Z', 'u2'), asst(FORK, 2, '2026-11-02T10:00:05Z', 'a2'), '{"type":"assi'].join('\r\n'),
    );
    const r = await claudeCodeParser.load({ paths: { 'claude-code': [root] } });
    const owner = Object.fromEntries(r.events.map((e) => [e.id, e.sessionId]));
    assert.deepEqual(owner, { 'claude-code:m1:r1': ORIG, 'claude-code:m2:r2': FORK });
    const orig = r.sessions.find((s) => s.sessionId === ORIG)!;
    const fork = r.sessions.find((s) => s.sessionId === FORK)!;
    assert.equal(orig.assistantMessages, 1);
    assert.equal(orig.toolCalls, 1);
    assert.equal(orig.userMessages, 1);
    assert.equal(fork.assistantMessages, 1);
    assert.equal(fork.toolCalls, 1);
    assert.equal(fork.userMessages, 1);
    assert.equal(fork.startedAt, Date.parse('2026-11-02T10:00:00Z'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
