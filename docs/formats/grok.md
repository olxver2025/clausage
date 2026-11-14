# Grok Build (xAI `grok` CLI v1.0.13): spec for extracting usage data

## TL;DR
- **The source to use:** `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/updates.jsonl`, the records where `params.update.sessionUpdate == "turn_completed"`. Each of these carries `usage` for **one user prompt (turn)**. The values are per turn, not cumulative. They include input (the full prompt, cache included), cached-read, cache-creation, output, reasoning, modelCalls, apiDurationMs, **costUsdTicks** (1 USD = 1e10 ticks) and a per-model breakdown in `modelUsage`.
- **Validation:** I checked these totals against the per-inference `shell.turn.inference_done` lines in `logs/unified.jsonl`. They match exactly for every session with usage. I also recomputed cost from tokens and it matches `costUsdTicks` exactly.
- **Metadata:** `summary.json` gives session id, cwd, model, created/updated times and message counts. `events.jsonl` gives turn and tool timing. `signals.json` gives counters, but not every session has it.
- **`~/.grok-grokified`:** a second GROK_HOME (a profile pointed at a custom endpoint). It has **no sessions** (only an empty-ish `session_search.sqlite`), and its `logs/unified.jsonl` has no usage lines. Scan it anyway because the layout is identical.

## 1. Locations
- **Base directory:** `GROK_HOME` env var, default `~/.grok`. On Windows that is `%USERPROFILE%\.grok`. Linux and macOS use the same `~/.grok`. There is no XDG location. (Docs: `17-sessions.md`, `05-configuration.md`, `26-config-reference.md`.)
- **Extra homes:** `summary.json.grok_home` records the home a session was written under. Also support a `--grok-home` list or glob (for example `~/.grok-*`) so profiles like `~/.grok-grokified` are picked up.
- **Sessions:** `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/`
  - `<encoded-cwd>` is the URL-encoded cwd, e.g. `D%3A%5CCoding%5Cmyproject`, so `decodeURIComponent` gives `D:\Coding\myproject`.
  - If the encoded name would be longer than 255 bytes, Grok uses a slug plus hash instead and writes the real path to `<group>/.cwd`. Read `.cwd` first, then fall back to decoding the name. Prefer `summary.json.info.cwd` over both.
  - `<session-id>` is a UUIDv7, or a client-supplied UUID (`-s`).
  - Each group also holds `prompt_history.jsonl` (keys: `timestamp, session_id, prompt, is_bash`). It contains prompt text, so **do not read or display it**.
- **Files in a session directory:**

| File | Purpose |
|---|---|
| `summary.json` | Index metadata |
| `updates.jsonl` | ACP update stream. Authoritative; contains the usage. |
| `events.jsonl` | Telemetry-like timing events |
| `chat_history.jsonl` | Raw model messages |
| `signals.json` | Counters (optional) |
| `rewind_points.jsonl` | Keys: `prompt_index, created_at, file_snapshots, after_snapshots` |
| `plan.json`, `plan_mode.json`, `prompt_context.json`, `resources_state.json`, `system_prompt.txt`, `title_refresh_idx`, `announcement_state.json` | Other session state |
| `compaction_requests/*.json`, `recap_requests/*.json` | Side-model requests; no usage fields |
| `terminal/*.log` | Terminal output |
| `subagents/` | Per-subagent `meta.json` (docs). Child sessions live in the normal tree. |
| `*.lock` | Lock files |

- **Other places checked:**
  - `$GROK_HOME/logs/unified.jsonl`: a single log file with per-inference token lines. Useful as a cross-check or fallback, but it may rotate.
  - `sessions/session_search.sqlite`: an FTS index (`session_docs(session_id,cwd,updated_at,title,content,...)`). No usage; skip it.
  - `worktrees.db`: worktree registry, 0 rows. No usage.
  - `active_sessions.json`: `[]`.
  - `config.toml`: contains an `api_key`. Never read it in the tool beyond `[models] default` if needed at all.
  - `auth.json`: never read.

## 2. `updates.jsonl`, the primary source
Every line is a JSON-RPC envelope:
```json
{"timestamp":1787865772,"method":"session/update" | "_x.ai/session/update",
 "params":{"sessionId":"<uuid>","update":{"sessionUpdate":"<kind>", ...},
           "_meta":{"eventId":"<sessionId>-<seq>","agentTimestampMs":1787865771750, ...}}}
```
- `timestamp` is in unix **seconds**. `params._meta.agentTimestampMs` is in ms; prefer it.

**Update kinds seen (`params.update.sessionUpdate`):**

| Kind | Contents | Use |
|---|---|---|
| `user_message_chunk` | `content.text`, plus `update._meta.modelId` and `update._meta.promptIndex` | Distinct `promptIndex` = number of user prompts |
| `agent_message_chunk` | Assistant text | — |
| `agent_thought_chunk` | Reasoning text | — |
| `tool_call` | `toolCallId`, `title`; tool name in `update._meta["x.ai/tool"].name`; also `kind`, `namespace`, `read_only` | Count distinct `toolCallId` to get tool calls |
| `tool_call_update` | ~2 per tool call | Do not count |
| `plan`, `current_mode_update`, `image_dropped` | Other state | — |
| `retry_state` | `type:"failed"`, `error_type`, `message` | Failure info |
| **`turn_completed`** | Method `_x.ai/session/update`. Fields `prompt_id`, `stop_reason` (`end_turn` / `cancelled` / `error`), optional `agent_result`, optional `elapsed_ms`, optional **`usage`** | **The usage record** |

