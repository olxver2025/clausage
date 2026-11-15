import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pipeline } from 'node:stream';
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

const CHUNK_BYTES = 1 << 20;

/** A file's bytes, a chunk at a time; a chunk is only valid until the next one is requested. */
async function* plainChunks(file: string): AsyncGenerator<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) return;
      yield buf.subarray(0, bytesRead);
    }
  } finally {
    await fh.close();
  }
}

function zstChunks(file: string): AsyncIterable<Buffer> {
  const z = zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream };
  if (typeof z.createZstdDecompress !== 'function') {
    throw new Error('zstd decompression requires Node >= 22.15');
  }
  return pipeline(createReadStream(file, { highWaterMark: CHUNK_BYTES }), z.createZstdDecompress(), () => {}) as never;
}

/** Call `onLine` with each line of the byte stream (without the newline; a final unterminated line too). */
async function forEachLine(chunks: AsyncIterable<Buffer>, onLine: (line: string) => void): Promise<void> {
  // bytes of a line that runs past the end of the chunks seen so far (copied: chunks may be reused)
  let carry: Buffer[] = [];
  for await (const chunk of chunks) {
    let start = 0;
    let nl = chunk.indexOf(10);
    while (nl !== -1) {
      if (carry.length) {
        carry.push(chunk.subarray(start, nl));
        onLine(Buffer.concat(carry).toString('utf8'));
        carry = [];
      } else {
        onLine(chunk.toString('utf8', start, nl));
      }
      start = nl + 1;
      nl = chunk.indexOf(10, start);
    }
    if (start < chunk.length) carry.push(Buffer.from(chunk.subarray(start)));
  }
  if (carry.length) onLine(Buffer.concat(carry).toString('utf8'));
}

/**
 * Parse every JSON value in a JSONL file. Same skipping rules and `.zst` support as
 * readJsonlLines, but awaits once per 1MB chunk instead of once per line: far fewer promises,
 * which matters when a host (e.g. React's dev-mode async tracking) instruments every promise
 * created while it runs.
 *
 * The file is never held whole (in memory as one buffer or JS string): rollouts can be tens of
 * megabytes, and a long-running host otherwise keeps that peak as resident memory long after.
 * `map` runs on each value as it is parsed, so a caller that keeps only a few fields lets the full
 * parsed line be collected straight away instead of holding the whole file's objects at once;
 * values it maps to `undefined` are left out (a caller that only handles each line returns nothing).
 */
export async function readJsonlFile(file: string, map?: (value: unknown) => unknown): Promise<unknown[]> {
  const out: unknown[] = [];
  const onLine = (line: string) => {
    const r = parseLine(line);
    if (!r.ok) return;
    const v = map ? map(r.value) : r.value;
    if (v !== undefined) out.push(v);
  };
  if (!file.toLowerCase().endsWith('.zst')) {
    await forEachLine(plainChunks(file), onLine);
    return out;
  }
  try {
    await forEachLine(zstChunks(file), onLine);
  } catch (err) {
    // A truncated .zst of a live session may fail to decompress; surface as no lines.
    if ((err as Error).message?.includes('Node >=')) throw err;
    return [];
  }
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
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

/** Longest tool name kept; longer names are cut. */
export const TOOL_NAME_MAX = 80;

/**
 * A tool call's name as recorded by the tool (`Bash`, `apply_patch`, `mcp__github__create_pr`),
 * trimmed and capped at TOOL_NAME_MAX characters. Non-string or empty names give undefined.
 * Only the name is ever read; a call's arguments, input and output are never touched.
 */
export function toolCallName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  return s.length > TOOL_NAME_MAX ? s.slice(0, TOOL_NAME_MAX) : s;
}

/** Add `n` calls of `name` to a per-name tally (a Map, so any name is a safe key). */
export function countToolCall(tally: Map<string, number>, name: string | undefined, n = 1): void {
  if (!name || !(n > 0)) return;
  tally.set(name, (tally.get(name) ?? 0) + n);
}

/** A tally as SessionInfo.toolCallsByName: undefined when empty, keys sorted for stable output. */
export function toolCallsRecord(tally: ReadonlyMap<string, number>): Record<string, number> | undefined {
  if (tally.size === 0) return undefined;
  return Object.fromEntries([...tally].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/** Sum of a tally's counts. */
export function toolCallTotal(tally: ReadonlyMap<string, number>): number {
  let n = 0;
  for (const v of tally.values()) n += v;
  return n;
}
