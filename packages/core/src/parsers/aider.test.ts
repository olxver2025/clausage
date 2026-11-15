import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiderParser } from './aider.js';

const T0 = Date.parse('2026-10-06T07:00:00.000Z') / 1000; // Aider logs epoch seconds
const line = (event: string, t: number, properties: Record<string, unknown> = {}) =>
  JSON.stringify({ event, properties, user_id: 'SYNTHETIC-USER-ID', time: t });
const send = (t: number, model: string, prompt: number, completion: number, cost: number) =>
  line('message_send', t, {
    main_model: model,
    weak_model: 'gpt-5-mini',
    editor_model: model,
    edit_format: 'diff',
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cost,
    total_cost: cost,
  });

test('aider parser: analytics log, sessions per launch, recorded cost, privacy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-aider-test-'));
  try {
    const aider = join(dir, '.aider');
    mkdirSync(aider, { recursive: true });
    writeFileSync(join(aider, 'analytics.json'), JSON.stringify({ uuid: 'SHOULD-NEVER-BE-READ', permanently_disable: false }));
    const log = join(aider, 'analytics.jsonl');
    writeFileSync(
      log,
      [
        line('launched', T0),
        line('repo', T0 + 1, { num_files: 12 }),
        line('message_send_starting', T0 + 2),
        send(T0 + 10, 'anthropic/claude-sonnet-4-5', 12000, 800, 0.048),
        line('message_send_exception', T0 + 20, { exception: 'SECRET-EXCEPTION-TEXT' }),
        send(T0 + 70, 'anthropic/claude-sonnet-4-5', 13000, 0, 0.039),
        line('exit', T0 + 80, { reason: 'Control-C' }),
        line('launched', T0 + 3600),
        send(T0 + 3700, 'openai/REDACTED', 500, 50, 0),
        send(T0 + 3710, 'gpt-5', 0, 0, 0), // no tokens: no event
        '{"event":"message_send","time":',
      ].join('\n'),
    );

    const warnings: string[] = [];
    const r = await aiderParser.load({ paths: { aider: [log] }, warn: (m) => warnings.push(m) });
    assert.equal(r.tool, 'aider');
    assert.deepEqual(warnings, []);
    assert.deepEqual(r.sources, [log]);
    assert.equal(r.events.length, 3);

    const [a, b, c] = r.events;
    assert.equal(a!.timestamp, (T0 + 10) * 1000);
    assert.equal(a!.model, 'anthropic/claude-sonnet-4-5');
    assert.equal(a!.provider, 'anthropic');
    assert.equal(a!.inputTokens, 12000);
    assert.equal(a!.outputTokens, 800);
    assert.equal(a!.cacheReadTokens, 0);
    assert.equal(a!.recordedCostUSD, 0.048);
    assert.equal(a!.project, '');
    assert.equal(b!.outputTokens, 0);
    assert.equal(b!.sessionId, a!.sessionId);
    assert.equal(c!.model, 'openai/REDACTED');
    assert.equal(c!.recordedCostUSD, undefined);
    assert.notEqual(c!.sessionId, a!.sessionId);

    assert.equal(r.sessions.length, 2);
    const s1 = r.sessions[0]!;
    assert.equal(s1.sessionId, `analytics-${T0 * 1000}`);
    assert.equal(s1.startedAt, T0 * 1000);
    assert.equal(s1.endedAt, (T0 + 80) * 1000);
    assert.equal(s1.turns, 2);
    assert.equal(s1.userMessages, 2);
    assert.equal(s1.activeMs, 80000);
    assert.deepEqual(s1.models, ['anthropic/claude-sonnet-4-5']);
    assert.equal(r.sessions[1]!.turns, 2);

    const dump = JSON.stringify({ events: r.events, sessions: r.sessions });
    for (const secret of ['SYNTHETIC-USER-ID', 'SECRET-EXCEPTION-TEXT', 'SHOULD-NEVER-BE-READ']) assert.ok(!dump.includes(secret), secret);

    // a directory root reads its .jsonl logs but never analytics.json
    const viaDir = await aiderParser.load({ paths: { aider: [aider] } });
    assert.equal(viaDir.events.length, 3);
    const bounded = await aiderParser.load({ paths: { aider: [aider] }, since: (T0 + 3000) * 1000 });
    assert.equal(bounded.events.length, 1);
    assert.equal(bounded.sessions.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aider parser: AIDER_ANALYTICS_LOG and missing log', async () => {
  const prev = process.env.AIDER_ANALYTICS_LOG;
  const prevHome = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'clausage-aider-env-'));
  try {
    process.env.HOME = dir;
    process.env.AIDER_ANALYTICS_LOG = '/nonexistent/aider.jsonl';
    assert.deepEqual(aiderParser.defaultPaths(), ['/nonexistent/aider.jsonl', join(dir, '.aider', 'analytics.jsonl')]);
    const r = await aiderParser.load({});
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.sources, []);
  } finally {
    if (prev === undefined) delete process.env.AIDER_ANALYTICS_LOG;
    else process.env.AIDER_ANALYTICS_LOG = prev;
    process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
