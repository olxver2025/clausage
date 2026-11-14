# clausage

A [ccusage](https://github.com/ryoppippi/ccusage)-style usage tracker for agentic coding tools. It reads the local logs of **Claude Code**, **OpenAI Codex**, **Grok Build** and **OpenCode** and reports tokens, cost and active time per day, week, month, session, 5-hour billing block, model, project and tool.

Everything runs locally. The only network request is the LiteLLM price list (skip it with `--offline`). clausage reads metadata and token counts only. It never reads, stores or prints prompt or response text, credentials, `auth.json` or API keys. Session titles are the one exception: they are shown when the tool stores one, and some tools build the title from your first prompt.

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
clausage codex daily           # ccusage-style "<tool> <command>" also works
```

### Commands

| Command | Description |
|---|---|
| `daily` (default) | Usage per day in the chosen timezone |
| `weekly` | Usage per week (`--start-of-week`, default monday) |
| `monthly` | Usage per month |
| `session` | Usage per root session: project, title, last activity, active time, models, tokens, cost. `+N` = number of subagent sessions folded in. `--id <suffix>` selects one session |
| `blocks` | 5-hour billing blocks per tool, with gap rows. The active block also shows elapsed/remaining time, burn rate and a projection. Block options: `-a/--active`, `-r/--recent` (last 3 days), `--token-limit <n\|max>`, `--session-length <hours>` |
| `models` | Usage per model (with per-tool breakdown) |
| `projects` | Usage per project directory (the root session's working directory) |
| `tools` | Usage per tool |
| `summary` | Dashboard: period totals, per-tool sessions and active time, top models |
| `pricing <model...>` | Shows which LiteLLM entry a model name resolves to, and its prices and tiers |
| `web` | Starts the local web dashboard (`apps/web`) on `--port` (default 3456) when run from a clone; prints setup instructions otherwise |
| `help` | Help; `clausage <command> --help` for command options |

### Options

| Flag | Meaning |
|---|---|
| `-s, --since <date>` / `-u, --until <date>` | Inclusive date range, `YYYYMMDD` or `YYYY-MM-DD`, in the report timezone |
| `-t, --tool <list>` | `claude`, `codex`, `grok`, `opencode` (aliases `claude-code`, `cc`, `oc`). Comma-separated or repeatable |
| `-j, --json` | Print the report object as JSON (includes `warnings`) |
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

## Data sources

| Tool | Default location | Override |
|---|---|---|
| Claude Code | `~/.config/claude` and `~/.claude` (`projects/**/*.jsonl`, `stats-cache.json`) | `CLAUDE_CONFIG_DIR` (comma-separated), `--path claude=…` |
| Codex | `~/.codex` (`sessions/**`, `archived_sessions/**` `rollout-*.jsonl[.zst]`, `state_*.sqlite` for titles, `session_index.jsonl`) | `CODEX_HOME` (comma / `;` separated), `--path codex=…` |
| Grok Build | `~/.grok` plus any `~/.grok-*` profile with a `sessions/` dir | `GROK_HOME`, `--path grok=…` |
| OpenCode | `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode` (`opencode*.db`, legacy `storage/` JSON tree) | `OPENCODE_DATA_DIR`, `--path opencode=…` |

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

### Sessions, projects and active time
- **Sessions:** reports group by root session. Subagents, sidechains, forks and guardians are folded into their parent.
- **Projects:** events are attributed to the root session's working directory.
- **Active time:** the larger of the tool's own figure for the root session and an idle-gap estimate over every request in the session tree. The estimate adds up the gaps between consecutive requests that are under 5 minutes.

### Billing blocks
- **Start:** a block starts at the first request, floored to the UTC hour.
- **End:** a new block starts when a request falls more than 5 hours after the block start, or more than 5 hours after the previous request.
- Blocks are built per tool.

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

**Service tiers:** Codex requests run on the priority ("Fast") or flex tier (the recorded `service_tier`) are billed at LiteLLM's `*_priority` / `*_flex` rates, including their long-context tier, when the model has them.

**Modes (`--mode`):**
- `auto` (default): the tool's recorded cost when present (Grok, OpenCode, legacy Claude `costUSD`), otherwise calculated.
- `calculate`: always calculated from prices. Falls back to the recorded cost when no price is known.
- `display`: recorded cost only; $0 when absent.

**Not yet priced:**
- Claude fast mode, and service tiers of models with no `*_priority` / `*_flex` prices in LiteLLM: billed at standard rates.
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
- **Overview** (`/`): today's totals, KPIs with the change against the previous period, usage over time stacked by tool, a card for each tool, token composition, and the top models and projects.
- **Sessions** (`/sessions`, `/sessions/<tool>/<id>`): a searchable, sortable list, and a detail page with a token and cost timeline, a per-model breakdown and subagents.
- **Models** (`/models`): cost share, and per-model tokens, effective $/1M and the matched price.
- **Projects** (`/projects`): per project folder, with drill-down via `?project=`.
- **Blocks & limits** (`/blocks`): active 5-hour blocks with projections, a token budget, Codex rate limits, recent blocks and an activity heatmap.

Filters live in the URL, so every view can be shared and refreshed:
- `tools=claude-code,codex` (aliases `claude`, `cc`, `grok`, `oc`)
- `range=7d|30d|90d|all|custom` (default `30d`), with `since` and `until` as `YYYY-MM-DD`
- `tz` (an IANA zone, `UTC` or `local`), `mode=auto|calculate|display`, `group=daily|weekly|monthly`, `project=<substring>`, `subagents=0`

Parsed data is cached in memory for 30 seconds. The **Refresh** button, or `?fresh=1`, reloads it.

JSON API for scripts and agents: `GET /api/usage?kind=daily|weekly|monthly|session|blocks|models|projects|tools` returns the report, and takes the same filter params plus `order`, `breakdown=0` and `sessionLength`. `kind=sources` lists the data folders found and `kind=limits` returns the Codex rate-limit snapshot.

```sh
curl "http://localhost:3456/api/usage?kind=models&tools=codex&range=7d"
```

**Agents:** the page registers WebMCP tools in browsers that provide `document.modelContext`. These are ui-sdk's `snapshot`, `query` and `act`, which find and use the filter controls by name, plus `get_usage_report` (`{kind}`, returns the report for the current filters) and `set_filters` (`{tools, range, since, until, mode, group, tz, project}`).

Light and dark themes follow the system setting, or the toggle in the sidebar. Prompt and message text is never shown.

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
