import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliOptions } from '../args.js';
import { c } from '../format.js';

/** The monorepo root when the CLI runs from a clone (packages/cli/dist/commands → root), else undefined. */
export function findRepoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  const root = resolve(from, '..', '..', '..', '..');
  const webPkg = join(root, 'apps', 'web', 'package.json');
  const rootPkg = join(root, 'package.json');
  if (!existsSync(webPkg) || !existsSync(rootPkg)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(rootPkg, 'utf8')) as { workspaces?: string[] };
    return Array.isArray(pkg.workspaces) ? root : undefined;
  } catch {
    return undefined;
  }
}

function instructions(port: number): string {
  return [
    '',
    ` ${c.bold('clausage web dashboard')}`,
    '',
    ' The dashboard ships with the source repository, not with the published CLI. From a clone run:',
    '',
    `   ${c.cyan('npm install')}`,
    `   ${c.cyan('npm run build')}       ${c.dim('# builds @clausage/core and the CLI')}`,
    `   ${c.cyan(`npm run dev -w web -- -p ${port}`)}`,
    '',
    ` Then open ${c.cyan(`http://localhost:${port}`)}. Everything stays local; no data leaves your machine`,
    ' except the LiteLLM pricing download.',
    '',
  ].join('\n');
}

export function runWeb(opts: Pick<CliOptions, 'port'>): Promise<number> {
  const port = opts.port;
  const root = findRepoRoot();
  if (!root) {
    process.stdout.write(instructions(port) + '\n');
    return Promise.resolve(0);
  }
  if (!existsSync(join(root, 'packages', 'core', 'dist', 'index.js'))) {
    process.stderr.write(`${c.red('error: ')}@clausage/core is not built. Run ${c.cyan('npm run build')} in ${root} first.\n`);
    return Promise.resolve(1);
  }
  if (!existsSync(join(root, 'node_modules', 'next')) && !existsSync(join(root, 'apps', 'web', 'node_modules', 'next'))) {
    process.stderr.write(`${c.red('error: ')}The web app's dependencies are missing. Run ${c.cyan('npm install')} in ${root} first.\n`);
    return Promise.resolve(1);
  }

  const url = `http://localhost:${port}`;
  process.stdout.write(`\n ${c.bold('clausage web')}  starting the dashboard at ${c.cyan(url)}  ${c.dim('(Ctrl+C to stop)')}\n\n`);

  return new Promise((done) => {
    // One command string: `port` is a validated integer, and npm is a .cmd shim on Windows that needs a shell.
    const child = spawn(`npm run dev -w web -- -p ${port}`, { cwd: root, stdio: 'inherit', shell: true });
    const forward = () => {};
    // Ctrl+C reaches the child through the terminal; the CLI waits for it to exit.
    process.on('SIGINT', forward);
    child.on('error', (e) => {
      process.off('SIGINT', forward);
      process.stderr.write(`${c.red('error: ')}could not start npm: ${e.message}\n`);
      done(1);
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', forward);
      done(code ?? (signal ? 130 : 0));
    });
  });
}
