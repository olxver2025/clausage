import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { geminiParser } from './gemini.js';

const T0 = Date.parse('2026-10-02T09:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function gem(id: string, ts: number, tokens: Record<string, number> | null, over: Record<string, unknown> = {}) {
  return {
    id,
    timestamp: iso(ts),
    type: 'gemini',
    content: [{ text: 'private answer text' }],
    thoughts: [{ subject: 'private', description: 'private thoughts', timestamp: iso(ts) }],
    toolCalls: [{ id: 't1', name: 'run_shell_command', args: { command: 'cat secret.env' }, status: 'success', timestamp: iso(ts), result: [{ text: 'private output' }] }],
    model: 'gemini-3-pro-preview',
    ...(tokens ? { tokens } : {}),
    ...over,
  };
}

test('gemini parser: JSONL + legacy JSON + subagent, token normalisation, privacy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-gemini-test-'));
  try {
    const g = join(dir, '.gemini');
    const chats = join(g, 'tmp', 'my-proj', 'chats');
    mkdirSync(join(chats, 'sess-1'), { recursive: true });
    writeFileSync(join(g, 'tmp', 'my-proj', '.project_root'), '/synthetic/gem\n');
    writeFileSync(join(g, 'oauth_creds.json'), JSON.stringify({ access_token: 'SHOULD-NEVER-BE-READ' }));
    writeFileSync(join(g, 'settings.json'), JSON.stringify({ apiKey: 'SHOULD-NEVER-BE-READ' }));
    // an unrelated folder under ~/.gemini must be ignored
    mkdirSync(join(g, 'antigravity-cli', 'chats'), { recursive: true });
    writeFileSync(join(g, 'antigravity-cli', 'chats', 'session-x.jsonl'), JSON.stringify(gem('zzz', T0, { input: 9, output: 9, cached: 0, total: 18 })) + '\n');

    const lines = [
      { sessionId: 'sess-1', projectHash: 'abc', startTime: iso(T0), lastUpdated: iso(T0), kind: 'main' },
      { id: 'u1', timestamp: iso(T0 + 1000), type: 'user', content: [{ text: 'private prompt text' }] },
      // first written without tokens, then re-appended with tokens (same id)
      gem('g1', T0 + 5000, null),
      gem('g1', T0 + 5000, { input: 12000, output: 300, cached: 8000, thoughts: 700, tool: 0, total: 13000 }),
      { $patch: { id: 'g1', content: [{ text: 'private patched text' }] } },
      gem('g2', T0 + 60000, { input: 500, output: 20, cached: 0, thoughts: 0, tool: 40, total: 560 }, { model: 'gemini-3-flash-preview', toolCalls: [] }),
      { $rewindTo: 'g1' },
      { $set: { lastUpdated: iso(T0 + 120000), summary: 'Add retry logic' } },
      { id: 'i1', timestamp: iso(T0 + 61000), type: 'info', content: 'private info' },
    ];
    writeFileSync(join(chats, 'session-2026-10-02T09-00-sess-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"id":"half');

    writeFileSync(
      join(chats, 'sess-1', 'sub-1.jsonl'),
      [
        { sessionId: 'sub-1', projectHash: 'abc', startTime: iso(T0 + 10000), lastUpdated: iso(T0 + 20000), kind: 'subagent' },
        gem('s1', T0 + 15000, { input: 100, output: 10, cached: 0, thoughts: 5, total: 115 }),
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    );

    // legacy whole-file JSON recording in a project dir without a marker (hash id)
    const legacyChats = join(g, 'tmp', 'a'.repeat(64), 'chats');
    mkdirSync(legacyChats, { recursive: true });
    writeFileSync(
      join(legacyChats, 'session-2026-09-01T08-00-old1.json'),
      JSON.stringify({
        sessionId: 'old-1',
        projectHash: 'a'.repeat(64),
        startTime: iso(T0 - 86400000),
        lastUpdated: iso(T0 - 86000000),
        messages: [
          { id: 'ou1', timestamp: iso(T0 - 86400000), type: 'user', content: 'private prompt text' },
          gem('og1', T0 - 86300000, { input: 50, output: 5, cached: 10, thoughts: 0, tool: 0, total: 55 }, { model: 'gemini-2.5-pro' }),
        ],
      }),
    );

    const warnings: string[] = [];
    const r = await geminiParser.load({ paths: { gemini: [g] }, warn: (m) => warnings.push(m) });
    assert.equal(r.tool, 'gemini');
    assert.deepEqual(r.sources, [g]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(r.events.map((e) => e.id).sort(), ['gemini:old-1:og1', 'gemini:sess-1:g1', 'gemini:sess-1:g2', 'gemini:sub-1:s1']);

    const g1 = r.events.find((e) => e.id === 'gemini:sess-1:g1')!;
    assert.equal(g1.inputTokens, 4000); // 12000 - 8000 cached
    assert.equal(g1.cacheReadTokens, 8000);
    assert.equal(g1.outputTokens, 1000); // 300 + 700 thoughts
    assert.equal(g1.reasoningTokens, 700);
    assert.equal(g1.cacheWriteTokens, 0);
    assert.equal(g1.provider, 'google');
    assert.equal(g1.model, 'gemini-3-pro-preview');
    assert.equal(g1.project, '/synthetic/gem');
    assert.equal(g1.timestamp, T0 + 5000);
    assert.equal(g1.inputTokens + g1.outputTokens + g1.cacheReadTokens, 13000); // matches recorded total

    const g2 = r.events.find((e) => e.id === 'gemini:sess-1:g2')!; // rewound, but billed
    assert.equal(g2.inputTokens, 540); // tool-use prompt tokens are separate from promptTokenCount
    assert.equal(g2.model, 'gemini-3-flash-preview');

    const s1 = r.events.find((e) => e.id === 'gemini:sub-1:s1')!;
    assert.equal(s1.isSubagent, true);
    assert.equal(s1.rootSessionId, 'sess-1');
    assert.equal(s1.outputTokens, 15);

    const old = r.events.find((e) => e.id === 'gemini:old-1:og1')!;
    assert.equal(old.project, '');
    assert.equal(old.inputTokens, 40);

    const s = r.sessions.find((x) => x.sessionId === 'sess-1')!;
    assert.equal(s.title, 'Add retry logic');
    assert.equal(s.userMessages, 1);
    assert.equal(s.assistantMessages, 2);
    assert.equal(s.toolCalls, 1);
    assert.deepEqual(s.toolCallsByName, { run_shell_command: 1 });
    assert.equal(s.startedAt, T0);
    assert.equal(s.endedAt, T0 + 120000);
    assert.equal(s.isSubagent, false);
    assert.deepEqual(s.models.sort(), ['gemini-3-flash-preview', 'gemini-3-pro-preview']);
    assert.equal(r.sessions.length, 3);

    const blob = JSON.stringify(r);
    for (const x of ['private', 'secret.env', 'SHOULD-NEVER-BE-READ', 'zzz']) assert.ok(!blob.includes(x), x);

    const filtered = await geminiParser.load({ paths: { gemini: [g] }, since: T0 });
    assert.ok(!filtered.events.some((e) => e.id === 'gemini:old-1:og1'));
    assert.ok(!filtered.sessions.some((x) => x.sessionId === 'old-1'));

    // GEMINI_CLI_HOME-style root (the parent of .gemini) also works
    const viaHome = await geminiParser.load({ paths: { gemini: [dir] } });
    assert.equal(viaHome.events.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gemini parser: project root from projects.json registry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-gemini-reg-'));
  try {
    const chats = join(dir, 'tmp', 'other-proj', 'chats');
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ projects: { '/synthetic/registered': 'other-proj' } }));
    writeFileSync(
      join(chats, 'session-2026-10-02T09-00-abc.jsonl'),
      [{ sessionId: 'reg-1', projectHash: 'x', startTime: iso(T0), lastUpdated: iso(T0) }, gem('m1', T0, { input: 10, output: 1, cached: 0, total: 11 })]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    );
    const r = await geminiParser.load({ paths: { gemini: [dir] } });
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0]!.project, '/synthetic/registered');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gemini parser: missing dir yields empty result', async () => {
  const r = await geminiParser.load({ paths: { gemini: [join(tmpdir(), 'clausage-does-not-exist-gemini')] } });
  assert.equal(r.events.length, 0);
  assert.equal(r.sessions.length, 0);
  assert.equal(r.sources.length, 0);
});

test('gemini defaultPaths honours GEMINI_CLI_HOME', () => {
  const saved = process.env.GEMINI_CLI_HOME;
  try {
    process.env.GEMINI_CLI_HOME = join(tmpdir(), 'gem-home');
    assert.deepEqual(geminiParser.defaultPaths(), [join(tmpdir(), 'gem-home', '.gemini')]);
  } finally {
    if (saved === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = saved;
  }
});
