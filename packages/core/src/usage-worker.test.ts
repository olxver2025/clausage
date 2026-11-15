import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadUsage } from './loader.js';
import { createUsageWorker } from './usage-worker.js';

function line(n: number): string {
  return (
    JSON.stringify({
      type: 'assistant',
      uuid: `u${n}`,
      sessionId: 's1',
      cwd: '/tmp/project',
      timestamp: new Date(Date.UTC(2026, 8, 14, 10, n)).toISOString(),
      requestId: `req${n}`,
      message: { id: `msg${n}`, model: 'claude-sonnet-4-5', usage: { input_tokens: 10 * n, output_tokens: n } },
    }) + '\n'
  );
}

test('worker loads match direct loads and pick up appended lines', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clausage-worker-'));
  const worker = createUsageWorker();
  try {
    const dir = path.join(root, 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 's1.jsonl');
    writeFileSync(file, line(1) + line(2));
    const opts = { tools: ['claude-code' as const], paths: { 'claude-code': [root] }, offline: true, pricingCacheDir: root };

    const first = await worker.loadUsage(opts);
    const direct = await loadUsage(opts);
    assert.equal(first.events.length, 2);
    assert.deepEqual(first.events, direct.events);
    assert.deepEqual(first.sessions, direct.sessions);
    assert.ok(first.events[0]!.costUSD > 0);
    assert.deepEqual(first.pricing.lookup('claude-sonnet-4-5', 'claude-code'), direct.pricing.lookup('claude-sonnet-4-5', 'claude-code'));

    // Within the TTL the raw parse is reused; a fresh load re-reads the file that changed.
    appendFileSync(file, line(3));
    assert.equal((await worker.loadUsage(opts)).events.length, 2);
    const fresh = await worker.loadUsage(opts, { fresh: true });
    assert.equal(fresh.events.length, 3);
    assert.equal(fresh.sessions[0]!.assistantMessages, 3);
    // Unchanged files come from the per-file cache; results stay identical and independent.
    const again = await worker.loadUsage(opts, { fresh: true });
    assert.deepEqual(again.events, fresh.events);
    assert.deepEqual(again.sessions, fresh.sessions);
  } finally {
    await worker.terminate();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker errors reject the call', async () => {
  const worker = createUsageWorker();
  try {
    // A non-cloneable option cannot be posted to the worker.
    await assert.rejects(worker.loadUsage({ timezone: (() => {}) as unknown as string }));
    assert.equal((await worker.loadUsage({ tools: ['opencode'], paths: { opencode: ['/nonexistent'] }, offline: true })).events.length, 0);
  } finally {
    await worker.terminate();
  }
});
