import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesParser } from './hermes.js';

const T0 = 1788015595; // epoch seconds, as Hermes stores REAL timestamps

type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown };
  close(): void;
};

async function openDb(path: string): Promise<Db> {
  const spec = 'node:sqlite';
  const { DatabaseSync } = (await import(spec)) as { DatabaseSync: new (p: string) => Db };
  return new DatabaseSync(path);
}

const SESSIONS_DDL = `CREATE TABLE sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, display_name TEXT, model TEXT,
  system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL,
  message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0, cwd TEXT, git_repo_root TEXT,
  billing_provider TEXT, billing_base_url TEXT, billing_mode TEXT, estimated_cost_usd REAL, actual_cost_usd REAL,
  title TEXT, api_call_count INTEGER DEFAULT 0)`;

const USAGE_DDL = `CREATE TABLE session_model_usage (
  session_id TEXT NOT NULL, model TEXT NOT NULL, billing_provider TEXT NOT NULL DEFAULT '',
  billing_base_url TEXT NOT NULL DEFAULT '', billing_mode TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '',
  api_call_count INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
  actual_cost_usd REAL NOT NULL DEFAULT 0, cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL,
  PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task))`;

const MESSAGES_DDL = `CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, reasoning TEXT)`;

async function makeStore(dir: string): Promise<void> {
  const db = await openDb(join(dir, 'state.db'));
  db.exec(SESSIONS_DDL);
  db.exec(USAGE_DDL);
  db.exec(MESSAGES_DDL);
  db.exec(`CREATE TABLE system_prompts (hash TEXT PRIMARY KEY, prompt TEXT NOT NULL)`);
  db.prepare('INSERT INTO system_prompts VALUES (?,?)').run('h', 'SECRET SYSTEM PROMPT');
  const ses = db.prepare(
    `INSERT INTO sessions (id, source, user_id, display_name, model, system_prompt, parent_session_id, started_at, ended_at,
      message_count, tool_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      cwd, billing_provider, estimated_cost_usd, actual_cost_usd, title)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // root session: switched models mid-session (two per-model rows) + an aux compression row
  ses.run('s_root', 'cli', 'u-123', 'Private Person', 'claude-sonnet-4-6', 'SECRET SYSTEM PROMPT', null, T0, T0 + 600,
    4, 3, 1100, 330, 5000, 200, 30, '/synthetic/proj', 'anthropic', 0.5, null, 'Fix the build');
  // child (delegated subagent): no per-model rows, counters only (legacy / absolute path)
  ses.run('s_child', 'cli', null, null, 'gpt-5.2', null, 's_root', T0 + 100, T0 + 200,
    2, 1, 400, 90, 0, 0, 40, null, 'openai', 0, 0.12, null);
  // grandchild
  ses.run('s_gc', 'cli', null, null, 'gpt-5.2', null, 's_child', T0 + 150, T0 + 160,
    0, 0, 10, 5, 0, 0, 0, null, 'openai', 0, null, null);
  // empty launch stub
  ses.run('s_empty', 'cli', null, null, 'x', null, null, T0 - 86400 * 10, null, 0, 0, 0, 0, 0, 0, 0, '/synthetic/old', null, null, null, null);

  const use = db.prepare(
    `INSERT INTO session_model_usage (session_id, model, billing_provider, billing_base_url, billing_mode, task,
      api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      estimated_cost_usd, actual_cost_usd, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  use.run('s_root', 'claude-sonnet-4-6', 'anthropic', 'https://api.anthropic.com?key=SHOULD-NOT-LEAK', '', '', 3, 600, 200, 3000, 200, 30, 0.3, 0, T0, T0 + 300);
  use.run('s_root', 'claude-opus-4-6', 'anthropic', 'https://api.anthropic.com?key=SHOULD-NOT-LEAK', '', '', 2, 500, 130, 2000, 0, 0, 0.2, 0, T0 + 300, T0 + 600);
  use.run('s_root', 'gemini-3-flash', 'google', '', '', 'compression', 1, 50, 10, 0, 0, 0, 0.001, 0, T0 + 400, T0 + 400);

  const msg = db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp, reasoning) VALUES (?,?,?,?,?,?)');
  msg.run('s_root', 'user', 'private prompt text', null, T0 + 1, null);
  msg.run('s_root', 'assistant', 'private answer', '[{"id":"c1","type":"function","function":{"name":"terminal","arguments":"rm -rf secret"}},{"name":"bash","args":"rm -rf secret"}]', T0 + 5, 'private thoughts');
  msg.run('s_root', 'tool', 'tool output', null, T0 + 6, null);
  msg.run('s_root', 'assistant', 'more', null, T0 + 30, null);
  msg.run('s_child', 'user', 'delegated task', null, T0 + 101, null);
  msg.run('s_child', 'assistant', 'done', '[{"function":{"name":', T0 + 150, null); // malformed tool_calls
  db.close();
}

test('hermes parser: per-model rows, residuals, subagents, privacy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-hermes-test-'));
  try {
    await makeStore(dir);
    const warnings: string[] = [];
    const r = await hermesParser.load({ paths: { hermes: [dir] }, warn: (m) => warnings.push(m) });
    assert.equal(r.tool, 'hermes');
    assert.deepEqual(r.sources, [dir]);
    assert.deepEqual(r.historical, []);
    assert.deepEqual(warnings, []);

    const ids = r.events.map((e) => e.id).sort();
    assert.deepEqual(ids, [
      'hermes:s_child:session',
      'hermes:s_gc:session',
      'hermes:s_root:claude-opus-4-6:anthropic::',
      'hermes:s_root:claude-sonnet-4-6:anthropic::',
      'hermes:s_root:gemini-3-flash:google::compression',
    ]);
    for (const e of r.events) assert.ok(e.id.startsWith('hermes:'));

    const sonnet = r.events.find((e) => e.model === 'claude-sonnet-4-6')!;
    assert.equal(sonnet.inputTokens, 600);
    assert.equal(sonnet.outputTokens, 200); // already includes reasoning
    assert.equal(sonnet.reasoningTokens, 30);
    assert.equal(sonnet.cacheReadTokens, 3000);
    assert.equal(sonnet.cacheWriteTokens, 200);
    assert.equal(sonnet.recordedCostUSD, 0.3);
    assert.equal(sonnet.timestamp, T0 * 1000);
    assert.equal(sonnet.provider, 'anthropic');
    assert.equal(sonnet.project, '/synthetic/proj');
    assert.equal(sonnet.isSubagent, false);

    // root counters (1100/330/5000/200) are fully covered by its main-loop rows -> no residual
    assert.ok(!r.events.some((e) => e.id === 'hermes:s_root:session'));

    const child = r.events.find((e) => e.id === 'hermes:s_child:session')!;
    assert.equal(child.inputTokens, 400);
    assert.equal(child.outputTokens, 90);
    assert.equal(child.reasoningTokens, 40);
    assert.equal(child.recordedCostUSD, 0.12); // actual preferred over estimate
    assert.equal(child.isSubagent, true);
    assert.equal(child.rootSessionId, 's_root');
    assert.equal(child.project, '/synthetic/proj'); // inherited from root
    assert.equal(r.events.find((e) => e.id === 'hermes:s_gc:session')!.rootSessionId, 's_root');
    assert.equal(r.events.find((e) => e.id === 'hermes:s_gc:session')!.recordedCostUSD, undefined);

    const root = r.sessions.find((s) => s.sessionId === 's_root')!;
    assert.equal(root.title, 'Fix the build');
    assert.equal(root.userMessages, 1);
    assert.equal(root.assistantMessages, 2);
    assert.equal(root.toolCalls, 3);
    assert.deepEqual(root.toolCallsByName, { bash: 1, terminal: 1 });
    assert.equal(r.sessions.find((s) => s.sessionId === 's_child')!.toolCallsByName, undefined);
    assert.equal(root.startedAt, T0 * 1000);
    assert.equal(root.endedAt, (T0 + 600) * 1000);
    assert.equal(root.activeMs, 29000);
    assert.deepEqual(root.models.sort(), ['claude-opus-4-6', 'claude-sonnet-4-6', 'gemini-3-flash']);
    assert.equal(r.sessions.length, 4);

    const blob = JSON.stringify(r);
    for (const secret of ['SECRET SYSTEM PROMPT', 'private', 'rm -rf', 'Private Person', 'u-123', 'SHOULD-NOT-LEAK', 'tool output']) {
      assert.ok(!blob.includes(secret), secret);
    }

    const filtered = await hermesParser.load({ paths: { hermes: [dir] }, since: (T0 + 250) * 1000 });
    assert.deepEqual(filtered.events.map((e) => e.model).sort(), ['claude-opus-4-6', 'gemini-3-flash']);
    assert.ok(!filtered.sessions.some((s) => s.sessionId === 's_empty'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hermes parser: legacy store without session_model_usage and named profiles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-hermes-legacy-'));
  try {
    mkdirSync(join(dir, 'profiles', 'work'), { recursive: true });
    mkdirSync(join(dir, 'profiles', '.deleted', 'gone'), { recursive: true });
    const db = await openDb(join(dir, 'profiles', 'work', 'state.db'));
    // minimal old schema: no cache/reasoning/cost/cwd columns at all
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at REAL, ended_at REAL,
      input_tokens INTEGER, output_tokens INTEGER)`);
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run('old1', 'cli', 'hermes-4-405b', T0, T0 + 60, 1000, 250);
    db.close();
    const r = await hermesParser.load({ paths: { hermes: [dir] } });
    assert.equal(r.events.length, 1);
    const e = r.events[0]!;
    assert.equal(e.id, 'hermes:old1:session');
    assert.equal(e.model, 'hermes-4-405b');
    assert.equal(e.inputTokens, 1000);
    assert.equal(e.outputTokens, 250);
    assert.equal(e.cacheReadTokens, 0);
    assert.equal(e.project, '');
    assert.equal(r.sessions[0]!.userMessages, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hermes parser: missing dir yields empty result', async () => {
  const r = await hermesParser.load({ paths: { hermes: [join(tmpdir(), 'clausage-does-not-exist-hermes')] } });
  assert.equal(r.events.length, 0);
  assert.equal(r.sessions.length, 0);
  assert.equal(r.sources.length, 0);
});

test('hermes defaultPaths honours HERMES_HOME', () => {
  const saved = process.env.HERMES_HOME;
  try {
    process.env.HERMES_HOME = join(tmpdir(), 'hermes-home');
    assert.deepEqual(hermesParser.defaultPaths(), [join(tmpdir(), 'hermes-home')]);
    delete process.env.HERMES_HOME;
    const d = hermesParser.defaultPaths();
    assert.equal(d.length, 1);
    assert.ok(/[/\\]\.hermes$|[/\\]hermes$/.test(d[0]!));
  } finally {
    if (saved === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = saved;
  }
});
