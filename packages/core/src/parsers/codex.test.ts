import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { codexParser, parseCodexRolloutLines, readCodexRateLimits } from './codex.js';

const zstd = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;

const U = (input: number, cached: number, output: number, reasoning = 0) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});

let ordinal = 0;
const line = (ts: string, type: string, payload: unknown) =>
  JSON.stringify({ timestamp: ts, ordinal: ordinal++, type, payload });

const PARENT = '01aaaaaa-0000-7000-8000-000000000001';
const CHILD = '01aaaaaa-0000-7000-8000-000000000002';
const OLD = '01aaaaaa-0000-7000-8000-000000000003';

function parentRollout(): string {
  ordinal = 0;
  return [
    line('2026-10-01T10:00:00.000Z', 'session_meta', {
      id: PARENT, session_id: PARENT, cwd: '/work/proj', cli_version: '0.166.0', source: 'vscode',
      thread_source: 'user', model_provider: 'openai', base_instructions: { text: 'SECRET-INSTRUCTIONS' },
    }),
    line('2026-10-01T10:00:01.000Z', 'event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'm-settings', service_tier: 'priority' } }),
    line('2026-10-01T10:00:01.000Z', 'event_msg', { type: 'task_started', turn_id: 't1' }),
    line('2026-10-01T10:00:02.000Z', 'turn_context', { turn_id: 't1', model: 'model-a', cwd: '/work/proj' }),
    line('2026-10-01T10:00:02.000Z', 'event_msg', { type: 'item_completed', item: { type: 'UserMessage', text: 'SECRET-PROMPT' } }),
    line('2026-10-01T10:00:03.000Z', 'response_item', { type: 'function_call', name: 'exec', call_id: 'c1', arguments: 'SECRET-ARGS' }),
    line('2026-10-01T10:00:04.000Z', 'response_item', { type: 'custom_tool_call', name: ' apply_patch ', call_id: 'c2', input: 'SECRET-PATCH' }),
    line('2026-10-01T10:00:04.000Z', 'response_item', { type: 'function_call', namespace: 'mcp__github', name: 'create_pr', call_id: 'c3', arguments: 'SECRET-ARGS' }),
    line('2026-10-01T10:00:04.000Z', 'response_item', { type: 'function_call', namespace: 'mcp__github', name: 'create_pr', call_id: 'c3', arguments: 'SECRET-ARGS' }),
    line('2026-10-01T10:00:04.000Z', 'response_item', { type: 'local_shell_call', call_id: 'c4', action: { command: ['SECRET-CMD'] } }),
    line('2026-10-01T10:00:04.000Z', 'response_item', { type: 'function_call', name: { not: 'a string' }, call_id: 'c5' }),
    line('2026-10-01T10:00:05.000Z', 'token_usage_record', { thread_id: PARENT, turn_id: 't1', response_id: 'r1', usage: U(1000, 800, 50, 10) }),
    line('2026-10-01T10:00:05.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: U(1000, 800, 50, 10), last_token_usage: U(1000, 800, 50, 10) } }),
    line('2026-10-01T10:00:06.000Z', 'event_msg', { type: 'item_completed', item: { type: 'AgentMessage', text: 'SECRET-ANSWER' } }),
    line('2026-10-01T10:00:07.000Z', 'event_msg', { type: 'task_complete', turn_id: 't1', duration_ms: 6000, last_agent_message: 'SECRET' }),
    // compaction record for turn t2 appears BEFORE t2's turn_context
    line('2026-10-02T09:00:00.000Z', 'token_usage_record', { thread_id: PARENT, turn_id: 't2', response_id: 'r2', usage: U(500, 0, 20) }),
    line('2026-10-02T09:00:00.000Z', 'event_msg', { type: 'task_started', turn_id: 't2' }),
    line('2026-10-02T09:00:01.000Z', 'turn_context', { turn_id: 't2', model: 'model-b', cwd: '/work/proj' }),
    line('2026-10-02T09:00:02.000Z', 'token_usage_record', { thread_id: PARENT, turn_id: 't2', response_id: 'r3', usage: U(2000, 1500, 100, 40) }),
    line('2026-10-02T09:00:03.000Z', 'event_msg', {
      type: 'token_count', info: { total_token_usage: U(3000, 2300, 150, 50), last_token_usage: U(2000, 1500, 100, 40) },
      rate_limits: { limit_id: 'codex', primary: { used_percent: 12, window_minutes: 300, resets_at: 1790000000 },
        secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1790500000 }, credits: { balance: '99.00' }, plan_type: 'plus' },
    }),
    line('2026-10-02T09:00:04.000Z', 'event_msg', { type: 'turn_aborted', turn_id: 't2', reason: 'interrupted', duration_ms: 4000 }),
  ].join('\n') + '\n{"timestamp":"2026-10-02T09:00:05.000Z","type":"event_ms'; // truncated live line
}

function childRollout(): string {
  ordinal = 0;
  return [
    line('2026-10-01T11:00:00.000Z', 'session_meta', {
      id: CHILD, session_id: PARENT, parent_thread_id: PARENT, cwd: '/work/proj', thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } }, subagent_history_start_ordinal: 3,
    }),
    line('2026-10-01T11:00:00.000Z', 'session_meta', { id: PARENT, session_id: PARENT }),
    // copied parent history: inherited cumulative snapshot and a copied record
    line('2026-10-01T10:00:05.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: U(1000, 800, 50, 10) } }),
    line('2026-10-01T11:00:01.000Z', 'event_msg', { type: 'task_started', turn_id: 'c-t1' }),
    line('2026-10-01T11:00:01.000Z', 'turn_context', { turn_id: 'c-t1', model: 'model-a' }),
    line('2026-10-01T11:00:02.000Z', 'token_usage_record', { thread_id: CHILD, turn_id: 'c-t1', response_id: 'cr1', usage: U(300, 100, 30) }),
    line('2026-10-01T11:00:03.000Z', 'event_msg', { type: 'task_complete', turn_id: 'c-t1', duration_ms: 2000 }),
  ].join('\n') + '\n';
}