- **Pitfall:** chunk and tool records carry `params._meta.totalTokens`. That is the **current context size**, not usage. Never sum it.

**Redacted `turn_completed` example:**
```json
{"timestamp":1787867272,"method":"_x.ai/session/update","params":{"sessionId":"<uuid>",
 "update":{"sessionUpdate":"turn_completed","prompt_id":"<uuid>","stop_reason":"error","agent_result":"<text>",
  "usage":{"inputTokens":2258794,"outputTokens":52190,"totalTokens":2310984,"cachedReadTokens":1827200,
   "cacheCreationTokens":0,"reasoningTokens":36261,"modelCalls":31,"apiDurationMs":1265813,
   "costUsdTicks":23074940000,
   "modelUsage":{"grok-4.6":{ ...same fields... }},"numTurns":31}},
 "_meta":{"eventId":"<sid>-1521","agentTimestampMs":1787867272034}}}
```

**What each field means (verified against the logs):**

| Field | Meaning |
|---|---|
| `inputTokens` | The **full** prompt, including cached reads. Uncached input = `inputTokens - cachedReadTokens - cacheCreationTokens`. Check: 10965 + 128 = 11093 = log `prompt_tokens`. |
| `cachedReadTokens` | Cache hits |
| `cacheCreationTokens` | Cache writes. Always 0 here. |
| `outputTokens` | Output only; **excludes reasoning**. Check: log `completion_tokens` 1 with `reasoning_tokens` 28. |
| `reasoningTokens` | Separate bucket, billed at the output rate (see cost below) |
| `totalTokens` | `inputTokens + outputTokens`; excludes reasoning. Don't use it; recompute. |
| `modelCalls` | Model API rounds in the turn. Includes subagent calls, per the docs. |
| `numTurns` | Main-agent rounds only |
| `apiDurationMs` | Model API time for the turn |
| `costUsdTicks` | USD × 1e10. The docs say cost is stamped for API-key traffic and is often missing on OAuth/pool paths. Treat a missing value as "unknown", never 0. |
| `modelUsage` | Map of model id to the same fields. Use it for the per-model split. Fall back to the top level plus `summary.current_model_id`. |

- **Usage is per turn and not cumulative.** For example, a session whose two usage-bearing turns made 31 and 3 calls totals 34, matching its 34 `inference_done` log lines.
- **Usage can be missing.** It appears on `end_turn` turns, on some `cancelled` turns and on some `error` turns. Turns that never reached the model have no `usage`, and may have `elapsed_ms` instead. Only sum turns that have `usage`.
- **Side calls are not in turn usage.** Compaction and recap side-model calls are excluded (docs); their request files under `compaction_requests/` and `recap_requests/` have no usage fields.
- **Timestamp for a turn:** use the `turn_completed` envelope's `agentTimestampMs`. That is the end of the turn. The start time is in `events.jsonl` `turn_started`.

**Cost formula.** It reproduced `costUsdTicks` exactly for every turn, so prices can be derived for unpriced records:

`cost = uncached_input*$2/M + cachedRead*$0.50/M + (output + reasoning)*$6/M`

This is grok-4.6 on this account. Example: 559516\*2e-6 + 2069248\*0.5e-6 + 92932\*6e-6 = $2.711248, which matches the recorded value. Prefer the recorded `costUsdTicks`; use a pricing table (LiteLLM-style, xAI models) only when ticks are absent, and mark the value as "estimated".

## 3. Deduplication and pitfalls
- **Dedupe key:** `(sessionId, prompt_id)` for `turn_completed`.
- **Forks:** `/fork`, `--fork-session` and restored sessions get `summary.parent_session_id`. They likely copy the parent's history, including old `turn_completed` lines with the same `prompt_id`. Dedupe **globally on `prompt_id`** (a UUID), not per session. Not observed locally: there are no forks in the data.
- **Subagents:** parent turn usage already includes subagents that finished before the turn ended ("usage sums tokens for the prompt, including subagents… also under their own `modelUsage` keys"). Child sessions also exist in the tree with their own `turn_completed` lines. To avoid double counting, skip sessions listed in a parent's `subagents/*/meta.json`. A fallback heuristic is `parent_session_id` set and the agent being a subagent. Not observed locally: `subagents/` is absent everywhere.
- **`/rewind`** truncates history. The changelog notes usage now matches the server count after a rewind. The `turn_completed` lines already written are what we sum.
- **Logs as fallback.** In `logs/unified.jsonl`, lines with `msg == "shell.turn.inference_done"` have top-level `sid` and `ts` (ISO) and `ctx {prompt_tokens (full, incl. cached), cached_prompt_tokens, completion_tokens, reasoning_tokens, model_elapsed_ms, ttft_ms, tokens_per_sec, loop_index, attempts}`. There is **no model and no cost** on these lines. `msg == "agent response failed"` lines embed `promptUsage` in an error string. Only use the logs if `updates.jsonl` is missing. The file is shared across homes and processes and may rotate.
- **Other pitfalls:**
  - Malformed or partial final lines can occur while a session is being written (the `.lock` files show this). Wrap each `JSON.parse` in try/catch.
  - Millisecond and second timestamps are mixed. ISO timestamps carry 7–9 fractional digits (e.g. `2026-08-27T22:26:37.728287700Z`); `Date.parse` handles them.

