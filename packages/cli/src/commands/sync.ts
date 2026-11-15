import {
  installSyncKey,
  listRemoteMachines,
  loadSyncConfig,
  localSnapshotInfo,
  parseTools,
  saveSyncConfig,
  TOOL_IDS,
  writeSnapshot,
} from '@clausage/core';
import type { CliOptions } from '../args.js';
import { c } from '../format.js';
import { printJson } from '../context.js';

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/**
 * clausage sync [--folder <dir|off>] [--name <name>]
 * Configures the shared sync folder, writes this computer's snapshot into it and lists the others.
 */
export async function runSync(opts: CliOptions): Promise<number> {
  if (opts.positionals.length) {
    const [command, source] = opts.positionals;
    if (!((command === 'init-key' && opts.positionals.length === 1) ||
          (command === 'import-key' && opts.positionals.length === 2 && source))) {
      throw new Error('Use clausage sync init-key or clausage sync import-key <file>.');
    }
    if (opts.folder !== undefined || opts.name !== undefined) throw new Error('Configure the folder separately after setting up the key.');
    const keyFile = installSyncKey(source);
    if (opts.json) printJson({ keyFile });
    else process.stdout.write(`Sync key saved to ${keyFile}\n`);
    return 0;
  }
  if (opts.folder !== undefined || opts.name !== undefined) {
    const off = opts.folder === '' || opts.folder === 'off';
    saveSyncConfig({
      ...(opts.name !== undefined ? { machineName: opts.name } : {}),
      ...(opts.folder !== undefined ? { folder: off ? null : opts.folder } : {}),
    });
  }
  const config = loadSyncConfig();
  if (config.folder && config.publish !== false) {
    const warn = (m: string) => opts.debug && process.stderr.write(c.dim(m) + '\n');
    writeSnapshot(config, await parseTools(TOOL_IDS, { paths: opts.paths, warn }));
  }
  const local = localSnapshotInfo(config);
  const remotes = listRemoteMachines(config, (m) => process.stderr.write(c.yellow('warning: ') + m + '\n'));
  if (opts.json) {
    printJson({ machineName: config.machineName, folder: config.folder ?? null, local, remotes });
    return 0;
  }
  const out: string[] = ['', ` ${c.bold('This computer')}  ${config.machineName}`];
  if (!config.folder) {
    out.push(` ${c.bold('Sync folder')}    ${c.dim('not set')}`, '');
    out.push(' First run clausage sync init-key on one computer. Transfer the key privately and run clausage sync import-key <file> on each other computer.');
    out.push(' 1. Create a folder in iCloud Drive, Dropbox, Syncthing or a shared network drive.');
    out.push(' 2. On each computer, run this with the local path to that same existing folder:');
    out.push(`   ${c.cyan('clausage sync --folder ~/Dropbox/clausage --name "Work laptop"')}`);
    out.push(' 3. Wait for your folder service to transfer the files, then run clausage sync to check.', '');
    process.stdout.write(out.join('\n') + '\n');
    return 0;
  }
  out.push(` ${c.bold('Sync folder')}    ${config.folder}`);
  out.push(` ${c.bold('Shared')}         ${config.publish === false ? 'no (viewing only)' : local ? `written ${ago(local.exportedAt)}` : 'not yet'}`, '');
  if (!remotes.length) out.push(c.dim(' No other computers yet. Set up the same shared folder on each computer and wait for the files to transfer.'));
  for (const m of remotes) {
    out.push(` ${m.machineName.padEnd(24)} ${c.dim(`synced ${ago(m.exportedAt)} · ${m.events.toLocaleString('en-US')} requests · ${m.tools.join(', ')}`)}`);
  }
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}
