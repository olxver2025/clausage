# Aider (Aider-AI/aider) usage extraction spec

Checked against upstream `main` in November 2026:
- `aider/analytics.py` (`Analytics.event`, the `--analytics-log` writer)
- `aider/coders/base_coder.py` (`calculate_and_show_tokens_and_cost`, the `message_send` event)
- `aider/args.py` (`--analytics-log`)

The parser was tested on synthetic fixtures. Aider is not installed on this machine.

## 1. What Aider keeps locally

- Aider stores **no per-request token counts by default**. The chat history (`.aider.chat.history.md`) contains "Tokens: … sent, … received. Cost: …" lines, but it is a transcript of prompts and replies, so clausage never opens it.
- The one structured source is the **opt-in analytics log**: `aider --analytics-log <file>` (or `AIDER_ANALYTICS_LOG=<file>`, Aider's own env mapping) appends one JSON object per analytics event. It is written whenever the option is set, even with remote analytics disabled.
- clausage reads `$AIDER_ANALYTICS_LOG` (comma-separated) and `~/.aider/analytics.jsonl` when present. `--path aider=<file>` reads that file; `--path aider=<dir>` reads every `*.jsonl` below it. `~/.aider/analytics.json` (the anonymous id / opt-in file) is never opened.

## 2. Record format

```json
{"event": "message_send", "properties": {"main_model": "anthropic/claude-sonnet-4-5", "weak_model": "…", "editor_model": "…", "edit_format": "diff", "prompt_tokens": 12000, "completion_tokens": 800, "total_tokens": 12800, "cost": 0.048, "total_cost": 0.31}, "user_id": "<uuid>", "time": 1791958810}
```

- `time` is epoch **seconds**. Other events include `launched`, `repo`, `message_send_starting`, `message_send_exception`, `exit`.
- `main_model` is the LiteLLM model name, or `<provider>/REDACTED` when LiteLLM does not know it.
- `prompt_tokens` is the tokens sent for the message (summed over retries / reflections). For providers that report Anthropic-style cache fields Aider adds `cache_creation_input_tokens` to it; cache reads are excluded for Anthropic and included for OpenAI-style providers. Cache reads and writes are not logged separately.
- `cost` is Aider's own USD estimate for the message (LiteLLM prices with its cache adjustments); `total_cost` is the running session total.

## 3. Mapping

- One event per `message_send` with tokens: `inputTokens` = `prompt_tokens`, `outputTokens` = `completion_tokens` (includes reasoning), cache fields 0, `reasoningTokens` 0, `recordedCostUSD` = `cost` when > 0.
- `provider` = the `provider/` prefix of the model name (else inferred for claude / gpt / gemini).
- **Sessions:** each `launched` event starts a new session (`<file name>-<launch ms>`); events before the first `launched` form their own. turns = user = assistant messages = `message_send` count, `toolCalls` = 0, project = `''` (the log has no working directory), active time from event times.
- id `aider:<sessionId>:<line number>`.

## 4. Never read

- `user_id` and every property other than `main_model`, `prompt_tokens`, `completion_tokens` and `cost` (e.g. exception text) are dropped as each line is parsed.
- `.aider.chat.history.md`, `.aider.input.history`, `.aider.tags.cache*`, `.aider.conf.yml`, `.env`, `~/.aider/analytics.json`, `~/.aider/caches`.

## 5. Open questions

- Because cached input is not split out, `calculate` mode prices all input at the uncached rate; `auto` (the default) uses Aider's recorded `cost`, which already applies its cache discounts.
