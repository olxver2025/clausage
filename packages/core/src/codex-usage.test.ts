import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCodexUsage, fetchCodexUsage, parseCodexUsage, readCodexUsageHistory } from './codex-usage.js';

const T = Date.UTC(2026, 10, 15, 10);
const rate = { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: T / 1000 + 10_000 }, planType: 'plus' };
const body = { accountId: 'private-account', rateLimits: rate, rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'private-credit', title: 'Full reset', status: 'available', expiresAt: T / 1000 + 86400 }] } };

test('Codex reset availability distinguishes unknown, zero and truncated details', () => {
  const s = parseCodexUsage(body, T)!;
  assert.equal(s.resets!.availableCount, 1);
  assert.equal(s.resets!.grants![0]!.expiresAt, T + 86400_000);
  assert.ok(s.accountKey);
  assert.ok(!JSON.stringify(s).includes('private-'));
  assert.equal(parseCodexUsage({ rateLimits: rate }, T)!.resets, undefined);
  assert.deepEqual(parseCodexUsage({ rateLimits: rate, rateLimitResetCredits: { availableCount: 0, credits: [] } }, T)!.resets, { availableCount: 0, grants: [] });
  assert.deepEqual(parseCodexUsage({ rateLimits: rate, rateLimitResetCredits: { availableCount: 3, credits: null } }, T)!.resets, { availableCount: 3 });
  assert.equal(parseCodexUsage({ ...body, rateLimitsByLimitId: { other: rate } }, T), null);
  assert.deepEqual(parseCodexUsage({ ...body, rateLimitResetCredits: { availableCount: 1, credits: [{ status: 'unknown' }] } }, T)!.resets, { availableCount: 1 });
});

test('Codex account history survives restart and skips torn, expired and future records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-codex-history-'));
  try {
    const file = join(dir, 'history.jsonl');
    const s = parseCodexUsage(body, T)!;
    writeFileSync(file, '{torn}\n');
    appendCodexUsage(s, file);
    appendCodexUsage({ ...s, timestamp: T - 46 * 86400_000 }, file);
    appendCodexUsage({ ...s, timestamp: T + 1 }, file);
    assert.deepEqual(readCodexUsageHistory(file, T), [s]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing Codex CLI returns an unavailable check without leaking process errors', async () => {
  const r = await fetchCodexUsage({ command: '/nonexistent/clausage-codex' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /Install the Codex CLI/);
});

test('Codex subprocess performs only initialization and the read-only account request', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clausage-codex-protocol-'));
  try {
    const command = join(dir, 'codex');
    writeFileSync(command, `#!${process.execPath}\nconst readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialized')return;
 if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
 else if(m.method==='account/rateLimits/read')process.stdout.write(JSON.stringify({id:m.id,result:${JSON.stringify(body)}})+'\\n');
 else process.exit(1);
});\n`, { mode: 0o700 });
    const r = await fetchCodexUsage({ command, timeoutMs: 3000 });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.snapshot.resets!.availableCount, 1);
    writeFileSync(command, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
    const timeout = await fetchCodexUsage({ command, timeoutMs: 100 });
    assert.equal(timeout.ok, false);
    if (!timeout.ok) assert.match(timeout.error, /timed out/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
