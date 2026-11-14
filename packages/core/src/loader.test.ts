import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadUsage } from './loader.js';
import { startOfDay, endOfDay } from './aggregate.js';

test('historical rows are filtered by calendar date in the report timezone', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clausage-loader-'));
  try {
    mkdirSync(path.join(root, 'projects'), { recursive: true });
    writeFileSync(
      path.join(root, 'stats-cache.json'),
      JSON.stringify({
        dailyModelTokens: [
          { date: '2026-09-13', tokensByModel: { 'claude-x': 100 } },
          { date: '2026-09-14', tokensByModel: { 'claude-x': 200 } },
          { date: '2026-09-15', tokensByModel: { 'claude-x': 300 } },
        ],
      }),
    );
    for (const tz of ['UTC', 'Europe/London', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Etc/GMT+12']) {
      const r = await loadUsage({
        tools: ['claude-code'],
        paths: { 'claude-code': [root] },
        offline: true,
        pricingCacheDir: root,
        timezone: tz,
        since: startOfDay('2026-09-14', tz),
        until: endOfDay('2026-09-14', tz),
      });
      assert.deepEqual(r.historical.map((h) => h.date), ['2026-09-14'], tz);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
