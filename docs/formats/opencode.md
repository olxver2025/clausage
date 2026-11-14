# OpenCode (sst/opencode) usage extraction spec

The data was checked against the local install: OpenCode **v1.18.25**, SQLite storage with 38 migrations. The newest migration is `20260612174303_project_dir_strategy`.

## 1. Locations

**Data dir**
- `$XDG_DATA_HOME/opencode`. The default is `~/.local/share/opencode` on Windows, Linux and macOS alike, because OpenCode uses xdg-basedir everywhere.
- Also support an explicit override env var. ccusage uses `OPENCODE_DATA_DIR`. Also accept a CLI `--path`.

**Database**
- `<data>/opencode.db`, plus `opencode.db-wal` and `opencode.db-shm` (WAL mode).
- Glob for `opencode*.db` in case non-stable release channels use a suffixed DB name. That suffix is an inference; I have not checked it.
- Here the DB is 85 MB with a 5.7 MB WAL.

**Legacy JSON storage** (older versions, before SQLite; not present on this machine)
- `<data>/storage/session/<projectID>/ses_*.json`
- `<data>/storage/message/<sessionID>/msg_*.json`
- `<data>/storage/part/<messageID>/prt_*.json`
- The JSON shapes are the same as the `data` columns below, with `id` and `sessionID` inside the JSON.
- Support both sources. If both exist, merge them and dedupe by message id.

**Config**
- `~/.config/opencode/opencode.jsonc` (`$XDG_CONFIG_HOME`). It contains nothing relevant to usage; here it holds only `$schema`.

**Other contents of the data dir**
- `<data>/auth.json` and the `account`, `control_account` and `credential` tables hold secrets. **Never read them.**
- `log/`, `snapshot/` (git snapshots), `tool-output/` and `repos/` are not needed.
- `~/.local/state/opencode/` (`model.json`, `prompt-history.jsonl`) is not needed. The prompt history contains user prompt text, so avoid it.

**Opening the DB**
- `new DatabaseSync(path, { readOnly: true })` works directly on the live DB and sees the WAL contents: it returned 202 messages, the same as the copy.
- Fallback: if the open fails (e.g. `SQLITE_CANTOPEN` or busy), copy `opencode.db` and `opencode.db-wal` together into a temp dir and open the copy.
- Never copy the `-shm` file without the `-wal` file.

## 2. Schema (relevant tables)

All timestamps are **epoch milliseconds**.

| table | columns | rows here |
|---|---|---|
| `session` | `id` (ses_…), `project_id`, `workspace_id`, `parent_id`, `slug`, `directory`, `path`, `title`, `version`, `share_url`, `summary_additions`, `summary_deletions`, `summary_files`, `summary_diffs`, `metadata`, **`cost` REAL**, **`tokens_input`**, **`tokens_output`**, **`tokens_reasoning`**, **`tokens_cache_read`**, **`tokens_cache_write`**, `revert`, `permission`, `agent`, `model` (JSON text, e.g. `{"id":"grok-4.6","providerID":"xai","variant":"high"}`), `time_created`, `time_updated`, `time_compacting`, `time_archived` | 8 |
| `message` | `id` (msg_…), `session_id`, `time_created`, `time_updated`, `data` (JSON text) | 202 (18 user, 184 assistant) |
| `part` | `id` (prt_…), `message_id`, `session_id`, `time_created`, `time_updated`, `data` (JSON text) | 1099 |
| `project` | `id` ("global", or a git root-commit sha), `worktree`, `vcs`, `name`, `time_*`, `sandboxes`, `commands` | 2 |
| `project_directory` | (`project_id`, `directory`, `type`, `strategy`, `time_created`) | 1 |
| `event` / `event_sequence` | event-sourcing log: `type` in `message.part.updated.1` (3502), `message.updated.1` (770), `session.updated.1` (227), `session.created.1` (8); `data` = `{sessionID, info}` | 4507 |

Other tables (`todo`, `session_message`, `session_input`, `session_share`, `workspace`, `permission`, `migration`) are empty or not relevant.

## 3. Message `data` JSON

### Assistant message (redacted)

```json
{"role":"assistant","parentID":"msg_…(user msg)","mode":"build","agent":"build","variant":"max",
 "path":{"cwd":"<text>","root":"<text>"},
 "cost":0.00489405,
 "tokens":{"total":10717,"input":10649,"output":68,"reasoning":0,"cache":{"write":0,"read":0}},
 "modelID":"grok-4.6","providerID":"xai",
 "time":{"created":1788015595745,"completed":1788015600498},
 "finish":"tool-calls"}
```

- `finish` takes the values `"tool-calls"`, `"stop"`, or is missing.
- An error message has an `error` field of shape `{name:"APIError", data:{…}}`, all tokens 0, cost 0, no `finish` and no `time.completed`.
- `variant` is the reasoning-effort preset: `high`, `xhigh` or `max`.
- `mode` and `agent` name the agent: `build` or `explore`.

### User message (redacted)

```json
{"role":"user","time":{"created":…},"agent":"build","model":{"providerID":"xai","modelID":"grok-4.6"},"summary":{"diffs":[]}}
```

User messages carry no tokens. Their text lives in `part` rows of type `text`; do not read those.

