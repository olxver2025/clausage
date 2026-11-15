# Qwen Code (QwenLM/qwen-code) usage extraction spec

Checked against upstream `main` in November 2026:
- `packages/core/src/services/chatRecordingService.ts` (`ChatRecord`, `recordAssistantTurn`)
- `packages/core/src/config/storage.ts`, `packages/core/src/utils/paths.ts` (`sanitizeCwd`)
- `packages/core/src/core/openaiContentGenerator/converter.ts`, `openaiResponsesContentGenerator/responses-converter.ts`, `anthropicContentGenerator/usage.ts` (how provider usage becomes `usageMetadata`)
- `packages/core/src/telemetry/gen-ai-usage.ts` (`outputIncludesThoughts`, `outputTokenCount`)
- ccusage `rust/adapters/qwen` for the file layout

The parser was tested on synthetic fixtures. Qwen Code is not installed on this machine.

## 1. Locations

- **Runtime dir:** `$QWEN_RUNTIME_DIR`, else `$QWEN_HOME`, else `~/.qwen`. `$QWEN_DATA_DIR` (ccusage's override, comma-separated) is honoured too; clausage reads every one that is set.
- **Transcripts:** `<qwen>/projects/<sanitised cwd>/chats/<sessionId>.jsonl` (append-only JSONL). The sanitised cwd replaces every non-alphanumeric character with `-`, so it cannot be reversed; the project comes from the records' `cwd`.
- Only `*.jsonl` files below a `chats/` folder under `projects/` are read. `--path qwen=…` accepts the Qwen dir or its `projects/` dir.

## 2. Record format

```ts
{ uuid, parentUuid, sessionId, timestamp, type: "user" | "assistant" | "tool_result" | "system",
  subtype?, cwd, version, gitBranch?, message?, model?, usageMetadata?, contextWindowSize?,
  executionContext?: { modelId, authType, approvalMode }, toolCallResult?, systemPayload?,
  isSidechain?, agentId?, agentName? }
```

`type: "assistant"` records carry Gemini-shaped `usageMetadata`: `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `cachedContentTokenCount`, `totalTokenCount`.

### Token semantics

- `promptTokenCount` **includes** the cached prompt for every provider (the OpenAI, Responses and Anthropic converters all build it as the full prompt), and `cachedContentTokenCount` is the cache read.
- Cache writes (Anthropic `cache_creation_input_tokens`, OpenAI `cache_write_tokens`) are kept only in an in-memory WeakMap and are **not persisted**; they stay inside `promptTokenCount`.
- `candidatesTokenCount` includes reasoning for OpenAI-style providers (chat completions `completion_tokens`, Responses `output_tokens`) and excludes it for Gemini.

## 3. Mapping

- **Fields:**
  - `inputTokens` = `promptTokenCount − cachedContentTokenCount`; `cacheReadTokens` = `cachedContentTokenCount`; `cacheWriteTokens` = 0.
  - `outputTokens` follows Qwen's own `outputTokenCount()`: when `totalTokenCount − promptTokenCount` lies between `candidates` and `candidates + thoughts` it is the output; otherwise `candidates` for auth types `openai`, `openai-responses` and `qwen-oauth` (taken from the latest user record's `executionContext.authType`) and `candidates + thoughts` for the others. A total without a breakdown counts as output.
  - `reasoningTokens` = `thoughtsTokenCount` (capped at output). `provider` = `alibaba` for `qwen*` / `qwq*` models.
- **No recorded cost:** Qwen Code does not store one.
- **Dedupe:** records are deduped by `uuid` across all files (resumed and forked sessions copy records); the first file in path order keeps them.
- **Identity:** id is `qwen:<sessionId>:<uuid>`, timestamp is the record `timestamp`.
- **Subagents:** records with `isSidechain: true` are subagent events in their session. A session whose `system` / `parent_session` record names `systemPayload.parentSessionId` rolls up to that session (`isSubagent`, `rootSessionId`).
- **Sessions:** `title` = the last `system` / `custom_title` record's `systemPayload.customTitle` (set by `/rename` or Qwen's auto-title); `project` = the first record `cwd`; user messages = `type: "user"` records without a `subtype` that are not sidechain; `toolCalls` = `tool_result` records; `version` = the CLI `version`; active time from record timestamps.
- **`since` optimisation:** files whose mtime is before `since` are skipped.

## 4. Never read

- `message` (prompts, responses, thoughts, function calls and responses), `toolCallResult` contents, `userText`, every `systemPayload` other than the title and parent id. Each line is reduced at once to ids, types, timestamps, cwd, model, auth type, version and numbers.
- `settings.json`, `oauth_creds.json`, `mcp-oauth-tokens.json`, `installation_id`, `google_accounts.json`, `memory.md`, `plans/`, `commands/`, `bin/`, `ide/`, logs, title sidecar files and anything outside `projects/*/chats/`.

## 5. Open questions

- Cache-write tokens are billed as uncached input because Qwen Code does not persist them, so calculated cost can be slightly off for Anthropic-backed sessions.
- When a session switches auth type mid-way and a record lacks `totalTokenCount`, the latest auth type seen so far decides whether thoughts are added.
