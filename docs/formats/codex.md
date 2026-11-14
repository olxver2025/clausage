# Codex CLI / Codex Desktop usage extraction spec

This is based on real local data, read only. Nothing under `~/.codex` was modified, and auth files were not read.

## 0. Bottom line
- **Primary source:** the rollout JSONL files. Many are **zstd-compressed** (`*.jsonl.zst`). Node 24 can read them with `zlib.zstdDecompressSync` (confirmed available, v24.20.0).
- **Best token record:** the `token_usage_record` line type, one per model API response, keyed by `response_id`. Fall back to `event_msg` `token_count` only for older rollouts that lack `token_usage_record`.
- **`cached_input_tokens` is a subset of `input_tokens`** (true in 1037 of 1037 records). **`reasoning_output_tokens` is a subset of `output_tokens`** (1037 of 1037). **`total_tokens = input_tokens + output_tokens`** (1036 of 1037; the one exception is a post-compaction placeholder, see pitfalls).
  - Never add cached or reasoning on top of input or output.
  - For a ccusage-style table: `inputNonCached = input − cached`, `cacheRead = cached`, `output = output_tokens` (includes reasoning), `reasoning` is shown for information only.
- `cache_write_input_tokens` exists in the schema but is 0 everywhere in this data. Treat it as cache creation if it is ever non-zero. It is not verified whether it would be a subset of input; assume it is, like cached.
- **Cost is not recorded anywhere.** It must be computed from a price table.

## 1. Locations
- **Root:** `$CODEX_HOME` if set, otherwise `~/.codex`. The default is the same on every OS: Windows `%USERPROFILE%\.codex`, Linux/macOS `$HOME/.codex`. Allowing a comma-separated list of homes is a nice extra.
- **Active sessions:** `<root>/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<uuid>.jsonl`
  - Files are uncompressed while a session is live, and a long session keeps appending to its file for days.
  - Once closed they become `.jsonl.zst`.
  - The folder date is when the session **started**, not when its events happened.
- **Archived:** `<root>/archived_sessions/rollout-*.jsonl[.zst]`, a flat folder.
- **Glob:** `sessions/**/rollout-*.jsonl`, `sessions/**/rollout-*.jsonl.zst`, `archived_sessions/rollout-*.jsonl{,.zst}`. Match `/^rollout-.*\.jsonl(\.zst)?$/`.
- **Session id:** the UUID at the end of the file name (UUIDv7-like). It equals `session_meta.payload.id`.
  - Dedupe by this id across sessions and archived_sessions, and across `.jsonl` vs `.jsonl.zst` during compression. Prefer the larger or newer file.
- **`session_index.jsonl`:** lines are `{id, thread_name:"<text>", updated_at:ISO}`. Titles only; no usage.
- **SQLite files** (all readable with `new DatabaseSync(p,{readOnly:true})`, WAL files present, works):
  - **`state_5.sqlite`, table `threads`** (one row per rollout). Useful metadata: `id`, `rollout_path`, `created_at` (epoch seconds), `created_at_ms`, `updated_at`, `source` (JSON string), `thread_source` (user/subagent/guardian_review), `model_provider`, `model`, `reasoning_effort`, `cwd`, `title`, `git_sha`, `git_branch`, `git_origin_url`, `cli_version`, `originator`, `agent_nickname`, `agent_role`, `agent_path`, `archived`, `archived_at`, `project_id`, `tokens_used`.
    - **Do not use `tokens_used` for totals.** It equals the last `thread_token_usage.total_tokens`, so it double-counts cached tokens inside total_tokens and includes inherited parent usage for forked or guardian threads. A guardian thread can show several times its own usage.
    - Table `thread_spawn_edges(parent_thread_id, child_thread_id, status)` holds subagent links.
    - Tables `projects` and `project_roots(path)` hold project grouping.
  - **`thread_history_1.sqlite`**
    - `thread_turns(thread_id, turn_id, status completed|interrupted, started_at, completed_at, duration_ms, …)`. Its duration sum matches the JSONL.
    - `thread_items(item_type: agentMessage, userMessage, commandExecution, mcpToolCall, fileChange, webSearch, reasoning, subAgentActivity, collabAgentToolCall, imageView, sleep, contextCompaction)`.
    - It has no token data. It is a good optional source for tool-call breakdowns (it includes `webSearch`, which is not visible as function_call in the JSONL).
  - **`logs_2.sqlite` table `logs`:** tracing logs only. Ignore.
  - **Other files:** `goals_1.sqlite` (`thread_goals.tokens_used`, empty), `queue_1`, `memories*`, and `sqlite/codex.db` (Desktop app catalog `local_thread_catalog`: titles, cwd, model_provider). None carry token data.
  - Recommendation: the JSONL is the source of truth; SQLite is optional enrichment.