### Token semantics (verified)

- **Per message, not cumulative.** Each assistant row covers one LLM call (one step). Sum the rows.
- `total = input + output + reasoning + cache.read + cache.write`. This held exactly on every row checked.
- So `input` **excludes** cached tokens, `output` **excludes** reasoning, and reasoning is reported separately. This is unlike raw OpenAI usage.
- **`cost` is USD, computed by OpenCode** from the models.dev pricing for that provider and model.
  - It is **0 for models without known pricing**, such as custom or modal endpoints.
  - The CLI should therefore offer a cost mode: `auto` uses the recorded cost when it is > 0 and otherwise calculates from a pricing table; `calculate` always calculates; `display` shows only the recorded cost.
- Model key: `providerID` + `modelID`.
  - Model ids can be long custom strings, e.g. `<workspace>--ep-<model>-server.<region>.modal.direct`.
  - For pricing lookup, normalise them or fall back to the provider/model as given.

## 4. Parts (`part.data.type`)

Counts here:

| type | count |
|---|---|
| text | 80 |
| reasoning | 170 |
| step-start | 183 |
| step-finish | 183 |
| tool | 461 (458 `state.status:"completed"`, 3 `"error"`) |
| patch | 22 |

Other types may appear in other versions: `file`, `agent`, `subtask`, `compaction`, `snapshot`.

**step-finish**
- Shape: `{"type":"step-finish","reason":"tool-calls","tokens":{total,input,output,reasoning,cache:{read,write}},"cost":0.0035667}`.
- Exactly one per assistant message here. In all 183 cases the cost and tokens matched the parent message exactly; the only message without one was the errored message.
- Pitfall: older OpenCode versions could have several steps per assistant message. There the message-level `tokens` may reflect only the last step, while `cost` accumulated across steps.
  - Robust rule: if a message has more than one step-finish part, use the sum of its step-finish parts.
  - Otherwise use `message.data.tokens` and `message.data.cost`.

**tool**
- Shape: `{"type":"tool","tool":"bash","callID":"call_…","state":{"status":"completed"|"error"|"running"|"pending","input":{…},"output":"<text>","metadata":{…},"title":"<text>","time":{"start":ms,"end":ms}}}`.
- Count tool calls as the number of `type='tool'` parts, grouped by `$.tool`.
- Here: read 154, bash 111, grep 63, edit 56, webfetch 34 (+2 errors), glob 15, todowrite 13, write 11, task 1, question 1 (error).
- Tool duration is `state.time.end - state.time.start`.
- `state.input` and `state.output` contain user code and commands. Never extract them.

**reasoning** and **text**
- Both have `time.start` and `time.end`.
- Their content is private; skip it.

**patch**
- Shape: `{hash, files:[paths]}`. Usable as a "files changed" count.

## 5. Extraction recipe (SQL)

```sql
SELECT m.id, m.session_id, m.time_created, m.data,
       s.title, s.directory, s.parent_id, s.project_id, p.worktree
FROM message m JOIN session s ON s.id = m.session_id
LEFT JOIN project p ON p.id = s.project_id
WHERE json_extract(m.data,'$.role') = 'assistant';
```

Tool counts:

```sql
SELECT session_id, message_id, json_extract(data,'$.tool') tool, json_extract(data,'$.state.status') st
FROM part WHERE json_extract(data,'$.type')='tool';
```

Field mapping:
- **timestamp** = `data.time.created` (same as `m.time_created`).
- **duration per message** = `data.time.completed - data.time.created`. Skip the message if `completed` is missing.
- **session duration** = `session.time_updated - session.time_created`, or last minus first message time.
- **project/cwd**: `session.directory`, or `data.path.cwd` / `data.path.root` per message. `project.worktree` is the git root; `project_id='global'` means the directory is not under git.
- **message counts**: user = `role='user'` rows; assistant = `role='assistant'` rows.
- **subagent sessions**: `session.parent_id` is non-null for child sessions created by the `task` tool (agent `explore`). Their messages are separate rows, so summing message rows does not double-count them. Roll them up under the parent if desired.
- **dedupe**: by `message.id` (the primary key). Only needed when merging legacy JSON storage with the DB, or when reading multiple DB files.

## 6. Pitfalls

- **Do not use the `event` table for usage.** It holds many `message.updated` snapshots per message (770 events for 202 messages), so summing it overcounts.
- **`session.cost` and `session.tokens_*` are denormalised aggregates.** They matched the per-message sums exactly for all 8 sessions, so they are fine for a quick per-session total.
  - Each session's aggregate covers only its own messages, not its children. The child session's $0.409 is not included in its parent's $0.087.
  - Sessions with zero usage exist; one session here has only a user message and an errored reply.
- **Errored assistant messages** have zero tokens. Count them as errors and not as usage.
- **Cost 0 does not mean free.** It means OpenCode had no price for that model, so recalculate from a pricing table.
- **Timestamps are ms.** Bucket them by local day or month in the user's timezone.
- **Old sessions:** `version` (`1.18.25`) tells you which OpenCode release wrote each session.
- **No usage data here:** `session.model` and `data.model` on user messages are JSON strings or objects for the selected model, not usage.