/** Older rollout without token_usage_record: token_count deltas with baseline + compaction. */
function oldRollout(): string {
  ordinal = 0;
  return [
    line('2026-09-01T08:00:00.000Z', 'session_meta', {
      id: OLD, session_id: OLD, cwd: '/work/other', thread_source: 'guardian_review',
      source: { subagent: { other: 'guardian' } }, subagent_history_start_ordinal: 99999,
    }),
    // inherited baseline before first task_started (start ordinal is past EOF -> ignored)
    line('2026-09-01T08:00:00.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: U(5000, 4000, 100) } }),
    line('2026-09-01T08:00:01.000Z', 'event_msg', { type: 'task_started', turn_id: 'o1' }),
    line('2026-09-01T08:00:01.000Z', 'turn_context', { turn_id: 'o1', model: 'old-model' }),
    line('2026-09-01T08:00:02.000Z', 'event_msg', { type: 'token_count', info: null }),
    line('2026-09-01T08:00:03.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: U(5600, 4400, 130), last_token_usage: U(600, 400, 30) } }),
    // duplicate re-emission
    line('2026-09-01T08:00:04.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: U(5600, 4400, 130), last_token_usage: U(0, 0, 0) } }),
    // a dropped token_count: delta (2000) > last (900)
    line('2026-09-01T08:00:05.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: U(7500, 5800, 230), last_token_usage: U(900, 700, 50) } }),
    line('2026-09-01T08:00:06.000Z', 'compacted', {
      compaction_response_id: 'comp1', replacement_history: [{ text: 'SECRET' }],
      latest_token_usage_record: { thread_id: OLD, turn_id: 'o1', response_id: 'comp1', usage: U(700, 100, 7) },
    }),
    line('2026-09-01T08:00:07.000Z', 'event_msg', { type: 'task_complete', turn_id: 'o1', duration_ms: 6000 }),
  ].join('\n') + '\n';
}

function makeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clausage-codex-'));
  const day = path.join(home, 'sessions', '2026', '10', '01');
  mkdirSync(day, { recursive: true });
  mkdirSync(path.join(home, 'archived_sessions'), { recursive: true });
  const p = parentRollout();
  // live .jsonl (complete) and an older, shorter compressed copy of the same rollout
  writeFileSync(path.join(day, `rollout-2026-10-01T10-00-00-${PARENT}.jsonl`), p);
  const shorter = p.split('\n').slice(0, 9).join('\n') + '\n';
  if (zstd) writeFileSync(path.join(day, `rollout-2026-10-01T10-00-00-${PARENT}.jsonl.zst`), zstd(Buffer.from(shorter)));
  else writeFileSync(path.join(home, 'archived_sessions', `rollout-2026-10-01T10-00-00-${PARENT}.jsonl`), shorter);
  const c = childRollout();
  if (zstd) writeFileSync(path.join(day, `rollout-2026-10-01T11-00-00-${CHILD}.jsonl.zst`), zstd(Buffer.from(c)));
  else writeFileSync(path.join(day, `rollout-2026-10-01T11-00-00-${CHILD}.jsonl`), c);
  writeFileSync(path.join(home, 'archived_sessions', `rollout-2026-09-01T08-00-00-${OLD}.jsonl`), oldRollout());
  writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: PARENT, thread_name: 'Parent title', updated_at: '2026-10-02T00:00:00Z' }) + '\n');
  return home;
}

