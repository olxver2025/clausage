import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ampParser } from './amp.js';

const T0 = Date.parse('2026-10-05T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function assistant(messageId: number, ts: number, usage: Record<string, unknown> | null, tools: string[] = []) {
  return {
    role: 'assistant',
    messageId,
    content: [
      { type: 'thinking', thinking: 'private thinking' },
      { type: 'text', text: 'private answer' },
      ...tools.map((name, i) => ({ type: 'tool_use', id: `tu${i}`, name, input: { cmd: 'cat secret.env' }, complete: true })),
    ],
    state: { type: 'complete', stopReason: 'end_turn' },
    ...(usage ? { usage: { timestamp: iso(ts), ...usage } } : {}),
  };
}

test('amp parser: message usage, ledger precedence, project, title, privacy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-amp-test-'));
  try {
    const amp = join(dir, 'amp');
    const threads = join(amp, 'threads');
    mkdirSync(threads, { recursive: true });
    writeFileSync(join(amp, 'secrets.json'), JSON.stringify({ apiKey: 'SHOULD-NEVER-BE-READ' }));
    const workspace = join(dir, 'work', 'repo');

    // current schema: usage on assistant messages only
    writeFileSync(
      join(threads, 'T-aaaa.json'),
      JSON.stringify({
        v: 3,
        id: 'T-aaaa',
        created: T0,
        title: 'Fix the flaky test',
        env: { initial: { trees: [{ displayName: 'repo', uri: pathToFileURL(workspace).href }], platform: { os: 'darwin' } } },
        messages: [
          { role: 'user', messageId: 0, content: [{ type: 'text', text: 'private prompt' }], meta: { sentAt: T0 + 1000 } },
          assistant(1, T0 + 5000, { model: 'claude-sonnet-4-5', inputTokens: 10, outputTokens: 178, cacheCreationInputTokens: 986, cacheReadInputTokens: 11372, totalInputTokens: 12368 }, ['Bash', 'edit_file']),
          { role: 'user', messageId: 2, content: [{ type: 'tool_result', toolUseID: 'tu0', run: { status: 'done', result: { output: 'private output' } } }], meta: { sentAt: T0 + 6000 } },
          assistant(3, T0 + 9000, { model: 'claude-sonnet-4-5', inputTokens: 5, outputTokens: 42, cacheCreationInputTokens: 0, cacheReadInputTokens: 12000 }, ['Bash']),
          assistant(4, T0 + 9500, { model: 'claude-sonnet-4-5', inputTokens: 0, outputTokens: 0 }),
          assistant(5, T0 + 9800, { model: 'claude-haiku-4-5', totalTokens: 345 }),
        ],
      }),
    );

    // legacy schema: a usage ledger (takes precedence; cache split from the message it points at)
    writeFileSync(
      join(threads, 'T-bbbb.json'),
      JSON.stringify({
        id: 'T-bbbb',
        created: T0 + 86400000,
        messages: [
          { role: 'user', messageId: 0, content: [{ type: 'text', text: 'private prompt' }] },
          assistant(1, T0 + 86401000, { model: 'claude-opus-4-5', inputTokens: 99, outputTokens: 99, cacheCreationInputTokens: 300, cacheReadInputTokens: 700 }),
        ],
        usageLedger: {
          events: [
            { id: 'ev-1', timestamp: iso(T0 + 86401000), model: 'claude-opus-4-5', tokens: { input: 20, output: 30 }, toMessageId: 1, credits: 1.5, operationType: 'inference' },
            { id: 'ev-2', timestamp: iso(T0 + 86402000), model: 'gpt-5', tokens: { input: 7, output: 3 }, operationType: 'title' },
            { id: 'ev-3', model: 'gpt-5', tokens: { input: 1, output: 1 } }, // no timestamp: skipped
          ],
        },
      }),
    );
    writeFileSync(join(threads, 'T-broken.json'), '{"id":"T-broken", "messages": [');
    writeFileSync(join(threads, 'not-a-thread.json'), JSON.stringify({ id: 'x', messages: [assistant(1, T0, { model: 'm', inputTokens: 1 })] }));

    const warnings: string[] = [];
    const r = await ampParser.load({ paths: { amp: [amp] }, warn: (m) => warnings.push(m) });
    assert.equal(r.tool, 'amp');
    assert.deepEqual(r.sources, [amp]);
    assert.equal(warnings.length, 1); // the truncated thread
    assert.match(warnings[0]!, /T-broken/);
    assert.deepEqual(r.events.map((e) => e.id), ['amp:T-aaaa:M:1', 'amp:T-aaaa:M:3', 'amp:T-aaaa:M:5', 'amp:T-bbbb:L:ev-1', 'amp:T-bbbb:L:ev-2']);

    const m1 = r.events[0]!;
    assert.equal(m1.inputTokens, 10);
    assert.equal(m1.outputTokens, 178);
    assert.equal(m1.cacheWriteTokens, 986);
    assert.equal(m1.cacheReadTokens, 11372);
    assert.equal(m1.inputTokens + m1.cacheWriteTokens + m1.cacheReadTokens, 12368); // = totalInputTokens
    assert.equal(m1.model, 'claude-sonnet-4-5');
    assert.equal(m1.provider, 'anthropic');
    assert.equal(m1.project, workspace);
    assert.equal(m1.timestamp, T0 + 5000);
    assert.equal(m1.recordedCostUSD, undefined);

    assert.equal(r.events[2]!.outputTokens, 345); // total-only fallback

    const l1 = r.events.find((e) => e.id === 'amp:T-bbbb:L:ev-1')!;
    assert.equal(l1.inputTokens, 20);
    assert.equal(l1.outputTokens, 30);
    assert.equal(l1.cacheWriteTokens, 300);
    assert.equal(l1.cacheReadTokens, 700);
    assert.equal(l1.project, '');
    const l2 = r.events.find((e) => e.id === 'amp:T-bbbb:L:ev-2')!;
    assert.equal(l2.model, 'gpt-5');
    assert.equal(l2.provider, 'openai');
    assert.equal(l2.cacheReadTokens, 0);

    const s = r.sessions.find((x) => x.sessionId === 'T-aaaa')!;
    assert.equal(s.title, 'Fix the flaky test');
    assert.equal(s.project, workspace);
    assert.equal(s.userMessages, 2);
    assert.equal(s.assistantMessages, 4);
    assert.equal(s.toolCalls, 3);
    assert.deepEqual(s.toolCallsByName, { Bash: 2, edit_file: 1 });
    assert.equal(s.startedAt, T0);
    assert.equal(s.endedAt, T0 + 9800);
    assert.equal(s.activeMs, 9800 - 1000);
    assert.deepEqual(s.models.sort(), ['claude-haiku-4-5', 'claude-sonnet-4-5']);
    assert.equal(r.sessions.length, 2);

    // privacy: nothing of the message text survives into the results
    const dump = JSON.stringify({ events: r.events, sessions: r.sessions });
    for (const secret of ['private prompt', 'private answer', 'private thinking', 'private output', 'secret.env', 'SHOULD-NEVER-BE-READ']) assert.ok(!dump.includes(secret), secret);

    // a since filter drops the older thread's events
    const later = await ampParser.load({ paths: { amp: [amp] }, since: T0 + 86400000 });
    assert.deepEqual(later.events.map((e) => e.id), ['amp:T-bbbb:L:ev-1', 'amp:T-bbbb:L:ev-2']);

    // a root that is itself an export dir, and the same thread in two roots, counted once
    const exportDir = join(dir, 'export');
    mkdirSync(exportDir);
    writeFileSync(join(exportDir, 'T-aaaa.json'), JSON.stringify({ id: 'T-aaaa', created: T0, messages: [] }));
    const both = await ampParser.load({ paths: { amp: [amp, exportDir] } });
    assert.equal(both.events.length, 5);
    assert.equal(both.sessions.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('amp parser: AMP_DATA_DIR override and missing dirs', async () => {
  const prev = process.env.AMP_DATA_DIR;
  try {
    process.env.AMP_DATA_DIR = '/nonexistent/amp-a,/nonexistent/amp-b';
    assert.deepEqual(ampParser.defaultPaths(), ['/nonexistent/amp-a', '/nonexistent/amp-b']);
    const r = await ampParser.load({});
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.sources, []);
  } finally {
    if (prev === undefined) delete process.env.AMP_DATA_DIR;
    else process.env.AMP_DATA_DIR = prev;
  }
});
