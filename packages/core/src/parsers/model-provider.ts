/**
 * Best-effort model maker from a model name, for parsers whose logs don't record the provider
 * (Amp, Copilot CLI). Only used for the dashboard's provider marks; pricing uses the model name.
 */
export function providerOf(model: string): string | undefined {
  const m = model.toLowerCase().replace(/^.*\//, '');
  if (/^claude|^(opus|sonnet|haiku|fable)/.test(m)) return 'anthropic';
  if (/^(gpt|o\d|codex)/.test(m)) return 'openai';
  if (/^gemini/.test(m)) return 'google';
  if (/^grok/.test(m)) return 'xai';
  if (/^(qwen|qwq)/.test(m)) return 'alibaba';
  return undefined;
}