test('codex parser: records, fork baseline, token_count fallback, sessions', async () => {
  const home = makeHome();
  try {
    const r = await codexParser.load({ paths: { codex: [home] } });
    assert.equal(r.tool, 'codex');
    assert.equal(r.sources.length, 1);
    assert.equal(r.sessions.length, 3);

    const parentEv = r.events.filter((e) => e.sessionId === PARENT);
    assert.deepEqual(parentEv.map((e) => e.id), ['codex:r1', 'codex:r2', 'codex:r3']);
    const r1 = parentEv[0]!;
    assert.equal(r1.model, 'model-a');
    assert.equal(r1.inputTokens, 200);
    assert.equal(r1.cacheReadTokens, 800);
    assert.equal(r1.outputTokens, 50);
    assert.equal(r1.reasoningTokens, 10);
    assert.equal(r1.speed, 'priority');
    assert.equal(r1.provider, 'openai');
    assert.equal(r1.project, path.resolve('/work/proj'));
    assert.equal(r1.isSubagent, false);
    // compaction record mapped to its turn's model even though turn_context comes later
    assert.equal(parentEv[1]!.model, 'model-b');
    assert.equal(parentEv[2]!.model, 'model-b');

    const childEv = r.events.filter((e) => e.sessionId === CHILD);
    assert.equal(childEv.length, 1);
    assert.equal(childEv[0]!.rootSessionId, PARENT);
    assert.equal(childEv[0]!.isSubagent, true);
    assert.equal(childEv[0]!.inputTokens + childEv[0]!.cacheReadTokens + childEv[0]!.outputTokens, 330);

    const oldEv = r.events.filter((e) => e.sessionId === OLD);
    const tot = oldEv.reduce((a, e) => a + e.inputTokens + e.cacheReadTokens + e.outputTokens, 0);
    // deltas 630 + 2000 (baseline 5100 excluded, duplicate skipped) + compaction 707
    assert.equal(tot, 630 + 2000 + 707);
    assert.equal(oldEv.reduce((a, e) => a + e.cacheReadTokens, 0), 400 + 1400 + 100);
    assert.ok(oldEv.every((e) => e.model === 'old-model' && e.isSubagent));

    const ps = r.sessions.find((s) => s.sessionId === PARENT)!;
    assert.equal(ps.title, 'Parent title');
    assert.equal(ps.turns, 2);
    assert.equal(ps.activeMs, 10000);
    assert.equal(ps.toolCalls, 5);
    // names only (trimmed; MCP namespace joined; unnamed built-ins by item type; non-strings ignored)
    assert.deepEqual(ps.toolCallsByName, { apply_patch: 1, exec: 1, local_shell: 1, mcp__github__create_pr: 1 });
    assert.equal(ps.userMessages, 1);
    assert.equal(ps.assistantMessages, 1);
    assert.equal(ps.version, '0.166.0');
    assert.deepEqual(ps.models.sort(), ['model-a', 'model-b']);
    assert.equal(ps.startedAt, Date.parse('2026-10-01T10:00:00.000Z'));
    assert.equal(ps.endedAt, Date.parse('2026-10-02T09:00:04.000Z'));

    const cs = r.sessions.find((s) => s.sessionId === CHILD)!;
    assert.equal(cs.turns, 1);
    assert.equal(cs.activeMs, 2000);

    // privacy: no text from prompts / instructions / balances leaks into results
    const dump = JSON.stringify(r);
    assert.ok(!dump.includes('SECRET'));
    assert.ok(!dump.includes('99.00'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex token_count method agrees with record method on the same rollout', () => {
  const lines = parentRollout().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const a = parseCodexRolloutLines(lines, { seenResponseIds: new Set() });
  const b = parseCodexRolloutLines(lines, { seenResponseIds: new Set() }, { forceTokenCount: true });
  assert.equal(a.method, 'records');
  assert.equal(b.method, 'token_count');
  const sum = (ev: typeof a.events) => ev.reduce((x, e) => x + e.inputTokens + e.cacheReadTokens + e.outputTokens, 0);
  // the record method also sees the compaction response r2 (520) which token_count misses here
  assert.equal(sum(a.events), sum(b.events) + 520);
});

test('readCodexRateLimits returns the latest snapshot without balances', async () => {
  const home = makeHome();
  try {
    const rl = await readCodexRateLimits({ paths: [home] });
    assert.ok(rl);
    assert.equal(rl.plan_type, 'plus');
    assert.equal(rl.primary?.used_percent, 12);
    assert.equal(rl.secondary?.window_minutes, 10080);
    assert.equal(rl.timestamp, Date.parse('2026-10-02T09:00:03.000Z'));
    assert.ok(!JSON.stringify(rl).includes('balance'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex defaultPaths honours CODEX_HOME', () => {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(os.tmpdir(), 'a') + ',' + path.join(os.tmpdir(), 'b');
  try {
    assert.deepEqual(codexParser.defaultPaths(), [path.resolve(os.tmpdir(), 'a'), path.resolve(os.tmpdir(), 'b')]);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

const parseRaw = (raw: string) =>
  raw.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
const tokSum = (ev: Array<{ inputTokens: number; cacheReadTokens: number; outputTokens: number }>) =>
  ev.reduce((x, e) => x + e.inputTokens + e.cacheReadTokens + e.outputTokens, 0);

test('codex token_count: rollout without any task_started still counts usage', () => {
  ordinal = 0;
  const id = '01aaaaaa-0000-7000-8000-000000000010';
  const raw = [
    line('2025-06-01T08:00:00.000Z', 'session_meta', { id, session_id: id, cwd: '/w' }),
    line('2025-06-01T08:00:01.000Z', 'turn_context', { model: 'legacy-model' }),
    line('2025-06-01T08:00:02.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: U(1000, 600, 40), last_token_usage: U(1000, 600, 40) } }),
    line('2025-06-01T08:00:03.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: U(2500, 1600, 90), last_token_usage: U(1500, 1000, 50) } }),
  ].join('\n');
  const r = parseCodexRolloutLines(parseRaw(raw), { seenResponseIds: new Set() });
  assert.equal(r.method, 'token_count');
  assert.equal(tokSum(r.events), 2590);
  assert.ok(r.events.every((e) => e.model === 'legacy-model'));
});

test('codex token_count: counter reset is rebased instead of dropping later usage', () => {
  ordinal = 0;
  const id = '01aaaaaa-0000-7000-8000-000000000011';
  const raw = [
    line('2026-06-01T08:00:00.000Z', 'session_meta', { id, session_id: id }),
    line('2026-06-01T08:00:01.000Z', 'event_msg', { type: 'task_started', turn_id: 'a' }),
    line('2026-06-01T08:00:01.000Z', 'turn_context', { turn_id: 'a', model: 'm' }),
    line('2026-06-01T08:00:02.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: U(5000, 0, 100), last_token_usage: U(5000, 0, 100) } }),
    // process restarted: cumulative counter starts again from this response
    line('2026-06-01T09:00:02.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: U(300, 0, 10), last_token_usage: U(300, 0, 10) } }),
    line('2026-06-01T09:00:03.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: U(800, 0, 30), last_token_usage: U(500, 0, 20) } }),
  ].join('\n');
  const r = parseCodexRolloutLines(parseRaw(raw), { seenResponseIds: new Set() });
  assert.equal(tokSum(r.events), 5100 + 310 + 520);
});

test('codex: thread resumed by a newer CLI counts the token_count-only segment once', () => {
  ordinal = 0;
  const id = '01aaaaaa-0000-7000-8000-000000000012';
  const raw = [
    line('2026-06-01T08:00:00.000Z', 'session_meta', { id, session_id: id }),
    // old CLI segment: no task_started persisted, no records
    line('2026-06-01T08:00:01.000Z', 'turn_context', { model: 'old' }),
    line('2026-06-01T08:00:02.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: U(1000, 500, 50), last_token_usage: U(1000, 500, 50) } }),
    // newer CLI: per-turn records plus cumulative token_count continuing from 1050
    line('2026-07-01T08:00:00.000Z', 'event_msg', { type: 'task_started', turn_id: 'n1' }),
    line('2026-07-01T08:00:00.000Z', 'turn_context', { turn_id: 'n1', model: 'new' }),
    line('2026-07-01T08:00:01.000Z', 'token_usage_record', { thread_id: id, turn_id: 'n1', response_id: 'nr1', usage: U(2000, 1000, 100) }),
    line('2026-07-01T08:00:01.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: U(3000, 1500, 150), last_token_usage: U(2000, 1000, 100) } }),
  ].join('\n');
  const r = parseCodexRolloutLines(parseRaw(raw), { seenResponseIds: new Set() });
  assert.equal(r.method, 'records');
  assert.equal(tokSum(r.events), 1050 + 2100);
  assert.deepEqual(r.events.map((e) => e.model).sort(), ['new', 'old']);
});

test('Codex retains tier changes, with response metadata overriding only its own request', () => {
  const ts = '2026-11-15T10:00:00Z';
  const settings = (tier?: string) => line(ts, 'event_msg', {
    type: 'thread_settings_applied', thread_settings: { service_tier: tier },
  });
  const request = (service_tier?: string) => line(ts, 'token_usage_record', { usage: { ...U(5, 0, 1), service_tier } });
  const raw = [line(ts, 'session_meta', { id: PARENT }), settings('priority'), request(),
    settings('ultrafast'), request('default'), request(), settings(), request()].join('\n');
  const result = parseCodexRolloutLines(parseRaw(raw), { seenResponseIds: new Set() });
  assert.deepEqual(result.events.map((e) => e.speed), ['priority', 'default', 'ultrafast', undefined]);
});
