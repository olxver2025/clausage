import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPricingCacheDir } from './pricing.js';
import { accountFingerprint } from './usage-resets.js';
import type { LimitSnapshot, LimitWindow, ResetGrant } from './types.js';

export type CodexUsageResult = { ok: true; snapshot: LimitSnapshot } | { ok: false; error: string };
const obj = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

function windowOf(value: unknown): LimitWindow | undefined {
  const w = obj(value);
  if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 ||
    typeof w.windowDurationMins !== 'number' || !Number.isFinite(w.windowDurationMins) || w.windowDurationMins <= 0 ||
    typeof w.resetsAt !== 'number' || !Number.isFinite(w.resetsAt)) return;
  return { usedPercent: w.usedPercent, windowMinutes: w.windowDurationMins, resetsAt: w.resetsAt * 1000 };
}

export function parseCodexUsage(value: unknown, now = Date.now()): LimitSnapshot | null {
  const body = obj(value);
  const buckets = obj(body?.rateLimitsByLimitId);
  const rate = obj(buckets ? buckets.codex : body?.rateLimits);
  if (!body || !rate) return null;
  const primary = windowOf(rate.primary);
  const secondary = windowOf(rate.secondary);
  if (!primary && !secondary) return null;
  const summary = obj(body.rateLimitResetCredits);
  const grants: ResetGrant[] = [];
  let detailsValid = Array.isArray(summary?.credits);
  if (Array.isArray(summary?.credits)) for (const raw of summary.credits) {
    const c = obj(raw);
    if (!c || typeof c.id !== 'string' || !['available', 'redeemed', 'redeeming'].includes(String(c.status))) { detailsValid = false; continue; }
    if (c.status === 'redeeming') { detailsValid = false; continue; }
    grants.push({
      id: accountFingerprint(c.id), label: typeof c.title === 'string' ? c.title.slice(0, 160) : 'Full reset',
      remaining: c.status === 'available' ? 1 : 0,
      ...(typeof c.expiresAt === 'number' && Number.isFinite(c.expiresAt) ? { expiresAt: c.expiresAt * 1000 } : {}),
    });
  }
  return {
    tool: 'codex', timestamp: now, ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}),
    ...(typeof rate.planType === 'string' ? { planType: rate.planType } : {}),
    ...(typeof body.accountId === 'string' ? { accountKey: accountFingerprint(body.accountId) } : {}),
    ...(summary && typeof summary.availableCount === 'number' && Number.isSafeInteger(summary.availableCount) && summary.availableCount >= 0
      ? { resets: { availableCount: summary.availableCount, ...(detailsValid ? { grants } : {}) } } : {}),
  };
}

/** Only initializes the installed CLI and reads account limits; never starts a turn or redeems a reset. */
export async function fetchCodexUsage(options: { command?: string; timeoutMs?: number } = {}): Promise<CodexUsageResult> {
  return new Promise((resolve) => {
    const child = spawn(options.command ?? 'codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    let settled = false;
    const finish = (result: CodexUsageResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'Codex account check timed out.' }), options.timeoutMs ?? 12_000);
    child.on('error', () => finish({ ok: false, error: 'Couldn’t start Codex. Install the Codex CLI to check available resets.' }));
    child.stdin.on('error', () => finish({ ok: false, error: 'Couldn’t read Codex account limits.' }));
    child.on('exit', () => finish({ ok: false, error: 'Codex account check stopped. Check that Codex is signed in.' }));
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    lines.on('line', (line) => {
      let m: Record<string, unknown> | undefined;
      try { m = obj(JSON.parse(line)); } catch { return; }
      if (!m) return;
      if (m.id === 1) {
        if (m.error) return finish({ ok: false, error: 'This Codex CLI could not initialize an account check.' });
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read', params: {} });
      } else if (m.id === 2) {
        const snapshot = m.error ? null : parseCodexUsage(m.result);
        finish(snapshot ? { ok: true, snapshot } : { ok: false, error: 'Codex did not supply account usage. Check the login and CLI version.' });
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'clausage', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
  });
}

export function codexUsageHistoryFile(): string {
  return join(defaultPricingCacheDir(), 'codex-usage.jsonl');
}

export function readCodexUsageHistory(file = codexUsageHistoryFile(), now = Date.now()): LimitSnapshot[] {
  try {
    return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
      try {
        const s = JSON.parse(line) as LimitSnapshot;
        return s?.tool === 'codex' && Number.isFinite(s.timestamp) && s.timestamp <= now && now - s.timestamp < 45 * 86_400_000 ? [s] : [];
      } catch { return []; }
    }).sort((a, b) => a.timestamp - b.timestamp);
  } catch { return []; }
}

export function appendCodexUsage(snapshot: LimitSnapshot, file = codexUsageHistoryFile()): void {
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, JSON.stringify(snapshot) + '\n', { mode: 0o600 });
  if (statSync(file).size > 512 * 1024) writeFileSync(file, readCodexUsageHistory(file).map((s) => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 });
}
