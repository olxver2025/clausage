#!/usr/bin/env node
// Regenerates src/pricing-snapshot.json from LiteLLM's model_prices_and_context_window.json.
// Usage: node packages/core/scripts/update-pricing-snapshot.mjs [local-prices.json]
// Keeps only chat/responses entries of the providers clausage cares about, and only pricing fields.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const URL_ = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pricing-snapshot.json');

const PRICE_FIELD =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)(_above_1hr)?(_above_\d+k_tokens)?(_priority|_ultrafast|_flex)?$/;
const PROVIDERS = new Set(['anthropic', 'openai', 'xai', 'deepseek', 'gemini', 'mistral', 'groq', 'dashscope', 'moonshot', 'zai']);
const OPENROUTER_RE = /claude|gpt|grok|glm|deepseek|qwen|kimi/;

function keep(key, v) {
  if (!v || typeof v !== 'object') return false;
  if (v.mode !== 'chat' && v.mode !== 'responses') return false;
  if (typeof v.input_cost_per_token !== 'number') return false;
  const p = v.litellm_provider;
  if (p === 'azure_ai' && /^azure_ai\/claude-(?:opus-5-5|mythos-5-2|fable-5-2)-fast$/.test(key)) return true;
  if (PROVIDERS.has(p)) return true;
  if (p === 'vertex_ai-language-models') return /gemini/.test(key);
  if (p === 'openrouter') return OPENROUTER_RE.test(key);
  // retired Claude models (claude-sonnet-4, claude-opus-4-1, claude-3-x) survive only as Vertex / Bedrock entries
  if (p === 'vertex_ai-anthropic_models') return true;
  if (/^anthropic\.claude-[^:/]+-v\d+:0$/.test(key)) return true;
  return false;
}

const raw = process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], 'utf8'))
  : await (await fetch(URL_, { signal: AbortSignal.timeout(30000) })).json();

const result = {};
for (const key of Object.keys(raw).sort()) {
  const v = raw[key];
  if (!keep(key, v)) continue;
  const e = { litellm_provider: v.litellm_provider };
  for (const [f, val] of Object.entries(v)) if (PRICE_FIELD.test(f) && typeof val === 'number') e[f] = val;
  result[key] = e;
}
const json = JSON.stringify(result);
writeFileSync(out, json + '\n');
console.log(`wrote ${Object.keys(result).length} models, ${(json.length / 1024).toFixed(0)} KiB -> ${out}`);
