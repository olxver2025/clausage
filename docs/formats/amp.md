# Amp (Sourcegraph Amp CLI) usage extraction spec

Amp has no published schema for its thread files. This spec follows the two independent readers that are validated against real threads, checked in November 2026:
- ccusage `rust/adapters/amp/src/parser.rs` and `src/README.md`
- tokscale `crates/tokscale-core/src/sessions/amp.rs`
- the `sidecar` Go adapter (`internal/adapter/amp`), for the thread / message / env struct layout

The parser was tested on synthetic fixtures. Amp is not installed on this machine, so no local thread was inspected.

## 1. Locations

- **Data dir:** `$AMP_DATA_DIR` (comma-separated; the variable ccusage uses), otherwise `$XDG_DATA_HOME/amp` and `~/.local/share/amp`.
- **Threads:** `<amp>/threads/T-<uuid>.json`, one JSON object per thread. Newer Amp versions keep threads on ampcode.com and may not write this folder; an export of thread JSON files (`T-*.json`) can be read with `--path amp=<dir>`. A root without a `threads/` folder is walked for `T-*.json` itself.
- The same thread id found in two roots (live + backup) is read once.

## 2. Record format

```ts
{
  v, id: "T-…", created: <epoch ms>, title?,
  env?: { initial: { trees: [{ displayName, uri: "file:///abs/path", repository? }], platform } },
  messages: [{
    role: "user" | "assistant", messageId: <int>, meta?: { sentAt: <epoch ms> },
    content: [{ type: "text" | "thinking" | "tool_use" | "tool_result", name?, … }],
    usage?: { model, inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens,
              totalInputTokens, totalTokens?, timestamp, credits? }
  }],
  usageLedger?: { events: [{ id, timestamp, model, tokens: { input, output, total? },
                             operationType, fromMessageId, toMessageId, credits }] }
}
```

### Token semantics

- Message `inputTokens` is **uncached** input (Anthropic style): `totalInputTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens`.
- The ledger's `tokens.input` / `tokens.output` carry no cache split; the split comes from the assistant message the event points at (`toMessageId`).

## 3. Mapping

- **Source choice (same as ccusage):** a thread with a non-empty `usageLedger.events` uses one event per ledger entry, which also covers calls with no assistant message (e.g. title generation). Otherwise one event per assistant message with `usage`.
- **Fields:** `inputTokens` = input, `outputTokens` = output, `cacheWriteTokens` = `cacheCreationInputTokens`, `cacheReadTokens` = `cacheReadInputTokens`. A record with only a total counts the total as output (ccusage's fallback). `reasoningTokens` = 0 (not reported separately; thinking is inside output).
- **No recorded cost:** Amp `credits` have no documented USD rate, so they are not used.
- **Identity:** `amp:<threadId>:L:<ledgerEventId>` or `amp:<threadId>:M:<messageId>`. Timestamp is the ledger / usage `timestamp` (ledger entries without one are skipped, as in ccusage), else the message `meta.sentAt`, else `created`.
- **Provider:** inferred from the model name (claude → anthropic, gpt / o-series → openai, gemini → google).
- **Sessions:** one per thread. `title` = `title`; `project` = the first `env.initial.trees[].uri` (`file://` → path); user / assistant counts from `role`; `toolCalls` = number of `tool_use` blocks in assistant messages, with `toolCallsByName` from their `name`; `startedAt` = `created`; active time from message and usage timestamps (idle-gap estimate).
- **`since` optimisation:** files whose mtime is before `since` are skipped.

## 4. Never read

- Text, thinking, tool inputs and tool results in `content` (each thread is parsed whole, then reduced at once to ids, roles, timestamps, model names, numbers, tool names, title and workspace URI).
- `secrets.json`, settings, logs and anything else under the Amp data dir that is not a `T-*.json` thread.

## 5. Open questions

- Whether ledger `tokens.input` is uncached input like message `inputTokens` (ccusage and tokscale both treat it so).
- Subagent threads (if Amp links them) are not detected; each thread is a root session.
