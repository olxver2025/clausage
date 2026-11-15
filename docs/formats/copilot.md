# GitHub Copilot CLI usage extraction spec

Checked in November 2026 against:
- `github/copilot-sdk` `nodejs/src/generated/session-events.ts` (event schema; which events are `ephemeral`)
- ccusage `rust/adapters/copilot` (session-state shutdown handling, token semantics)
- tokscale `crates/tokscale-core/src/sessions/copilot_session_store.rs` and Microsoft's `ghc-cli-dashboard` `extract_usage.py` (`session-store.db` tables)
- github/copilot-cli issue #4351 (the `assistant_usage_events` ledger matches billing)

The parser was tested on synthetic fixtures. On this machine `~/.copilot` holds only `ide/` and `logs/` (no `session-state/`, no `session-store.db`), so no local session was inspected.

## 1. Locations

- **Copilot dir:** `$COPILOT_HOME`, else `~/.copilot`. `--path copilot=…` takes the same dir.
- **`session-store.db`** (SQLite, opened read-only):
  - `assistant_usage_events(id, session_id, turn_index, model, copilot_usage_model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, duration_ms, created_at, …)`, one row per model call.
  - `sessions(id, cwd, repository, branch, summary, created_at, updated_at, …)`.
  - GitHub does not document this schema as a stable API, so columns are probed (`PRAGMA table_info`) and missing optional ones read as NULL; without `session_id`, `input_tokens` and `output_tokens` the store is ignored.
- **`session-state/<sessionId>/events.jsonl`**: the session event log (`{type, id, parentId, timestamp, data, agentId?, ephemeral?, checkpoint?}` per line).

## 2. Usage in the event log

`assistant.usage` (per call) and `session.title_changed` are `ephemeral: true` in the SDK schema, so they are never written to disk. The persisted usage is `session.shutdown`:

```ts
data: { sessionStartTime, shutdownType, totalApiDurationMs, totalNanoAiu?, currentModel?,
        modelMetrics: { [model]: { usage: { inputTokens, outputTokens, cacheReadTokens,
                                            cacheWriteTokens, reasoningTokens? },
                                   requests: { count?, cost? }, totalNanoAiu? } },
        agentMetrics?: { [agentId]: { modelMetrics, … } }, codeChanges, … }
```

`modelMetrics` is cumulative: a resumed session restores the previous totals, so every resume adds another, larger snapshot.

### Token semantics

- `inputTokens` / `input_tokens` **include** cache reads and cache writes (ccusage, tokscale and obol agree).
- `reasoningTokens` is treated as a **subset** of `outputTokens` (ccusage, tokscale).
- `total_nano_aiu`: 1 AI credit = $0.01 and 1 nano-AIU = 1e-9 AI credits, so USD = `total_nano_aiu / 1e11`.
- `requests.cost` is a premium-request multiplier, not USD.

## 3. Mapping

- **Per-call rows (preferred):** one event per `assistant_usage_events` row with any tokens or credits.
  - `inputTokens` = `input_tokens − cache_read_tokens − cache_write_tokens` (clamped at 0); `cacheReadTokens`, `cacheWriteTokens` as stored; `outputTokens` = `output_tokens`; `reasoningTokens` = `reasoning_tokens` (capped at output).
  - `model` = `copilot_usage_model`, else `model`, else `auto`. `durationMs` = `duration_ms`.
  - `recordedCostUSD` = `total_nano_aiu / 1e11` when > 0 (used in `auto` mode; `calculate` prices the tokens).
  - timestamp = `created_at` (SQLite `YYYY-MM-DD HH:MM:SS`, read as UTC), else the session's `created_at`. id `copilot:<sessionId>:db:<rowid>`.
- **Shutdown intervals (fallback):** only for sessions with no rows in `session-store.db`. For each `session.shutdown` and model, the event is the difference from the previous shutdown of that model (the first is taken as-is; if any counter drops, an older CLI restarted the counters and the snapshot is taken as-is). Timestamp = the shutdown time, so a long session's usage lands on the day it ended or was resumed. id `copilot:<sessionId>:shutdown:<eventId>:<model>`.
- **Provider:** inferred from the model name.
- **Sessions:** merged from both sources by session id. `project` = `session.start` / `session.resume` `data.context.cwd`, else `sessions.cwd`; `title` = `sessions.summary`; `version` = `copilotVersion`; user / assistant counts from `user.message` / `assistant.message` without `agentId` (subagent turns are not main-agent turns); `toolCalls` = `tool.execution_start` events with `toolCallsByName` from `data.toolName`; a `session.start` with `detachedFromSpawningParentSessionId` rolls up to that parent. Records with `checkpoint: true` (replay copies) are ignored.
- **`since` optimisation:** event logs whose mtime is before `since` are skipped.

## 4. Never read

- From SQLite: only the columns above are selected; turn, message, checkpoint and search tables are never queried.
- From the event log: message `content`, reasoning, tool `arguments` and results, attachments, `codeChanges` file lists. Each line is reduced at once to type, ids, timestamps, cwd, model names, tool names and numbers.
- `config.json`, `logs/`, `otel/`, `ide/`, `workspace.yaml`, `data.db` (Copilot desktop app) and every credential or token file.

## 5. Open questions

- The `session-store.db` schema is reverse-engineered by third parties; Microsoft's dashboard describes cache tokens as additive to `input_tokens`, while tokscale (and ccusage / obol for the shutdown totals) treat them as included. clausage subtracts them, clamped at 0.
- `reasoningTokens` being part of `outputTokens` is the majority reading, not documented.
- Shutdown intervals attribute no usage to subagents separately (`agentMetrics` is not split out), and calls of a process that ended without a shutdown are missing from the fallback (as ccusage notes). OpenTelemetry exports (`otel/*.jsonl`, opt-in) are not read.
