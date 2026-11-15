# Gemini CLI (google-gemini/gemini-cli) usage extraction spec

Checked against upstream `main` in November 2026:
- `packages/core/src/services/chatRecordingService.ts`
- `packages/core/src/services/chatRecordingTypes.ts`
- `packages/core/src/config/storage.ts`
- `packages/core/src/config/projectRegistry.ts`
- `packages/core/src/utils/paths.ts`

The parser was tested on synthetic fixtures. This machine's `~/.gemini` holds no Gemini CLI data.

## 1. Locations

- **Gemini dir:** `homedir()/.gemini`, where `homedir()` is `$GEMINI_CLI_HOME` when set and `os.homedir()` otherwise. So the default is `~/.gemini`.
- **Seatbelt sandbox:** under the macOS seatbelt sandbox (`SANDBOX=sandbox-exec`), runtime state goes to `~/.cache/.gemini` instead. clausage scans both.
- **Chat recordings:** `<gemini>/tmp/<project-id>/chats/`
  - `session-<YYYY-MM-DDTHH-MM>-<first 8 of sessionId>.jsonl` is the current append-only format.
  - `session-*.json` is the legacy whole-file `ConversationRecord`. Current versions rename it to `.jsonl` when they resume a session.
  - `<parentSessionId>/<sessionId>.jsonl` holds subagent recordings (`kind: "subagent"`).
- **`<project-id>`** is a short slug from the project registry, or a legacy sha256 hash of the project path.
- **Project root:**
  - `tmp/<project-id>/.project_root`, a plain-text absolute path written by `ProjectRegistry`.
  - Otherwise the reverse of `<gemini>/projects.json` (`{"projects": {"<abs path>": "<slug>"}}`).
  - Otherwise `''`. Hash dirs cannot be reversed.
- clausage accepts the Gemini dir, its `tmp` dir, or a `GEMINI_CLI_HOME`-style parent through `--path gemini=…`. **Only `tmp/` is walked**, so unrelated folders under `~/.gemini` (e.g. `antigravity-cli`) are never touched.

## 2. Record format (JSONL)

Each line is one of:

| shape | meaning |
|---|---|
| `{sessionId, projectHash, startTime, lastUpdated, kind?, directories?}` | initial metadata |
| `{id, timestamp, type: "user"\|"gemini"\|"info"\|"error"\|"warning", content, …}` | a `MessageRecord`; re-appended in full whenever it changes (last wins by id) |
| `{"$set": {...metadata, summary?, messages?}}` | metadata update; `messages` is a deprecated full-history checkpoint |
| `{"$patch": {id?, content?, toolCalls?, updates?, removeIds?, orderIds?}}` | content edits |
| `{"$rewindTo": "<messageId>"}` | conversation rewound |

`gemini` messages carry `model`, `toolCalls[]`, `thoughts[]` and `tokens`:

```ts
tokens: { input: promptTokenCount, output: candidatesTokenCount, cached: cachedContentTokenCount,
          thoughts: thoughtsTokenCount, tool: toolUsePromptTokenCount, total: totalTokenCount }
```

`recordMessageTokens()` sets `tokens` once per message, on the latest `gemini` message that has none, and re-appends the message.

### Token semantics

- `promptTokenCount` **includes** cached content tokens, and `candidatesTokenCount` **excludes** thoughts. These are Gemini API usageMetadata semantics.
- `totalTokenCount = prompt + candidates + thoughts + toolUsePrompt`.

## 3. Mapping

- **Fields:**
  - `inputTokens` = `input − cached`, plus `tool` when `total ≥ input + output + thoughts + tool`, which shows tool-use prompt tokens are reported separately.
  - `cacheReadTokens` = `cached`.
  - `outputTokens` = `output + thoughts`, and `reasoningTokens` = `thoughts`.
  - `cacheWriteTokens` = 0. `provider` = `google`.
- **No recorded cost:** Gemini CLI does not record one, so `recordedCostUSD` is never set.
- **Identity:** id is `gemini:<sessionId>:<messageId>`. timestamp is the message `timestamp`, falling back to the session `startTime`.
- **Rewound or removed messages still produce events.** Their tokens were billed. Re-appended copies of the same message id are merged.
- **Sessions:**
  - `title` = `summary`, the session summary Gemini CLI shows in `/resume`.
  - user and assistant counts come from `type`. `toolCalls` = Σ `toolCalls.length`.
  - `startedAt` / `endedAt` = `startTime` / `lastUpdated`, widened by message times.
  - Subagent sessions: `isSubagent` is true and `rootSessionId` = the parent dir name, which is the parent session id.
- **`since` optimisation:** files whose mtime is before `since` are skipped.

## 4. Never read

- Message `content` and `displayContent`, `thoughts`, tool `args` / `result` / `resultDisplay`, `memoryScratchpad` and `directories`. Each line is parsed, then reduced at once to ids, types, timestamps, model and numbers.
- Credential and config files: `settings.json`, `oauth_creds.json`, `google_accounts.json`, `mcp-oauth-tokens.json`, `a2a-oauth-tokens.json`, `installation_id`, `trustedFolders.json`.
- Other data under `tmp/<project>/`: `logs/`, `checkpoints/`, `shell_history`, `memory/`, `plans/`, `tasks/`, `tracker/`.
- Everything outside `tmp/` except `projects.json`, which is a path → slug map.

## 5. Assumptions

- `toolUsePromptTokenCount` is treated as separate from `promptTokenCount` only when `total` confirms it. When `total` is absent or smaller, `tool` is ignored.
- Message ids are assumed to be unique within a session.
