import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PricingTable,
  applyCosts,
  costForEvent,
  costForTokens,
  embeddedSnapshot,
  loadPricing,
  normalizeModelName,
  reduceLiteLLM,
  toModelPricing,
} from './pricing.js';
import type { ModelPricing, ToolId, UsageEvent } from './types.js';

const M = 1e-6;
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const table = new PricingTable(embeddedSnapshot(), 'embedded');

function ev(over: Partial<UsageEvent> & { tool: ToolId; model: string }): UsageEvent {
  return {
    id: 'x', timestamp: Date.UTC(2026, 10, 13), sessionId: 's', rootSessionId: 's', isSubagent: false, project: '',
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0,
    costUSD: 0, ...over,
  };
}

test('embedded snapshot is small and has key models', () => {
  assert.ok(table.size > 300);
  assert.ok(JSON.stringify(embeddedSnapshot()).length < 1.5e6);
  const opus = table.lookup('claude-opus-5-5')!;
  close(opus.input, 4 * M); close(opus.output, 20 * M); close(opus.cacheRead!, 0.2 * M);
  close(opus.cacheWrite!, 5 * M); close(opus.cacheWrite1h!, 8 * M);
  assert.equal(opus.tiers, undefined);
  const terra = table.lookup('gpt-6.1-terra', 'codex')!;
  close(terra.input, 1 * M); close(terra.cacheRead!, 0.05 * M);
  assert.deepEqual(terra.tiers?.map((t) => t.threshold), [272000]);
  close(terra.tiers![0].input!, 2 * M);
});

test('normalisation and provider-prefixed lookups', () => {
  assert.equal(normalizeModelName('Anthropic/Claude-Opus-4-6[1m]'), 'claude-opus-4-6');
  assert.equal(normalizeModelName('x-ai/grok-4.6-build'), 'grok-4.6');
  assert.equal(normalizeModelName('vertex_ai/claude-opus-5@default'), 'claude-opus-5');
  assert.equal(table.lookup('grok-4.6', 'grok')!.key, 'xai/grok-4.6');
  assert.equal(table.lookup('grok-4.6-build', 'grok')!.key, 'xai/grok-4.6');
  assert.equal(table.lookup('grok-4.6', 'opencode', 'xai')!.key, 'xai/grok-4.6');
  assert.equal(table.lookup('x-ai/grok-4.6')!.key, 'xai/grok-4.6');
  assert.equal(table.lookup('claude-haiku-4-5-20251001')!.key, 'claude-haiku-4-5-20251001');
  assert.equal(table.lookup('claude-opus-4-6-20991231')!.key, 'claude-opus-4-6'); // unknown date -> undated
  assert.equal(table.lookup('claude-opus-5-5[1m]')!.key, 'claude-opus-5-5');
  assert.equal(table.lookup('anthropic/claude-sonnet-4.5')!.key, 'claude-sonnet-4-5');
  // retired Claude model only available via Bedrock key
  assert.match(table.lookup('claude-sonnet-4-20250514')!.key, /^anthropic\.claude-sonnet-4-20250514-v1:0$/);
  assert.equal(table.lookup('modal/someone--ep-glm-5-3-flash-abc'), null);
});

test('aliases and family fallbacks', () => {
  assert.equal(table.lookup('codex-auto-review', 'codex')!.key, 'gpt-5.6-luna');
  assert.equal(table.lookup('codex-auto-review', 'codex', undefined, Date.UTC(2026, 6, 29))!.key, 'gpt-5.4');
  assert.equal(table.lookup('codex-auto-review', 'codex', undefined, Date.UTC(2026, 6, 30))!.key, 'gpt-5.6-luna');
  assert.equal(table.lookup('gpt-reserve')!.key, 'gpt-5.6-luna');
  assert.equal(table.lookup('', 'codex')!.key, 'gpt-5');
  assert.equal(table.resolve('claude-opus-5-5-fast')!.pricing.key, 'azure_ai/claude-opus-5-5-fast');
  assert.equal(table.resolve('claude-opus-5-5-fast')!.match, 'prefixed');
  const fam = table.resolve('claude-opus-9')!;
  assert.equal(fam.match, 'family');
  assert.match(fam.pricing.key, /^claude-opus-\d/);
  assert.equal(table.lookup('claude-sonnet-5-2')!.key, 'claude-sonnet-5'); // closest version below
  assert.ok(table.lookup('opus'));
});

