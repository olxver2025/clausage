# Claude Code: how to extract usage data

Based on a read-only survey of real local data.

## 1. Where the data lives

| Source | Path | Notes |
|---|---|---|
| Transcripts (primary) | `<root>/projects/<encoded-cwd>/<sessionId>.jsonl` | One file per session |
| Subagent transcripts | `<root>/projects/<encoded-cwd>/<sessionId>/subagents/**/agent-<agentId>.jsonl` (seen as `subagents/workflows/wf_<id>/agent-*.jsonl`; Task subagents use the same tree) | Workflow folders may also hold a `journal.jsonl` |
| Workflow journal | `.../subagents/workflows/wf_*/journal.jsonl` | Holds only `launched` and `started` rows, no usage. Skip it, or just tolerate it. |
| Aggregate cache | `<root>/stats-cache.json` | Optional. May cover days whose transcripts were cleaned up. |
| Prompt history | `<root>/history.jsonl` | One line per submitted prompt |
| Live process files | `<root>/sessions/<pid>.json` | Holds pid, sessionId, cwd, startedAt (ms), version, kind, entrypoint, name, status, updatedAt. Useful for "active now". |

Root resolution (same as ccusage):
- If `CLAUDE_CONFIG_DIR` is set, use it. It may be comma-separated, and each entry is a root.
- Otherwise use both `~/.config/claude` (newer XDG default) and `~/.claude` (legacy).
- Keep only roots that contain a `projects/` dir.
- These paths are the same on Linux and macOS. On Windows, `~` is `%USERPROFILE%`.

Glob: `projects/**/*.jsonl`. Exclude `journal.jsonl`; it is harmless anyway because it has no `message.usage`.

Old transcripts are removed by Claude Code's retention cleanup. `~/.claude/.last-cleanup` holds an ISO timestamp, and `cleanupPeriodDays` defaults to 30 and is not set in settings.json. Older usage may then survive only in `stats-cache.json`.

**Claude desktop app:** it does not keep separate transcripts. Desktop "Claude Code" sessions run the same CLI, and their transcripts go to `~/.claude/projects` with `entrypoint: "claude-desktop"`.
- The desktop metadata is at `%LOCALAPPDATA%\Claude-Data\claude_<pkgid>\claude-code-sessions\<accountUuid>\<orgUuid>\local_<uuid>.json`. It holds `cliSessionId`, `cwd`, `createdAt`, `lastActivityAt` (epoch ms), `model`, `effort`, `title`, `isArchived`, plus `deleted_<uuid>` tombstones.
- It contains no token data. It could optionally supply session titles, joined on `cliSessionId` = `sessionId`.
- `%LOCALAPPDATA%\claude-cli-nodejs\Cache\...\mcp-logs-*\*.jsonl` are MCP logs only. Ignore them.

## 2. Transcript record types (`type` field)

Types seen include `assistant`, `user`, `attachment`, `api-request`, `api-request-blob`, `api-request-shape`, `cost-state`, `last-prompt`, `custom-title`, `tools-used`, `agent-name`, `atis-latch`, `bridge-session`, `file-history-snapshot`, `mode`, `permission-mode`, `system` (subtype `local_command`), `queue-operation`, `session-owner`, `started` and `launched`. Older versions also wrote `summary`.

The parser should ignore unknown types and skip lines that fail `JSON.parse`. A live session file may end in a partial line.

### 2.1 `assistant` (the only token source)

Redacted example:
```json
{"parentUuid":"…","isSidechain":true,"agentId":"<agentId>",
 "message":{"model":"claude-opus-5-5","id":"msg_011Ch…","type":"message","role":"assistant",
  "content":[{"type":"thinking","thinking":"<text>"}],
  "stop_reason":"tool_use",
  "usage":{"input_tokens":2,"cache_creation_input_tokens":14313,"cache_read_input_tokens":41639,"output_tokens":169,
   "output_tokens_details":{"thinking_tokens":19},
   "server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},
   "service_tier":"standard",
   "cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":14313},
   "inference_geo":"global","iterations":[{"input_tokens":2,"output_tokens":169,"cache_read_input_tokens":41639,"cache_creation_input_tokens":14313,"cache_creation":{…},"type":"message"}],
   "speed":"standard","fallback_credit":null}},
 "thinkingDurationMs":640,"apiBlockIndex":0,"requestId":"req_011Ch…","requestedModel":"claude-opus-5-5",
 "promptCacheRequested":"5m","attributionAgent":"workflow-subagent","type":"assistant","uuid":"…",
 "timestamp":"<ISO-8601>","effort":"medium","userType":"external","entrypoint":"claude-desktop",
 "cwd":"<path>","sessionId":"<session>-…","version":"2.1.321","gitBranch":"HEAD"}
```

