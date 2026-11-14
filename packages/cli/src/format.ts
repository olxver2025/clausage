import type { ToolId } from '@clausage/core';

// ---------------------------------------------------------------------------
// ANSI colours (NO_COLOR / FORCE_COLOR / non-TTY aware)

let colorEnabled = detectColor();

function detectColor(): boolean {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) return force !== '0' && force.toLowerCase() !== 'false';
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

export function setColor(enabled: boolean): void {
  colorEnabled = enabled;
}

export function useColor(): boolean {
  return colorEnabled;
}

const wrap = (open: number, close: number) => (s: string) =>
  colorEnabled ? `\u001b[${open}m${s}\u001b[${close}m` : s;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Display width (ANSI stripped; wide CJK / emoji counted as 2). */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f || (cp >= 0x300 && cp <= 0x36f)) continue;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      cp === 0x231b
    )
      w += 2;
    else w += 1;
  }
  return w;
}

/** Truncate plain text to `max` columns with an ellipsis. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (visibleWidth(s) <= max) return s;
  const plain = stripAnsi(s);
  let out = '';
  let w = 0;
  for (const ch of plain) {
    const cw = visibleWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** Truncate keeping the end (useful for paths). */
export function truncateStart(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s;
  const chars = [...stripAnsi(s)];
  let out = '';
  let w = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = visibleWidth(chars[i]!);
    if (w + cw > max - 1) break;
    out = chars[i]! + out;
    w += cw;
  }
  return '…' + out;
}

export function terminalWidth(): number {
  const env = Number(process.env.COLUMNS);
  if (process.stdout.isTTY && process.stdout.columns) return process.stdout.columns;
  if (Number.isFinite(env) && env > 0) return env;
  return 120;
}

// ---------------------------------------------------------------------------
// Numbers and durations

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtInt(n: number): string {
  return intFmt.format(Math.round(n || 0));
}

export function fmtUSD(n: number): string {
  const v = n || 0;
  if (v > 0 && v < 0.005) return '<$0.01';
  return usdFmt.format(v);
}

/** Compact token count: 1.2K, 3.4M, 5.6B. */
export function fmtShort(n: number): string {
  const v = Math.abs(n || 0);
  const sign = n < 0 ? '-' : '';
  if (v >= 1e9) return `${sign}${(v / 1e9).toFixed(v >= 1e10 ? 1 : 2)}B`;
  if (v >= 1e6) return `${sign}${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2)}M`;
  if (v >= 1e3) return `${sign}${(v / 1e3).toFixed(1)}K`;
  return `${sign}${Math.round(v)}`;
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const dtFormatters = new Map<string, Intl.DateTimeFormat>();
/** 'YYYY-MM-DD HH:mm' in the given zone. */
export function fmtDateTime(ts: number, tz: string): string {
  if (!Number.isFinite(ts) || ts <= 0) return '-';
  let f = dtFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    dtFormatters.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ts))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

// ---------------------------------------------------------------------------
// Names

export const TOOL_SHORT: Record<ToolId, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  grok: 'grok',
  opencode: 'opencode',
};

const TOOL_COLOR: Record<ToolId, (s: string) => string> = {
  'claude-code': (s) => c.yellow(s),
  codex: (s) => c.green(s),
  grok: (s) => c.magenta(s),
  opencode: (s) => c.cyan(s),
};

export function toolName(t: ToolId): string {
  return TOOL_COLOR[t] ? TOOL_COLOR[t](TOOL_SHORT[t] ?? t) : t;
}

/** Shorten a model id for tables: drop provider path, 'claude-' prefix and date suffixes. */
export function shortModel(m: string): string {
  let s = m || '(unknown)';
  if (s.includes('/')) {
    const parts = s.split('/');
    s = parts[parts.length - 1]!;
  }
  s = s.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/@\d{8}$/, '');
  // custom deployments: '<account>--<name>' and hostname-like suffixes ('.us-west.modal.direct')
  if (s.includes('--')) s = s.slice(s.lastIndexOf('--') + 2);
  const host = /\.[a-z][^.]*\.[a-z]/i.exec(s);
  if (host) s = s.slice(0, host.index);
  if (s.length > 32) s = truncate(s, 32);
  return s;
}

/** Shorten a project path to its last two segments. */
export function shortProject(p: string): string {
  if (!p) return '(unknown)';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return p;
  return parts.slice(-2).join('/');
}
