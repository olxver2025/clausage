/**
 * Run usage loads in a worker thread. For long-running hosts (the web dashboard):
 *
 * - parsing hundreds of megabytes of logs no longer blocks the host's event loop;
 * - the host awaits one message per load instead of thousands of file reads. Hosts that
 *   instrument every promise and I/O call made during a request (React's dev-mode async debug
 *   info) otherwise spend minutes recording a load.
 *
 * The worker keeps the parsers' per-file caches and a short-lived cache of raw parses, so
 * repeat loads only re-read files that changed.
 */
import { Worker } from 'node:worker_threads';
import type { LoadUsageOptions, LoadUsageResult } from './loader.js';
import type { CodexRateLimits } from './parsers/codex.js';
import { PricingTable, type PricingSnapshot } from './pricing.js';
import type { RemoteMachine, SyncConfig } from './sync.js';
import type { ClaudeUsageResult } from './claude-usage.js';
import type { CodexUsageResult } from './codex-usage.js';

export interface SyncStatus {
  config: SyncConfig;
  /** this computer's snapshot in the folder, if written */
  local: { file: string; exportedAt: number; bytes: number } | null;
  remotes: RemoteMachine[];
  warnings: string[];
}

export type WorkerLoadOptions = Omit<LoadUsageOptions, 'warn' | 'parseCache'>;

type WorkerCall =
  | { kind: 'usage'; opts: WorkerLoadOptions; fresh: boolean; parseTtlMs: number }
  | { kind: 'rateLimits' }
  | { kind: 'clear' }
  | { kind: 'syncStatus'; config: SyncConfig }
  | { kind: 'syncPublish'; config: SyncConfig }
  | { kind: 'claudeUsage'; force: boolean }
  | { kind: 'codexUsage'; force: boolean };

export type WorkerRequest = WorkerCall & { id: number };

export type WorkerUsageResult = Omit<LoadUsageResult, 'pricing'> & { pricingKey: string; pricing?: PricingSnapshot };

export type WorkerResponse =
  | { id: number; ok: true; result: WorkerUsageResult | CodexRateLimits | SyncStatus | ClaudeUsageResult | CodexUsageResult | null }
  | { id: number; ok: false; error: string; stack?: string; result?: undefined };

export interface UsageWorkerLoadOptions {
  /** drop the worker's cached raw parses first (files unchanged on disk are still not re-read) */
  fresh?: boolean;
  /** how long raw parses are reused across loads (default 30s) */
  parseTtlMs?: number;
}

export interface UsageWorker {
  loadUsage(opts?: WorkerLoadOptions, load?: UsageWorkerLoadOptions): Promise<LoadUsageResult>;
  readCodexRateLimits(): Promise<CodexRateLimits | null>;
  /** this computer's snapshot and the other computers in the sync folder */
  syncStatus(config: SyncConfig): Promise<SyncStatus>;
  /** write this computer's snapshot now (parses every tool), then return the status */
  syncPublish(config: SyncConfig): Promise<SyncStatus>;
  /**
   * Claude's real usage limits (opt-in; null when off). Fetched at most once a minute unless
   * `force`, and recorded to the history the Claude parser reads.
   */
  claudeUsage(force?: boolean): Promise<ClaudeUsageResult | null>;
  codexUsage(force?: boolean): Promise<CodexUsageResult>;
  /** drop the worker's cached raw parses */
  clear(): void;
  terminate(): Promise<void>;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (reason: Error) => void;
}

export function createUsageWorker(): UsageWorker {
  let worker: Worker | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let pricing: { key: string; table: PricingTable } | undefined;

  const failAll = (w: Worker, err: Error) => {
    if (worker !== w) return;
    worker = undefined;
    // A fresh worker has sent no pricing table yet; it will send one with its first load.
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const ensure = (): Worker => {
    if (worker) return worker;
    // A smaller young generation (V8 sizes it for throughput, up to ~128MB) keeps the worker's
    // resident memory ~100MB lower after a parse, at no measurable cost to load time.
    const w = new Worker(new URL('./usage-worker-thread.js', import.meta.url), {
      resourceLimits: { maxYoungGenerationSizeMb: 48 },
    });
    w.on('message', (msg: WorkerResponse) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (pending.size === 0) w.unref();
      if (msg.ok) p.resolve(msg.result as never);
      else {
        const err = new Error(msg.error);
        if (msg.stack) err.stack = msg.stack;
        p.reject(err);
      }
    });
    w.on('error', (err) => failAll(w, err instanceof Error ? err : new Error(String(err))));
    w.on('exit', (code) => failAll(w, new Error(`usage worker exited with code ${code}`)));
    // An idle worker never keeps the host process alive. (After the listeners: adding a 'message'
    // listener refs the worker's port again.)
    w.unref();
    worker = w;
    return w;
  };

  const call = <T>(req: WorkerCall): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as Pending['resolve'], reject });
      try {
        const w = ensure();
        // Keep the process alive while a call is in flight.
        w.ref();
        w.postMessage({ ...req, id });
      } catch (err) {
        pending.delete(id);
        reject(err as Error);
      }
    });

  return {
    async loadUsage(opts = {}, load = {}) {
      const res = await call<WorkerUsageResult>({
        kind: 'usage',
        opts,
        fresh: load.fresh === true,
        parseTtlMs: load.parseTtlMs ?? 30_000,
      });
      const { pricing: snapshot, pricingKey, ...rest } = res;
      if (snapshot) pricing = { key: pricingKey, table: PricingTable.fromSnapshot(snapshot) };
      if (!pricing || pricing.key !== pricingKey) {
        // Responses arrive in order, so the table for this key was sent with an earlier response;
        // this only happens if that response was lost with a crashed worker.
        throw new Error('usage worker did not send its pricing table');
      }
      return { ...rest, pricing: pricing.table };
    },
    readCodexRateLimits: () => call<CodexRateLimits | null>({ kind: 'rateLimits' }),
    syncStatus: (config) => call<SyncStatus>({ kind: 'syncStatus', config }),
    syncPublish: (config) => call<SyncStatus>({ kind: 'syncPublish', config }),
    claudeUsage: (force = false) => call<ClaudeUsageResult | null>({ kind: 'claudeUsage', force }),
    codexUsage: (force = false) => call<CodexUsageResult>({ kind: 'codexUsage', force }),
    clear() {
      if (worker) void call<null>({ kind: 'clear' }).catch(() => {});
    },
    async terminate() {
      const w = worker;
      if (!w) return;
      failAll(w, new Error('usage worker terminated'));
      await w.terminate();
    },
  };
}
