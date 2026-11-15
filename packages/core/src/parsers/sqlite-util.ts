/**
 * Shared read-only SQLite helpers for parsers backed by `node:sqlite` (Hermes, OpenClaw).
 *
 * - The database is opened read-only. If that fails (locked / busy / CANTOPEN), the db and its
 *   `-wal` are copied together into a temp dir and the copy is opened; the copy is deleted on
 *   cleanup. The `-shm` file is never copied without the `-wal`.
 * - Callers select individual columns or json_extract() fields so message text never enters the
 *   process.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Minimal local typings: the repo's @types/node predates node:sqlite.
export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDb;
}

const SQLITE_SPECIFIER = 'node:sqlite';
let sqliteMod: Promise<SqliteModule | null> | undefined;

/** Import node:sqlite while suppressing only its ExperimentalWarning. null when unavailable. */
export function getSqlite(): Promise<SqliteModule | null> {
  if (!sqliteMod) {
    sqliteMod = (async () => {
      const orig = process.emitWarning;
      process.emitWarning = function (this: unknown, warning: unknown, ...rest: unknown[]) {
        const msg = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
        const r0 = rest[0];
        const type =
          typeof r0 === 'string'
            ? r0
            : typeof r0 === 'object' && r0 !== null
              ? (r0 as { type?: string }).type
              : warning instanceof Error
                ? warning.name
                : '';
        if (type === 'ExperimentalWarning' && /sqlite/i.test(msg)) return;
        return (orig as (...a: unknown[]) => void).call(process, warning, ...rest);
      } as typeof process.emitWarning;
      try {
        return (await import(SQLITE_SPECIFIER)) as SqliteModule;
      } catch {
        return null;
      } finally {
        process.emitWarning = orig;
      }
    })();
  }
  return sqliteMod;
}

/** Open `path` read-only, falling back to a temp copy of db + wal. null (after warn) on failure. */
export function openReadOnly(
  sqlite: SqliteModule,
  path: string,
  label: string,
  warn: (m: string) => void,
): { db: SqliteDb; cleanup: () => void } | null {
  try {
    const db = new sqlite.DatabaseSync(path, { readOnly: true });
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    return { db, cleanup: () => db.close() };
  } catch (err) {
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(tmpdir(), `clausage-${label}-`));
      const target = join(dir, basename(path));
      copyFileSync(path, target);
      if (existsSync(path + '-wal')) copyFileSync(path + '-wal', target + '-wal');
      const db = new sqlite.DatabaseSync(target, { readOnly: false });
      db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
      const d = dir;
      return {
        db,
        cleanup: () => {
          try {
            db.close();
          } catch {
            /* ignore */
          }
          rmSync(d, { recursive: true, force: true });
        },
      };
    } catch (err2) {
      if (dir) rmSync(dir, { recursive: true, force: true });
      warn(`${label}: cannot open ${path}: ${(err2 as Error).message ?? (err as Error).message}`);
      return null;
    }
  }
}

/** Column names of `table` ('' set when the table does not exist). */
export function tableColumns(db: SqliteDb, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}
