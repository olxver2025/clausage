import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendClaudeUsage, fetchClaudeUsage, parseClaudeUsage, parseClaudeResets, readClaudeUsageHistory } from './claude-usage.js';
import { limitStatus } from './limits.js';
import type { UsageEvent } from './types.js';

const NOW = Date.UTC(2026, 10, 15, 14, 0);
const creds = async () => ({ accessToken: 'test-token', expiresAt: NOW + 3_600_000, subscriptionType: 'max' });
const body = {
  five_hour: { utilization: 63, resets_at: '2026-11-15T16:00:00.000Z' },
  seven_day: { utilization: 31, resets_at: '2026-11-20T09:00:00.000Z' },
  seven_day_opus: { utilization: 12, resets_at: '2026-11-20T09:00:00.000Z' },
  seven_day_oauth_apps: null,
  extra_usage: { is_enabled: false },
};

function fakeFetch(status: number, json: unknown, seen?: { url?: string; auth?: string }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (seen) {
      seen.url = url;
      seen.auth = (init?.headers as Record<string, string>).Authorization;
    }
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
}

test('parses the usage response into 5-hour, weekly and extra windows', () => {
  const s = parseClaudeUsage(body, NOW, 'max')!;
  assert.deepEqual(s.primary, { usedPercent: 63, windowMinutes: 300, resetsAt: Date.parse('2026-11-15T16:00:00.000Z') });
  assert.equal(s.secondary!.usedPercent, 31);
  assert.deepEqual(s.extra!.map((x) => [x.key, x.label]), [['seven_day_opus', 'Weekly · Opus']]);
  assert.equal(s.planType, 'max');
  assert.equal(parseClaudeUsage({ unrelated: true }, NOW), null);
});

test('fetch sends the login only to Anthropic and reports failures in plain words', async () => {
  const seen: { url?: string; auth?: string } = {};
  const ok = await fetchClaudeUsage({ now: NOW, readCredentials: creds, fetch: fakeFetch(200, body, seen) });
  assert.equal(ok.ok, true);
  assert.equal(seen.url, 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1');
  assert.equal(seen.auth, 'Bearer test-token');

  const expired = await fetchClaudeUsage({ now: NOW, readCredentials: async () => ({ accessToken: 'x', expiresAt: NOW - 1 }), fetch: fakeFetch(200, body) });
  assert.deepEqual([expired.ok, !expired.ok && expired.code], [false, 'expired']);
  const none = await fetchClaudeUsage({ now: NOW, readCredentials: async () => null });
  assert.deepEqual([none.ok, !none.ok && none.code], [false, 'no-credentials']);
  const denied = await fetchClaudeUsage({ now: NOW, readCredentials: creds, fetch: fakeFetch(401, {}) });
  assert.deepEqual([denied.ok, !denied.ok && denied.code], [false, 'unauthorized']);
  const changed = await fetchClaudeUsage({ now: NOW, readCredentials: creds, fetch: fakeFetch(200, { something: 'else' }) });
  assert.deepEqual([changed.ok, !changed.ok && changed.code], [false, 'format']);
  for (const r of [expired, none, denied, changed]) assert.ok(!r.ok && !r.error.includes('test-token'));
});

test('Claude reset grants retain counters and expiry, without raw redemption IDs', () => {
  const grant = { id: 'private-grant', label: 'Full reset', resets_left: 1, ends_at: '2026-12-10T22:00:00Z', usable_now: true };
  const s = parseClaudeUsage({ ...body, cedar_ember: { grants: [grant] } }, NOW)!;
  assert.equal(s.resets!.availableCount, 1);
  assert.equal(s.resets!.grants![0]!.usableNow, true);
  assert.equal(s.resets!.grants![0]!.expiresAt, Date.parse(grant.ends_at));
  assert.ok(!JSON.stringify(s).includes('private-grant'));
  assert.equal(parseClaudeResets({ grants: [{ ...grant, resets_left: -1 }] }, NOW), undefined);
  assert.equal(parseClaudeResets({ ineligible_reason: 'unavailable', grants: [] }, NOW), undefined);
  assert.equal(parseClaudeResets({}, NOW), undefined);
  assert.equal(parseClaudeResets({ grants: [] }, NOW)!.availableCount, 0);
  assert.equal(parseClaudeResets({ grants: [{ ...grant, ends_at: '2026-10-01T00:00:00Z' }] }, NOW)!.availableCount, 0);
});

test('history round-trips and feeds limitStatus with real Claude windows', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clausage-claude-usage-'));
  try {
    const file = path.join(dir, 'claude-usage.jsonl');
    const snap = parseClaudeUsage(body, NOW, 'max')!;
    appendClaudeUsage(snap, file);
    const history = readClaudeUsageHistory(file, NOW);
    assert.equal(history.length, 1);
    const ev = (model: string, tokens: number): UsageEvent => ({
      tool: 'claude-code', id: `c:${model}`, timestamp: NOW - 30 * 60_000, sessionId: 's', rootSessionId: 's', isSubagent: false, project: '',
      model, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, costUSD: 0,
    });
    const [claude] = limitStatus({ events: [ev('claude-opus-5-5', 100), ev('claude-sonnet-5-5', 50)], limits: history, now: NOW, tools: ['claude-code'] });
    assert.equal(claude!.planType, 'max');
    assert.equal(claude!.fiveHour!.usedPercent, 63);
    assert.equal(claude!.fiveHour!.source, 'reported');
    assert.equal(claude!.weekly!.usedPercent, 31);
    assert.equal(claude!.extra[0]!.label, 'Weekly · Opus');
    assert.equal(claude!.extra[0]!.tokens, 100, 'model window counts only that model');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