test('tier parsing from field names', () => {
  const p = toModelPricing('m', {
    input_cost_per_token: 1, output_cost_per_token: 2,
    input_cost_per_token_above_128k_tokens: 3, output_cost_per_token_above_128k_tokens: 4,
    input_cost_per_token_above_256k_tokens: 5, cache_read_input_token_cost_above_256k_tokens: 0.5,
    input_cost_per_token_above_272k_tokens_priority: 99, cache_creation_input_token_cost_above_1hr: 7,
  })!;
  assert.deepEqual(p.tiers, [
    { threshold: 128000, input: 3, output: 4 },
    { threshold: 256000, input: 5, cacheRead: 0.5 },
  ]);
  assert.equal(p.cacheWrite1h, 7);
});

test('costForTokens: base, cache fallbacks, 1h writes, whole-request tiers', () => {
  const p: ModelPricing = { key: 't', input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25,
    tiers: [{ threshold: 200, input: 2, output: 15, cacheRead: 0.2 }] };
  // below threshold (prompt = 10 + 50 + 40 = 100)
  close(costForTokens({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 50, cacheWriteTokens: 40, cacheWrite1hTokens: 10 }, p),
    10 * 1 + 5 * 10 + 50 * 0.1 + 30 * 1.25 + 10 * 2);
  // above threshold: whole request at tier rates; cacheWrite has no tier -> base; 1h = 2x tier input
  close(costForTokens({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 50, cacheWrite1hTokens: 50 }, p),
    100 * 2 + 5 * 15 + 100 * 0.2 + 50 * 4);
  // threshold must be strictly exceeded
  close(costForTokens({ inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, p), 200);
  close(costForTokens({ inputTokens: 201, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, p), 402);
  // applyTiers: false
  close(costForTokens({ inputTokens: 201, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, p, { applyTiers: false }), 201);
  // missing cache prices -> input rate
  const bare: ModelPricing = { key: 'b', input: 3, output: 6 };
  close(costForTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 2, cacheWriteTokens: 3 }, bare), 15);
  // explicit 1h price scaled by tier ratio
  const h: ModelPricing = { key: 'h', input: 1, output: 1, cacheWrite: 1.25, cacheWrite1h: 2, tiers: [{ threshold: 10, input: 5 }] };
  close(costForTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 20, cacheWrite1hTokens: 20 }, h), 20 * 10);
});

test('real prices: haiku-5-5 100k tier, gpt-6.1-terra 272k tier, grok never tiered', () => {
  const haiku = table.lookup('claude-haiku-5-5')!;
  close(costForEvent(ev({ tool: 'claude-code', model: 'x', inputTokens: 100_001 }), haiku), 100_001 * 0.5 * M);
  close(costForEvent(ev({ tool: 'claude-code', model: 'x', inputTokens: 100_000 }), haiku), 100_000 * 0.1 * M);
  const terra = table.lookup('gpt-6.1-terra')!;
  close(costForEvent(ev({ tool: 'codex', model: 'x', inputTokens: 1000, cacheReadTokens: 300_000, outputTokens: 100 }), terra),
    1000 * 2 * M + 300_000 * 0.1 * M + 100 * 7.5 * M);
  // spec check: grok turn 3 = $0.403754 (127,922 uncached, 242,048 cached, 621+3,860 output incl. reasoning)
  const grok = table.lookup('grok-4.6', 'grok')!;
  close(costForEvent(ev({ tool: 'grok', model: 'grok-4.6', inputTokens: 127_922, cacheReadTokens: 242_048, outputTokens: 4481 }), grok), 0.403754, 1e-9);
});

test('reference totals from the spec (aggregate tokens, untiered)', () => {
  const c = (model: string, tool: ToolId, i: number, cr: number, cw: number, o: number) =>
    costForTokens({ inputTokens: i, cacheReadTokens: cr, cacheWriteTokens: cw, outputTokens: o }, table.lookup(model, tool)!, { applyTiers: false });
  close(c('claude-opus-5', 'claude-code', 5222, 417_440_411, 10_093_278, 3_610_601), 362.0943, 1e-3);
  close(c('claude-sonnet-5', 'claude-code', 852, 48_901_090, 2_299_911, 329_038), 18.8221, 1e-3);
  close(c('claude-haiku-4-5-20251001', 'claude-code', 610, 3_678_282, 189_892, 23_891), 0.7253, 1e-3);
  close(c('claude-fable-5', 'claude-code', 32, 495_476, 126_580, 22_534), 3.2047, 1e-3);
  close(c('gpt-6.1-terra', 'codex', 875_975, 70_302_592, 0, 118_420), 4.9832, 1e-3);
  close(c('gpt-6.1-sol', 'codex', 682_611, 32_283_392, 0, 145_597), 6.0495, 1e-3);
  close(c('gpt-6-luna', 'codex', 651_053, 16_790_144, 0, 57_624), 0.2618, 1e-3);
  close(c('gpt-6-astra', 'codex', 118_092, 2_905_088, 0, 18_990), 5.0355, 1e-3);
  close(c('grok-4.6', 'grok', 592_552, 2_069_632, 0, 93_305), 2.7798, 1e-3); // output column already includes reasoning
});

