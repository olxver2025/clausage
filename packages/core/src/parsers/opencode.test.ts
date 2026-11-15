import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opencodeParser } from './opencode.js';

const T0 = 1788015595745;

function asst(over: Record<string, unknown> = {}) {
  return {
    role: 'assistant',
    modelID: 'grok-4.6',
    providerID: 'xai',
    path: { cwd: '/synthetic/proj', root: '/synthetic/proj' },
    cost: 0.01,
    tokens: { total: 1160, input: 100, output: 50, reasoning: 10, cache: { read: 1000, write: 0 } },
    time: { created: T0, completed: T0 + 4000 },
    finish: 'stop',
    ...over,
  };
}

async function makeDb(dir: string): Promise<void> {
  const spec = 'node:sqlite';
  const { DatabaseSync } = (await import(spec)) as {
    DatabaseSync: new (p: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...a: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT, directory TEXT,
      version TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE credential (id TEXT, secret TEXT);
  `);
  db.prepare('INSERT INTO credential VALUES (?,?)').run('x', 'SHOULD-NEVER-BE-READ');
  db.prepare('INSERT INTO project VALUES (?,?)').run('global', '/');
  const ses = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?)');
  ses.run('ses_root', 'global', null, 'Root title', '/synthetic/proj', '1.18.25', T0 - 1000, T0 + 60000);
  ses.run('ses_child', 'global', 'ses_root', 'Child', '/synthetic/proj', '1.18.25', T0 + 5000, T0 + 30000);
  ses.run('ses_grandchild', 'global', 'ses_child', 'GC', '/synthetic/proj', '1.18.25', T0 + 6000, T0 + 7000);
  const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  msg.run('msg_u1', 'ses_root', T0 - 500, T0 - 500, JSON.stringify({ role: 'user', time: { created: T0 - 500 } }));
  msg.run('msg_a1', 'ses_root', T0, T0, JSON.stringify(asst()));
  msg.run(
    'msg_err',
    'ses_root',
    T0 + 10000,
    T0 + 10000,
    JSON.stringify(
      asst({
        cost: 0,
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: T0 + 10000 },
        error: { name: 'APIError', data: {} },
      }),
    ),
  );
  // multi-step message: message-level tokens reflect only the last step
  msg.run(
    'msg_multi',
    'ses_child',
    T0 + 20000,
    T0 + 20000,
    JSON.stringify(
      asst({
        modelID: 'custom-model',
        providerID: 'modal',
        cost: 0,
        tokens: { total: 30, input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: T0 + 20000, completed: T0 + 25000 },
      }),
    ),
  );
  msg.run('msg_gc', 'ses_grandchild', T0 + 6500, T0 + 6500, JSON.stringify(asst({ time: { created: T0 + 6500 } })));
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)');
  part.run('prt_1', 'msg_a1', 'ses_root', T0, T0, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'secret' } } }));
  part.run('prt_2', 'msg_a1', 'ses_root', T0, T0, JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'error' } }));
  part.run('prt_3', 'msg_a1', 'ses_root', T0, T0, JSON.stringify({ type: 'text', text: 'private prompt text' }));
  part.run('prt_4', 'msg_a1', 'ses_root', T0, T0, JSON.stringify({ type: 'step-finish', tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 1000, write: 0 } }, cost: 0.01 }));
  part.run('prt_5', 'msg_multi', 'ses_child', T0, T0, JSON.stringify({ type: 'step-finish', tokens: { input: 5, output: 7, reasoning: 1, cache: { read: 100, write: 3 } }, cost: 0 }));
  part.run('prt_6', 'msg_multi', 'ses_child', T0, T0, JSON.stringify({ type: 'step-finish', tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }));
  db.close();
}

function makeLegacy(dir: string): void {
  const s = join(dir, 'storage');
  mkdirSync(join(s, 'session', 'global'), { recursive: true });
  mkdirSync(join(s, 'message', 'ses_legacy'), { recursive: true });
  mkdirSync(join(s, 'message', 'ses_root'), { recursive: true });
  mkdirSync(join(s, 'part', 'msg_l1'), { recursive: true });
  writeFileSync(
    join(s, 'session', 'global', 'ses_legacy.json'),
    JSON.stringify({ id: 'ses_legacy', title: 'Legacy', directory: '/synthetic/old', time: { created: T0 - 86400000, updated: T0 - 86000000 } }),
  );
  writeFileSync(
    join(s, 'message', 'ses_legacy', 'msg_l1.json'),
    JSON.stringify({ id: 'msg_l1', sessionID: 'ses_legacy', ...asst({ time: { created: T0 - 86400000 } }) }),
  );
  writeFileSync(join(s, 'part', 'msg_l1', 'prt_l1.json'), JSON.stringify({ id: 'prt_l1', type: 'tool', tool: 'edit' }));
  // duplicate of a DB message -> must be deduped
  writeFileSync(join(s, 'message', 'ses_root', 'msg_a1.json'), JSON.stringify({ id: 'msg_a1', sessionID: 'ses_root', ...asst() }));
}

test('opencode parser: sqlite + legacy, dedupe, subagents, step-finish, privacy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-oc-test-'));
  try {
    await makeDb(dir);
    makeLegacy(dir);
    const warnings: string[] = [];
    const r = await opencodeParser.load({ paths: { opencode: [dir] }, warn: (m) => warnings.push(m) });
    assert.equal(r.tool, 'opencode');
    assert.equal(r.sources.length, 1);
    assert.deepEqual(r.historical, []);

    const ids = r.events.map((e) => e.id).sort();
    assert.deepEqual(ids, ['opencode:msg_a1', 'opencode:msg_gc', 'opencode:msg_l1', 'opencode:msg_multi']);

    const a1 = r.events.find((e) => e.id === 'opencode:msg_a1')!;
    assert.equal(a1.inputTokens, 100);
    assert.equal(a1.outputTokens, 60); // output + reasoning
    assert.equal(a1.reasoningTokens, 10);
    assert.equal(a1.cacheReadTokens, 1000);
    assert.equal(a1.recordedCostUSD, 0.01);
    assert.equal(a1.durationMs, 4000);
    assert.equal(a1.model, 'grok-4.6');
    assert.equal(a1.provider, 'xai');
    assert.equal(a1.isSubagent, false);
    assert.equal(a1.rootSessionId, 'ses_root');

    const multi = r.events.find((e) => e.id === 'opencode:msg_multi')!;
    assert.equal(multi.inputTokens, 15);
    assert.equal(multi.outputTokens, 28);
    assert.equal(multi.cacheReadTokens, 100);
    assert.equal(multi.cacheWriteTokens, 3);
    assert.equal(multi.recordedCostUSD, undefined); // cost 0 = unpriced
    assert.equal(multi.isSubagent, true);
    assert.equal(multi.rootSessionId, 'ses_root');

    const gc = r.events.find((e) => e.id === 'opencode:msg_gc')!;
    assert.equal(gc.rootSessionId, 'ses_root');
    assert.equal(gc.durationMs, undefined);

    const root = r.sessions.find((s) => s.sessionId === 'ses_root')!;
    assert.equal(root.title, 'Root title');
    assert.equal(root.userMessages, 1);
    assert.equal(root.assistantMessages, 2); // incl. errored
    assert.equal(root.toolCalls, 2);
    assert.deepEqual(root.toolCallsByName, { bash: 1, read: 1 });
    assert.equal(root.version, '1.18.25');
    assert.ok(root.activeMs > 0);
    assert.equal(r.sessions.find((s) => s.sessionId === 'ses_legacy')!.toolCalls, 1);
    assert.deepEqual(r.sessions.find((s) => s.sessionId === 'ses_legacy')!.toolCallsByName, { edit: 1 });

    const blob = JSON.stringify(r);
    assert.ok(!blob.includes('SHOULD-NEVER-BE-READ'));
    assert.ok(!blob.includes('private prompt text'));
    assert.ok(!blob.includes('secret'));
    assert.deepEqual(warnings, []);

    const filtered = await opencodeParser.load({ paths: { opencode: [dir] }, since: T0 - 1000 });
    assert.ok(!filtered.events.some((e) => e.id === 'opencode:msg_l1'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode parser: missing dir yields empty result', async () => {
  const r = await opencodeParser.load({ paths: { opencode: [join(tmpdir(), 'clausage-does-not-exist-xyz')] } });
  assert.equal(r.events.length, 0);
  assert.equal(r.sources.length, 0);
});

test('opencode defaultPaths honours OPENCODE_DATA_DIR and XDG_DATA_HOME', () => {
  const saved = { a: process.env.OPENCODE_DATA_DIR, b: process.env.XDG_DATA_HOME };
  try {
    delete process.env.OPENCODE_DATA_DIR;
    process.env.XDG_DATA_HOME = join(tmpdir(), 'xdg');
    assert.deepEqual(opencodeParser.defaultPaths(), [join(tmpdir(), 'xdg', 'opencode')]);
    process.env.OPENCODE_DATA_DIR = `${join(tmpdir(), 'a')},${join(tmpdir(), 'b')}`;
    assert.deepEqual(opencodeParser.defaultPaths(), [join(tmpdir(), 'a'), join(tmpdir(), 'b')]);
  } finally {
    if (saved.a === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = saved.a;
    if (saved.b === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved.b;
  }
});

test('opencode parser: a malformed JSON row does not drop the whole database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-oc-bad-'));
  try {
    const spec = 'node:sqlite';
    const { DatabaseSync } = (await import(spec)) as {
      DatabaseSync: new (p: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...a: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new DatabaseSync(join(dir, 'opencode.db'));
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('ses_x', null, 't', '/synthetic/p', T0, T0 + 1000);
    const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
    msg.run('msg_ok', 'ses_x', T0, T0, JSON.stringify(asst()));
    msg.run('msg_bad', 'ses_x', T0 + 1, T0 + 1, '{"role":"assistant","tokens":{"inp');
    const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)');
    part.run('prt_ok', 'msg_ok', 'ses_x', T0, T0, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed' } }));
    part.run('prt_bad', 'msg_ok', 'ses_x', T0, T0, '{"type":"tool",');
    db.close();
    const warns: string[] = [];
    const r = await opencodeParser.load({ paths: { opencode: [dir] }, warn: (m) => warns.push(m) });
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0]!.inputTokens, 100);
    assert.equal(r.sessions[0]!.toolCalls, 1);
    assert.deepEqual(r.sessions[0]!.toolCallsByName, { bash: 1 });
    assert.ok(warns.some((w) => /malformed JSON/.test(w)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