Token field mapping. All values are per API request: not cumulative, and not split across lines.
- input = `message.usage.input_tokens`. This excludes cached tokens.
- output = `message.usage.output_tokens`
- cacheRead = `message.usage.cache_read_input_tokens`
- cacheCreate (cache write) = `message.usage.cache_creation_input_tokens`
  - Split it via `message.usage.cache_creation.ephemeral_5m_input_tokens` and `.ephemeral_1h_input_tokens`.
  - Verified: 5m + 1h == cache_creation_input_tokens on all rows.
  - Price 1h writes at 2x base input and 5m writes at 1.25x.
  - Fall back to treating it as all-5m when `cache_creation` is absent (older versions).
- reasoning = `message.usage.output_tokens_details.thinking_tokens`. Treat it as a subset of output_tokens and never add it to output (19 ≤ 169 in the sample). Older versions lack this field, so default it to 0. Show it informationally only.
- web search / fetch counts = `message.usage.server_tool_use.web_search_requests` and `.web_fetch_requests`. They are billable per request ($10 per 1k searches).
- `usage.iterations[]`: per-iteration breakdown. Verified that the sum of iterations equals the top-level value on every row. Use the top-level value; do not add iterations on top.
- `usage.speed` ("standard"/"fast") and `service_tier` are optional extra dimensions. Fast mode may cost more.

Other fields:
- **model**: `message.model`. Skip `"<synthetic>"` (local error/synthetic messages, none seen here). `requestedModel` can differ, for example on a fallback; use `message.model` for pricing.
- **cost**: there is no per-message cost here. Older CLI versions wrote a top-level `costUSD` on assistant lines; support it via the ccusage modes `auto` (use costUSD if present, else compute), `calculate` and `display`. Default to calculating from a pricing table such as LiteLLM `model_prices_and_context_window.json`, keyed by model id.
- **timestamp**: ISO-8601 UTC string. Use it to bucket by day, month, or 5-hour billing block.
- **sessionId**: in subagent files it equals the parent session's id. Subagent lines also carry `agentId` and `isSidechain: true`.
- **project**: use the `cwd` field. It is the real path, while the directory name is lossy because `:`, `\`, `/` and `.` all become `-`, e.g. `D--Coding-clausage`. ccusage uses the dir name; prefer `cwd` and fall back to the dir name.
- `version` (CLI version), `entrypoint` (`cli`/`claude-desktop`/`sdk-*`), `gitBranch`, `effort`, `thinkingDurationMs` and `attributionAgent` / `attributionSkill` / `attributionMcpServer` / `attributionPlugin` are optional breakdown dimensions.

### 2.2 Dedupe (critical)

Claude Code writes one `assistant` line per content block, distinguished by `apiBlockIndex` 0, 1, … Every one of those lines repeats the full `usage` of the same API response.
- In every duplicate group, usage was identical.
- Dedupe key: `${message.id}:${requestId}`, the same as ccusage. Use one global Set across all files, because resumed or forked sessions copy history into new files.
- If either id is missing (very old logs), do not dedupe that line.
- Keep the first occurrence.
- Without this, totals come out about 1.8x too high.
- Collect content blocks across all lines, including duplicates, to count tool calls.

### 2.3 Counting messages, tool calls and time

- **Tool calls**: count unique `message.content[].type == "tool_use"` blocks by their `id` (`toolu_…`) across all assistant lines. Server tools appear as `server_tool_use` blocks.
- **Assistant messages / requests**: the number of unique dedupe keys.
- **User prompts**: `type=="user"` and `!isMeta` and `!isSidechain`, excluding lines whose `message.content` is an array containing a `tool_result`. Content can be a string or an array of `text`/`tool_result` blocks. Newer lines may carry `origin:{kind:"human"}` / `promptSource`.
  - Variants seen: plain strings (meta true or false), sidechain strings (subagent task prompts), tool_result arrays, and text arrays with meta=true.
- **Sidechain/subagent**: `isSidechain: true` plus `agentId`. Include them in totals, as ccusage does, and allow a breakdown.
- **Duration**:
  1. Wall clock: max(timestamp) − min(timestamp) per session across all its lines, including subagent files.
  2. Better, when present: the session's **`cost-state`** record:
     ```
     {type:"cost-state", sessionId, totalCostUSD, totalAPIDuration(ms), totalAPIDurationWithoutRetries(ms), totalToolDuration(ms), totalLinesAdded, totalLinesRemoved, totalDuration(ms), startTime(epoch ms), modelUsage:{<model>:{…}}, hasUnknownModelCost}
     ```
     It is a cumulative snapshot written repeatedly, so take the last one per session and never sum them. It appears to be written at exit or periodically: the running session has none yet. When it is non-zero it is an independent cost and lines-changed cross-check.
  3. "Active" time can be estimated from gaps between consecutive timestamps under a threshold.
- `tools-used` records: `{type, tools:[toolName…], sessionId}`, a per-session list of distinct tool names. Optional.
- `custom-title` / `agent-name` / `last-prompt`: session display names. `last-prompt` contains user text and must not be shown in exports.

### 2.4 Other lines

- `api-request` lines (`querySource`, `params.model`, `max_tokens`, `thinking`): request metadata with no usage. Ignore them.
- `api-request-blob` contains raw request message content and should never be read for display.

## 3. `~/.claude/stats-cache.json` (secondary/historical source)

Structure (version 5):
```
{ version:5, lastComputedDate:"YYYY-MM-DD", dailyModelTokensVersion:5,
  dailyActivity:[{date, messageCount, sessionCount, toolCallCount}],
  dailyModelTokens:[{date, tokensByModel:{<model>: <int>}}],
  modelUsage:{<model>:{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens}},
  totalSessions, totalMessages,
  longestSession:{sessionId, duration(ms), messageCount, timestamp},
  firstSessionDate, hourCounts:{"0".."23": sessionCount} }
