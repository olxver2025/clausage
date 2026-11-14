# Usage-tracker data spec: Claude Code, Codex, Grok Build, OpenCode (plus ccusage design and LiteLLM pricing)

The extraction rules below were validated read-only against real local data. Every SQLite file was opened with `new DatabaseSync(path, { readOnly: true })`; no auth or credential file was read.

---

## 0. Six findings that change the implementation

1. **Codex rollouts are mostly Zstandard-compressed.**
   - Closed sessions are `.jsonl.zst`; only live ones are plain `.jsonl`.
   - The `rollout_path` column in `state_5.sqlite` still says `.jsonl`, and on Windows it may carry a `\\?\` prefix.
   - Node 24 can read them with `zlib.zstdDecompressSync`.
2. **Codex forked subagents inherit the parent's token totals.**
   - "Guardian" `codex-auto-review` rollouts start with a copied `token_count` snapshot that already holds the parent's totals.
   - Treat any `token_count` that appears before the file's first `task_started` as a baseline, not as usage.
   - Remote compaction calls are not included in `token_count` totals and must be added separately.
   - With both rules applied, the delta method and the `token_usage_record` method give exactly the same total.
   - Summing the `threads.tokens_used` column over-counts, because the inherited baselines are counted again.
3. **Grok `reasoningTokens` are NOT part of `outputTokens`.** They are billed on top of output.
   - With output = `outputTokens + reasoningTokens`, my calculated cost matched the stored `costUsdTicks / 1e10` exactly on every turn ($2.7798 total).
   - The ccusage Grok documentation says reasoning is a subset of output. The data says otherwise.
4. **OpenCode `tokens.output` also excludes `tokens.reasoning`, and `tokens.input` excludes cache.**
   - Calculated cost for `xai/grok-4.6` was $19.4517, identical to the stored cost.
5. **Current Claude Code no longer writes `costUSD` on entries.**
   - Every assistant entry appears twice or more, once per content block. The duplicates carry identical `usage` (79 duplicate pairs checked, 0 differences).
   - Transcripts are deleted after 30 days by default (`cleanupPeriodDays`).
   - `~/.claude/stats-cache.json` keeps aggregates that outlive deletion.
6. **LiteLLM uses different long-context thresholds per family.**
   - OpenAI GPT-5.4 and later: `_above_272k_tokens`.
   - xAI: `_above_200k_tokens`.
   - Anthropic Claude 4.6 and later on direct Anthropic: no tier (flat 1M context).
   - Parse the threshold from the field name rather than hard-coding 200k.

---

## 1. Claude Code

### Where the data lives
- **Roots:** `$CLAUDE_CONFIG_DIR`, which can be a comma-separated list. Otherwise both `~/.config/claude` and `~/.claude`.
  - The same paths apply on Linux, macOS and Windows (`C:\Users\<u>\.claude`).
- **Transcripts:** `<root>/projects/<encoded-cwd>/<sessionId>.jsonl`.
  - The encoded folder name replaces `:`, `\` and `/` with `-`, which loses information. For example `D--Coding-clausage`. Use the `cwd` field inside records instead.
- **Subagent transcripts:** `<root>/projects/<encoded-cwd>/<sessionId>/subagents/**/agent-*.jsonl`. Their records have `isSidechain: true`.
  - There is also a `journal.jsonl` there with types `launched`, `started` and `result`. It has no usage.
- **Glob:** `projects/**/*.jsonl`, recursive.
- **Aggregate cache:** `~/.claude/stats-cache.json` (version 5). Fields:
  - `dailyActivity[]{date, messageCount, sessionCount, toolCallCount}`
  - `dailyModelTokens[]{date, tokensByModel{model: n}}`
  - `modelUsage{model: {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD (0 here), contextWindow, maxOutputTokens}}`
  - `totalSessions`, `totalMessages`, `longestSession{sessionId, duration (ms), messageCount, timestamp}`, `firstSessionDate`, `hourCounts`, `lastComputedDate`

### Record types seen
`assistant`, `user`, `system` (subtypes `local_command`, `stop_hook_summary`), `attachment`, `file-history-snapshot`, `queue-operation`, `last-prompt`, `custom-title`, `agent-name`, `mode`, `permission-mode`, `cost-state`, `tools-used`, `api-request`, `api-request-shape`, `api-request-blob`, `bridge-session`, `atis-latch`.

### Usage records: `type == "assistant"` with `message.usage`
```json
{"type":"assistant","isSidechain":false,"sessionId":"<uuid>","uuid":"<uuid>","parentUuid":"<uuid>",
 "timestamp":"2026-11-13T20:51:06.204Z","cwd":"<text>","gitBranch":"<text>","version":"2.1.321","requestId":"req_...",
 "message":{"id":"msg_...","model":"claude-opus-5-5","role":"assistant","stop_reason":"tool_use",
  "content":[{"type":"thinking"},{"type":"tool_use","id":"toolu_...","name":"<tool>","input":{}}],
  "usage":{"input_tokens":2,"cache_creation_input_tokens":33486,"cache_read_input_tokens":48157,"output_tokens":618,
   "output_tokens_details":{"thinking_tokens":168},
   "cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":33486},
   "server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","speed":"standard",
   "iterations":[{"input_tokens":2,"output_tokens":618,"cache_read_input_tokens":48157,"cache_creation_input_tokens":33486}]}},
 "effort":"medium","thinkingDurationMs":1855}