## 2. Line envelope
Every line looks like `{"timestamp":"2026-..T..:..:..sssZ","ordinal":<int, 0-based line index, monotonic>,"type":<type>,"payload":{...}, "metadata"?:{...}}`. Timestamps are ISO UTC with milliseconds.

The live file can end with a half-written line, so wrap `JSON.parse` in try/catch. Observed `type` and `payload.type` counts across 37 files (69,041 lines total):

| type / payload.type | count | notes |
|---|---|---|
| session_meta | 49 | ordinal 0 of every file. A 2nd one at ordinal 1 in forked subagent files is the **parent's** meta |
| turn_context | 222 | per turn: `payload.turn_id`, `payload.model`, `payload.effort`, `payload.cwd`, `collaboration_mode.settings.{model,reasoning_effort}`, approval/sandbox |
| world_state | 129 | `payload.state.model`, `payload.state.environments.environments.local.cwd` |
| token_usage_record | 1015 | **per-response usage** (see 3A) |
| event_msg:token_count | 1037 | cumulative and last usage plus rate_limits (see 3B) |
| event_msg:task_started | 212 | `turn_id`, `started_at` (epoch s), `model_context_window` |
| event_msg:task_complete | 175 | `turn_id`, `started_at`, `completed_at` (epoch s), `duration_ms`, `time_to_first_token_ms`, `last_agent_message:"<text>"` |
| event_msg:turn_aborted | 37 | `reason:"interrupted"`, `duration_ms` |
| event_msg:thread_settings_applied | 172 | `thread_settings.{model, model_provider_id, service_tier: default/priority, reasoning_effort, cwd}` |
| event_msg:item_completed | 2215 | `item.type`: UserMessage, AgentMessage, Reasoning, CommandExecution, McpToolCall, FileChange, Extension, SubAgentActivity, CollabAgentToolCall, ImageView, ContextCompaction |
| response_item:message | 950 | `role`: user 333 / assistant 402 / developer 215 (user includes injected context, so not a good count of real prompts) |
| response_item:function_call | 544 | `name` (js, spawn_agent, send_message, wait_agent, followup_task, sleep, list_agents, request_user_input_async), `call_id` |
| response_item:custom_tool_call | 778 | `name:"exec"` (shell), `call_id` |
| response_item:*_output | 1310 | tool results |
| response_item:reasoning | 1393 | encrypted_content |
| compacted / response_item:compaction | 11 / 2 | context compaction. `compacted.payload.latest_token_usage_record` and `resume_metadata.previous_turn_settings.model` |
| response_item:agent_message, inter_agent_communication_metadata, additional_tools | | multi-agent plumbing |

### session_meta.payload (redacted)
```json
{"id":"<uuid=file id>","session_id":"<root thread uuid>","parent_thread_id":"<uuid>|absent","timestamp":"ISO","cwd":"<path>","originator":"Codex Desktop|codex_work_desktop|codex_cli_rs…","cli_version":"0.166.0-alpha.6","source":"vscode"|{"subagent":{"other":"guardian"}}|{"subagent":{"thread_spawn":{"parent_thread_id":"..","depth":1,"agent_path":"/root/<name>","agent_nickname":"<text>","agent_role":null}}},"thread_source":"user|subagent|guardian_review","model_provider":"openai","history_mode":"paginated","subagent_history_start_ordinal":5,"git":{"commit_hash":"..","branch":"..","repository_url":".."},"base_instructions":{"text":"<text>"}}
```
- `session_id` is the **root** conversation id, so `session_id != id` for child threads. Group child threads under the root via `session_id`, or via `thread_spawn_edges`.
- `cwd`: from `session_meta.payload.cwd`. Use per-turn `turn_context.payload.cwd` if you want per-turn precision.

## 3. Token extraction

### 3A. Preferred: token_usage_record
```json
{"type":"token_usage_record","payload":{"thread_id":"<uuid>","session_id":"<root uuid>","turn_id":"<id>","root_turn_id":"<id>","response_id":"<id>",
 "usage":{"input_tokens":N,"cached_input_tokens":N,"cache_write_input_tokens":0,"output_tokens":N,"reasoning_output_tokens":N,"total_tokens":N},
 "turn_token_usage":{...cumulative within turn...},"thread_token_usage":{...cumulative within thread, INCLUDING inherited fork baseline...}}}
```
- `usage` is **per response, not cumulative**. Sum `usage` only.
- `turn_token_usage` is the running sum within the turn (verified 1015 of 1015).
- `thread_token_usage` is the running sum plus any inherited baseline. 30 records showed exactly the parent's copied total as an offset.
- **Dedupe key:** `response_id`, global. No duplicates were seen, but it is cheap insurance.
- Only count records whose `payload.thread_id === session_meta.id` of the file. All observed records satisfy this, but it guards against copied history.
- **Model:** build a map `turn_id → turn_context.payload.model` over the whole file first. A compaction record appears *before* its turn's turn_context, so a forward-only "current model" goes wrong there. Fall back in order to: last seen turn_context.model, then `thread_settings_applied.thread_settings.model`, then `world_state.state.model`, then `threads.model` from SQLite, then `"unknown"`. All 1015 records mapped through turn_id.
- **Timestamp:** the line's `timestamp`. Use it for daily and monthly bucketing, not the folder date.
- **Captures compaction calls**, which token_count misses. Example: one compaction response of 348,846 tokens had no token_count event.

