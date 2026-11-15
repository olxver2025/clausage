/**
 * Opt-in: Claude's real usage limits, as Claude Code's `/usage` screen shows them.
 *
 * Claude Code never writes its limit status to disk, so the only source is Anthropic's usage
 * endpoint, called with the Claude Code login. When the user turns this on:
 *
 * - the login is read from the macOS Keychain (item "Claude Code-credentials") or
 *   `~/.claude/.credentials.json` (`$CLAUDE_CONFIG_DIR` honoured); only the access token, its
 *   expiry and the plan name are used, kept in memory for the one request, never stored, logged
 *   or returned;
 * - the token is only ever sent to https://api.anthropic.com/api/oauth/usage;
 * - an expired token is never refreshed (refreshing rotates it and could sign Claude Code out);
 *   the user is asked to open Claude Code once instead;
 * - normalized percentages, reset times and saved-reset grants are appended to clausage's cache, so Claude's
 *   windows get the same history as Codex's (anchored blocks, window-size estimates).
 *
 * The endpoint is private and undocumented; parsing is defensive and any change surfaces as an
 * error message rather than wrong numbers.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultPricingCacheDir } from './pricing.js';
import { readStored, writeStored } from './sync.js';
import { accountFingerprint } from './usage-resets.js';
import type { LimitSnapshot, LimitWindow, ResetAvailability, ResetGrant } from './types.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const HISTORY_DAYS = 45;
let agentPromise: Promise<string> | undefined;
function usageUserAgent(): Promise<string> {
  return agentPromise ??= new Promise((done) => {
    execFile('claude', ['--version'], { timeout: 5000, maxBuffer: 4096 }, (err, stdout) => {
      const version = !err && /\b(\d+\.\d+\.\d+)\b/.exec(String(stdout))?.[1];
      done(version ? `claude-cli/${version} (external, cli)` : 'clausage/0.1.0');
    });
  });
}

export interface ClaudeUsageConfig {
  enabled: boolean;
}

export function loadClaudeUsageConfig(): ClaudeUsageConfig {
  const raw = readStored().claudeUsage as { enabled?: unknown } | undefined;
  return { enabled: raw?.enabled === true };
}

export function saveClaudeUsageConfig(config: ClaudeUsageConfig): ClaudeUsageConfig {
  writeStored({ ...readStored(), claudeUsage: { enabled: config.enabled === true } });
  return loadClaudeUsageConfig();
}

export type ClaudeUsageErrorCode = 'no-credentials' | 'expired' | 'unauthorized' | 'http' | 'network' | 'format';

export type ClaudeUsageResult =
  | { ok: true; snapshot: LimitSnapshot }
  | { ok: false; code: ClaudeUsageErrorCode; error: string; at: number };

interface Credentials {
  accessToken: string;
  expiresAt?: number;
  subscriptionType?: string;
}

function parseCredentials(text: string): Credentials | null {
  try {
    const o = JSON.parse(text) as { claudeAiOauth?: Record<string, unknown> };
    const c = o?.claudeAiOauth;
    if (!c || typeof c.accessToken !== 'string' || !c.accessToken) return null;
    return {
      accessToken: c.accessToken,
      // milliseconds normally; accept seconds too
      ...(typeof c.expiresAt === 'number' && c.expiresAt > 0 ? { expiresAt: c.expiresAt < 1e12 ? c.expiresAt * 1000 : c.expiresAt } : {}),
      ...(typeof c.subscriptionType === 'string' && c.subscriptionType ? { subscriptionType: c.subscriptionType } : {}),
    };
  } catch {
    return null;
  }
}

function keychain(): Promise<string | null> {
  return new Promise((done) => {
    execFile('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) =>
      done(err ? null : String(stdout).trim() || null),
    );
  });
}

/** The Claude Code login (access token, expiry, plan); null if Claude Code isn't signed in here. */
export async function readClaudeCredentials(): Promise<Credentials | null> {
  if (process.platform === 'darwin') {
    const text = await keychain();
    const creds = text ? parseCredentials(text) : null;
    if (creds) return creds;
  }
  const dirs = (process.env.CLAUDE_CONFIG_DIR ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => resolve(d));
  dirs.push(join(homedir(), '.claude'));
  for (const dir of dirs) {
    try {
      const creds = parseCredentials(readFileSync(join(dir, '.credentials.json'), 'utf8'));
      if (creds) return creds;
    } catch {
      // not there
    }
  }
  return null;
}

const WINDOW_MINUTES: Array<[RegExp, number]> = [
  [/^five_hour/, 300],
  [/^seven_day/, 10080],
];

function label(key: string): string {
  if (key === 'five_hour') return '5-hour window';
  if (key === 'seven_day') return 'Weekly';
  const m = /^seven_day_(.+)$/.exec(key);
  if (m) return `Weekly · ${m[1]!.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}`;
  return key.replace(/_/g, ' ');
}

export function parseClaudeResets(value: unknown, now = Date.now()): ResetAvailability | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  if (data.ineligible_reason === 'unavailable') return;
  if (!Array.isArray(data.grants)) return;
  const grants: ResetGrant[] = [];
  for (const raw of data.grants) {
    if (!raw || typeof raw !== 'object') return;
    const g = raw as Record<string, unknown>;
    if (typeof g.id !== 'string' || !Number.isSafeInteger(g.resets_left) || (g.resets_left as number) < 0) return;
    const expiry = typeof g.ends_at === 'string' ? Date.parse(g.ends_at) : NaN;
    grants.push({
      id: accountFingerprint(g.id), label: typeof g.label === 'string' ? g.label.slice(0, 160) : 'Usage reset',
      remaining: g.resets_left as number,
      ...(Number.isFinite(expiry) ? { expiresAt: expiry } : {}),
      ...(typeof g.usable_now === 'boolean' ? { usableNow: g.usable_now } : {}),
    });
  }
  return { availableCount: grants.reduce((n, g) => n + (g.expiresAt === undefined || g.expiresAt > now ? g.remaining : 0), 0), grants };
}