```

**Token fields**
- Usage is per API call, not cumulative.
- `input_tokens` is non-cached input only.
- `cache_read_input_tokens` is cache read.
- `cache_creation_input_tokens` is cache write. Split it with `cache_creation.ephemeral_5m_input_tokens` and `cache_creation.ephemeral_1h_input_tokens`. The 1h price is the LiteLLM field `cache_creation_input_token_cost_above_1hr`, or input × 2 if missing.
- `output_tokens` already includes thinking. `output_tokens_details.thinking_tokens` is informational only.
- Total = input + output + cache_creation + cache_read.

**Dedupe**
- Key on `message.id + ":" + requestId`. This matches ccusage. Keep entries that lack either id.
- 109 of 226 assistant lines were duplicates here.
- Skip `message.model == "<synthetic>"`, and probably `isApiErrorMessage`.

**Other fields**
- **Cost:** legacy entries may carry top-level `costUSD`; use it in display/auto mode. None exists in current data.
- **`cost-state` records:** `{totalCostUSD, totalAPIDuration, totalAPIDurationWithoutRetries, totalToolDuration, totalLinesAdded, totalLinesRemoved, totalDuration, startTime, modelUsage{}, hasUnknownModelCost}`. These are session aggregates; all were 0 here.
- **Tool calls:** count unique `content[].type == "tool_use"` ids. Count them before deduping by message, because content blocks are split across the duplicate lines.
- **Prompts:** `type=="user"`, `!isMeta`, and string `message.content`. Lines that carry `toolUseResult` are tool results, not prompts.
- **Duration:** span of `timestamp` values per session, or `cost-state.totalDuration` in ms.
- **Project:** `cwd`.
- **Session:** `sessionId`.

---

## 2. Codex (CLI, VS Code and Desktop)

### Where the data lives
- **Root:** `$CODEX_HOME` (ccusage also accepts a comma-separated list), otherwise `~/.codex`.
- **Rollouts:**
  - `sessions/YYYY/MM/DD/rollout-<ISO-local-ts>-<threadId>.jsonl[.zst]`
  - `archived_sessions/rollout-*.jsonl[.zst]` (flat folder)
- **Precedence rules (ccusage):** if a plain and a `.zst` copy exist, prefer plain. If the same file is in both `sessions/` and `archived_sessions/`, prefer `sessions/`.

**SQLite metadata** (read-only; migration numbers change, so glob `state_*.sqlite`)
- `state_5.sqlite`, table `threads`, columns: `id`, `rollout_path`, `created_at` (s), `created_at_ms`, `updated_at`, `source` (`vscode` or JSON such as `{"subagent":{"other":"guardian"}}` / `{"subagent":{"thread_spawn":...}}`), `model_provider`, `model`, `reasoning_effort`, `cwd`, `title`, `tokens_used` (total only, and it includes inherited baselines), `archived`, `git_*`, `cli_version`, `originator`.
- `thread_spawn_edges(parent_thread_id, child_thread_id)`.
- `thread_history_1.sqlite`:
  - `thread_turns(thread_id, turn_id, status, started_at, completed_at, duration_ms)`
  - `thread_items(item_type ∈ agentMessage, commandExecution, mcpToolCall, webSearch, fileChange, reasoning, userMessage, ...)`
  - This file has no token data.
- `session_index.jsonl`: `{id, thread_name, updated_at}`.

### Record shape
Every line is `{timestamp (ISO UTC), ordinal, type, payload}`.

| type / payload.type | Use |
|---|---|
| `session_meta` | `payload.id` (thread id), `session_id`, `parent_thread_id`, `subagent_history_start_ordinal`, `cwd`, `originator`, `cli_version`, `source`, `model_provider`, `git{}` |
| `turn_context` | `payload.model`, `effort`, `cwd`, `turn_id`. Gives the model for the usage that follows. |
| `event_msg/thread_settings_applied` | `thread_settings.model`, `service_tier` (`default` / `priority`; priority means Fast, priced ×2 or via `*_priority` fields), `reasoning_effort` |
| `event_msg/task_started` | `turn_id`, `started_at` (s), `model_context_window` |
| `event_msg/task_complete` | `duration_ms`, `time_to_first_token_ms`, `started_at`, `completed_at` |
| `event_msg/turn_aborted` | `duration_ms`, `reason` |
| `event_msg/token_count` | `info.total_token_usage` (cumulative per thread), `info.last_token_usage` (last request), `info.model_context_window`, `rate_limits{primary{used_percent, window_minutes:300, resets_at}, secondary{window_minutes:10080}, plan_type}` |
| `token_usage_record` (newer) | `{thread_id, turn_id, session_id, response_id, usage, turn_token_usage, thread_token_usage}`. `usage` is per request. |
| `compacted` | `compaction_response_id`, `latest_token_usage_record`, `replacement_history` (skip its content) |
| `response_item/*` | `message` (role user/assistant/developer), `reasoning`, `function_call`, `custom_tool_call`, `*_output`, `compaction`, `additional_tools` |
| `world_state` | Skip. |

**Token object:** `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`
- `input_tokens` includes cached tokens, so non-cached = `input_tokens - cached_input_tokens`.
- `output_tokens` includes reasoning, which is not billed separately.
- `total_tokens = input_tokens + output_tokens`.

### Algorithm (validated; methods A and B agree to the token)
**A. Delta method**
1. Per file, track the current model from the latest `turn_context` or `thread_settings_applied`.
2. Set `started = false`. On `task_started`, set it to true.
3. For each `token_count` with `info`:
   - If not `started`, set `prev = total` and skip. This is the inherited fork baseline.
   - Otherwise, if `total.total_tokens <= prev.total_tokens`, skip. These are duplicate snapshots; 3 appeared in one file.
   - Otherwise add `delta = total - prev`, field by field, attributed to the current model, and set `prev = total`.
4. Then, for each `compacted.compaction_response_id`, add the matching `token_usage_record.usage`.
   - In the 10/25 file this was 348,846 tokens: 346,470 input, 23,552 cached, 2,376 output.
   - The `thread_token_usage` of every later record is offset by that amount relative to `token_count`.

**B. Record method** (simpler where it applies)
- Sum `token_usage_record.usage`, deduped by `response_id`.
- In forked guardian files, records only cover new requests, so baselines are excluded automatically.
- Older files without these records need method A.
- Recommendation: use B when records exist, otherwise A. ccusage also counts compaction usage only once across reports.

### Other fields and pitfalls
- **Model fallback:**
  - ccusage assumes `gpt-5` when there is no `turn_context` (logs from early September 2025).
  - `codex-auto-review` has no LiteLLM price. ccusage maps it to `gpt-5.6-luna` from 2026-07-30 onward, and to `gpt-5.4` for 2026-03-05 to 2026-07-29. Rows get `isFallback: true`.
  - `gpt-reserve` is priced as `gpt-5.6-luna`.
- **Tool calls:** `response_item` with `payload.type` ∈ {`function_call`, `custom_tool_call`, `local_shell_call`, `web_search_call`, `tool_search_call`}. Also `thread_history.thread_items` item types.
- **Messages:** `response_item/message` with role `user` or `assistant`, excluding `developer`.
- **Duration:** sum of `task_complete.duration_ms`, plus `turn_aborted.duration_ms`.
- **Project:** `session_meta.payload.cwd` or `turn_context.cwd`.
- **Session:** `session_meta.payload.id`, the thread id. `session_id` is the root session for subagents.

---

## 3. Grok Build CLI

### Where the data lives
- **Root:** `$GROK_HOME`, otherwise `~/.grok`.
  - A second home, `~/.grok-grokified`, exists here with no sessions. Consider scanning `~/.grok*`.
- **Session folders:** `sessions/<url-encoded-cwd>/<sessionId>/`.
  - The folder name is the cwd URL-encoded, for example `D%3A%5CCoding%5Cmyproject`. Use `decodeURIComponent`.
- **Files in a session folder:**
  - `updates.jsonl`: the usage source.
  - `summary.json`: `{info{id, cwd}, created_at, updated_at, last_active_at, num_messages, num_chat_messages, current_model_id, agent_name, generated_title}`.
  - `signals.json`: `{turnCount, userMessageCount, assistantMessageCount, toolCallCount, toolsUsed[], modelsUsed[], primaryModelId, sessionDurationSeconds, avgTimeToFirstTokenMs, contextTokensUsed, contextWindowTokens, agentLinesAdded, agentLinesRemoved, ...}`. Only 2 sessions have it.
  - `events.jsonl`: `{ts, type}` with types `turn_started{model_id, turn_number}`, `tool_started`, `tool_completed{duration_ms, outcome, tool_call_id}`, `first_token`, `turn_ended{outcome}`.
  - `chat_history.jsonl`: types `system`, `user`, `assistant{tool_calls[], model_id}`, `reasoning`, `tool_result`. No usage.
  - Also present: `prompt_context.json`, `rewind_points.jsonl`, `compaction_requests/*.json`, `recap_requests/*.json`.
- **Skip:** `sessions/session_search.sqlite` (full-text index) and `logs/unified.jsonl` (no per-request model).

### Usage records
Lines in `updates.jsonl` with `method == "_x.ai/session/update"` and `params.update.sessionUpdate == "turn_completed"`:
```json
{"timestamp":1787867272,"method":"_x.ai/session/update","params":{"sessionId":"<uuid>","update":{"sessionUpdate":"turn_completed",
 "prompt_id":"<uuid>","stop_reason":"end_turn|error|cancelled","agent_result":"<text>",
 "usage":{"inputTokens":2258794,"outputTokens":52190,"totalTokens":2310984,"cachedReadTokens":1827200,"cacheCreationTokens":0,
  "reasoningTokens":36261,"modelCalls":31,"apiDurationMs":1265813,"costUsdTicks":23074940000,"numTurns":31,
  "modelUsage":{"grok-4.6":{ "...same fields per model..." }}}},
 "_meta":{"eventId":"<sid>-1521","agentTimestampMs":1787867272034}}}
```
- Usage is per turn, not cumulative. `numTurns` is the model-call count within the turn.
- Prefer `modelUsage[model]` for the per-model split.
- `timestamp` is in Unix seconds; `_meta.agentTimestampMs` is in ms.
- `inputTokens` includes cache. Uncached = `inputTokens - cachedReadTokens - cacheCreationTokens`.
- `totalTokens = inputTokens + outputTokens`, which excludes reasoning.
- Bill reasoning at the output rate, in addition to `outputTokens`.
  - Check: turn 3 is 127,922 × $2/M + 242,048 × $0.5/M + (621 + 3,860) × $6/M = $0.403754, equal to `costUsdTicks` 4,037,540,000 / 1e10.
- **Cost:** `costUsdTicks / 1e10` USD, treated as the invoice cost.
- Turns that were cancelled or errored early often have no `usage`; 6 of 11 here.
- **Dedupe:** `_meta.eventId`, which should be unique.
- **Tool calls:** `session/update` with `sessionUpdate == "tool_call"` (124), or `events.jsonl` `tool_started`.
- **Pricing lookup:** LiteLLM keys are prefixed `xai/`. ccusage also strips a trailing `-build` and tries `x-ai/`.

---

## 4. OpenCode

### Where the data lives
- **Root:** `$OPENCODE_DATA_DIR` (ccusage: comma-separated list; an empty value disables fallback), otherwise `${XDG_DATA_HOME:-~/.local/share}/opencode`.
  - The same path is used on Windows: `C:\Users\<u>\.local\share\opencode`.
- **New format (v1.18.25 here):** `opencode.db` in SQLite WAL mode. Open read-only.
- **Legacy format (ccusage reads only this):**
  - `storage/message/{sessionID}/msg_*.json`
  - `storage/session/{projectID}/{sessionID}.json`
  - `storage/part/...`
  - None of these exist here. Support both formats.

### Tables
- **`session`:** `id`, `project_id`, `parent_id` (subagent sessions), `directory`, `title`, `version`, `agent`, `model` (JSON `{id, providerID, variant}`), `cost` (USD), `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `time_created`, `time_updated`, `time_archived` (ms), `summary_additions`, `summary_deletions`, `summary_files`.
  - These are session totals and match the sum of messages exactly.
- **`message`:** `id`, `session_id`, `time_created`, `data` (JSON).
  - Assistant `data`: `{"role":"assistant","parentID","mode","agent","variant","path":{"cwd","root"},"cost":0.0035667,"tokens":{"total":7723,"input":7636,"output":87,"reasoning":0,"cache":{"read":0,"write":0}},"modelID":"grok-4.6","providerID":"xai","time":{"created":ms,"completed":ms},"finish":"tool-calls|stop","error"?:{...}}`
  - User `data`: `{role:"user", time, agent, model{providerID, modelID}}`
- **`part`:** `message_id`, `session_id`, `data.type` ∈ {`text`, `reasoning{time{start, end}}`, `tool{tool, callID, state{status, input, output, time{start, end}}}`, `step-start`, `step-finish{tokens, cost, reason}`, `patch`}.
- **`event`:** an event-sourcing log (`message.updated` 770 rows, `message.part.updated` 3,502). Do not use it for totals.

### Semantics
- Per assistant message: `tokens.input` is non-cached input, `cache.read` and `cache.write` are separate, and `tokens.output` excludes `tokens.reasoning`.
- Bill output + reasoning at the output rate.
- The stored `cost` is right for `xai/grok-4.6`.
- Custom `modal/*` models have no LiteLLM price. OpenCode stores $0 or a provider-reported cost for them.
- ccusage says older OpenCode stored `cost: 0`, and always recalculates.
- **Dedupe:** by `message.id`.
- **Forks:** ccusage excludes copied parent history.
- **Tool calls:** `part.type == "tool"` (461).
- **Duration:** `time.completed - time.created`.
- **Project:** `path.cwd` or `session.directory`.

---

## 5. ccusage design to copy

Sources: ccusage.com guide and GitHub.

### Commands
- **Reports:** `daily` (default), `weekly`, `monthly`, `session`.
- **`blocks`:** 5-hour billing windows.
- **`statusline`:** beta; a Claude Code status-line hook.
- **Per source:** `ccusage <source> daily|weekly|monthly|session`. Sources include `claude`, `codex`, `opencode`, `grok`, `amp`, `gemini`, `copilot`, and others. Plain `ccusage daily` aggregates every source it detects.

### Global flags
| Flag | Notes |
|---|---|
| `--since`, `--until` | `YYYYMMDD` or `YYYY-MM-DD`, inclusive |
| `--last N` | Periods, including the current one |
| `-j` / `--json` | |
| `-b` / `--breakdown` | Per-model rows |
| `--no-cost` | |
| `--mode auto\|calculate\|display` | Default `auto` |
| `--order asc\|desc` | Default `desc` |
| `-O` / `--offline` | |
| `-z` / `--timezone` | IANA name, `UTC` or `local` (the default) |
| `--compact` | Compact table |
| `--debug`, `--debug-samples` | |
| `--config <file>` | |
| `--sections daily,weekly,...` | Unified reports |
| `--by-agent` | JSON only |

### Command-specific flags
- **`daily`:** `-i` / `--instances` groups by project.
- **`daily`, `session`:** `-p` / `--project <name>`.
- **`weekly`:** `--start-of-week monday`.
- **`session`:** `--id <sessionId>`.
- **`blocks`:**
  - `-a` / `--active`
  - `-r` / `--recent` (last 3 days)
  - `-t` / `--token-limit <n|max>` (`max` = the highest previous block)
  - `--session-length <hours>` (default 5)
  - `--live`
  - `--refresh-interval <s>`
- **`codex`:** `--speed auto|standard|flex|fast`.
  - Fast = ×2 for GPT-5.6 and GPT-6.x; flex = ×0.5; ultrafast = ×6 for gpt-6.1-sol and gpt-6-astra.
  - The tier comes from the recorded `service_tier`, falling back to `config.toml`.
- **`statusline`:** `--cost-source auto|ccusage|cc|both`, `--visual-burn-rate off|emoji|text|emoji-text`, `--context-low-threshold 50`, `--context-medium-threshold 80`, `--no-offline`, `--cache`, `--refresh-interval`.
  - Example output: `🤖 Model (effort) | 💰 $0.23 session / $1.23 today / $0.45 block (2h 45m left) | 🔥 $0.12/hr | 🧠 25,000 (12%)`.
  - Burn-rate colours: green below 2,000 tokens/min, yellow 2,000–5,000, red above 5,000.

**Config precedence:** CLI > `--config` > `.ccusage/ccusage.json` > `~/.config/claude/ccusage.json` > `~/.claude/ccusage.json`. Config files support `pricingOverrides` per raw model name.

### Cost modes
- **`auto`:** use the stored cost when present, otherwise calculate. JSON reports the stored part as `storedCost`.
- **`calculate`:** always calculate from tokens.
- **`display`:** stored cost only; entries without one show $0.

**Formula (ccusage)**
```
input×in + output×out + cacheCreate5m×cacheCreate + cacheCreate1h×in×2 + cacheRead×cacheRead
```
- If there is no 5m/1h split, use the standard cache-creation rate.
- Codex: non-cached input at the input rate, cached at the cache-read rate (or the input rate if missing). Reasoning is not billed separately.

### Tables
- **Daily:** `Date | Models | Input | Output | Cache Create | Cache Read | Total Tokens | Cost (USD)`, then a yellow Total row.
  - `--breakdown` adds indented per-model rows (`└─ model`).
  - Terminals narrower than 100 columns (or `--compact`) switch to a compact layout.
- **Session:** adds `Last Activity`. In OpenCode session views, subagents are indented under the parent with `↳`.
- **Blocks:** `Block Start Time | Models | Input | Output | Cache Create | Cache Read | Total Tokens | Cost (USD)`, with gap rows such as "⌛ 11h gap".
  - Progress-bar colours: green below 70%, yellow 70–90%, red at 90% or above.

### JSON output
- **Daily:** `{daily:[{date, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens, totalCost, modelsUsed[], modelBreakdowns:[{modelName, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, cost}]}], totals:{...}}`
- **Monthly:** `monthly[].period` (`YYYY-MM`).
- **Session:** `session[]{agent, period, ..., metadata.lastActivity}`.
- **Blocks (legacy shape):** `{type:"blocks", data:[{blockStart, blockEnd, isActive, timeRemaining, models, ...tokens, costUSD, burnRate, projectedTotal, projectedCost}], summary}`.

### Blocks algorithm
The docs give behaviour only. The rules below are my recollection of ccusage's `_session-blocks.ts`, not taken from the docs. Verify them before relying on them.
1. Sort entries by time.
2. A block's start is the first entry's timestamp, floored to the UTC hour. Its end is start + 5h.
3. A new block begins when an entry is more than 5h after the block start, or more than 5h after the previous entry.
4. When the gap between entries is more than 5h, insert a gap block.
5. `actualEndTime` = the last entry in the block.
6. `isActive` = now − last entry < 5h and now < block end.
7. Burn rate = tokens / minutes between the first and last entry. ccusage uses input + output only for the colour indicator.
8. Cost per hour = cost / minutes × 60.
9. Projection = current + rate × minutes remaining.

Note: the docs' own example shows a block starting at 15:30, which contradicts the floor-to-hour rule. Decide which you want.

### Pricing
- **Source:** `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`. The docs also mention the models.dev catalogue.
- **Offline:** a pinned snapshot embedded at build time, refreshed by a scheduled PR.
- **Matching:** exact key first, then provider-prefixed variants (`anthropic/`, `openai/`, `xai/`, `x-ai/`), then strip a `-build` suffix or a date suffix.
- **Missing models:** cost $0 plus a warning.
- **Tiered pricing:** from memory, ccusage bills only the tokens above 200k at the tiered rate. Providers actually bill the whole request at the higher rate once it exceeds the threshold. Choose per-request whole-request semantics.
- **Grok:** ccusage applies the long-context rate for grok-4.5 and grok-4.6 per turn.

---

## 6. LiteLLM pricing fields and current prices

Prices below are USD per 1M tokens. LiteLLM stores them per token, so multiply by 1e6.

### Fields to read
- `input_cost_per_token`, `output_cost_per_token`
- `cache_read_input_token_cost`, `cache_creation_input_token_cost`
- `cache_creation_input_token_cost_above_1hr`: Anthropic's 1-hour cache-write price. Despite the name, it is not a token tier.
- `cache_creation_input_token_cost_above_12hr`: OpenAI's 12-hour cache-write price.
- Tier fields `{input|output|cache_read|cache_creation}_..._above_{128k|200k|256k|272k|512k}_tokens`. Parse the number from the name.
- Service-tier suffixes: `_priority` (Codex Fast), `_flex`, `_ultrafast`, `_batches`.
- Others: `output_cost_per_reasoning_token` (80 models), `tiered_pricing` (56), `max_input_tokens`, `litellm_provider`, `mode`.

### Anthropic (keys have no prefix)
| Key | In | Out | Cache read | Cache write (5m) | Cache write (1h) |
|---|---|---|---|---|---|
| `claude-opus-5-5` | 4 | 20 | 0.2 | 5 | 8 |
| `claude-opus-5` | 5 | 25 | 0.5 | 6.25 | 10 |
| `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5` (and dated variants) | 5 | 25 | 0.5 | 6.25 | 10 |
| `claude-sonnet-5` | 2 | 10 | 0.2 | 2.5 | 4 |
| `claude-sonnet-5-5` | 2 | 10 | 0.1 | 2.5 | 4 |
| `claude-sonnet-4-6`, `claude-sonnet-4-5` (`-20250929`) | 3 | 15 | 0.3 | 3.75 | 6 |
| `claude-haiku-5-5` | 0.1 | 0.5 | 0.01 | 0.125 | 0.2 |
| `claude-haiku-4-5` (`-20251001`) | 1 | 5 | 0.1 | 1.25 | 2 |
| `claude-fable-5` | 10 | 50 | 1 | 12.5 | 20 |
| `claude-fable-5-1` | 10 | 50 | 0.25 | 12.5 | 20 |
| `claude-fable-5-2` | 8 | 40 | 0.2 | 10 | 16 |

Tier notes:
- `claude-haiku-5-5` has `_above_100k_tokens` rates: in 0.5, out 2.5, cache read 0.05, cache write 0.625.
- Only the Bedrock entry `claude-sonnet-4-5-20250929-v1:0` has `_above_200k`: in 6, out 22.5, cache read 0.6, cache write 7.5.

### OpenAI (keys have no prefix; `openai/` variants also exist)
| Key | In | Out | Cache read | Cache write | Above 272k (in / out / cache read) | Priority (in / out / cache read) |
|---|---|---|---|---|---|---|
| `gpt-6.1-sol` | 2 | 10 | 0.1 | 2.5 | 4 / 15 / 0.2 | 4 / 20 / 0.2 (ultrafast 12 / 60 / 0.6) |
| `gpt-6.1-terra` | 1 | 5 | 0.05 | 1.25 | 2 / 7.5 / 0.1 | 2 / 10 / 0.1 |
| `gpt-6-sol` | 2 | 10 | 0.2 | 2.5 | | |
| `gpt-6-luna` | 0.1 | 0.5 | 0.01 | 0.125 | 0.2 / 0.75 / 0.02 | 0.2 / 1 / 0.02 |
| `gpt-6-astra` | 10 | 50 | 1 | 12.5 | 20 / 75 / 2 | 20 / 100 / 2 (ultrafast 60 / 300 / 6) |
| `gpt-5.6`, `gpt-5.6-sol` | 4 | 20 | 0.4 | 5 | | |
| `gpt-5.6-terra` | 2 | 12 | 0.2 | 2.5 | | |
| `gpt-5.6-luna` | 0.2 | 1.2 | 0.02 | 0.25 | | |
| `gpt-5.5` | 5 | 30 | 0.5 | – | 10 / 45 / 1 | 12.5 / – / 1.25 |
| `gpt-5.4` | 2.5 | 15 | 0.25 | – | 5 / 22.5 / 0.5 | |
| `gpt-5.4-mini` | 0.75 | 4.5 | 0.075 | – | | |
| `gpt-5.4-nano` | 0.2 | 1.25 | 0.02 | – | | |
| `gpt-5.3-codex`, `gpt-5.2`, `gpt-5.2-codex` | 1.75 | 14 | 0.175 | – | | |
| `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5`, `gpt-5-codex` | 1.25 | 10 | 0.125 | – | | |
| `gpt-5.1-codex-mini`, `gpt-5-mini` | 0.25 | 2 | 0.025 | – | | |
| `gpt-5-nano` | 0.05 | 0.4 | 0.005 | – | | |

Not in LiteLLM: `codex-auto-review` and `gpt-reserve`. Use ccusage's alias timeline (section 2).

### xAI (keys require the `xai/` prefix)
| Key | In | Out | Cache read | Above 200k (in / out / cache read) |
|---|---|---|---|---|
| `xai/grok-4.6`, `xai/grok-4.7` | 2 | 6 | 0.5 | 4 / 12 / 1 |
| `xai/grok-4.5` (`-latest`) | 2 | 6 | 0.3 | 4 / 12 / 0.6 |
| `xai/grok-4.3`, `xai/grok-4.20` and its `-0309` / `-reasoning` / `-non-reasoning` / `-multi-agent` variants | 1.25 | 2.5 | 0.2 | 2.5 / 5 / 0.4 |
| `xai/grok-code-fast`, `xai/grok-code-fast-1` (`-0825`) | 1 | 2 | 0.2 | 2 / 4 / 0.4 |

There is no cache-write price for xAI.

### OpenCode custom models
The `modal/<workspace>--ep-*` endpoints have no LiteLLM entry. Nearest public keys: `dashscope/glm-5.2` (1.4 / 4.4 / 0.28) and `azure_ai/deepseek-v4-flash` (0.19 / 0.51 / 0.028). Fall back to the stored cost, or show $0 with a warning.

---

## 7. Other pitfalls
- **Timestamps:** Claude and Codex use ISO UTC. Grok uses Unix seconds (and ms in `_meta`). OpenCode uses epoch ms. Bucket days in `--timezone`, defaulting to local.
- **Live files:** Claude, Codex and OpenCode files can be mid-write. Tolerate a truncated last JSONL line and open SQLite read-only without taking a write lock.
- **Windows paths:** expect `\\?\` prefixes, backslashes and URL-encoded folder names, and normalise them before grouping projects.
- **Claude retention:** transcripts are deleted after 30 days. Mention `cleanupPeriodDays` and use `stats-cache.json` as an aggregate-only fallback; it has no per-day cost split, but `dailyModelTokens` gives per-day totals.
- **Codex `threads.tokens_used`:** only a total, and it double counts forks. Use it only as a last-resort fallback when a rollout file is missing (none are missing here).
- **Codex `rate_limits`:** `token_count` events include them (5h primary and 7d secondary `used_percent`, `resets_at`). That is useful for a blocks or statusline view.
- **Rate-limit windows across tools:** Claude uses 5h blocks. Codex gives 300- and 10,080-minute windows directly.
