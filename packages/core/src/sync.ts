/**
 * Multi-computer sync through a shared folder (iCloud Drive, Dropbox, Syncthing, a network share…).
 *
 * Each computer writes one snapshot file, `<folder>/<machineId>.clausage.enc`, holding its raw
 * parser output (normalised token counts and metadata only: the parsers never keep prompt or
 * response text). Every computer reads the other snapshots and merges them into its own load,
 * tagging events and sessions with the computer's name. Pricing is applied by the reader, so all
 * machines are costed with the same table and cost mode. No server, ports or accounts.
 *
 * Config lives in `$CLAUSAGE_CONFIG_DIR` or `$XDG_CONFIG_HOME/clausage` or `~/.config/clausage`
 * (`config.json`). `CLAUSAGE_MACHINE` and `CLAUSAGE_SYNC_DIR` override the saved values.
 */
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { ParseResult, ToolId } from './types.js';
import { TOOL_IDS } from './types.js';

export interface SyncConfig {
  /** stable random id for this computer; names the snapshot file */
  machineId: string;
  /** display name for this computer (defaults to the host name) */
  machineName: string;
  /** shared folder; sync is off when unset */
  folder?: string;
  /** write this computer's snapshot (default true when a folder is set) */
  publish?: boolean;
}

export interface MachineSnapshot {
  machineId: string;
  machineName: string;
  /** epoch ms */
  exportedAt: number;
  /** tools that had data on that machine */
  tools: ToolId[];
  results: ParseResult[];
}

export interface RemoteMachine {
  machineId: string;
  machineName: string;
  exportedAt: number;
  file: string;
  bytes: number;
  events: number;
  tools: ToolId[];
}

const FORMAT = 'clausage-sync';
const VERSION = 1;
const SUFFIX = '.clausage.enc';
const LEGACY_SUFFIX = '.clausage.json.gz';
// Wire format: versioned header, 12-byte nonce, 16-byte authentication tag, ciphertext.
const HEADER = Buffer.from('CLAUSAGE-E2EE-1\n');
const TAG_START = HEADER.length + 12;
const DATA_START = TAG_START + 16;

function assertPrivatePath(folder: string, file: string): void {
  const rel = relative(realpathSync(folder), realpathSync(file));
  if (!(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))) {
    throw new Error('Keep the encryption key and clausage config outside the shared folder.');
  }
}

function parseKey(text: string): Buffer {
  const hex = text.trim();
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('Invalid sync.key. Import the key generated on the first computer.');
  return Buffer.from(hex, 'hex');
}

export function installSyncKey(source?: string): string {
  const folder = loadSyncConfig().folder;
  if (source && folder) assertPrivatePath(folder, source);
  const key = source ? parseKey(readFileSync(source, 'utf8')) : randomBytes(32);
  return storeSyncKey(key, folder);
}

export function importSyncKeyText(text: string): string {
  return storeSyncKey(parseKey(text), loadSyncConfig().folder);
}

export function installedSyncKeyPath(): string | null {
  const file = join(configDir(), 'sync.key');
  return statSync(file, { throwIfNoEntry: false })?.isFile() ? file : null;
}

function storeSyncKey(key: Buffer, folder?: string): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (folder) assertPrivatePath(folder, dir);
  const file = join(dir, 'sync.key');
  writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  return file;
}

function readKey(folder: string): Buffer {
  const file = join(configDir(), 'sync.key');
  try {
    assertPrivatePath(folder, file);
    return parseKey(readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    throw new Error('Sync needs an encryption key. Create or import one in Settings → Computers, or use clausage sync init-key and sync import-key <file>.');
  }
}


export function configDir(): string {
  const env = process.env.CLAUSAGE_CONFIG_DIR?.trim();
  if (env) return resolve(env);
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? resolve(xdg) : join(homedir(), '.config'), 'clausage');
}

function configFile(): string {
  return join(configDir(), 'config.json');
}

let cachedDefaultName: string | undefined;

