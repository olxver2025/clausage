import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

/** Default idle threshold used for active-time estimation (5 minutes). */
export const DEFAULT_IDLE_MS = 5 * 60 * 1000;

function parseLine(line: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = line.trim();
  if (!trimmed) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

function decodeZst(buf: Buffer): string {
  const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
  if (typeof z.zstdDecompressSync !== 'function') {
    throw new Error('zstd decompression requires Node >= 22.15');
  }
  return z.zstdDecompressSync(buf).toString('utf8');
}

/**
 * Parse every JSON value in a JSONL file, reading it in one go. Same skipping rules and `.zst`
 * support as readJsonlLines, but parses synchronously instead of awaiting each line: far fewer
 * promises, which matters when a host (e.g. React's dev-mode async tracking) instruments every
 * promise created while it runs.
 */
export async function readJsonlFile(file: string): Promise<unknown[]> {
  let text: string;
  if (file.toLowerCase().endsWith('.zst')) {
    try {
      text = decodeZst(await readFile(file));
    } catch (err) {
      // A truncated .zst of a live session may fail to decompress; surface as no lines.
      if ((err as Error).message?.includes('Node >=')) throw err;
      return [];
    }
  } else {
    text = await readFile(file, 'utf8');
  }
  const out: unknown[] = [];
  let start = 0;
  while (start < text.length) {
    let nl = text.indexOf('\n', start);
    if (nl === -1) nl = text.length;
    const r = parseLine(text.slice(start, nl));
    if (r.ok) out.push(r.value);
    start = nl + 1;
  }
  return out;
}

/**
 * Iterate parsed JSON values from a JSONL file. Blank, partial or invalid lines are skipped
 * silently (live files may end in a half-written line). Supports `.zst` compressed files via
 * zlib.zstdDecompressSync (Node >= 22.15 / 24).
 */
export async function* readJsonlLines(file: string): AsyncIterable<unknown> {
  if (file.toLowerCase().endsWith('.zst')) {
    let text: string;
    try {
      text = decodeZst(await readFile(file));
    } catch (err) {
      // A truncated .zst of a live session may fail to decompress; surface as no lines.
      if ((err as Error).message?.includes('Node >=')) throw err;
      return;
    }
    let start = 0;
    while (start < text.length) {
      let nl = text.indexOf('\n', start);
      if (nl === -1) nl = text.length;
      const r = parseLine(text.slice(start, nl));
      if (r.ok) yield r.value;
      start = nl + 1;
    }
    return;
  }
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const r = parseLine(line);
      if (r.ok) yield r.value;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Recursively collect files under `root` for which `predicate(fullPath, name)` is true.
 * Missing roots yield an empty list. Symlinked directories are not followed. Sorted output.
 */
export async function walkFiles(
  root: string,
  predicate: (fullPath: string, name: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (ent) => {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) await walk(full);
        else if (ent.isFile() && predicate(full, ent.name)) out.push(full);
      }),
    );
  }
  await walk(root);
  out.sort();
  return out;
}

/** True when the path exists (file or directory). */
export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Strip a Windows `\\?\` (or `\\?\UNC\`) long-path prefix and resolve to an absolute path. '' stays ''. */
export function normalizePath(p: string): string {
  if (!p) return '';
  let s = p;
  if (s.startsWith('\\\\?\\UNC\\')) s = '\\\\' + s.slice(8);
  else if (s.startsWith('\\\\?\\') || s.startsWith('//?/')) s = s.slice(4);
  s = path.resolve(s);
  // Normalise drive letter case on Windows for stable grouping.
  if (/^[a-z]:/.test(s)) s = s[0]!.toUpperCase() + s.slice(1);
  return s;
}

/** User home directory (honours HOME / USERPROFILE overrides, useful in tests). */
export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/**
 * Active time estimate: sum of gaps between consecutive (sorted) timestamps that are shorter
 * than or equal to `idleMs`. Gaps longer than the threshold count as idle.
 */
export function computeActiveMs(timestamps: number[], idleMs: number = DEFAULT_IDLE_MS): number {
  const ts = timestamps.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i]! - ts[i - 1]!;
    if (gap > 0 && gap <= idleMs) total += gap;
  }
  return total;
}

/**
 * Read an env var holding one or more paths, separated by commas or the platform path
 * delimiter (`;` on Windows, `:` elsewhere). Returns undefined when unset or empty.
 * On Windows a `:` is never treated as a separator (drive letters).
 */
export function envPaths(varName: string): string[] | undefined {
  const raw = process.env[varName];
  if (raw === undefined) return undefined;
  const sep = path.delimiter === ';' ? /[,;]/ : /[,:]/;
  const parts = raw
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('~') ? path.join(homeDir(), s.slice(1)) : s))
    .map((s) => path.resolve(s));
  return parts.length ? parts : undefined;
}

/** Parse an ISO string / epoch seconds / epoch ms into epoch ms, or NaN. */
export function toEpochMs(v: unknown): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    if (/^\d+(\.\d+)?$/.test(v)) return toEpochMs(Number(v));
    return Date.parse(v);
  }
  return NaN;
}

/** Coerce to a finite non-negative number (0 otherwise). */
export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}
