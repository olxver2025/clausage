# Hermes Agent (NousResearch/hermes-agent) usage extraction spec

Checked against upstream `main` in November 2026 (schema version 33): `hermes_state_common.py` (`SCHEMA_SQL`), `hermes_state_usage.py` (token writer), `agent/insights.py` (Hermes' own per-model reconciliation), `agent/usage_pricing.py` (token normalisation) and `hermes_constants.py` (home dir). No local install was available, so the parser was tested against synthetic stores built from that DDL.

## 1. Locations

- **Home:** `$HERMES_HOME`, otherwise `~/.hermes` (Linux/macOS) or `%LOCALAPPDATA%\hermes` (Windows). `HERMES_DATA_DIR_SUFFIX` is appended to the default name when set.
- **Database:** `<home>/state.db` (SQLite, WAL mode).
- **Named profiles:** `<home>/profiles/<name>/state.db`. Names starting with `.` (such as the `.deleted` tombstone dir) are skipped.
- clausage accepts a home dir or a `.db` file through `--path hermes=…`.

Opening the database: `node:sqlite` read-only. If the database is locked, the db and its `-wal` are copied to a temp dir, the copy is opened, and the copy is deleted afterwards.

## 2. Relevant tables

All timestamps are **epoch seconds (REAL)**.

| table | columns used |
|---|---|
| `sessions` | `id`, `parent_session_id`, `model`, `billing_provider`, `title`, `cwd`, `git_repo_root`, `started_at`, `ended_at`, `last_activity_at`, `tool_call_count`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `estimated_cost_usd`, `actual_cost_usd` |
| `session_model_usage` | `session_id`, `model`, `billing_provider`, `billing_mode`, `task`, the five token columns, `estimated_cost_usd`, `actual_cost_usd`, `first_seen`, `last_seen`. The primary key is (session, model, provider, base_url, mode, task). |
| `messages` | `session_id`, `role`, `timestamp` only |

Every column is checked with `PRAGMA table_info` first, so older stores that lack a column, or lack `session_model_usage` entirely, still load.

## 3. Token semantics (verified in source)

- `agent/usage_pricing.py` `CanonicalUsage`: `prompt_tokens = input_tokens + cache_read_tokens + cache_write_tokens`. So **`input_tokens` is uncached input**. Chat Completions and Responses totals have the cache buckets subtracted out; Anthropic's are reported uncached as they are.
- `output_tokens` is the provider's completion/output count, which already **includes reasoning**. `reasoning_tokens` comes from `*_tokens_details.reasoning_tokens` / `thinking_tokens` and is a subset. Insights' `total_tokens` is input + output + cache read + cache write, with no reasoning term.
- **There is no per-API-call usage.**
  - `update_token_counts()` adds each call's delta to the `sessions` counters and upserts it into `session_model_usage`, keyed by the model and route active at that call.
  - The gateway path writes **absolute** cumulative counters to `sessions` and records no per-model row.
  - Auxiliary calls (`task` = `vision`, `compression`, `title_generation`, `background_review`, …) go to `session_model_usage` only, not to the `sessions` counters.
- **Cost:** `actual_cost_usd` is the billed amount when the provider reports one. `estimated_cost_usd` is Hermes' own estimate.

## 4. Mapping

- **One event per `session_model_usage` row.** Rows with no tokens and no cost are skipped.
  - id: `hermes:<sessionId>:<model>:<provider>:<billing_mode>:<task>`, with `#n` appended for rows that differ only in `billing_base_url`. Base URLs never go into ids.
  - timestamp: `first_seen`, falling back to `sessions.started_at`.
- **Residual event** `hermes:<sessionId>:session`: per field, `max(0, sessions.x − Σ rows.x)`. This is the same reconciliation `agent/insights.py` `_compute_model_breakdown` uses.
  - It covers legacy sessions from before the table existed, and gateway absolute updates.
  - It is attributed to `sessions.model` / `billing_provider` at `started_at`.
- **Fields:**
  - `inputTokens` = `input_tokens`
  - `outputTokens` = `output_tokens`
  - `reasoningTokens` = `min(reasoning_tokens, output_tokens)`
  - cache read and cache write map directly
  - `cacheWrite1hTokens` = 0
- **`recordedCostUSD`** = `actual_cost_usd` when > 0, else `estimated_cost_usd` when > 0, else absent (priced by clausage).
- **Sessions:**
  - `title` = `sessions.title`.
  - `project` = `cwd`, else `git_repo_root`, else the root session's, else `''`.
  - `toolCalls` = `tool_call_count` (or the number of named calls, if larger).
  - `toolCallsByName`: each assistant message's `tool_calls[].function.name`, pulled out in SQLite with `json_each` / `json_extract` so the arguments never leave the database.
  - user and assistant counts come from `messages.role`.
  - `activeMs` comes from message timestamps (5 min idle threshold).
- **Subagents:** `parent_session_id` chains (delegated children, compression continuations) roll up to the root session: `rootSessionId` is set to the root and `isSubagent` is true.
- **Filtering:** `since`/`until` filter events by timestamp, and sessions by overlap.

## 5. Never read

- `messages.content`, `tool_calls` (other than each call's function name), `reasoning*`, `codex_*`, `api_content`, `display_metadata`
- `sessions.system_prompt`, `model_config`, `origin_json`, `display_name`, `user_id`, `chat_id`, `session_key`, `billing_base_url`
- the `system_prompts` table and the FTS tables
- every file in `HERMES_HOME` other than `state.db`: config, `.env`, auth and credential files, logs, skills

## 6. Pitfalls

- A session's counters exclude auxiliary usage, while `session_model_usage` includes it. Summing the `sessions` counters alone undercounts.
- A `task` route such as `voice_chat` counts in both the session counters and a model row. The per-field `max(0, …)` residual prevents double counting.
- Usage rows span a whole session, so a session that crosses midnight is bucketed on the day of `first_seen`.