/** The OS's friendly computer name (macOS Computer Name), else the host name, else a generic label. */
function defaultMachineName(): string {
  if (cachedDefaultName) return cachedDefaultName;
  let name = '';
  if (process.platform === 'darwin') {
    try {
      name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // not available: fall back to the host name
    }
  }
  if (!name) {
    const host = hostname().replace(/\.(local|lan|home)$/i, '');
    // DHCP sometimes hands out MAC- or IP-shaped host names; those make poor labels.
    if (host && !/^([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}$/i.test(host) && !/^\d+(\.\d+){3}$/.test(host)) name = host;
  }
  return (cachedDefaultName = (name || 'This computer').slice(0, 64));
}

/** Everything in config.json; other modules (limits) add their own keys. */
export interface StoredConfig {
  machineId?: string;
  machineName?: string;
  sync?: { folder?: string; publish?: boolean };
  [key: string]: unknown;
}

export function readStored(): StoredConfig {
  try {
    const parsed = JSON.parse(readFileSync(configFile(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as StoredConfig) : {};
  } catch {
    return {};
  }
}

export function writeStored(cfg: StoredConfig): void {
  mkdirSync(configDir(), { recursive: true });
  const tmp = `${configFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, configFile());
}

/** The sync config, creating and saving a machine id on first use. */
export function loadSyncConfig(): SyncConfig {
  const stored = readStored();
  let machineId = stored.machineId;
  if (!machineId || !/^[a-zA-Z0-9-]{8,64}$/.test(machineId)) {
    machineId = randomUUID();
    try {
      writeStored({ ...stored, machineId });
    } catch {
      // read-only config dir: the id lasts for this process
    }
  }
  const envName = process.env.CLAUSAGE_MACHINE?.trim();
  const envDir = process.env.CLAUSAGE_SYNC_DIR?.trim();
  const folder = envDir || stored.sync?.folder?.trim() || undefined;
  return {
    machineId,
    machineName: envName || stored.machineName?.trim() || defaultMachineName(),
    ...(folder ? { folder: resolve(folder.replace(/^~(?=$|[\\/])/, homedir())) } : {}),
    publish: stored.sync?.publish !== false,
  };
}

/** Save config changes (pass `folder: null` to turn sync off). Returns the effective config. */
export function saveSyncConfig(patch: { machineName?: string; folder?: string | null; publish?: boolean }): SyncConfig {
  const current = loadSyncConfig();
  const stored = readStored();
  const next: StoredConfig = { ...stored, machineId: current.machineId };
  if (patch.machineName !== undefined) {
    const name = patch.machineName.trim().slice(0, 64);
    if (name) next.machineName = name;
    else delete next.machineName;
  }
  const sync = { ...(stored.sync ?? {}) };
  if (patch.folder === null || patch.folder === '') delete sync.folder;
  else if (patch.folder !== undefined) {
    const dir = resolve(patch.folder.trim().replace(/^~(?=$|[\\/])/, homedir()));
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not a folder: ${dir}`);
    assertPrivatePath(dir, configDir());
    sync.folder = dir;
  }
  if (patch.publish !== undefined) sync.publish = patch.publish;
  next.sync = sync;
  writeStored(next);
  return loadSyncConfig();
}

/** Write this machine's snapshot into the sync folder (atomically, so sync clients never see half a file). */
export function writeSnapshot(config: SyncConfig, results: ParseResult[], now = Date.now()): { file: string; bytes: number } {
  if (!config.folder) throw new Error('No sync folder is set');
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(config.machineId)) throw new Error('Invalid machine ID');
  const key = readKey(config.folder);
  const payload = {
    format: FORMAT,
    version: VERSION,
    machineId: config.machineId,
    machineName: config.machineName,
    exportedAt: now,
    tools: results.filter((r) => r.events.length || r.historical.length).map((r) => r.tool),
    // `sources` are local paths; the reader has no use for them and they'd leak the home dir layout.
    results: results.map((r) => ({ ...r, sources: [], parseWarnings: undefined })),
  };
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([HEADER, Buffer.from(config.machineId)]));
  const ciphertext = cipher.update(gzipSync(JSON.stringify(payload), { level: 6 }));
  const final = cipher.final();
  const body = Buffer.concat([HEADER, nonce, cipher.getAuthTag(), ciphertext, final]);
  const file = join(config.folder, `${config.machineId}${SUFFIX}`);
  const tmp = join(config.folder, `.${config.machineId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  rmSync(join(config.folder, config.machineId + LEGACY_SUFFIX), { force: true });
  return { file, bytes: body.length };
}

const snapshotCache = new Map<string, { size: number; ctimeMs: number; fingerprint: string; snap: MachineSnapshot }>();

function readSnapshotFile(file: string, key: Buffer, fingerprint: string, warn?: (m: string) => void): MachineSnapshot | null {
  const st = statSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) return null;
  const hit = snapshotCache.get(file);
  if (hit && hit.size === st.size && hit.ctimeMs === st.ctimeMs && hit.fingerprint === fingerprint) return hit.snap;
  let snap: MachineSnapshot | null = null;
  try {
    const body = readFileSync(file);
    const id = basename(file, SUFFIX);
    if (body.length <= DATA_START || !body.subarray(0, HEADER.length).equals(HEADER)) throw new Error('unsupported encrypted snapshot');
    const decipher = createDecipheriv('aes-256-gcm', key, body.subarray(HEADER.length, TAG_START), { authTagLength: 16 });
    decipher.setAAD(Buffer.concat([HEADER, Buffer.from(id)]));
    decipher.setAuthTag(body.subarray(TAG_START, DATA_START));
    const compressed = decipher.update(body.subarray(DATA_START));
    let final: Buffer;
    try {
      final = decipher.final();
    } catch {
      throw new Error('authentication failed. Check that both computers have the same key.');
    }
    const raw = JSON.parse(gunzipSync(Buffer.concat([compressed, final])).toString('utf8')) as Record<string, unknown>;
    if (raw.machineId !== id) throw new Error('snapshot machine ID mismatch');
    if (raw.format !== FORMAT) throw new Error('not a clausage sync file');
    if (raw.version !== VERSION) throw new Error(`unsupported version ${String(raw.version)} (update clausage on both computers)`);
    const results = (Array.isArray(raw.results) ? raw.results : []) as ParseResult[];
    snap = {
      machineId: String(raw.machineId ?? ''),
      machineName: String(raw.machineName ?? 'Unknown computer').slice(0, 64),
      exportedAt: Number(raw.exportedAt) || st.mtimeMs,
      tools: (Array.isArray(raw.tools) ? raw.tools : []).filter((t): t is ToolId => TOOL_IDS.includes(t as ToolId)),
      results: results.filter((r) => r && TOOL_IDS.includes(r.tool) && Array.isArray(r.events)),
    };
  } catch (err) {
    warn?.(`sync: skipped ${file}: ${(err as Error).message}`);
  }
  if (snap) snapshotCache.set(file, { size: st.size, ctimeMs: st.ctimeMs, fingerprint, snap });
  return snap;
}

/** Every other machine's snapshot in the sync folder (cached until a file changes). */
export function readRemoteSnapshots(config: SyncConfig, warn?: (m: string) => void): MachineSnapshot[] {
  if (!config.folder) return [];
  let names: string[];
  try {
    names = readdirSync(config.folder);
  } catch (err) {
    warn?.(`sync: cannot read folder ${config.folder}: ${(err as Error).message}`);
    return [];
  }
  if (names.some((name) => name.endsWith(LEGACY_SUFFIX))) {
    warn?.('sync: plaintext snapshots ignored. Update each publishing computer and sync again to replace its old file.');
  }
  let key: Buffer;
  try {
    key = readKey(config.folder);
  } catch (err) {
    warn?.('sync: ' + (err as Error).message);
    return [];
  }
  const fingerprint = createHash('sha256').update(key).digest('hex');
  const out: MachineSnapshot[] = [];
  for (const name of names) {
    if (!name.endsWith(SUFFIX) || name === `${config.machineId}${SUFFIX}`) continue;
    const snap = readSnapshotFile(join(config.folder, name), key, fingerprint, warn);
    if (snap && snap.machineId !== config.machineId) out.push(snap);
  }
  return out.sort((a, b) => a.machineName.localeCompare(b.machineName));
}

/** Summary of the other machines in the sync folder, for status displays. */
export function listRemoteMachines(config: SyncConfig, warn?: (m: string) => void): RemoteMachine[] {
  return readRemoteSnapshots(config, warn).map((s) => {
    const file = join(config.folder!, `${s.machineId}${SUFFIX}`);
    return {
      machineId: s.machineId,
      machineName: s.machineName,
      exportedAt: s.exportedAt,
      file,
      bytes: statSync(file, { throwIfNoEntry: false })?.size ?? 0,
      events: s.results.reduce((n, r) => n + r.events.length, 0),
      tools: s.tools,
    };
  });
}

/** When this machine last wrote its snapshot, if it has. */
export function localSnapshotInfo(config: SyncConfig): { file: string; exportedAt: number; bytes: number } | null {
  if (!config.folder) return null;
  const file = join(config.folder, `${config.machineId}${SUFFIX}`);
  const st = statSync(file, { throwIfNoEntry: false });
  return st?.isFile() ? { file, exportedAt: st.mtimeMs, bytes: st.size } : null;
}
