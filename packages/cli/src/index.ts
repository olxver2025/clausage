#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { UsageError, parseCli, type Command } from './args.js';
import { c, setColor } from './format.js';
import { runPeriodReport } from './commands/reports.js';
import { runSession } from './commands/session.js';
import { runBlocks } from './commands/blocks.js';
import { runSummary } from './commands/summary.js';
import { runPricing } from './commands/pricing.js';
import { runWeb } from './commands/web.js';

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

const GLOBAL_HELP = `
Usage: clausage [command] [options]

Track token usage, cost and time across Claude Code, Codex, Grok Build and OpenCode.

Commands:
  daily              Usage per day (default)
  weekly             Usage per week (--start-of-week, default monday)
  monthly            Usage per month
  session            Usage per session (subagents grouped under their root session)
  blocks             5-hour billing blocks with burn rate and projection for the active block
  models             Usage per model
  projects           Usage per project directory
  tools              Usage per tool
  summary            Dashboard: today / this week / this month, per tool, top models
  pricing <model>    Show the resolved LiteLLM price for a model
  web                Start the local web dashboard (--port, default 3456)

Options:
  -s, --since <date>        Start date, YYYYMMDD or YYYY-MM-DD (inclusive)
  -u, --until <date>        End date (inclusive)
  -t, --tool <list>         claude,codex,grok,opencode (aliases: claude-code, cc, oc); repeatable
  -j, --json                Print the report as JSON
  -b, --breakdown           Per-model sub-rows
  -m, --mode <mode>         Cost mode: auto (default; recorded cost when present), calculate, display
  -O, --offline             Use cached / embedded pricing, never fetch
      --refresh-pricing     Re-download LiteLLM pricing now
  -o, --order <asc|desc>    Sort order for time-based reports (default asc)
  -z, --timezone <tz>       IANA zone, UTC or local (default local)
      --compact             Narrow table layout
  -p, --project <text>      Only projects whose path contains <text>
      --no-subagents        Exclude subagent / sidechain usage
      --path <tool=dir>     Override a tool's data directory; repeatable
      --no-color            Disable colours (also NO_COLOR / FORCE_COLOR)
  -d, --debug               Show all warnings
  -h, --help                Show help (also: clausage <command> --help)
  -v, --version             Show version

Run "clausage <command> --help" for command-specific options.
`;

const COMMAND_HELP: Partial<Record<Command, string>> = {
  weekly: `
Usage: clausage weekly [options]

  --start-of-week <day>   sunday..saturday (default monday)
`,
  session: `
Usage: clausage session [options]

Rows per root session: Session | Tool | Project | Title | Last Active | Active time | Tokens | Cost.
"+N" after the id = number of subagent sessions folded in.

  --id <text>             Only sessions whose id contains <text>
  -p, --project <text>    Only projects whose path contains <text>
  --no-subagents          Exclude subagent usage
`,
  blocks: `
Usage: clausage blocks [options]

ccusage-style billing blocks per tool: a block starts at the first request floored to the hour
and lasts --session-length hours; a longer gap starts a new block.

  -a, --active            Only the active block(s), with projection
  -r, --recent            Only the last 3 days
  --session-length <h>    Block length in hours (default 5)
  --token-limit <n|max>   Show usage against a token limit ("max" = largest previous block)
`,
  pricing: `
Usage: clausage pricing <model> [<model>...] [--tool <tool>] [--offline] [--json]

Shows the LiteLLM key the model resolves to and its prices per 1M tokens.
`,
  web: `
Usage: clausage web [--port <n>]

Starts the Next.js dashboard from apps/web in development mode when the CLI runs from a
clone of the repository, and prints its URL. Ctrl+C stops it.

  -P, --port <n>          Port to listen on (default 3456)
`,
  summary: `
Usage: clausage summary [options]

Compact dashboard: totals for today / this week / this month / all time, per tool
(sessions, active time, tokens, cost) and the top models by cost.
`,
};

async function main(): Promise<number> {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(c.red('error: ') + (e as Error).message + '\n');
    process.stderr.write(c.dim('Run "clausage --help" for usage.\n'));
    return 2;
  }
  if (opts.color !== undefined) setColor(opts.color);
  if (opts.json) setColor(false);
  if (opts.version) {
    process.stdout.write(version() + '\n');
    return 0;
  }
  if (opts.help) {
    const specific = opts.command !== 'help' ? COMMAND_HELP[opts.command] : undefined;
    process.stdout.write((specific ? specific + GLOBAL_HELP.split('Options:')[1]!.replace(/^/, '\nGlobal options:') : GLOBAL_HELP) + '\n');
    return 0;
  }

  switch (opts.command) {
    case 'daily':
    case 'weekly':
    case 'monthly':
    case 'models':
    case 'projects':
    case 'tools':
      await runPeriodReport(opts.command, opts);
      break;
    case 'session':
      await runSession(opts);
      break;
    case 'blocks':
      await runBlocks(opts);
      break;
    case 'summary':
      await runSummary(opts);
      break;
    case 'pricing':
      await runPricing(opts);
      break;
    case 'web':
      return runWeb(opts);
    case 'help':
      process.stdout.write(GLOBAL_HELP + '\n');
      break;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    if (e instanceof UsageError) {
      process.stderr.write(c.red('error: ') + e.message + '\n');
      process.exitCode = 2;
      return;
    }
    process.stderr.write(c.red('error: ') + ((e as Error)?.stack ?? String(e)) + '\n');
    process.exitCode = 1;
  },
);

// EPIPE (e.g. `clausage | head`) should not crash noisily
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});