test('applyCosts modes', () => {
  const mk = () => [
    ev({ tool: 'opencode', model: 'grok-4.6', provider: 'xai', inputTokens: 100_000, recordedCostUSD: 9 }),
    ev({ tool: 'claude-code', model: 'claude-opus-5-5', outputTokens: 1_000_000 }),
    ev({ tool: 'opencode', model: 'modal/unknown-model', inputTokens: 5, recordedCostUSD: 0.25 }),
    ev({ tool: 'opencode', model: 'modal/unknown-model', inputTokens: 5 }),
  ];
  const warnings: string[] = [];
  let e = mk(); applyCosts(e, table, 'auto', (m) => warnings.push(m));
  assert.deepEqual(e.map((x) => x.costUSD), [9, 20, 0.25, 0]);
  assert.deepEqual(e.map((x) => !!x.costUnknown), [false, false, false, true]);
  assert.equal(warnings.length, 1);
  e = mk(); applyCosts(e, table, 'calculate');
  close(e[0].costUSD, 0.2); assert.equal(e[1].costUSD, 20); assert.equal(e[2].costUSD, 0.25); assert.equal(e[3].costUnknown, true);
  e = mk(); applyCosts(e, table, 'display');
  assert.deepEqual(e.map((x) => x.costUSD), [9, 0, 0.25, 0]);
  // alias warning
  const w2: string[] = [];
  applyCosts([ev({ tool: 'codex', model: 'codex-auto-review', inputTokens: 1 }), ev({ tool: 'codex', model: 'codex-auto-review', inputTokens: 1 })], table, 'auto', (m) => w2.push(m));
  assert.equal(w2.length, 1);
  assert.match(w2[0], /gpt-5\.6-luna/);
});

test('reduceLiteLLM keeps only priced chat entries and pricing fields', () => {
  const r = reduceLiteLLM({
    sample_spec: { input_cost_per_token: 0 },
    a: { mode: 'chat', litellm_provider: 'x', input_cost_per_token: 1, output_cost_per_token: 2, max_tokens: 5, supports_vision: true },
    b: { mode: 'image_generation', input_cost_per_token: 1 },
    c: { mode: 'chat' },
  });
  assert.deepEqual(r, { a: { litellm_provider: 'x', input_cost_per_token: 1, output_cost_per_token: 2 } });
});

