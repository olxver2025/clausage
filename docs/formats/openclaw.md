# OpenClaw and Pi session transcripts: usage extraction spec

This spec covers **Pi** (badlogic/pi-mono, `@mariozechner/pi-coding-agent`, now `@earendil-works/pi-coding-agent`) and **OpenClaw** (openclaw/openclaw). OpenClaw embeds pi's agent and writes the same entry format. Both are implemented in `packages/core/src/parsers/openclaw.ts`.

Checked against upstream `main` in November 2026:
- pi-mono: `packages/coding-agent/src/core/session-manager.ts`, `packages/coding-agent/src/config.ts`, `packages/ai/src/types.ts`, `packages/ai/src/api/openai-completions.ts`, `openai-responses-shared.ts`.
- openclaw: `docs/concepts/session.md`, `docs/reference/database-schemas/layout.md`, `src/state/openclaw-agent-schema.sql`, `src/config/sessions/transcript-file-names.ts`, `src/config/paths.ts`.

No local install was available, so the parsers were tested on synthetic fixtures.

## 1. Locations

**Pi**
- Agent dir: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`. The env name is `<APP_NAME>_CODING_AGENT_DIR`; rebranded builds use a different app name.
- Transcripts: `<agent>/sessions/--<cwd with / \ : replaced by ->--/<isoTimestamp>_<sessionId>.jsonl`.
- `$PI_CODING_AGENT_SESSION_DIR` (a custom session dir) is also scanned when set.
- Every `*.jsonl` under the sessions dir is read, recursively.

**OpenClaw**
- State dir: `$OPENCLAW_STATE_DIR`, else `~/.openclaw`. Profile dirs `~/.openclaw-*`, and the pre-rename dirs `~/.clawdbot` and `~/.moltbot`, are also scanned.
- **Before v2026.8.1**, transcripts are JSONL: `agents/<agentId>/sessions/<sessionId>.jsonl`. The `sessions.json` index sits beside them.
- **From v2026.8.1** (agent schema 4), sessions and transcripts live in SQLite: `agents/<agentId>/agent/openclaw-agent.sqlite`, table `transcript_events`.
- **Archived transcripts** stay as files in `agents/<agentId>/sessions/`. clausage uses OpenClaw's own `parseUsageCountedSessionIdFromFileName` rule:
  - Counted: `<id>.jsonl`, `<id>.jsonl.reset.<ts>[.<gen32>][.zst]` and `<id>.jsonl.deleted.<ts>[.<gen32>][.zst]`.
  - Not counted: `*.trajectory.jsonl`, `*.checkpoint.<uuid>.jsonl` and `.bak` archives.
- A root may also point at an agent dir, a sessions dir, or an `openclaw-agent.sqlite` file.

## 2. Entry format (JSONL line, or `transcript_events.event_json`)

```json
{"type":"session","version":3,"id":"<uuid>","timestamp":"<iso>","cwd":"/abs/path","parentSession":"<file of forked-from session>"}
{"type":"message","id":"<8 hex>","parentId":"…","timestamp":"<iso>","message":{
   "role":"assistant","api":"…","provider":"anthropic","model":"claude-…","responseModel":"…",
   "content":[{"type":"text"…},{"type":"thinking"…},{"type":"toolCall",…}],
   "usage":{"input":100,"output":50,"cacheRead":1000,"cacheWrite":20,"cacheWrite1h":5,"reasoning":10,
            "totalTokens":1170,"cost":{"input":…,"output":…,"cacheRead":…,"cacheWrite":…,"total":0.0014,"totalFromProvider":false}},
   "stopReason":"stop|toolUse|length|error|aborted","timestamp":<ms request start>,"durationMs":2500}}
{"type":"model_change","provider":"openai","modelId":"gpt-5.2",…}
{"type":"usage","kind":"cache_warm","provider":"…","model":"…","usage":{…}}       // billed usage outside the context
{"type":"compaction","summary":"…","usage":{…}} / {"type":"branch_summary",…,"usage":{…}}
{"type":"session_info","name":"<user-defined session name>"}
```

`thinking_level_change`, `custom`, `custom_message`, `label` and `context_edit` entries carry no usage.

### Token semantics (verified in pi-ai)

- `input` is **uncached** input. In `openai-completions.ts` it is `prompt_tokens − cached − cache_write`, and in `openai-responses-shared.ts` it is `input_tokens − cached − cacheWrite`.
- `output` **includes reasoning**. The `Usage` doc comment says so, and OpenAI `completion_tokens` already includes `reasoning_tokens`.
- `reasoning` is an informational subset of `output`. `cacheWrite1h` is the subset of `cacheWrite` written with 1-hour retention (Anthropic only).
- `totalTokens` = input + output + cacheRead + cacheWrite.
- `cost.total` is the provider-billed cost when `totalFromProvider` is set, otherwise pi's catalog estimate. It is 0 when the model has no price.

## 3. Mapping

- **One event per assistant message, `usage` entry, or `compaction` / `branch_summary` entry with `usage`.**
  - Events with zero tokens and zero cost (errors, aborts) are skipped.
  - `model` = `message.model`, falling back to `responseModel`. Summary usage without a model uses the most recent model, from an assistant message or a `model_change` entry.
- **Fields:**
  - `inputTokens` = `input`, `outputTokens` = `output`, `cacheReadTokens` = `cacheRead`, `cacheWriteTokens` = `cacheWrite`.
  - `cacheWrite1hTokens` = `min(cacheWrite1h, cacheWrite)` and `reasoningTokens` = `min(reasoning, output)`.
  - `recordedCostUSD` = `cost.total` when > 0. `durationMs` = `message.durationMs`.
  - `timestamp` = `message.timestamp` (request start), falling back to the entry timestamp.
- **Dedupe id:** `<tool>:<entryId>:<message.timestamp or entry timestamp>`.
  - A fork (`/fork`, `/tree` branching) copies the path's entries into a new file **with the same entry ids and timestamps**, so this id counts each response once.
  - The same id is produced from a JSONL file and from its Doctor-imported SQLite copy.
  - Transcripts are processed oldest first, so a shared response is attributed to the original session.
- **Sessions:**
  - `sessionId` = header `id`, else the file / db session id.
  - `project` = header `cwd`.
  - `title` = latest `session_info.name`, else OpenClaw `sessions.json` `label` / `session_nodes.label`.
  - user and assistant counts come from message roles. `toolCalls` = number of `toolCall` content blocks; only their type is counted.
  - `activeMs` comes from entry timestamps.
  - OpenClaw `session_windows.started_at` / `ended_at` widen the time range.
  - Forks are separate sessions; `isSubagent` is false.

## 4. OpenClaw SQLite specifics

- `transcript_events(session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes, navigation_json, …)`.
- Rows with `event_json` are read using `json_extract()` of the fields above. Tool calls are counted with `json_each` on `$.message.content`, comparing only `$.type`. Malformed JSON rows are ignored.
- Rows with `event_zstd`, the compact payload storage from agent schema 23, are decompressed in memory with `zlib.zstdDecompressSync` (Node ≥ 22.15). They are reduced to the same text-free view and then discarded. On older Node they are skipped with a warning.
- Rows with neither column are in cold storage (separate archive files). They are counted and reported through `warn`, but not read.
- `session_windows` supplies times and `session_nodes.label` supplies labels. `display_name`, `entry_json` and conversation tables are not read.

## 5. Never read

- auth and settings files: `auth.json`, `auth-profiles.json`, `models.json`, `settings.json`, `openclaw.json`
- `credentials.sqlite`, the shared `state/openclaw.sqlite`, and the `auth_profile_*`, `memory_*` and conversation tables
- message text, thinking, tool arguments and results, compaction and branch summaries, and system prompts
- `sessions.json` fields other than `sessionId` and `label`. `displayName` and the origin, chat and account fields are dropped.

## 6. Assumptions not verified against a live install

- `transcript_events.event_json` holds the same pi entry objects as the JSONL lines. This follows from the Doctor import path and the `navigation_type` / `message_role` projections, but no real DB was inspected.
- The `~/.openclaw-<profile>` naming for profile state dirs is assumed. `OPENCLAW_PROFILE` resolution was not traced fully.
- Older pi versions before the `reasoning` field are assumed to also count thinking tokens inside `output`.
