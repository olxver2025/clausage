import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { openclawParser, openclawTranscriptSessionId, piParser } from './openclaw.js';

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function header(id: string, cwd: string, ts = T0, extra: Record<string, unknown> = {}) {
  return { type: 'session', version: 3, id, timestamp: iso(ts), cwd, ...extra };
}

function assistant(id: string, ts: number, over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: iso(ts + 3000),
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private reasoning text' },
        { type: 'text', text: 'private answer text' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'cat secret.env' } },
      ],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: {
        input: 100,
        output: 50,
        cacheRead: 1000,
        cacheWrite: 20,
        cacheWrite1h: 5,
        reasoning: 10,
        totalTokens: 1170,
        cost: { input: 0.0003, output: 0.00075, cacheRead: 0.0003, cacheWrite: 0.000075, total: 0.001425 },
        ...usage,
      },
      stopReason: 'toolUse',
      timestamp: ts,
      durationMs: 2500,
      ...over,
    },
  };
}

function user(id: string, ts: number) {
  return { type: 'message', id, parentId: null, timestamp: iso(ts), message: { role: 'user', content: 'private prompt text', timestamp: ts } };
}

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n{"type":"message","id":"partial';

test('pi parser: usage, model_change, usage entries, fork dedupe, privacy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-pi-test-'));
  try {
    const sdir = join(dir, 'sessions', '--synthetic-proj--');
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ anthropic: { key: 'SHOULD-NEVER-BE-READ' } }));
    const rows = [
      header('sess-a', '/synthetic/proj'),
      user('u1', T0 + 1000),
      assistant('a1', T0 + 2000),
      { type: 'model_change', id: 'mc1', parentId: 'a1', timestamp: iso(T0 + 10000), provider: 'openai', modelId: 'gpt-5.2' },
      assistant('a2', T0 + 20000, { provider: 'openai', model: 'gpt-5.2', content: [{ type: 'text', text: 'x' }] }, { cacheWrite: 0, cacheWrite1h: 0, cost: { total: 0 } }),
      // errored response: zero usage -> no event
      assistant('a3', T0 + 30000, { stopReason: 'error', provider: 'openai', model: 'gpt-5.2' }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }),
      { type: 'usage', id: 'us1', parentId: 'a3', timestamp: iso(T0 + 31000), kind: 'cache_warm', provider: 'anthropic', model: 'claude-haiku-4-5', usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 900, totalTokens: 901, cost: { total: 0.0011 } } },
      // compaction summary usage has no model: attributed to the current model
      { type: 'compaction', id: 'c1', parentId: 'us1', timestamp: iso(T0 + 40000), summary: 'private summary', firstKeptEntryId: 'a2', tokensBefore: 5000, usage: { input: 3000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 3200, cost: { total: 0 } } },
      { type: 'session_info', id: 'si1', parentId: 'c1', timestamp: iso(T0 + 41000), name: 'Refactor parser' },
    ];
    writeFileSync(join(sdir, '2026-10-01T10-00-00-000Z_sess-a.jsonl'), jsonl(rows));
    // fork: copies u1/a1 verbatim (same ids + timestamps) into a new session file
    const fork = [header('sess-b', '/synthetic/proj', T0 + 60000, { parentSession: join(sdir, '2026-10-01T10-00-00-000Z_sess-a.jsonl') }), user('u1', T0 + 1000), assistant('a1', T0 + 2000), assistant('b1', T0 + 70000)];
    writeFileSync(join(sdir, '2026-10-01T10-01-00-000Z_sess-b.jsonl'), jsonl(fork));

    const warnings: string[] = [];
    const r = await piParser.load({ paths: { pi: [dir] }, warn: (m) => warnings.push(m) });
    assert.equal(r.tool, 'pi');
    assert.deepEqual(r.sources, [dir]);
    assert.deepEqual(warnings, []);

    const ids = r.events.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(r.events.length, 5); // a1, a2, us1, c1, b1 (a1 deduped across the fork, a3 empty)
    for (const id of ids) assert.ok(id.startsWith('pi:'));

    const a1 = r.events.find((e) => e.id === `pi:a1:${T0 + 2000}`)!;
    assert.equal(a1.sessionId, 'sess-a'); // original wins over the fork
    assert.equal(a1.inputTokens, 100);
    assert.equal(a1.outputTokens, 50);
    assert.equal(a1.reasoningTokens, 10);
    assert.equal(a1.cacheReadTokens, 1000);
    assert.equal(a1.cacheWriteTokens, 20);
    assert.equal(a1.cacheWrite1hTokens, 5);
    assert.equal(a1.recordedCostUSD, 0.001425);
    assert.equal(a1.durationMs, 2500);
    assert.equal(a1.timestamp, T0 + 2000);
    assert.equal(a1.provider, 'anthropic');
    assert.equal(a1.project, '/synthetic/proj');

    const a2 = r.events.find((e) => e.id.startsWith('pi:a2:'))!;
    assert.equal(a2.model, 'gpt-5.2');
    assert.equal(a2.recordedCostUSD, undefined); // cost 0 = unpriced

    const warm = r.events.find((e) => e.id.startsWith('pi:us1:'))!;
    assert.equal(warm.model, 'claude-haiku-4-5');
    assert.equal(warm.cacheWriteTokens, 900);
    const compaction = r.events.find((e) => e.id.startsWith('pi:c1:'))!;
    assert.equal(compaction.model, 'gpt-5.2');
    assert.equal(compaction.inputTokens, 3000);

    const sa = r.sessions.find((s) => s.sessionId === 'sess-a')!;
    assert.equal(sa.title, 'Refactor parser');
    assert.equal(sa.userMessages, 1);
    assert.equal(sa.assistantMessages, 3);
    assert.equal(sa.toolCalls, 2);
    assert.deepEqual(sa.toolCallsByName, { bash: 2 });
    assert.equal(sa.project, '/synthetic/proj');
    assert.equal(sa.isSubagent, false);
    assert.ok(sa.activeMs > 0);
    assert.ok(r.sessions.some((s) => s.sessionId === 'sess-b'));

    const blob = JSON.stringify(r);
    for (const s of ['private', 'secret.env', 'SHOULD-NEVER-BE-READ']) assert.ok(!blob.includes(s), s);

    const filtered = await piParser.load({ paths: { pi: [dir] }, since: T0 + 35000 });
    assert.deepEqual(filtered.events.map((e) => e.id.split(':')[1]).sort(), ['b1', 'c1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openclaw transcript file-name rule matches upstream', () => {
  assert.equal(openclawTranscriptSessionId('abc.jsonl'), 'abc');
  assert.equal(openclawTranscriptSessionId('abc.trajectory.jsonl'), null);
  assert.equal(openclawTranscriptSessionId('abc.checkpoint.123e4567-e89b-12d3-a456-426614174000.jsonl'), null);
  assert.equal(openclawTranscriptSessionId('abc.jsonl.reset.2026-09-01T10-00-00.000Z'), 'abc');
  assert.equal(openclawTranscriptSessionId('abc.jsonl.deleted.2026-09-01T10-00-00Z.0123456789abcdef0123456789abcdef.zst'), 'abc');
  assert.equal(openclawTranscriptSessionId('abc.jsonl.bak.2026-09-01T10-00-00Z'), null);
  assert.equal(openclawTranscriptSessionId('sessions.json'), null);
});

async function makeAgentDb(path: string): Promise<boolean> {
  const spec = 'node:sqlite';
  const { DatabaseSync } = (await import(spec)) as {
    DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): unknown }; close(): void };
  };
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT, label TEXT, display_name TEXT);
    CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT, created_at INTEGER, updated_at INTEGER,
      started_at INTEGER, ended_at INTEGER, model TEXT, model_provider TEXT, display_name TEXT);
    CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT, created_at INTEGER NOT NULL,
      event_zstd BLOB, event_utf8_bytes INTEGER, navigation_json TEXT, PRIMARY KEY (session_id, seq));
    CREATE TABLE auth_profile_store (id TEXT, secret TEXT);
  `);
  db.prepare('INSERT INTO auth_profile_store VALUES (?,?)').run('x', 'SHOULD-NEVER-BE-READ');
  db.prepare('INSERT INTO session_nodes VALUES (?,?,?,?,?)').run('agent:main:main', 'db-sess', '{"origin":"private chat"}', 'Daily standup', 'Private Person');
  db.prepare('INSERT INTO session_windows VALUES (?,?,?,?,?,?,?,?,?)').run('db-sess', 'agent:main:main', T0, T0 + 900000, T0, T0 + 900000, 'gpt-5.2', 'openai', 'Private Person');
  const ev = db.prepare('INSERT INTO transcript_events (session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes, navigation_json) VALUES (?,?,?,?,?,?,?)');
  ev.run('db-sess', 0, JSON.stringify(header('db-sess', '/synthetic/claw')), T0, null, null, null);
  ev.run('db-sess', 1, JSON.stringify(user('du1', T0 + 1000)), T0 + 1000, null, null, null);
  const da1Content = [
    { type: 'text', text: 'private answer text' },
    { type: 'toolCall', id: 'call_r', name: 'read', arguments: { path: 'secret.env' } },
    { type: 'toolCall', id: 'call_u', arguments: { x: 1 } }, // no name: counted, not named
  ];
  ev.run('db-sess', 2, JSON.stringify(assistant('da1', T0 + 2000, { provider: 'openai', model: 'gpt-5.2', content: da1Content })), T0 + 5000, null, null, null);
  ev.run('db-sess', 3, '{"type":"message","message":{"role":"assis', T0 + 6000, null, null, null); // malformed
  // the JSONL transcript imported into SQLite: same entry id + timestamp as the file -> deduped
  ev.run('db-sess', 4, JSON.stringify(assistant('fa1', T0 - 3600000)), T0 - 3600000, null, null, null);
  const z = zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer };
  const hasZstd = typeof z.zstdCompressSync === 'function';
  if (hasZstd) {
    const plain = Buffer.from(JSON.stringify(assistant('dz1', T0 + 8000, { provider: 'openai', model: 'gpt-5.2' }, { input: 7 })));
    ev.run('db-sess', 5, null, T0 + 9000, z.zstdCompressSync!(plain), plain.length, '{}');
  }
  ev.run('db-sess', 6, null, T0 + 9500, null, 10, '{}'); // cold-archived row
  db.close();
  return hasZstd;
}

test('openclaw parser: agent JSONL + archives + SQLite transcripts, labels, dedupe, privacy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-openclaw-test-'));
  try {
    const sdir = join(dir, 'agents', 'main', 'sessions');
    mkdirSync(sdir, { recursive: true });
    mkdirSync(join(dir, 'agents', 'main', 'agent'), { recursive: true });
    writeFileSync(join(dir, 'openclaw.json'), JSON.stringify({ apiKey: 'SHOULD-NEVER-BE-READ' }));
    writeFileSync(join(dir, 'agents', 'main', 'agent', 'auth-profiles.json'), JSON.stringify({ token: 'SHOULD-NEVER-BE-READ' }));
    writeFileSync(
      join(sdir, 'sessions.json'),
      JSON.stringify({ 'agent:main:telegram:123': { sessionId: 'file-sess', label: 'Weekly report', displayName: 'Private Person', origin: { from: 'private chat' } } }),
    );
    writeFileSync(join(sdir, 'file-sess.jsonl'), jsonl([header('file-sess', '/synthetic/claw', T0 - 3700000), user('fu1', T0 - 3650000), assistant('fa1', T0 - 3600000)]));
    writeFileSync(join(sdir, 'old-sess.jsonl.reset.2026-09-30T10-00-00.000Z'), jsonl([header('old-sess', '/synthetic/claw', T0 - 86400000), assistant('oa1', T0 - 86000000)]));
    writeFileSync(join(sdir, 'file-sess.trajectory.jsonl'), jsonl([assistant('tr1', T0)])); // not a transcript
    const hasZstd = await makeAgentDb(join(dir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'));

    const warnings: string[] = [];
    const r = await openclawParser.load({ paths: { openclaw: [dir] }, warn: (m) => warnings.push(m) });
    assert.equal(r.tool, 'openclaw');
    assert.deepEqual(r.sources, [dir]);

    const short = r.events.map((e) => e.id.split(':')[1]).sort();
    assert.deepEqual(short, hasZstd ? ['da1', 'dz1', 'fa1', 'oa1'] : ['da1', 'fa1', 'oa1']);
    for (const e of r.events) assert.ok(e.id.startsWith('openclaw:'));
    assert.ok(warnings.some((w) => /cold storage/.test(w)));

    const fa1 = r.events.find((e) => e.id.includes(':fa1:'))!;
    assert.equal(fa1.sessionId, 'file-sess');
    assert.equal(fa1.recordedCostUSD, 0.001425);
    const da1 = r.events.find((e) => e.id.includes(':da1:'))!;
    assert.equal(da1.sessionId, 'db-sess');
    assert.equal(da1.model, 'gpt-5.2');
    assert.equal(da1.inputTokens, 100);
    assert.equal(da1.outputTokens, 50);
    assert.equal(da1.cacheReadTokens, 1000);
    assert.equal(da1.project, '/synthetic/claw');
    assert.equal(da1.timestamp, T0 + 2000);
    if (hasZstd) assert.equal(r.events.find((e) => e.id.includes(':dz1:'))!.inputTokens, 7);

    const fileSess = r.sessions.find((s) => s.sessionId === 'file-sess')!;
    assert.equal(fileSess.title, 'Weekly report');
    assert.equal(fileSess.userMessages, 1);
    const dbSess = r.sessions.find((s) => s.sessionId === 'db-sess')!;
    assert.equal(dbSess.title, 'Daily standup');
    assert.equal(dbSess.toolCalls, hasZstd ? 4 : 3);
    // SQL rows give names via json_extract; the zstd row goes through the JSONL reduction
    assert.deepEqual(dbSess.toolCallsByName, { bash: hasZstd ? 2 : 1, read: 1 });
    assert.equal(dbSess.startedAt, T0);
    assert.equal(dbSess.endedAt, T0 + 900000);
    assert.ok(r.sessions.some((s) => s.sessionId === 'old-sess'));

    const blob = JSON.stringify(r);
    for (const s of ['private', 'secret.env', 'SHOULD-NEVER-BE-READ', 'Private Person']) assert.ok(!blob.includes(s), s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openclaw / pi: missing dirs yield empty results', async () => {
  const missing = join(tmpdir(), 'clausage-does-not-exist-claw');
  for (const p of [openclawParser, piParser]) {
    const r = await p.load({ paths: { [p.tool]: [missing] } });
    assert.equal(r.events.length, 0);
    assert.equal(r.sessions.length, 0);
    assert.equal(r.sources.length, 0);
  }
});

test('openclaw / pi defaultPaths honour env vars', () => {
  const keys = ['OPENCLAW_STATE_DIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.OPENCLAW_STATE_DIR = join(tmpdir(), 'claw-state');
    assert.deepEqual(openclawParser.defaultPaths(), [join(tmpdir(), 'claw-state')]);
    process.env.PI_CODING_AGENT_DIR = join(tmpdir(), 'pi-agent');
    process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpdir(), 'pi-sessions');
    assert.deepEqual(piParser.defaultPaths(), [join(tmpdir(), 'pi-agent'), join(tmpdir(), 'pi-sessions')]);
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    assert.ok(piParser.defaultPaths()[0]!.endsWith(join('.pi', 'agent')));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
