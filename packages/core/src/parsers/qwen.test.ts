import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qwenOutputTokens, qwenParser } from './qwen.js';

const T0 = Date.parse('2026-10-03T08:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

let seq = 0;
function rec(sessionId: string, ts: number, type: string, over: Record<string, unknown> = {}) {
  return { uuid: `u-${++seq}`, parentUuid: null, sessionId, timestamp: iso(ts), type, cwd: '/synthetic/qwen-proj', version: '0.9.1', ...over };
}
function asst(sessionId: string, ts: number, usageMetadata: Record<string, number>, over: Record<string, unknown> = {}) {
  return rec(sessionId, ts, 'assistant', {
    model: 'qwen3-coder-plus',
    message: { role: 'model', parts: [{ text: 'private answer' }, { thought: true, text: 'private thought' }, { functionCall: { name: 'run_shell_command', args: { command: 'cat secret.env' } } }] },
    usageMetadata,
    ...over,
  });
}
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

test('qwen parser: usage mapping, dedupe, title, sub-session, privacy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-qwen-test-'));
  try {
    const q = join(dir, '.qwen');
    const chats = join(q, 'projects', '-synthetic-qwen-proj', 'chats');
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(q, 'settings.json'), JSON.stringify({ apiKey: 'SHOULD-NEVER-BE-READ' }));
    writeFileSync(join(q, 'oauth_creds.json'), JSON.stringify({ access_token: 'SHOULD-NEVER-BE-READ' }));

    const user = rec('s-1', T0, 'user', { message: { role: 'user', parts: [{ text: 'private prompt' }] }, executionContext: { modelId: 'qwen3-coder-plus', authType: 'qwen-oauth', approvalMode: 'default' } });
    // OpenAI-style: total = prompt + candidates, thoughts are inside candidates
    const a1 = asst('s-1', T0 + 4000, { promptTokenCount: 12000, candidatesTokenCount: 500, thoughtsTokenCount: 200, cachedContentTokenCount: 9000, totalTokenCount: 12500 });
    const tool = rec('s-1', T0 + 5000, 'tool_result', { toolCallResult: { callId: 'c1', status: 'success', resultDisplay: 'private output' } });
    // no total: falls back to the auth type (qwen-oauth includes thoughts in candidates)
    const a2 = asst('s-1', T0 + 9000, { promptTokenCount: 13000, candidatesTokenCount: 80, thoughtsTokenCount: 30, cachedContentTokenCount: 12000 });
    // subagent record in the same file
    const a3 = asst('s-1', T0 + 10000, { promptTokenCount: 400, candidatesTokenCount: 40, totalTokenCount: 440 }, { isSidechain: true, agentId: 'explore-1', model: 'qwen3-coder-flash' });
    const title = rec('s-1', T0 + 11000, 'system', { subtype: 'custom_title', systemPayload: { customTitle: 'Refactor the parser', titleSource: 'auto' } });
    const later = rec('s-1', T0 + 12000, 'system', { subtype: 'custom_title', systemPayload: { customTitle: 'Refactor the loader', titleSource: 'manual' } });
    writeFileSync(join(chats, 's-1.jsonl'), jsonl([user, a1, tool, a2, a3, title, later]) + '{"uuid":"half');

    // a forked session that copies earlier records (same uuids) and adds one of its own
    const a4 = asst('s-2', T0 + 60000, { promptTokenCount: 700, candidatesTokenCount: 50, thoughtsTokenCount: 25, cachedContentTokenCount: 0, totalTokenCount: 775 }, { model: 'gemini-2.5-pro' });
    const forkUser = rec('s-2', T0 + 59000, 'user', { message: { role: 'user', parts: [{ text: 'private prompt 2' }] }, executionContext: { modelId: 'gemini-2.5-pro', authType: 'gemini', approvalMode: 'default' } });
    writeFileSync(join(chats, 's-2.jsonl'), jsonl([{ ...user, sessionId: 's-2' }, { ...a1, sessionId: 's-2' }, forkUser, a4]));

    // a sub-session spawned by s-1
    const otherChats = join(q, 'projects', '-synthetic-other', 'chats');
    mkdirSync(otherChats, { recursive: true });
    writeFileSync(
      join(otherChats, 'child.jsonl'),
      jsonl([
        rec('child', T0 + 20000, 'system', { subtype: 'parent_session', systemPayload: { parentSessionId: 's-1' }, cwd: '/synthetic/other' }),
        asst('child', T0 + 21000, { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 }, { cwd: '/synthetic/other' }),
      ]),
    );
    // files outside a chats/ dir are ignored
    writeFileSync(join(q, 'projects', '-synthetic-qwen-proj', 'notes.jsonl'), jsonl([asst('zzz', T0, { promptTokenCount: 9, candidatesTokenCount: 9 })]));

    const warnings: string[] = [];
    const r = await qwenParser.load({ paths: { qwen: [q] }, warn: (m) => warnings.push(m) });
    assert.equal(r.tool, 'qwen');
    assert.deepEqual(warnings, []);
    assert.deepEqual(r.sources, [q]);
    assert.equal(r.events.length, 5); // a1 once (not again from the fork), a2, a3, a4, child

    const e1 = r.events.find((e) => e.id === `qwen:s-1:${a1.uuid}`)!;
    assert.equal(e1.inputTokens, 3000);
    assert.equal(e1.cacheReadTokens, 9000);
    assert.equal(e1.outputTokens, 500); // thoughts already inside candidates
    assert.equal(e1.reasoningTokens, 200);
    assert.equal(e1.inputTokens + e1.cacheReadTokens + e1.outputTokens, 12500); // = totalTokenCount
    assert.equal(e1.project, '/synthetic/qwen-proj');
    assert.equal(e1.provider, 'alibaba');
    assert.equal(e1.isSubagent, false);

    const e2 = r.events.find((e) => e.id === `qwen:s-1:${a2.uuid}`)!;
    assert.equal(e2.inputTokens, 1000);
    assert.equal(e2.outputTokens, 80);

    const e3 = r.events.find((e) => e.id === `qwen:s-1:${a3.uuid}`)!;
    assert.equal(e3.isSubagent, true);
    assert.equal(e3.rootSessionId, 's-1');
    assert.equal(e3.model, 'qwen3-coder-flash');

    const e4 = r.events.find((e) => e.id === `qwen:s-2:${a4.uuid}`)!;
    assert.equal(e4.outputTokens, 75); // Gemini-style: thoughts separate (total decides)
    assert.equal(e4.reasoningTokens, 25);
    assert.equal(e4.provider, undefined);

    const child = r.events.find((e) => e.sessionId === 'child')!;
    assert.equal(child.rootSessionId, 's-1');
    assert.equal(child.isSubagent, true);
    assert.equal(child.project, '/synthetic/other');

    const s1 = r.sessions.find((s) => s.sessionId === 's-1')!;
    assert.equal(s1.title, 'Refactor the loader');
    assert.equal(s1.userMessages, 1);
    assert.equal(s1.assistantMessages, 3);
    assert.equal(s1.toolCalls, 1);
    assert.equal(s1.startedAt, T0);
    assert.equal(s1.endedAt, T0 + 10000);
    assert.equal(s1.activeMs, 10000);
    assert.equal(s1.version, '0.9.1');
    assert.deepEqual(s1.models.sort(), ['qwen3-coder-flash', 'qwen3-coder-plus']);
    const sc = r.sessions.find((s) => s.sessionId === 'child')!;
    assert.equal(sc.isSubagent, true);
    assert.equal(sc.rootSessionId, 's-1');
    assert.equal(r.sessions.length, 3);

    const dump = JSON.stringify({ events: r.events, sessions: r.sessions });
    for (const secret of ['private prompt', 'private answer', 'private thought', 'private output', 'secret.env', 'SHOULD-NEVER-BE-READ']) assert.ok(!dump.includes(secret), secret);

    const bounded = await qwenParser.load({ paths: { qwen: [q] }, until: T0 + 9500 });
    assert.equal(bounded.events.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen parser: output token convention', () => {
  const u = { prompt: 100, candidates: 50, thoughts: 20, cached: 0, total: 0 };
  assert.equal(qwenOutputTokens(u, 'openai'), 50);
  assert.equal(qwenOutputTokens(u, 'gemini'), 70);
  assert.equal(qwenOutputTokens(u, undefined), 70);
  assert.equal(qwenOutputTokens({ ...u, total: 170 }, 'openai'), 70); // total wins over the convention
  assert.equal(qwenOutputTokens({ ...u, total: 150 }, 'gemini'), 50);
  assert.equal(qwenOutputTokens({ prompt: 0, candidates: 0, thoughts: 0, cached: 0, total: 33 }, 'openai'), 33);
});

test('qwen parser: env overrides', () => {
  const keys = ['QWEN_DATA_DIR', 'QWEN_RUNTIME_DIR', 'QWEN_HOME'] as const;
  const prev = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    process.env.QWEN_HOME = '/nonexistent/qwen-home';
    process.env.QWEN_RUNTIME_DIR = '/nonexistent/qwen-runtime';
    assert.deepEqual(qwenParser.defaultPaths(), ['/nonexistent/qwen-runtime', '/nonexistent/qwen-home']);
  } finally {
    keys.forEach((k, i) => (prev[i] === undefined ? delete process.env[k] : (process.env[k] = prev[i])));
  }
});
