import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotParser, copilotTime, shutdownDelta } from './copilot.js';

const T0 = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const sqlTime = (ms: number) => iso(ms).slice(0, 19).replace('T', ' ');
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

let seq = 0;
function ev(type: string, ts: number, data: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return { type, id: `e-${++seq}`, parentId: null, timestamp: iso(ts), data, ...over };
}
function shutdown(ts: number, modelMetrics: Record<string, Record<string, number>>) {
  return ev('session.shutdown', ts, {
    shutdownType: 'routine',
    sessionStartTime: T0,
    totalApiDurationMs: 1000,
    codeChanges: { linesAdded: 1, linesRemoved: 0, filesModified: ['/private/file.ts'] },
    totalNanoAiu: 123,
    modelMetrics: Object.fromEntries(Object.entries(modelMetrics).map(([m, usage]) => [m, { usage, requests: { count: 2, cost: 1 } }])),
  });
}

async function makeStore(path: string): Promise<void> {
  const spec = 'node:sqlite';
  const { DatabaseSync } = (await import(spec)) as {
    DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): unknown }; close(): void };
  };
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_index INTEGER, model TEXT,
      copilot_usage_model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, total_nano_aiu INTEGER, duration_ms INTEGER, created_at TEXT);
    CREATE TABLE turns (session_id TEXT, user_message TEXT, assistant_response TEXT);
  `);
  db.prepare('INSERT INTO turns VALUES (?,?,?)').run('db-1', 'private prompt', 'private answer');
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)').run('db-1', '/synthetic/copilot-db', 'o/r', 'github', 'main', 'Add pagination', sqlTime(T0), sqlTime(T0 + 600000));
  const ins = db.prepare(
    'INSERT INTO assistant_usage_events (session_id, turn_index, model, copilot_usage_model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  ins.run('db-1', 0, 'auto', 'claude-sonnet-4.5', 21343, 100, 0, 20974, 0, 556570000, 1234, sqlTime(T0 + 60000));
  ins.run('db-1', 1, 'gpt-5.4', null, 5000, 300, 4000, 0, 120, 0, null, sqlTime(T0 + 120000));
  ins.run('db-1', 2, 'gpt-5.4', null, 0, 0, 0, 0, 0, 0, null, sqlTime(T0 + 130000)); // empty: skipped
  db.close();
}

test('copilot parser: session-store rows, shutdown intervals, metadata, privacy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-copilot-test-'));
  try {
    const home = join(dir, '.copilot');
    mkdirSync(join(home, 'logs'), { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ token: 'SHOULD-NEVER-BE-READ' }));
    writeFileSync(join(home, 'logs', 'process-1.log'), 'SHOULD-NEVER-BE-READ');
    await makeStore(join(home, 'session-store.db'));

    // db-1 also has an event log: its shutdown must not double-count the per-call rows
    const s1 = join(home, 'session-state', 'db-1');
    mkdirSync(s1, { recursive: true });
    writeFileSync(
      join(s1, 'events.jsonl'),
      jsonl([
        ev('session.start', T0, { sessionId: 'db-1', version: 1, producer: 'copilot-agent', copilotVersion: '1.0.80', startTime: iso(T0), context: { cwd: '/synthetic/copilot-db' } }),
        ev('user.message', T0 + 1000, { content: 'private prompt', source: 'user' }),
        ev('assistant.message', T0 + 60000, { content: 'private answer', model: 'claude-sonnet-4.5', outputTokens: 100 }),
        ev('tool.execution_start', T0 + 61000, { toolCallId: 't1', toolName: 'bash', arguments: { command: 'cat secret.env' } }),
        ev('tool.execution_start', T0 + 62000, { toolCallId: 't2', toolName: 'view', arguments: { path: '/private' } }),
        ev('assistant.message', T0 + 120000, { content: 'private answer' }),
        shutdown(T0 + 125000, { 'claude-sonnet-4.5': { inputTokens: 21343, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 20974 } }),
      ]),
    );

    // log-only session: two shutdowns (resume), cumulative per model
    const s2 = join(home, 'session-state', 'log-2');
    mkdirSync(s2, { recursive: true });
    writeFileSync(
      join(s2, 'events.jsonl'),
      'not json\n' +
        jsonl([
          ev('session.start', T0 + 86400000, { sessionId: 'log-2', copilotVersion: '1.0.10', startTime: iso(T0 + 86400000), context: { cwd: '/synthetic/copilot-log', gitRoot: '/synthetic/copilot-log' } }),
          ev('user.message', T0 + 86401000, { content: 'private prompt' }),
          ev('assistant.message', T0 + 86402000, { content: 'private answer' }, { agentId: 'sub-1' }),
          ev('subagent.started', T0 + 86402500, { agentName: 'explore' }, { agentId: 'sub-1' }),
          shutdown(T0 + 86403000, {
            'claude-opus-4.6-1m': { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 20, reasoningTokens: 5 },
          }),
          ev('session.resume', T0 + 2 * 86400000, { resumeTime: iso(T0 + 2 * 86400000), eventCount: 5, context: { cwd: '/synthetic/copilot-log' } }),
          ev('user.message', T0 + 2 * 86400000 + 1000, { content: 'private prompt' }),
          // replay checkpoint copies are ignored
          ev('user.message', T0 + 2 * 86400000 + 1500, { content: 'private prompt' }, { checkpoint: true }),
          shutdown(T0 + 2 * 86400000 + 5000, {
            'claude-opus-4.6-1m': { inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 30, reasoningTokens: 10 },
            'gpt-5.4': { inputTokens: 90, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 15, reasoningTokens: 4 },
          }),
        ]),
    );

    const warnings: string[] = [];
    const r = await copilotParser.load({ paths: { copilot: [home] }, warn: (m) => warnings.push(m) });
    assert.equal(r.tool, 'copilot');
    assert.deepEqual(warnings, []);
    assert.deepEqual(r.sources, [home]);
    assert.equal(r.events.length, 5);

    const [d1, d2] = r.events.filter((e) => e.sessionId === 'db-1');
    assert.equal(d1!.model, 'claude-sonnet-4.5'); // copilot_usage_model preferred over "auto"
    assert.equal(d1!.inputTokens, 369); // 21343 − 20974 cache write
    assert.equal(d1!.cacheWriteTokens, 20974);
    assert.equal(d1!.cacheReadTokens, 0);
    assert.equal(d1!.outputTokens, 100);
    assert.ok(Math.abs(d1!.recordedCostUSD! - 0.0055657) < 1e-12);
    assert.equal(d1!.durationMs, 1234);
    assert.equal(d1!.timestamp, T0 + 60000);
    assert.equal(d1!.project, '/synthetic/copilot-db');
    assert.equal(d1!.provider, 'anthropic');
    assert.equal(d2!.inputTokens, 1000);
    assert.equal(d2!.cacheReadTokens, 4000);
    assert.equal(d2!.reasoningTokens, 120);
    assert.equal(d2!.outputTokens, 300); // reasoning is a subset of output
    assert.equal(d2!.recordedCostUSD, undefined);

    const logEvents = r.events.filter((e) => e.sessionId === 'log-2');
    assert.deepEqual(
      logEvents.map((e) => [e.model, e.timestamp, e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheWriteTokens]),
      [
        ['claude-opus-4.6-1m', T0 + 86403000, 70, 50, 10, 20],
        ['claude-opus-4.6-1m', T0 + 2 * 86400000 + 5000, 80, 30, 10, 10], // difference from the first shutdown
        ['gpt-5.4', T0 + 2 * 86400000 + 5000, 65, 30, 10, 15],
      ],
    );
    assert.equal(logEvents[0]!.project, '/synthetic/copilot-log');

    const sdb = r.sessions.find((s) => s.sessionId === 'db-1')!;
    assert.equal(sdb.title, 'Add pagination');
    assert.equal(sdb.project, '/synthetic/copilot-db');
    assert.equal(sdb.userMessages, 1);
    assert.equal(sdb.assistantMessages, 2);
    assert.equal(sdb.toolCalls, 2);
    assert.deepEqual(sdb.toolCallsByName, { bash: 1, view: 1 });
    assert.equal(sdb.version, '1.0.80');
    assert.equal(sdb.startedAt, T0);
    assert.equal(sdb.endedAt, T0 + 600000); // sessions.updated_at
    assert.deepEqual(sdb.models.sort(), ['claude-sonnet-4.5', 'gpt-5.4']);

    const slog = r.sessions.find((s) => s.sessionId === 'log-2')!;
    assert.equal(slog.userMessages, 2);
    assert.equal(slog.assistantMessages, 0); // the subagent's message is not a main-agent reply
    assert.equal(slog.title, undefined);
    assert.equal(r.sessions.length, 2);

    const dump = JSON.stringify({ events: r.events, sessions: r.sessions });
    for (const secret of ['private prompt', 'private answer', 'file.ts', 'secret.env', 'SHOULD-NEVER-BE-READ']) assert.ok(!dump.includes(secret), secret);

    const day2 = await copilotParser.load({ paths: { copilot: [home] }, since: T0 + 2 * 86400000 });
    assert.equal(day2.events.length, 2);
    assert.deepEqual(day2.sessions.map((s) => s.sessionId), ['log-2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copilot parser: helpers and COPILOT_HOME', () => {
  assert.equal(copilotTime('2026-07-01 12:34:56'), Date.parse('2026-07-01T12:34:56Z'));
  assert.equal(copilotTime('2026-07-01T12:34:56.000Z'), Date.parse('2026-07-01T12:34:56Z'));
  assert.equal(copilotTime(1782909296), 1782909296000);
  const a = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 0 };
  assert.deepEqual(shutdownDelta(undefined, a), a);
  assert.deepEqual(shutdownDelta(a, { ...a, input: 15, output: 6 }), { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  assert.deepEqual(shutdownDelta(a, { ...a, input: 3 }), { ...a, input: 3 }); // counters restarted
  const prev = process.env.COPILOT_HOME;
  try {
    process.env.COPILOT_HOME = '/nonexistent/copilot-home';
    assert.deepEqual(copilotParser.defaultPaths(), ['/nonexistent/copilot-home']);
  } finally {
    if (prev === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = prev;
  }
});