/** Turn the endpoint's response into a limit snapshot; null if it doesn't look like usage data. */
export function parseClaudeUsage(body: unknown, now: number, planType?: string): LimitSnapshot | null {
  if (!body || typeof body !== 'object') return null;
  const windows = new Map<string, LimitWindow>();
  for (const [key, v] of Object.entries(body as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    if (typeof o.utilization !== 'number' || !Number.isFinite(o.utilization)) continue;
    const minutes = WINDOW_MINUTES.find(([re]) => re.test(key))?.[1];
    if (!minutes) continue;
    const reset = typeof o.resets_at === 'string' ? Date.parse(o.resets_at) : typeof o.resets_at === 'number' ? o.resets_at * (o.resets_at < 1e12 ? 1000 : 1) : NaN;
    // No reset time means the window hasn't started (nothing used since the last reset).
    windows.set(key, { usedPercent: o.utilization, windowMinutes: minutes, resetsAt: Number.isFinite(reset) ? reset : now });
  }
  const primary = windows.get('five_hour');
  const secondary = windows.get('seven_day');
  if (!primary && !secondary) return null;
  const extra = [...windows]
    .filter(([k]) => k !== 'five_hour' && k !== 'seven_day' && k !== 'seven_day_oauth_apps')
    .map(([key, window]) => ({ key, label: label(key), window }));
  const resets = parseClaudeResets((body as Record<string, unknown>).cedar_ember, now);
  return {
    tool: 'claude-code',
    timestamp: now,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(extra.length ? { extra } : {}),
    ...(planType ? { planType } : {}),
    ...(resets ? { resets } : {}),
  };
}

export interface FetchClaudeUsageOptions {
  now?: number;
  /** test seams */
  fetch?: typeof fetch;
  readCredentials?: () => Promise<Credentials | null>;
}

/** One request to Anthropic's usage endpoint with the Claude Code login. */
export async function fetchClaudeUsage(opts: FetchClaudeUsageOptions = {}): Promise<ClaudeUsageResult> {
  const now = opts.now ?? Date.now();
  const fail = (code: ClaudeUsageErrorCode, error: string): ClaudeUsageResult => ({ ok: false, code, error, at: now });
  const creds = await (opts.readCredentials ?? readClaudeCredentials)();
  if (!creds) return fail('no-credentials', 'Claude Code isn’t signed in on this computer.');
  if (creds.expiresAt !== undefined && creds.expiresAt <= now) {
    const ago = Math.round((now - creds.expiresAt) / 60_000);
    return fail(
      'expired',
      `The Claude Code login saved in ${process.platform === 'darwin' ? 'the Keychain' : '.credentials.json'} expired ${ago < 1 ? 'just now' : ago < 120 ? `${ago} min ago` : `${Math.round(ago / 60)} h ago`}. Claude Code renews it when it next makes a request from the terminal.`,
    );
  }
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${USAGE_URL}?cedar_ember=1&skip_spend=1`, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': opts.fetch ? 'clausage' : await usageUserAgent(),
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return fail('network', `Couldn’t reach Anthropic: ${(err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) {
    return fail('unauthorized', 'Anthropic didn’t accept the Claude Code login. Open Claude Code once to renew it.');
  }
  if (!res.ok) return fail('http', `Anthropic’s usage service answered ${res.status}.`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return fail('format', 'Anthropic’s usage service sent something unexpected.');
  }
  const snapshot = parseClaudeUsage(body, now, creds.subscriptionType);
  if (snapshot) {
    // Prefer a stable JWT subject. Opaque logins are isolated when the token rotates.
    let identity = creds.accessToken;
    try {
      const claims = JSON.parse(Buffer.from(creds.accessToken.split('.')[1] ?? '', 'base64url').toString());
      if (typeof claims.sub === 'string') identity = claims.sub;
    } catch { /* opaque token */ }
    snapshot.accountKey = accountFingerprint(identity);
  }
  return snapshot ? { ok: true, snapshot } : fail('format', 'Anthropic’s usage response has changed; clausage can’t read it.');
}

// ---------------------------------------------------------------------------------------------
// History (normalized usage and saved-reset metadata; no credentials or raw redemption IDs)

export function claudeUsageHistoryFile(): string {
  return join(defaultPricingCacheDir(), 'claude-usage.jsonl');
}

export function appendClaudeUsage(snapshot: LimitSnapshot, file = claudeUsageHistoryFile()): void {
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, JSON.stringify(snapshot) + '\n', { mode: 0o600 });
  // keep the file small: rewrite without old lines about once a day
  const st = statSync(file);
  if (st.size > 512 * 1024) {
    const keep = readClaudeUsageHistory(file);
    writeFileSync(file, keep.map((s) => JSON.stringify(s)).join('\n') + (keep.length ? '\n' : ''));
  }
}

export function readClaudeUsageHistory(file = claudeUsageHistoryFile(), now = Date.now()): LimitSnapshot[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: LimitSnapshot[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as LimitSnapshot;
      if (s?.tool !== 'claude-code' || typeof s.timestamp !== 'number') continue;
      if (now - s.timestamp > HISTORY_DAYS * 86_400_000) continue;
      out.push(s);
    } catch {
      // skip a torn line
    }
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}