### 3B. Fallback: event_msg token_count (older rollouts)
```json
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{6 fields},"last_token_usage":{6 fields},"model_context_window":258400}|null,
 "rate_limits":{"limit_id":"codex","primary":{"used_percent":2,"window_minutes":300,"resets_at":<epoch s>},"secondary":{"used_percent":0,"window_minutes":10080,"resets_at":<epoch s>},"credits":{"has_credits":false,"unlimited":false,"balance":"<redacted>"},"plan_type":"<plan>","rate_limit_reached_type":null,"spend_control_reached":null}}}
```
- `total_token_usage` is **cumulative per thread**. `last_token_usage` is the latest response.
- `info` can be `null` (none here; older versions emit it). Skip those.
- **Algorithm:** keep `prevTotal`. For each token_count:
  - If `total.total_tokens === prevTotal.total_tokens`, it is a **duplicate re-emission**. Skip it. There were 14 of these; `last` was usually repeated too, and once was zeros with total_tokens≠0.
  - Otherwise `delta = total − prevTotal`, field by field. Use the delta, **not `last_token_usage`**: once a token_count was dropped (delta = 126,796 vs last = 63,555), and summing `last` undercounts.
  - If no `total_token_usage` exists (very old format), use `last`.
- **Forked or guardian or subagent files** start with history copied from the parent, at ordinals `< session_meta.subagent_history_start_ordinal`. That copy can include a token_count holding the **parent's cumulative total**; there were 14 such events, with values up to 1.5M.
  - Do not count it. Use it as the `prevTotal` baseline, because the child's later totals continue from it.
  - **Anomaly:** in cli 0.155 one file had `subagent_history_start_ordinal` (48) greater than its max ordinal (47) while all its events were its own. Rule used: ignore the start ordinal if it is greater than the max ordinal.
  - Extra safety: a token_count is inherited only if no own `token_usage_record` precedes it.
- **Model for B:** the latest `turn_context.model` seen before the event.

### 3C. Duration, messages, tools
Exclude copied prefix lines (ordinal < valid start ordinal) from all of these counts.
- **Turn duration:** sum `task_complete.duration_ms` plus `turn_aborted.duration_ms`.
  - `started_at` and `completed_at` are epoch **seconds**.
  - `time_to_first_token_ms` is available.
- **Session wall time:** last line timestamp minus first line timestamp. Live sessions can span weeks.
- **Messages:** `item_completed` with `item.type` UserMessage / AgentMessage. This is cleaner than response_item:message, which includes developer and injected messages.
- **Tool calls:** count `response_item` with `payload.type ∈ {function_call, custom_tool_call}`, keyed by `name`. Optionally add `item_completed` item types (CommandExecution, McpToolCall, FileChange, webSearch from thread_items).
- **Rate limits:** latest token_count `rate_limits`. Primary is the 5 h window, secondary the weekly window; `used_percent` is 0–100 and `resets_at` is epoch seconds. `plan_type` is here too. Good for a "limits" panel.

## 4. Cost
Nothing is recorded. Compute as:

`cost = (input−cached)·p_in + cached·p_cached_in + output·p_out`

Reasoning is already inside output, and cache_write is 0. `service_tier:"priority"` is in `thread_settings_applied` (32 of 172) and may carry a price multiplier.

Model names in this data (`gpt-6.1-terra`, `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-astra`, `codex-auto-review`) may be missing from LiteLLM pricing. The CLI needs a fallback or alias table and should flag unpriced models rather than show $0. Show `codex-auto-review` (guardian approval reviewer) separately or tag it.

## 5. Pitfalls checklist
1. Decompress `.zst`, and tolerate a truncated last line in the live `.jsonl`.
2. Dedupe sessions by id across sessions/archived and .jsonl/.zst; dedupe responses by `response_id`.
3. Skip copied parent history in forked files (second session_meta at ordinal 1, ordinal < `subagent_history_start_ordinal`, and the start>maxOrdinal anomaly). Only count token_usage_record where thread_id equals the file's id.
4. token_count: skip repeats where the total is unchanged; use cumulative deltas rather than `last`; `info` may be null.
5. Cached is a subset of input and reasoning a subset of output; `total = input + output`. Never sum all fields.
6. Model is per turn and can change mid-session (a luna/sol switch was seen). Map by turn_id.
7. Bucket by event timestamp. Sessions can span weeks, and folder dates are the session start.
8. Subagent and guardian threads have their own rollout files. Attribute them to the root via `session_meta.session_id`, with an option to include or exclude them.
