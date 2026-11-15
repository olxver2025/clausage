import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadUsage } from './loader.js';
import { buildReport } from './aggregate.js';
import { installSyncKey, listRemoteMachines, loadSyncConfig, saveSyncConfig, writeSnapshot, type SyncConfig } from './sync.js';
import type { ParseResult, UsageEvent } from './types.js';

function event(id: string, session: string, project: string, ts: number): UsageEvent {
  return {
    tool: 'codex',
    id: `codex:${id}`,
    timestamp: ts,
    sessionId: session,
    rootSessionId: session,
    isSubagent: false,
    project,
    model: 'gpt-5',
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    recordedCostUSD: 1,
    costUSD: 0,
  };
}

function result(events: UsageEvent[]): ParseResult {
  return {
    tool: 'codex',
    events,
    sessions: [...new Set(events.map((e) => e.sessionId))].map((s) => ({
      tool: 'codex' as const,
      sessionId: s,
      rootSessionId: s,
      isSubagent: false,
      project: events.find((e) => e.sessionId === s)!.project,
      startedAt: 0,
      endedAt: 0,
      activeMs: 0,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      turns: 0,
      models: ['gpt-5'],
    })),
    historical: [],
    sources: ['/home/someone/.codex'],
  };
}

test('config: machine id is created once, folder and name are saved', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clausage-sync-'));
  const prev = process.env.CLAUSAGE_CONFIG_DIR;
  process.env.CLAUSAGE_CONFIG_DIR = path.join(dir, 'config');
  try {
    const a = loadSyncConfig();
    assert.equal(a.folder, undefined);
    assert.equal(loadSyncConfig().machineId, a.machineId);
    mkdirSync(path.join(dir, 'shared'));
    const b = saveSyncConfig({ machineName: 'Desk', folder: path.join(dir, 'shared') });
    assert.equal(b.machineName, 'Desk');
    assert.equal(b.folder, path.join(dir, 'shared'));
    assert.throws(() => saveSyncConfig({ folder: path.join(dir, 'missing') }), /Not a folder/);
    assert.equal(saveSyncConfig({ folder: null }).folder, undefined);
  } finally {
    if (prev === undefined) delete process.env.CLAUSAGE_CONFIG_DIR;
    else process.env.CLAUSAGE_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remote snapshots are merged, tagged by machine and grouped in session/project reports', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clausage-sync-'));
  const prev = process.env.CLAUSAGE_CONFIG_DIR;
  process.env.CLAUSAGE_CONFIG_DIR = path.join(dir, 'config');
  try {
    installSyncKey();
    const shared = path.join(dir, 'shared');
    const codexHome = path.join(dir, 'empty-codex');
    mkdirSync(shared);
    mkdirSync(codexHome);
    const laptop: SyncConfig = { machineId: 'laptop-0000-1111', machineName: 'Laptop', folder: shared };
    const desk: SyncConfig = { machineId: 'desk-0000-2222', machineName: 'Desk', folder: shared };
    const t = Date.UTC(2026, 10, 1, 12);
    writeSnapshot(laptop, [result([event('a', 's1', '/repo', t), event('b', 's1', '/repo', t + 1000)])]);
    writeSnapshot(desk, [result([event('c', 's9', '/repo', t)])]);
    assert.deepEqual(readdirSync(shared).sort(), ['desk-0000-2222.clausage.enc', 'laptop-0000-1111.clausage.enc']);

    // Viewed from Desk: Desk's own data comes from its parsers (empty here), Laptop's from the folder.
    assert.deepEqual(listRemoteMachines(desk).map((m) => [m.machineName, m.events]), [['Laptop', 2]]);
    const r = await loadUsage({ tools: ['codex'], paths: { codex: [codexHome] }, offline: true, pricingCacheDir: dir, sync: desk });
    assert.deepEqual(r.machines.map((m) => [m.name, m.local]), [['Desk', true], ['Laptop', false]]);
    assert.equal(r.events.length, 2);
    assert.ok(r.events.every((e) => e.machine === 'Laptop'));
    assert.equal(r.events.reduce((n, e) => n + e.costUSD, 0), 2, 'recorded cost re-applied by the reader');

    // From a third computer both remotes appear; same path on two machines = two projects.
    const third: SyncConfig = { machineId: 'third-0000-3333', machineName: 'Third', folder: shared };
    const all = await loadUsage({ tools: ['codex'], paths: { codex: [codexHome] }, offline: true, pricingCacheDir: dir, sync: third });
    assert.equal(all.events.length, 3);
    const projects = buildReport('projects', all.events, all.sessions);
    assert.deepEqual(projects.rows.map((row) => [row.label, row.meta?.machine]).sort(), [['/repo', 'Desk'], ['/repo', 'Laptop']]);
    const sessions = buildReport('session', all.events, all.sessions);
    assert.deepEqual(sessions.rows.map((row) => row.meta?.machine).sort(), ['Desk', 'Laptop']);

    const onlyDesk = await loadUsage({ tools: ['codex'], paths: { codex: [codexHome] }, offline: true, pricingCacheDir: dir, sync: third, machines: ['Desk'] });
    assert.equal(onlyDesk.events.length, 1);
  } finally {
    if (prev === undefined) delete process.env.CLAUSAGE_CONFIG_DIR;
    else process.env.CLAUSAGE_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sync requires the same key, authenticates each file and migrates only the local legacy snapshot', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clausage-e2ee-'));
  const previous = process.env.CLAUSAGE_CONFIG_DIR;
  const folder = path.join(root, 'shared');
  mkdirSync(folder);
  const sender = { folder, machineId: 'sender-01', machineName: 'Private laptop' };
  const reader = { folder, machineId: 'reader-02', machineName: 'Reader' };
  try {
    process.env.CLAUSAGE_CONFIG_DIR = path.join(root, 'sender');
    assert.throws(() => writeSnapshot(sender, []), /encryption key/);
    assert.deepEqual(readdirSync(folder), []);
    const source = installSyncKey();
    assert.throws(() => installSyncKey(), /EEXIST/);
    const legacy = path.join(folder, sender.machineId + '.clausage.json.gz');
    writeFileSync(legacy, 'legacy');
    writeFileSync(path.join(folder, 'other.clausage.json.gz'), 'legacy');
    const { file } = writeSnapshot(sender, [], 100);
    const first = readFileSync(file);
    writeSnapshot(sender, [], 100);
    const encrypted = readFileSync(file);
    assert.notDeepEqual(first, encrypted);
    assert.deepEqual(readdirSync(folder).sort(), ['other.clausage.json.gz', 'sender-01.clausage.enc']);
    process.env.CLAUSAGE_CONFIG_DIR = path.join(root, 'reader');
    const warnings: string[] = [];
    const list = () => listRemoteMachines(reader, (message) => warnings.push(message));
    assert.equal(list().length, 0);
    assert.ok(warnings.some((m) => m.includes('plaintext')));
    installSyncKey(source);
    assert.equal(list()[0]?.machineName, sender.machineName);
    process.env.CLAUSAGE_CONFIG_DIR = path.join(root, 'wrong-key');
    installSyncKey();
    assert.equal(list().length, 0, 'cached snapshots require the current key');
    assert.ok(warnings.some((m) => m.includes('authentication failed')));
    process.env.CLAUSAGE_CONFIG_DIR = path.join(root, 'reader');
    encrypted[encrypted.length - 1] = encrypted[encrypted.length - 1]! ^ 1;
    writeFileSync(file, encrypted);
    writeFileSync(path.join(folder, 'renamed.clausage.enc'), first);
    assert.equal(list().length, 0, 'modified and renamed snapshots are rejected');
    assert.throws(() => saveSyncConfig({ folder: root }), /outside the shared folder/);
  } finally {
    if (previous === undefined) delete process.env.CLAUSAGE_CONFIG_DIR;
    else process.env.CLAUSAGE_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
