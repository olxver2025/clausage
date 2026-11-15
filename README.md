# clausage

A [ccusage](https://github.com/ryoppippi/ccusage)-style usage tracker for agentic coding tools. It reads the local logs of **Claude Code**, **OpenAI Codex**, **Grok Build**, **OpenCode**, **Hermes Agent**, **OpenClaw**, **Pi**, **Gemini CLI**, **Amp**, **Qwen Code**, **GitHub Copilot CLI** and **Aider** (opt-in analytics log), optionally combined across several computers, and reports tokens, cost and active time per day, week, month, session, 5-hour billing block, model, project and tool.

Everything runs locally. The only network request is the LiteLLM price list (skip it with `--offline`). clausage reads metadata and token counts only. It never reads, stores or prints prompt or response text, credentials, `auth.json` or API keys, except the opt-in Claude limits check, which uses the Claude Code login for that one request (see Usage limits). Session titles are the one exception: they are shown when the tool stores one, and some tools build the title from your first prompt. Tool calls are counted by tool name (`Bash`, `apply_patch`, `mcp__github__create_pr`); their arguments, inputs and outputs are never read.

## Install

Requirements: Node.js 22.5 or newer (Node 24 recommended: `.jsonl.zst` Codex rollouts need `zlib.zstdDecompressSync`, and OpenCode needs `node:sqlite`).

```sh
git clone <repo> clausage && cd clausage
npm install
npm run build          # builds @clausage/core, then the CLI
node packages/cli/dist/index.js daily
# or: npm run cli -- daily
# or link it globally: npm link -w clausage  ->  clausage daily
```

Neither package has runtime dependencies. Both use Node built-ins only.

## Usage

```sh
clausage                       # = clausage daily
clausage weekly --breakdown    # per-model sub-rows
clausage monthly --json
clausage session -t codex      # one tool; subagents grouped under their root session
clausage blocks --active       # current 5h block, burn rate and projection
clausage models --since 20261101 --until 20261113
clausage projects -p myrepo
clausage tools
clausage summary               # today / this week / this month, per tool, top models
clausage pricing claude-opus-5-5 gpt-6.1-sol
clausage statusline            # one line for Claude Code's status bar
clausage export > usage.csv    # every usage event, for spreadsheets
clausage monthly -f csv        # any report as CSV / TSV / JSON Lines
clausage mcp                   # MCP server for agents
clausage codex daily           # ccusage-style "<tool> <command>" also works
```

### Commands

| Command | Description |
|---|---|
| `daily` (default) | Usage per day in the chosen timezone |
| `weekly` | Usage per week (`--start-of-week`, default monday) |
| `monthly` | Usage per month |
| `session` | Usage per root session: project, title, last activity, active time, models, tokens, cost. `+N` = number of subagent sessions folded in. `--id <suffix>` selects one session and also prints its tool calls per tool name |
| `blocks` | 5-hour billing blocks per tool, with gap rows. The active block also shows elapsed/remaining time, burn rate and a projection. Block options: `-a/--active`, `-r/--recent` (last 3 days), `--token-limit <n\|max>`, `--session-length <hours>` |
| `models` | Usage per model (with per-tool breakdown) |
| `projects` | Usage per project directory (the root session's working directory) |
| `tools` | Usage per tool |
| `summary` | Dashboard: period totals, per-tool sessions and active time, top models |
| `pricing <model...>` | Shows which LiteLLM entry a model name resolves to, and its prices and tiers |
| `web` | Starts the local web dashboard (`apps/web`) on `--port` (default 3456) when run from a clone; prints setup instructions otherwise |
| `sync` | Set up and check multi-computer sync (`--folder <dir\|off>`, `--name <name>`). See Multiple computers |
| `statusline` | One line of limits and spend for a status bar. See Status line |
| `export` | Every normalised usage event as CSV (default), TSV, JSON Lines or JSON. See Export |
| `mcp` | Model Context Protocol server on stdio. See MCP server |
| `help` | Help; `clausage <command> --help` for command options |

### Options

| Flag | Meaning |
|---|---|
| `-s, --since <date>` / `-u, --until <date>` | Inclusive date range, `YYYYMMDD` or `YYYY-MM-DD`, in the report timezone |
| `-t, --tool <list>` | `claude`, `codex`, `grok`, `opencode`, `hermes`, `openclaw`, `pi`, `gemini`, `amp`, `qwen`, `copilot`, `aider` (aliases `claude-code`, `cc`, `oc`, `qwen-code`, `copilot-cli`). Comma-separated or repeatable |
| `--local` | Only this computer; ignore other computers in the sync folder |
| `-j, --json` | Print the report object as JSON (includes `warnings`) |
| `-f, --format <fmt>` | `table` (default), `json`, `csv`, `tsv` or `jsonl`. With `--breakdown`, CSV has one line per model |
| `-b, --breakdown` | Per-model sub-rows |
| `-m, --mode <auto\|calculate\|display>` | Cost mode (see Pricing) |
| `-O, --offline` | Never fetch prices; use the cache or the embedded snapshot |
| `--refresh-pricing` | Re-download the LiteLLM prices now |
| `-o, --order <asc\|desc>` | Sort order for time-based reports (default `asc`) |
| `-z, --timezone <tz>` | IANA zone, `UTC` or `local` (default local). DST-safe day boundaries |
| `--start-of-week <day>` | For `weekly` / `summary` |
| `--compact` | Narrow table. Used automatically when the table is wider than the terminal |
| `-p, --project <text>` | Only projects whose path contains `text` (case-insensitive). Historical aggregates are excluded because they have no project |
| `--no-subagents` | Exclude subagent / sidechain / guardian usage |
| `--path <tool=dir>` | Override a tool's data directory. Repeatable, e.g. `--path codex=D:\backup\.codex` |
| `--no-color` | Disable colour (`NO_COLOR` and `FORCE_COLOR` are honoured; non-TTY output is uncoloured) |
| `-d, --debug` | Show every warning (by default each warning is shown once) |

Table markers: `†` means the row includes historical aggregates (see Claude Code below), and `*` means a model in the row has no known price, so the cost may be understated.

### Status line

`clausage statusline` prints one line for Claude Code's status bar, tmux or a shell prompt:

```
5h 42% 2h14m left · ⚠ limit ~18:50 · wk 61% · today $12.30 · session $3.10
```

Add it to `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "clausage statusline" } }
```

- Claude Code pipes its session JSON on stdin. When that's there, the line shows Claude Code's limits and the current session's cost. Without stdin it shows every tool with a known limit (use `-t` to choose).
- **Percentages:** reported limits (Codex, opt-in Claude) or your configured token limits; a reported figure older than 30 minutes is dimmed and marked `~`. Tools without a known limit show the 5-hour window's tokens instead.
- **Warnings:** `⚠ limit ~18:50` appears when the pace so far reaches 100% before the reset.
- **Speed:** figures are cached for `--cache` seconds (default 30, in the clausage cache folder), so a refresh is about 50 ms. Pricing is never downloaded here. When Real Claude limits is on, the line refreshes it at most once a minute and waits up to 3 seconds.
- Colour is on even though stdout is a pipe; `--no-color` or `NO_COLOR` turns it off. `--json` prints the figures.

### Export

- `clausage export` writes every normalised usage event (one billable response): timestamp (ISO), tool, computer, session and root session, subagent flag, project, model, provider, service tier, the token fields, cost, recorded cost and API latency. `--format csv` (default), `tsv`, `jsonl` or `json`, with the usual filters. There is no prompt or response text at this level. Historical aggregates have no per-event detail and are left out.
- Every report takes `--format csv|tsv|jsonl` too (`clausage session -f csv`, `clausage daily -b -f csv` for one line per day and model).
- CSV is RFC 4180 with CRLF line ends; values starting with `= + - @` are prefixed with `'` so spreadsheets never run them as formulas.
- Parquet isn't offered, because it would need a runtime dependency.

### MCP server

`clausage mcp` runs a read-only [Model Context Protocol](https://modelcontextprotocol.io) server on stdio, so an agent can check its own headroom and spend without the dashboard running:

```sh
claude mcp add clausage -- clausage mcp
```

For Codex, add `[mcp_servers.clausage]` with `command = "clausage"` and `args = ["mcp"]` to `~/.codex/config.toml`.

| Tool | Returns |
|---|---|
| `get_usage_report` | Any report kind (`daily` … `tools`) with filters, newest first, `limit` rows |
| `get_limits` | 5-hour and weekly windows per tool: % used, reset, pace projection, limit hits |
| `get_spend_summary` | Today, this week and this month, per tool, plus the month-end forecast |
| `get_cache_efficiency` | Cache hit rate and savings by `total`, `model`, `tool`, `day` or `session` |
| `find_spikes` | Unusual days and sessions (default: last 90 days) |

Global options (`--offline`, `-t`, `--local`, `-z`, `-m`) set the defaults; parsed logs are reused for 30 seconds. Only JSON-RPC goes to stdout.

### Insights

- **Cache efficiency:** hit rate = cache read ÷ (input + cache read + cache write). *Saved* = the same requests priced as if every prompt token were uncached input, minus their actual list-price cost, so cache-write premiums count against it. It can be negative for a model that writes much more than it reads. Unpriced models are left out of the money figures.
- **Unusual days:** a day is flagged when its cost is at least 3.5 robust standard deviations (1.4826 × median absolute deviation) above the median of your days with usage, at least 2× that median, and at least $1. Idle days are left out of the baseline.
- **Unusual sessions:** the same rule over root sessions of 10 cents or more, with a higher bar (5 deviations, 5×, at least $5).
- **Forecast:** month-to-date spend + the average daily cost of the last 14 complete days (idle days count as $0, days before your first recorded usage don't) × the time left in the month. The range uses the 25th and 75th percentile day instead of the average.

## Data sources

| Tool | Default location | Override |
|---|---|---|
| Claude Code | `~/.config/claude` and `~/.claude` (`projects/**/*.jsonl`, `stats-cache.json`) | `CLAUDE_CONFIG_DIR` (comma-separated), `--path claude=…` |
| Codex | `~/.codex` (`sessions/**`, `archived_sessions/**` `rollout-*.jsonl[.zst]`, `state_*.sqlite` for titles, `session_index.jsonl`) | `CODEX_HOME` (comma / `;` separated), `--path codex=…` |
| Grok Build | `~/.grok` plus any `~/.grok-*` profile with a `sessions/` dir | `GROK_HOME`, `--path grok=…` |
| OpenCode | `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode` (`opencode*.db`, legacy `storage/` JSON tree) | `OPENCODE_DATA_DIR`, `--path opencode=…` |
| Hermes Agent | `~/.hermes` (`state.db`, `profiles/*/state.db`) | `HERMES_HOME`, `--path hermes=…` |
| OpenClaw | `~/.openclaw`, `~/.openclaw-*`, legacy `~/.clawdbot` / `~/.moltbot` (`agents/*/sessions/*.jsonl`, `agents/*/agent/openclaw-agent.sqlite`) | `OPENCLAW_STATE_DIR`, `--path openclaw=…` |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` |
| Gemini CLI | `~/.gemini/tmp/*/chats/**` | `GEMINI_CLI_HOME`, `--path gemini=…` |
| Amp | `~/.local/share/amp/threads/T-*.json` (or `$XDG_DATA_HOME/amp`) | `AMP_DATA_DIR` (comma-separated), `--path amp=…` |
| Qwen Code | `~/.qwen/projects/*/chats/*.jsonl` | `QWEN_RUNTIME_DIR`, `QWEN_HOME`, `QWEN_DATA_DIR`, `--path qwen=…` |
| Copilot CLI | `~/.copilot` (`session-store.db`, `session-state/*/events.jsonl`) | `COPILOT_HOME`, `--path copilot=…` |
| Aider | opt-in analytics log only: `$AIDER_ANALYTICS_LOG` or `~/.aider/analytics.jsonl` | `AIDER_ANALYTICS_LOG`, `--path aider=<file\|dir>` |

The databases are opened read-only. If an OpenCode database is locked, a temporary copy is opened instead and deleted afterwards. Files that clausage never opens include prompt history files, `auth.json`, `config.toml`, credential tables and search indexes.

## How tokens are normalised

Every tool reports usage differently. clausage maps them all onto one shape:

- **input**: uncached input
- **cache read**
- **cache write**: the 1-hour part is tracked separately for pricing
- **output**: includes reasoning
- **reasoning**: informational subset of output

**Total = input + cache read + cache write + output.**

### Claude Code
- **Fields:** `message.usage` from assistant entries. `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (1h split from `cache_creation.ephemeral_1h_input_tokens`) and `output_tokens`.
- **Dedupe:** each API response is written once per content block, so entries are deduped globally on `message.id:requestId`.
- **Subagents:** files under `subagents/` share the parent session id. They are folded into the parent session as subagents.
- **Excluded:** `<synthetic>` entries.
- **Historical aggregates:** Claude Code deletes transcripts after 30 days, but `~/.claude/stats-cache.json` keeps per-day, per-model totals. clausage adds those rows (marked `†`) for any UTC day that has no transcript. The file only stores a combined total per day, so the split into input, output and cache types is estimated from each model's lifetime ratio. Day totals are exact.

### Codex
- **Token source:** per-response `token_usage_record` lines when present, otherwise deltas of the cumulative `token_count` snapshots.
- **Inherited snapshots:** forked subagent and guardian (`codex-auto-review`) rollouts start with a copy of the parent's totals. Any snapshot before the file's first `task_started`, or before the subagent history start, is treated as a baseline, not as usage.
- **Compaction:** remote compaction calls are added from `compacted.latest_token_usage_record`.
- **Duplicate files:** copies of the same thread (`.jsonl`, `.jsonl.zst`, archived) are deduped.
- **Field mapping:** input = `input_tokens − cached_input_tokens`; output already includes reasoning.
- **Active time:** the sum of `task_complete` / `turn_aborted` `duration_ms`.

### Grok Build
- **Source:** one event per turn and model from `updates.jsonl` `turn_completed.usage.modelUsage`.
- **Reasoning tokens are not included in Grok's `outputTokens`,** so output = `outputTokens + reasoningTokens`. With that, the calculated cost matches Grok's own stored cost exactly.
- **Recorded cost:** `costUsdTicks / 1e10`.
- **Forks:** turns are deduped by `prompt_id`, so forks that copy a parent's turns are not counted twice.

### OpenCode
- **Source:** one event per assistant message, from SQLite (`message`, `part` and `session` tables, via `json_extract`, so message text never enters the process) or the legacy JSON storage.
- **Field mapping:** `tokens.input` already excludes cache; output = `tokens.output + tokens.reasoning`.
- **Multi-step messages:** when a message has several `step-finish` parts, they are summed.
- **Recorded cost:** used when it is greater than 0. OpenCode stores 0 for models it has no price for.
- **Child sessions** are rolled up to their root session.

### Hermes Agent, OpenClaw, Pi and Gemini CLI
Field mappings, sources and what is never opened are documented in [docs/formats/hermes.md](docs/formats/hermes.md), [docs/formats/openclaw.md](docs/formats/openclaw.md) (also covers Pi, which writes the same session format) and [docs/formats/gemini.md](docs/formats/gemini.md). In short:
- **Hermes:** one event per `session_model_usage` row, plus the session counters' remainder; recorded `actual_cost_usd` / `estimated_cost_usd` is used. Child sessions roll up via `parent_session_id`.
- **OpenClaw / Pi:** one event per assistant message `usage` (`input` already excludes cache; `output` includes reasoning); recorded `cost.total` is used. OpenClaw 2026.8+ transcripts are read from its per-agent SQLite store.
- **Gemini CLI:** `input` includes cached tokens, so input = `input − cached`; output = `output + thoughts`. No recorded cost.

### Amp, Qwen Code, Copilot CLI and Aider
Details in [docs/formats/amp.md](docs/formats/amp.md), [docs/formats/qwen.md](docs/formats/qwen.md), [docs/formats/copilot.md](docs/formats/copilot.md) and [docs/formats/aider.md](docs/formats/aider.md). In short:
- **Amp:** one event per `usageLedger` event (cache split from the message it points at), or per assistant message `usage` when a thread has no ledger. `inputTokens` is already uncached. Amp credits are not converted to USD. Newer Amp versions keep threads on ampcode.com; point `--path amp=` at exported `T-*.json` files to read those.
- **Qwen Code:** one event per `assistant` record's `usageMetadata`. `promptTokenCount` includes the cache read, so input = `prompt − cached`; whether reasoning is already inside `candidatesTokenCount` follows Qwen's own rule (the total decides, else the auth type). Cache writes are not persisted, so they count as input. Records are deduped by `uuid`; titles come from `custom_title` records.
- **Copilot CLI:** per-call rows from `session-store.db` `assistant_usage_events` (input includes both cache buckets and is reduced by them; `total_nano_aiu / 1e11` is the recorded USD cost). Sessions without rows fall back to the cumulative `session.shutdown` `modelMetrics`, reported as the difference between consecutive shutdowns, dated at each shutdown. Per-call `assistant.usage` events are never written to disk.
- **Aider:** Aider keeps no token counts by default. With `--analytics-log <file>` (or `AIDER_ANALYTICS_LOG`) it logs a `message_send` event per reply with `prompt_tokens`, `completion_tokens` and its own `cost` estimate, which clausage reads (cache is not split out; each `launched` event starts a session; no project). The chat history markdown is never opened.
- **Not supported:** Cursor keeps usage on its servers (the local `state.vscdb` composer data has no reliable token counts), and Kiro mostly persists zero token counts, so either would need estimates from message text.

## Multiple computers

clausage can add up usage from several computers through a **shared folder** that iCloud Drive, Dropbox, Syncthing or a network share keeps in sync. There's no clausage server or account.

1. Open **Settings → Computers → Create key** on the first computer. Transfer the file at the displayed path privately, then select **Import key** in Settings on each other computer. For CLI setup, run `clausage sync init-key` on **one** computer. It creates a random 256-bit key in the local clausage config directory and prints its path. Transfer that file privately (for example by USB) and run `clausage sync import-key /path/to/sync.key` on every other computer, including read-only viewers. Keep the key and config directory outside the shared drive.
2. Create a folder inside your shared drive, such as `Dropbox/clausage`, and make sure it is available on every computer.
3. On each computer, open **Settings → Computers**, enter the local path to that existing folder, and save it. Give each computer a recognizable name. The local path can differ between computers, but it must point to the same shared folder.
4. Wait for your folder service to transfer the files. The other computers will appear in Settings; use **Sync now** to refresh the local snapshot and check again.

You can use the CLI instead on each computer (replace the example path with the folder's local path):

```sh
clausage sync --folder ~/Dropbox/clausage --name "Work laptop"   # on each computer
clausage sync                                                      # status, and refresh this computer's snapshot
clausage daily --local                                             # only this computer
```

To stop syncing on a computer, clear its sync folder in Settings or run `clausage sync --folder off`.

- Each computer writes `<folder>/<machine-id>.clausage.enc`, an AES-256-GCM encrypted snapshot of its normalised token counts and metadata (no prompt or response text, no local data-folder paths). The dashboard rewrites it at most once a minute while it runs; `clausage sync` writes it on demand.
- Every report reads the other computers' snapshots and prices them with the reader's own price table and cost mode. Totals, models and tools combine all computers. Sessions and projects are grouped by computer, and the Overview gets a **By computer** table.
- Config is in `~/.config/clausage/config.json` (`$CLAUSAGE_CONFIG_DIR` or `$XDG_CONFIG_HOME` override). `CLAUSAGE_MACHINE` and `CLAUSAGE_SYNC_DIR` override the saved name and folder. Dashboard URLs take `machines=<name>,<name>` to filter.
- When upgrading from plaintext sync, update every computer, install the same key and publish once on each writer. A successful publish removes its previous `.clausage.json.gz` file. Remove leftover snapshots from retired computers and clear provider version history or backups if needed. The shared folder still exposes random machine IDs, file sizes and update times.
- Update clausage on all computers together: a snapshot from a newer format version is skipped with a warning.

### Sessions, projects and active time
- **Sessions:** reports group by root session. Subagents, sidechains, forks and guardians are folded into their parent.
- **Projects:** events are attributed to the root session's working directory.
- **Active time:** the larger of the tool's own figure for the root session and an idle-gap estimate over every request in the session tree. The estimate adds up the gaps between consecutive requests that are under 5 minutes.
- **Tool calls:** `SessionInfo.toolCallsByName` counts calls per tool name, and the session report's `meta.toolCallsByName` folds in the subagents. Only the name is read: Claude Code `tool_use` blocks (deduped by id), Codex `function_call` / `custom_tool_call` items (MCP tools as `mcp__<server>__<tool>`; `local_shell_call`, `web_search_call` and `tool_search_call` by type), OpenCode tool parts (`$.tool` via `json_extract`), Grok `x.ai/tool` names, Gemini CLI `toolCalls[].name`, Hermes `tool_calls[].function.name` (via `json_extract`), and OpenClaw / Pi `toolCall` blocks. Names are trimmed and cut at 80 characters. `toolCalls` is the total; it is larger than the named sum when a log has calls without a name (some Grok backend calls). `toolCallStats()` and `mcpServerStats()` in `@clausage/core` summarise them across sessions.

### Usage limits
- **Codex** reports its limits with every response (`rate_limits`: a 5-hour and a weekly window with % used and reset time). clausage keeps that history, so the current windows are exact, blocks are the real 5-hour windows, each past block shows the % it used, and a full window's size is estimated from past windows (median of usage ÷ % used, in tokens and API-priced cost). Reports whose reset times differ by a few seconds count as one window.
- **Claude (opt-in):** Claude Code never saves its limits on disk. Turn on **Settings → Usage limits → Real Claude limits from your account** and clausage reads the Claude Code login (macOS Keychain item `Claude Code-credentials`, or `~/.claude/.credentials.json`) to fetch the same numbers as `/usage` from Anthropic, at most once a minute while the dashboard runs: the 5-hour and weekly windows plus any model-specific weekly window. The token is only sent to `api.anthropic.com`, never stored or shown, and an expired login is never renewed by clausage. Each normalized result (percentages, reset times and saved-reset metadata) is kept in `~/.cache/clausage/claude-usage.jsonl`, so Claude's blocks are anchored to its real windows like Codex's. The endpoint is unofficial and may change; failures are shown on the card.
- **Other tools** don't record their limits. The 5-hour window is the current block (first request floored to the hour, as Claude's limit starts), the week is rolling or from a reset day and hour you set, and % comes from token limits you set in **Settings → Usage limits** (saved under `limits` in `config.json`, also used by `clausage blocks`).
- **Limit hits:** Codex's `rate_limit_reached_type`, and Claude Code API-error entries flagged as rate limits. For Claude Code, only the synthetic error entry's own text is matched, and only against its fixed "usage limit reached" format (to read the reset time); no other message text is read.
- **Pace:** the share used so far ÷ time elapsed in the window, extrapolated to the reset; the dashboard warns when that reaches 100% before the reset.
- **Saved resets:** Blocks & limits checks Codex through the installed, signed-in `codex app-server` and Claude through its opt-in usage connection, at most once a minute while the dashboard loads usage. It shows available reset counts, grant labels and expiration dates. Codex account snapshots are kept in `~/.cache/clausage/codex-usage.jsonl`; Claude's existing history also stores reset grants. Only normalized usage and reset metadata are retained; account and grant identifiers are hashed. No reset is ever redeemed by clausage. Missing data, failed checks and Grok's unsupported reset availability are shown as unknown, not zero.
- **Unexpected resets:** a drop of at least 10 percentage points, observed more than five minutes before the prior scheduled reset, triggers a comparison of saved-reset grants. A falling grant counter confirms use; a disappearing, unexpired Codex grant with a lower balance indicates likely use. Otherwise the cause remains unconfirmed: a provider-wide reset or quota adjustment is possible. Scheduled refreshes, plan changes and different account fingerprints/computers aren't compared as redemptions. The latest five detected drops in the last 35 days appear on each tool's card; the time is when the drop was observed. Detection needs before-and-after reports, and cannot reconstruct an unseen reset between polls. Claude opaque-token rotation starts a new account fingerprint. Windows containing detected resets are excluded from capacity estimates.

### Billing blocks
- **Start:** a block starts at the first request, floored to the UTC hour.
- **End:** a new block starts when a request falls more than 5 hours after the block start, or more than 5 hours after the previous request.
- Blocks are built per tool.
- **Reported windows:** for tools that report their 5-hour window (Codex), requests inside a reported window form exactly that block (start and reset as reported), so blocks match the provider's own limit windows.

## Pricing

Prices come from LiteLLM's `model_prices_and_context_window.json`:

1. A cached copy under 24 hours old, in `$XDG_CACHE_HOME/clausage` or `~/.cache/clausage`.
2. Otherwise a live download (10 s timeout).
3. Otherwise the stale cache.
4. Otherwise an embedded snapshot of about 450 chat models (`packages/core/src/pricing-snapshot.json`). Regenerate it with `node packages/core/scripts/update-pricing-snapshot.mjs`.

**Model lookup:** clausage tries these in order:
1. The exact name.
2. The normalised name: lowercase, with provider prefixes, `[1m]`-style suffixes, Bedrock and Vertex decorations stripped.
3. Provider-prefixed variants, e.g. `xai/grok-4.6`.
4. The name with its date suffix stripped.
5. Aliases:
   - `codex-auto-review` maps to `gpt-5.6-luna` from 2026-07-30, and to `gpt-5.4` before.
   - `opus`, `sonnet`, `haiku` and `fable` map to the newest model of that family.
6. Progressively shorter names.
7. The closest Claude version in the same family.

A warning is printed whenever a fallback is used. `clausage pricing <model>` shows how a name resolves.

**Cost formula:** input × input price + cache read × cache-read price + 5m cache write × cache-write price + 1h cache write × 1h price (2× input when LiteLLM has no 1h price) + output × output price.

**Long-context tiers:**
- The threshold is parsed from the field name, e.g. `_above_272k_tokens` for GPT-5.4+, `_above_200k_tokens` for xAI.
- The tier applies **per request**: when input + cache read + cache write is above the threshold, the whole request is billed at the higher rate.
- Grok turns (which sum many model calls) and historical aggregates are never tiered.

**Service tiers:** Model and session breakdowns separate Fast, Ultrafast, and other recorded modes. Claude uses the response’s `usage.speed` and [Anthropic’s model-specific Fast rates](https://platform.claude.com/docs/en/build-with-claude/fast-mode), including prompt caching. Codex uses the response tier when available, otherwise the thread setting recorded at the time. Fast (`priority`) and [Ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode) use separate LiteLLM rates, including long-context and cache rates. Where the log has no speed, Clausage leaves it unspecified and estimates at standard rates. A known premium mode without a price uses recorded cost if available; otherwise it is flagged as unpriced.

**Modes (`--mode`):**
- `auto` (default): the tool's recorded cost when present (Grok, OpenCode, legacy Claude `costUSD`), otherwise calculated.
- `calculate`: always calculated from prices. Falls back to the recorded cost when no price is known.
- `display`: recorded cost only; $0 when absent.

**Not yet priced:**
- Web-search request fees.

## Web dashboard

`apps/web` is a local Next.js dashboard over the same data as the CLI. It runs on your machine only and reads the same log folders.

```sh
npm install
npm run build              # @clausage/core must be built first
clausage web               # or: node packages/cli/dist/index.js web --port 4000
# same as: npm run dev -w web   (http://localhost:3456)
```

For a faster production server: `npm run build -w web && npm run start -w web`.

Pages:
- **Overview** (`/`): today's totals, KPIs with the change against the previous period (the cache-hit tile also shows what caching saved), usage over time stacked by tool, the month-end forecast, unusual days and sessions, a card for each tool, token composition, and the top models and projects.
- **Sessions** (`/sessions`, `/sessions/<tool>/<id>`): a searchable, sortable list, and a detail page with a token and cost timeline, a per-model breakdown, tool calls per tool name and subagents. The list page also shows the top tool calls across the filtered sessions, calls per session and cost per tool call (the cost of sessions that made calls ÷ their calls).
- **Models** (`/models`): cost share, prompt-cache hit rate and savings per model, and per-model tokens, effective $/1M and the matched price, with a CSV download.
- **Projects** (`/projects`): per project folder, with drill-down via `?project=`.
- **Blocks & limits** (`/blocks`): usage limits per tool (5-hour and weekly windows, % used, reset time, pace projection, limit hits), active 5-hour blocks with projections, recent blocks with the share of the 5-hour limit each used, and an activity heatmap.
- **Settings** (`/settings`): subscriptions, theme, live updates (interval, number animation, background tabs), usage limits per tool, computers and sync, and which tools were found.

**Your money’s worth:** automatically uses Claude and Codex’s reported account plans to compare today’s and this calendar month’s API-equivalent inference with your monthly fee. Includes sourced ChatGPT, Claude, Grok, Google AI and OpenCode tiers, annual billing where verified, and optional custom monthly prices for every tool in **Settings → Subscriptions**. Broad plan types show a range when the exact tier is not reported. A $100/month subscription with $300 of logged inference shows 3× the monthly fee. Prices are a dated catalog; the comparison is estimated value, not a bill or provider cost. See [subscription pricing and methodology](docs/SUBSCRIPTIONS.md).

**Live updates:** open pages re-read the logs every 30 seconds by default (10 s to 5 min, or off, in Settings) without dimming the page, and totals roll to their new values. Only changed log files are parsed again. Hidden tabs pause unless you turn on background updates. The sidebar shows when the data was last updated.

Filters live in the URL, so every view can be shared and refreshed:
- `tools=claude-code,codex` (aliases `claude`, `cc`, `grok`, `oc`, `hermes`, `openclaw`, `pi`, `gemini`, `amp`, `qwen`, `copilot`, `aider`)
- `range=7d|30d|90d|all|custom` (default `30d`), with `since` and `until` as `YYYY-MM-DD`
- `tz` (an IANA zone, `UTC` or `local`), `mode=auto|calculate|display`, `group=daily|weekly|monthly`, `project=<substring>`, `machines=<name,…>`, `subagents=0`

Parsed data is cached in memory for 30 seconds. The **Refresh** button, or `?fresh=1`, reloads it.

JSON API for scripts and agents: `GET /api/usage?kind=daily|weekly|monthly|session|blocks|models|projects|tools` returns the report, and takes the same filter params plus `order`, `breakdown=0` and `sessionLength`. `kind=sources` lists the data folders found and `kind=limits` returns each tool's usage-limit status (5-hour and weekly windows, pace, hits) plus the raw Codex rate-limit snapshot. `kind=events` returns every usage event, `kind=cache&group=model|tool|day|session|total` the cache efficiency, and `kind=insights` the forecast and unusual days and sessions. Reports and events also take `format=csv|tsv|jsonl` (`breakdown=1` for one CSV line per model).

```sh
curl "http://localhost:3456/api/usage?kind=models&tools=codex&range=7d"
```

**Agents:** the page registers WebMCP tools in browsers that provide `document.modelContext`. These are ui-sdk's `snapshot`, `query` and `act`, which find and use the filter controls by name, plus `get_usage_report` (`{kind}`, returns the report for the current filters) and `set_filters` (`{tools, range, since, until, mode, group, tz, project}`).

Light and dark themes follow the system setting, or the choice in Settings. Tool and model-provider marks come from [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT). Prompt and message text is never shown.

## Development

```sh
npm run build
npm test            # core (node:test, synthetic fixtures only, never real user data) + web (vitest, jsdom)
npm run build -w web && npm run lint -w web && npx tsc --noEmit -p apps/web
```

Layout:
- `packages/core`: `@clausage/core`. Types (`src/types.ts`), parsers (`src/parsers/*`), `pricing.ts`, `aggregate.ts`, `loader.ts`.
- `packages/cli`: the `clausage` binary.
- `apps/web`: the dashboard.
- Data format notes and validated reference totals: `docs/formats/*.md`.

Using the library:

```ts
import { loadUsage, buildReport } from '@clausage/core';
const { events, sessions, historical } = await loadUsage({ offline: true, mode: 'auto' });
const report = buildReport('daily', events, sessions, { timezone: 'UTC', historical });
```