```

- Verified: for every model, the daily `tokensByModel` summed over all days equals input + output + cacheRead + cacheCreate from `modelUsage`.
- That means the per-day data is a single combined total. There is no per-day split or per-day cost.
- `costUSD` is 0 for every model, so cost must be computed from `modelUsage` using pricing (lifetime per model, not per day).
- It covers only up to `lastComputedDate`, and Claude Code recomputes it lazily.
- Use it to backfill days that are no longer present in the transcripts.
  - Prefer transcripts for any day both sources cover.
  - Label backfilled data "approx / from stats-cache" with no cache split.
  - For per-day cost, a split could be estimated from the lifetime ratio. Flag that as an estimate.

## 4. `~/.claude/history.jsonl`

One line per submitted prompt: `{display:"<text>", pastedContents:{…}, timestamp:<epoch ms>, project:"<abs path>", sessionId}`.
- There are no tokens. Use it only for counting prompts and sessions per project and day, including for days whose transcripts were cleaned up.
- Never output `display` or `pastedContents`.

## 5. Pitfalls

1. Dedupe on message.id + requestId (see 2.2). This is the biggest source of error.
2. Use the top-level usage numbers. Do not add `iterations[]` or `thinking_tokens` on top of them.
3. Price `cache_creation` 5m and 1h writes separately when the split exists.
4. Subagent files live in a subdirectory named after the session. A non-recursive glob misses them, and they can hold most of the requests.
5. A file can be appended to while you read it, so tolerate a truncated last line.
6. The project dir name is lossy, so use `cwd`.
7. Timestamps are UTC, so convert for daily buckets (ccusage offers `--timezone`).
8. Skip `<synthetic>` models. Message ids can be missing in very old logs.
9. Model ids may carry suffixes such as dates (`claude-haiku-4-5-20251001`) or `[1m]`. Normalize them for the pricing lookup, with a provider-prefixed fallback.
10. `cost-state` is cumulative: take the last one per session.
11. Retention cleanup deletes old transcripts. Warn users, and use stats-cache for older days.