## 4. Other metrics
**`summary.json`** (redacted):
```json
{"info":{"id":"<uuid>","cwd":"D:\\Coding\\myproject"},"session_summary":"<text>","generated_title":"<text>",
 "created_at":"2026-08-27T21:22:43.935743Z","updated_at":"…Z","last_active_at":"…Z",
 "num_messages":437,"num_chat_messages":198,"current_model_id":"grok-4.6","agent_name":"grok-build-plan",
 "next_trace_turn":5,"chat_format_version":1,"request_id":"<uuid>","grok_home":"C:\\Users\\<u>\\.grok","sandbox_profile":"off"}
```
- Optional keys (docs): `title_is_manual`, `parent_session_id`, `last_turn_summary`, `last_recap`.
- `num_messages` = number of lines in `updates.jsonl`.
- `num_chat_messages` = number of lines in `chat_history.jsonl`.
- Titles are user-derived text. Show them only locally, if at all.

**Counts and timing:**
- **Project:** `summary.info.cwd`. Use its basename as the project name.
- **Session wall time:** `created_at` → `last_active_at`, or the first and last `agentTimestampMs` in `updates.jsonl`.
- **Turn duration:** from `events.jsonl` (`{"ts":ISO,"type":...}`). `turn_started` has `session_id, turn_number, model_id, conversation_message_count, session_relationship ("primary")`. Pair it with the next `turn_ended` (`outcome`). For API time, use `usage.apiDurationMs`.
- **Other event types:** `tool_started/tool_completed{tool_name,duration_ms,outcome,tool_call_id}`, `permission_requested/resolved{decision,wait_ms}`, `loop_started`, `first_token`, `phase_changed`, `yolo_toggled`.
- **Tool calls:** distinct `tool_call.toolCallId` in `updates.jsonl` (123 for the big session), or `events.jsonl` `tool_started` (123). The tool name is `update._meta["x.ai/tool"].name`.
- **Messages:**
  - User prompts: distinct `user_message_chunk._meta.promptIndex`, or `chat_history.jsonl` lines with `type:"user"`.
  - Assistant messages: `chat_history.jsonl` lines with `type:"assistant"`, which carry `model_id` and `model_fingerprint` (34, equal to the number of modelCalls).
  - `chat_history` line types: `system`, `user`, `reasoning`, `assistant` (with `tool_calls[]`), `tool_result`.
- **`signals.json`** (present in 2 of 7 sessions): `turnCount, userMessageCount, assistantMessageCount, toolCallCount, toolsUsed[], modelsUsed[], primaryModelId, errorCount, cancellationCount, compactionCount, contextTokensUsed, contextWindowTokens, sessionDurationSeconds, avgTimeToFirstTokenMs, avgResponseTimeMs, agentLinesAdded/Removed, humanLinesAdded/Removed, gitCommitCount, prCreatedCount, …`. There are **no usage tokens** in it. It is optional enrichment only.

## 5. Recommended parser algorithm
1. Collect the homes: `[$GROK_HOME || ~/.grok, ...extra]`.
2. For each `sessions/*/*/` directory: read `summary.json` if present, then stream `updates.jsonl` line by line.
3. For each `turn_completed` that has `usage`:
   - Dedupe on `prompt_id`.
   - For each `[model, u]` in `usage.modelUsage` (fallback: `{[summary.current_model_id]: usage}`), emit one entry:
     `{tool:"grok", sessionId, projectPath: summary.info.cwd, model, timestamp: agentTimestampMs, inputTokens: u.inputTokens - u.cachedReadTokens - u.cacheCreationTokens, cacheReadTokens: u.cachedReadTokens, cacheCreationTokens: u.cacheCreationTokens, outputTokens: u.outputTokens, reasoningTokens: u.reasoningTokens, costUSD: u.costUsdTicks != null ? u.costUsdTicks/1e10 : priced(...), modelCalls, apiDurationMs}`.
4. Session-level fields: prompt count, tool-call count, first/last timestamps, `stop_reason` histogram. Optionally add turn durations from `events.jsonl`.
5. Skip subagent child sessions, and do not double count forks.

Grok's own user guide (`~/.grok/docs/user-guide/`: `17-sessions.md`, `14-headless-mode.md`, `24-monitoring-usage.md`, `26-config-reference.md`, `05-configuration.md`) documents the token and cost fields.