function fakeFetch(body: unknown, status = 200, calls?: { n: number }): typeof fetch {
  return (async () => {
    if (calls) calls.n++;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

test('loadPricing: live -> cache -> embedded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clausage-pricing-'));
  try {
    const live: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) live[`m${i}`] = { mode: 'chat', input_cost_per_token: i, output_cost_per_token: i };
    live['claude-opus-5-5'] = { mode: 'chat', input_cost_per_token: 42, output_cost_per_token: 1 };
    const calls = { n: 0 };
    const t1 = await loadPricing({ cacheDir: dir, fetchImpl: fakeFetch(live, 200, calls) });
    assert.equal(t1.source, 'live');
    assert.equal(t1.lookup('claude-opus-5-5')!.input, 42);
    assert.ok(t1.lookup('gpt-6.1-terra')); // embedded merged underneath
    const cached = JSON.parse(await readFile(join(dir, 'litellm-pricing.json'), 'utf8'));
    assert.equal(cached.models.m3.input_cost_per_token, 3);

    // fresh cache: no fetch
    const t2 = await loadPricing({ cacheDir: dir, fetchImpl: fakeFetch(live, 200, calls) });
    assert.equal(t2.source, 'cache');
    assert.equal(calls.n, 1);

    // stale cache + failing fetch -> cache with warning
    cached.fetchedAt = new Date(Date.now() - 2 * 86400_000).toISOString();
    await writeFile(join(dir, 'litellm-pricing.json'), JSON.stringify(cached));
    const warns: string[] = [];
    const t3 = await loadPricing({ cacheDir: dir, fetchImpl: fakeFetch({}, 500), warn: (m) => warns.push(m) });
    assert.equal(t3.source, 'cache');
    assert.equal(warns.length, 1);

    // offline uses cache without fetching
    const t4 = await loadPricing({ cacheDir: dir, offline: true, fetchImpl: fakeFetch(live, 200, calls) });
    assert.equal(t4.source, 'cache');
    assert.equal(calls.n, 1);

    // no cache + failing fetch -> embedded
    const empty = await mkdtemp(join(tmpdir(), 'clausage-pricing-'));
    const t5 = await loadPricing({ cacheDir: empty, fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch });
    assert.equal(t5.source, 'embedded');
    assert.equal(t5.lookup('claude-opus-5-5')!.input, 4e-6);
    await rm(empty, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('service tiers: Codex priority (Fast) and flex use *_priority / *_flex rates', () => {
  const luna = table.lookup('gpt-6-luna', 'codex')!;
  assert.ok(luna.serviceTiers?.priority && luna.serviceTiers?.flex);
  const base = { tool: 'codex' as const, model: 'gpt-6-luna', inputTokens: 1000, cacheReadTokens: 10_000, outputTokens: 100 };
  close(costForEvent(ev(base), luna), 1000 * 0.1 * M + 10_000 * 0.01 * M + 100 * 0.5 * M);
  close(costForEvent(ev({ ...base, speed: 'priority' }), luna), 1000 * 0.2 * M + 10_000 * 0.02 * M + 100 * 1 * M);
  close(costForEvent(ev({ ...base, speed: 'fast' }), luna), 1000 * 0.2 * M + 10_000 * 0.02 * M + 100 * 1 * M);
  close(costForEvent(ev({ ...base, speed: 'flex' }), luna), 1000 * 0.05 * M + 10_000 * 0.005 * M + 100 * 0.25 * M);
  // priority + long context: *_above_272k_tokens_priority
  close(costForEvent(ev({ ...base, cacheReadTokens: 300_000, speed: 'priority' }), luna),
    1000 * 0.4 * M + 300_000 * 0.04 * M + 100 * 1.5 * M);
  // Claude reports the delivered speed separately from its capacity tier.
  const opus = table.lookup('claude-opus-5-5')!;
  const c = { tool: 'claude-code' as const, model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 10 };
  close(costForEvent(ev({ ...c, speed: 'fast' }), opus), 10 * (8 + 40) * M);
  close(costForEvent(ev({ ...c, speed: 'standard' }), opus), costForEvent(ev(c), opus));
});

test('Ultrafast uses model-specific input, output, cache and long-context rates offline', () => {
  for (const [model, input, output, read, write] of [
    ['gpt-6.1-sol', 12, 60, 0.6, 15], ['gpt-6-astra', 60, 300, 6, 75],
  ] as const) {
    const event = ev({ tool: 'codex', model, speed: 'ultrafast', inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5 });
    const price = table.lookup(model, 'codex')!;
    close(costForEvent(event, price), (100 * input + 10 * output + 20 * read + 5 * write) * M);
    close(costForEvent({ ...event, inputTokens: 272001 }, price),
      (272001 * input * 2 + 10 * output * 1.5 + 20 * read * 2 + 5 * write * 2) * M);
  }
});

test('Claude Fast applies cache pricing once, including on a dedicated Fast deployment', () => {
  for (const model of ['claude-opus-5-5', 'claude-opus-5-5-fast']) {
    const e = ev({ tool: 'claude-code', model, speed: 'fast', inputTokens: 10, outputTokens: 20,
      cacheReadTokens: 300000, cacheWriteTokens: 15, cacheWrite1hTokens: 5 });
    applyCosts([e], table, 'calculate');
    close(e.costUSD, (10 * 8 + 20 * 40 + 300000 * 0.4 + 10 * 10 + 5 * 16) * M);
  }
});

test('missing premium prices respect recorded cost or flag the cost as unknown', () => {
  const e = ev({ tool: 'codex', model: 'gpt-6-luna', speed: 'ultrafast', inputTokens: 1000 });
  const recorded = { ...e, recordedCostUSD: 1.25 };
  applyCosts([e, recorded], table, 'calculate');
  assert.deepEqual([e.costUSD, e.costUnknown, recorded.costUSD, recorded.costUnknown], [0, true, 1.25, false]);
});
