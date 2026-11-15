/**
 * Worker-thread entry for createUsageWorker (usage-worker.ts). Runs loads off the host's main
 * thread and keeps the parsers' caches alive between loads.
 */
import { parentPort } from 'node:worker_threads';
import { loadUsage, parseTools } from './loader.js';
import { listRemoteMachines, localSnapshotInfo, writeSnapshot, type SyncConfig } from './sync.js';
import { TOOL_IDS } from './types.js';
import { appendClaudeUsage, fetchClaudeUsage, loadClaudeUsageConfig, type ClaudeUsageResult } from './claude-usage.js';
import { readCodexRateLimits, type CodexRateLimits } from './parsers/codex.js';
import { appendCodexUsage, fetchCodexUsage, type CodexUsageResult } from './codex-usage.js';
import type { ParseResult, ToolId } from './types.js';
import type { SyncStatus, WorkerRequest, WorkerResponse, WorkerUsageResult } from './usage-worker.js';

const port = parentPort;
if (!port) throw new Error('usage-worker-thread must run as a worker thread');

// Raw parses are shared by every filter combination, so a new filter only re-filters and re-costs.
let parseCache: { at: number; map: Map<ToolId, Promise<ParseResult>> } | undefined;
function sharedParseCache(fresh: boolean, ttlMs: number): Map<ToolId, Promise<ParseResult>> {
  const now = Date.now();
  if (fresh || !parseCache || now - parseCache.at >= ttlMs) parseCache = { at: now, map: new Map() };
  return parseCache.map;
}

// This computer's snapshot is rewritten at most once a minute, after a load, off the response path.
const PUBLISH_EVERY_MS = 60_000;
let lastPublish = 0;
let publishing: Promise<void> | undefined;
let publishError: string | undefined;

function publish(config: SyncConfig, ttlMs: number): Promise<void> {
  publishing ??= (async () => {
    try {
      const results = await parseTools(TOOL_IDS, { parseCache: sharedParseCache(false, ttlMs) });
      writeSnapshot(config, results);
      lastPublish = Date.now();
      publishError = undefined;
    } catch (err) {
      publishError = `sync: could not write this computer's snapshot: ${(err as Error).message}`;
      lastPublish = Date.now();
    } finally {
      publishing = undefined;
    }
  })();
  return publishing;
}

function maybePublish(config: SyncConfig | undefined, ttlMs: number): void {
  if (!config?.folder || config.publish === false) return;
  if (Date.now() - lastPublish < PUBLISH_EVERY_MS) return;
  setTimeout(() => void publish(config, ttlMs), 0);
}

function status(config: SyncConfig): SyncStatus {
  const warnings: string[] = publishError ? [publishError] : [];
  return { config, local: localSnapshotInfo(config), remotes: listRemoteMachines(config, (m) => warnings.push(m)), warnings };
}

// Claude's limits (opt-in): one request at a time, at most once a minute unless forced.
const CLAUDE_EVERY_MS = 60_000;
let claudeLast: ClaudeUsageResult | undefined;
let claudeAttempt = 0;
let claudeInflight: Promise<ClaudeUsageResult | null> | undefined;

function claudeUsage(force: boolean): Promise<ClaudeUsageResult | null> {
  if (!loadClaudeUsageConfig().enabled) {
    claudeLast = undefined;
    return Promise.resolve(null);
  }
  if (claudeInflight) return claudeInflight;
  if (!force && claudeLast && Date.now() - claudeAttempt < CLAUDE_EVERY_MS) return Promise.resolve(claudeLast);
  claudeAttempt = Date.now();
  claudeInflight = fetchClaudeUsage()
    .then((r) => {
      claudeLast = r;
      if (r.ok) {
        try {
          appendClaudeUsage(r.snapshot);
        } catch {
          // cache dir not writable: the live result still shows
        }
      }
      return r;
    })
    .finally(() => {
      claudeInflight = undefined;
    });
  return claudeInflight;
}

let codexLast: CodexUsageResult | undefined;
let codexAttempt = 0;
let codexInflight: Promise<CodexUsageResult> | undefined;
function codexUsage(force: boolean): Promise<CodexUsageResult> {
  if (codexInflight) return codexInflight;
  if (!force && codexLast && Date.now() - codexAttempt < 60_000) return Promise.resolve(codexLast);
  codexAttempt = Date.now();
  codexInflight = fetchCodexUsage().then((r) => {
    codexLast = r;
    if (r.ok) {
      try { appendCodexUsage(r.snapshot); } catch { /* live data still works without a writable cache */ }
    }
    return r;
  }).finally(() => { codexInflight = undefined; });
  return codexInflight;
}

/** Identity of the pricing table last sent to the host; the raw table is only re-sent when it changes. */
let sentPricingKey: string | undefined;

async function handle(req: WorkerRequest): Promise<WorkerUsageResult | CodexRateLimits | SyncStatus | ClaudeUsageResult | CodexUsageResult | null> {
  switch (req.kind) {
    case 'usage': {
      const res = await loadUsage({ ...req.opts, parseCache: sharedParseCache(req.fresh, req.parseTtlMs) });
      maybePublish(req.opts.sync, req.parseTtlMs);
      // keep Claude's limit history going while the dashboard is open
      setTimeout(() => void claudeUsage(false).catch(() => {}), 0);
      if (!req.opts.tools || req.opts.tools.includes('codex')) setTimeout(() => void codexUsage(false).catch(() => {}), 0);
      const { pricing, ...rest } = res;
      const snapshot = pricing.toSnapshot();
      const pricingKey = `${snapshot.source}|${snapshot.fetchedAt ?? ''}|${pricing.size}`;
      const send = pricingKey !== sentPricingKey;
      sentPricingKey = pricingKey;
      return { ...rest, pricingKey, pricing: send ? snapshot : undefined };
    }
    case 'rateLimits':
      return readCodexRateLimits();
    case 'clear':
      parseCache = undefined;
      return null;
    case 'syncStatus':
      return status(req.config);
    case 'claudeUsage':
      return claudeUsage(req.force);
    case 'codexUsage':
      return codexUsage(req.force);
    case 'syncPublish':
      lastPublish = 0;
      await publish(req.config, 30_000);
      return status(req.config);
  }
}

port.on('message', (req: WorkerRequest) => {
  handle(req).then(
    (result) => port.postMessage({ id: req.id, ok: true, result } satisfies WorkerResponse),
    (err: unknown) => {
      const e = err as Error;
      port.postMessage({ id: req.id, ok: false, error: e?.message ?? String(err), stack: e?.stack } satisfies WorkerResponse);
    },
  );
});
