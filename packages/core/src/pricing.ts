/**
 * Model pricing from LiteLLM's model_prices_and_context_window.json.
 *
 * Resolution order in loadPricing():
 *   1. fresh on-disk cache (< 24h) unless `refresh`
 *   2. live fetch (10s timeout) -> written to the cache
 *   3. stale cache, then the embedded snapshot (src/pricing-snapshot.json)
 * With `offline` no network request is made: cache of any age, else the embedded snapshot.
 * The embedded snapshot is always merged underneath live/cache data so keys that LiteLLM
 * later drops keep a price.
 *
 * Regenerate the snapshot with `node packages/core/scripts/update-pricing-snapshot.mjs`.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fastDeployment, usageSpeed } from './speed.js';
import snapshot from './pricing-snapshot.json' with { type: 'json' };
import type { CostMode, DailyAggregate, ModelPricing, ToolId, UsageEvent } from './types.js';

export const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const PRICING_CACHE_FILE = 'litellm-pricing.json';
export const PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/** One LiteLLM entry reduced to its numeric pricing fields (+ provider). */
export type RawPriceEntry = Record<string, number | string | undefined> & { litellm_provider?: string };
export type RawPriceTable = Record<string, RawPriceEntry>;

export type PricingSource = 'live' | 'cache' | 'embedded';

/** How a model name was resolved to a LiteLLM key. Anything but exact/normalized is an approximation. */
export type MatchKind = 'exact' | 'normalized' | 'prefixed' | 'shortened' | 'alias' | 'family';

export interface PriceResolution {
  pricing: ModelPricing;
  match: MatchKind;
}

const PRICE_FIELD =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)(_above_1hr)?(_above_\d+k_tokens)?(_priority|_ultrafast|_flex)?$/;
const TIER_FIELD =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens(_priority|_ultrafast|_flex)?$/;
const KEEP_MODES = new Set(['chat', 'responses', 'completion']);

/** Reduce a raw LiteLLM document to priced chat/responses entries with pricing fields only. */
export function reduceLiteLLM(raw: unknown): RawPriceTable {
  const out: RawPriceTable = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'sample_spec' || !v || typeof v !== 'object') continue;
    const entry = v as Record<string, unknown>;
    if (typeof entry.input_cost_per_token !== 'number') continue;
    if (typeof entry.mode === 'string' && !KEEP_MODES.has(entry.mode)) continue;
    const e: RawPriceEntry = {};
    if (typeof entry.litellm_provider === 'string') e.litellm_provider = entry.litellm_provider;
    for (const [f, val] of Object.entries(entry)) {
      if (typeof val === 'number' && Number.isFinite(val) && PRICE_FIELD.test(f)) e[f] = val;
    }
    out[key] = e;
  }
  return out;
}

function num(e: RawPriceEntry, f: string): number | undefined {
  const v = e[f];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const CLAUDE_FAST_INPUT: Record<string, number> = {
  'claude-opus-4-6': 30, 'claude-opus-4-7': 30, // historical successful Fast responses
  'claude-opus-4-8': 10, 'claude-opus-5': 10, 'claude-opus-5-5': 8,
  'claude-fable-5-2': 16, 'claude-mythos-5-2': 16,
};

/** Convert a reduced LiteLLM entry to ModelPricing. Returns null when input/output price is missing. */
export function toModelPricing(key: string, e: RawPriceEntry): ModelPricing | null {
  const input = num(e, 'input_cost_per_token');
  const output = num(e, 'output_cost_per_token');
  if (input === undefined || output === undefined) return null;
  const p: ModelPricing = { input, output, key };
  const cr = num(e, 'cache_read_input_token_cost');
  const cw = num(e, 'cache_creation_input_token_cost');
  const cw1h = num(e, 'cache_creation_input_token_cost_above_1hr');
  if (cr !== undefined) p.cacheRead = cr;
  if (cw !== undefined) p.cacheWrite = cw;
  if (cw1h !== undefined) p.cacheWrite1h = cw1h;

  const tierMaps = new Map<string, Map<number, NonNullable<ModelPricing['tiers']>[number]>>();
  for (const f of Object.keys(e)) {
    const m = TIER_FIELD.exec(f);
    if (!m) continue;
    const v = num(e, f);
    if (v === undefined) continue;
    const suffix = m[3] ?? '';
    let tiers = tierMaps.get(suffix);
    if (!tiers) tierMaps.set(suffix, (tiers = new Map()));
    const threshold = Number(m[2]) * 1000;
    const t = tiers.get(threshold) ?? { threshold };
    switch (m[1]) {
      case 'input_cost_per_token': t.input = v; break;
      case 'output_cost_per_token': t.output = v; break;
      case 'cache_read_input_token_cost': t.cacheRead = v; break;
      case 'cache_creation_input_token_cost': t.cacheWrite = v; break;
    }
    tiers.set(threshold, t);
  }
  const sortedTiers = (suffix: string) => {
    const t = tierMaps.get(suffix);
    return t && t.size ? [...t.values()].sort((a, b) => a.threshold - b.threshold) : undefined;
  };
  const baseTiers = sortedTiers('');
  if (baseTiers) p.tiers = baseTiers;

  // service-tier variants (Codex / OpenAI "priority" = Fast, "flex")
  for (const variant of ['priority', 'ultrafast', 'flex'] as const) {
    const vin = num(e, `input_cost_per_token_${variant}`);
    const vout = num(e, `output_cost_per_token_${variant}`);
    if (vin === undefined || vout === undefined) continue;
    const v: NonNullable<NonNullable<ModelPricing['serviceTiers']>['priority']> = { input: vin, output: vout };
    const vcr = num(e, `cache_read_input_token_cost_${variant}`);
    const vcw = num(e, `cache_creation_input_token_cost_${variant}`);
    if (vcr !== undefined) v.cacheRead = vcr;
    if (vcw !== undefined) v.cacheWrite = vcw;
    const vt = sortedTiers(`_${variant}`);
    if (vt) v.tiers = vt;
    (p.serviceTiers ??= {})[variant] = v;
  }
  // Anthropic publishes Fast separately from LiteLLM. These are USD per million
  // input tokens; output is 5x input and prompt caching keeps its model-specific ratio.
  // https://platform.claude.com/docs/en/build-with-claude/fast-mode
  const fastInput = CLAUDE_FAST_INPUT[stripDate(key)];
  if (e.litellm_provider === 'anthropic' && fastInput && !p.serviceTiers?.priority) {
    (p.serviceTiers ??= {}).priority = { input: fastInput / 1e6, output: fastInput * 5 / 1e6, tiers: [] };
  }
  return p;
}

/** Map an event's recorded speed / service tier to a LiteLLM service-tier variant. */
export function serviceTierOf(speed: string | undefined): 'priority' | 'ultrafast' | 'flex' | undefined {
  const s = speed?.toLowerCase();
  if (s === 'priority' || s === 'fast') return 'priority';
  if (s === 'ultrafast') return 'ultrafast';
  if (s === 'flex') return 'flex';
  return undefined;
}

/**
 * Pricing for a service tier ('priority' / 'flex'); the base pricing when the model has no such
 * variant. Rates the variant lacks are the base rates scaled by the variant's input ratio.
 */
export function pricingForServiceTier(p: ModelPricing, tier: 'priority' | 'ultrafast' | 'flex' | undefined): ModelPricing {
  const v = tier ? p.serviceTiers?.[tier] : undefined;
  if (!v) return p;
  const r = p.input > 0 ? v.input / p.input : 1;
  const scaled = (x: number | undefined) => (x === undefined ? undefined : x * r);
  const out: ModelPricing = { key: p.key, input: v.input, output: v.output };
  const cr = v.cacheRead ?? scaled(p.cacheRead);
  const cw = v.cacheWrite ?? scaled(p.cacheWrite);
  const cw1h = scaled(p.cacheWrite1h);
  if (cr !== undefined) out.cacheRead = cr;
  if (cw !== undefined) out.cacheWrite = cw;
  if (cw1h !== undefined) out.cacheWrite1h = cw1h;
  const tiers = v.tiers ?? p.tiers?.map((t) => ({
    threshold: t.threshold,
    ...(t.input !== undefined ? { input: t.input * r } : {}),
    ...(t.output !== undefined ? { output: t.output * r } : {}),
    ...(t.cacheRead !== undefined ? { cacheRead: t.cacheRead * r } : {}),
    ...(t.cacheWrite !== undefined ? { cacheWrite: t.cacheWrite * r } : {}),
  }));
  if (tiers && tiers.length) out.tiers = tiers;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Model name normalisation & aliases
// ---------------------------------------------------------------------------------------------

/** Provider prefixes that tools put in front of model ids; LiteLLM keys for these are unprefixed or use their own prefix. */
const STRIP_PREFIXES = [
  'anthropic/', 'openai/', 'xai/', 'x-ai/', 'google/', 'gemini/', 'deepseek/', 'mistral/', 'mistralai/',
  'moonshot/', 'moonshotai/', 'zai/', 'z-ai/', 'zhipuai/', 'dashscope/', 'alibaba/', 'qwen/', 'groq/',
  'openrouter/', 'vertex_ai/', 'bedrock/', 'opencode/', 'github-copilot/', 'azure/',
];

/** LiteLLM key prefixes to try for a provider id (as written by OpenCode `providerID` etc.). */
const PROVIDER_KEY_PREFIXES: Record<string, string[]> = {
  anthropic: [''],
  openai: ['', 'openai/'],
  xai: ['xai/'],
  'x-ai': ['xai/'],
  deepseek: ['deepseek/', ''],
  google: ['gemini/', ''],
  gemini: ['gemini/', ''],
  'google-vertex': ['', 'gemini/'],
  mistral: ['mistral/'],
  moonshot: ['moonshot/'],
  moonshotai: ['moonshot/'],
  zai: ['zai/'],
  'z-ai': ['zai/'],
  zhipuai: ['zai/'],
  dashscope: ['dashscope/'],
  alibaba: ['dashscope/'],
  groq: ['groq/'],
  openrouter: ['openrouter/'],
};

const TOOL_KEY_PREFIXES: Record<ToolId, string[]> = {
  'claude-code': [''],
  codex: ['', 'openai/'],
  grok: ['xai/'],
  opencode: [],
  // multi-provider agents: rely on the event's provider and the generic fallbacks
  hermes: [],
  openclaw: [],
  pi: [],
  gemini: ['gemini/', 'vertex_ai/'],
  amp: [''],
  qwen: ['', 'dashscope/'],
  copilot: [],
  aider: [],
};

/** Every prefix tried as a last resort, in order. */
const GENERIC_PREFIXES = ['', 'xai/', 'openai/', 'deepseek/', 'gemini/', 'mistral/', 'moonshot/', 'zai/', 'dashscope/', 'openrouter/'];

const CODEX_AUTO_REVIEW_LUNA_FROM = Date.UTC(2026, 6, 30); // 2026-07-30

/**
 * Models absent from LiteLLM. Values are LiteLLM keys (or names that resolve to one).
 * codex-auto-review follows ccusage's timeline: gpt-5.4 for 2026-03-05..2026-07-29 (and earlier),
 * gpt-5.6-luna from 2026-07-30 onward. Without a timestamp the current mapping is used.
 */
const ALIASES: Partial<Record<string, (at?: number) => string>> = {
  'codex-auto-review': (at) => (at !== undefined && at < CODEX_AUTO_REVIEW_LUNA_FROM ? 'gpt-5.4' : 'gpt-5.6-luna'),
  'gpt-reserve': () => 'gpt-5.6-luna',
  // Claude Code model aliases that occasionally appear verbatim
  opus: () => 'claude-opus*',
  sonnet: () => 'claude-sonnet*',
  haiku: () => 'claude-haiku*',
  fable: () => 'claude-fable*',
};

/** Lowercase and strip decorations that never appear in LiteLLM keys. */
export function normalizeModelName(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.replace(/\[[^\]]*\]$/, ''); // claude-opus-4-6[1m]
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of STRIP_PREFIXES) {
      if (m.startsWith(p)) { m = m.slice(p.length); changed = true; }
    }
  }
  m = m.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, ''); // us.anthropic.claude-...
  m = m.replace(/-v\d+:\d+$/, ''); // bedrock -v1:0
  m = m.replace(/@.*$/, ''); // vertex claude-opus-4-6@default / @20250514
  m = m.replace(/-build$/, '');
  return m;
}

function stripDate(m: string): string {
  return m.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
}

function dateSuffix(m: string): string | undefined {
  const r = /-(\d{8})$/.exec(m);
  return r ? r[1] : undefined;
}

function claudeFamily(m: string): { family: string; version: number[] } | null {
  const r = /^claude-(opus|sonnet|haiku|fable|mythos)(?:-([\d.-]+))?/.exec(m);
  if (!r) return null;
  const version = (r[2] ?? '')
    .split(/[-.]/)
    .filter((s) => /^\d{1,2}$/.test(s))
    .map(Number);
  return { family: r[1], version };
}

function cmpVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// PricingTable
// ---------------------------------------------------------------------------------------------

export interface PricingSnapshot {
  raw: RawPriceTable;
  source: PricingSource;
  fetchedAt?: string;
}

export class PricingTable {
  readonly source: PricingSource;
  /** ISO time the data was fetched (live/cache), if known */
  readonly fetchedAt?: string;
  private readonly entries = new Map<string, ModelPricing>();
  private readonly memo = new Map<string, PriceResolution | null>();
  private readonly raw: RawPriceTable;

  constructor(raw: RawPriceTable, source: PricingSource, fetchedAt?: string) {
    this.raw = raw;
    this.source = source;
    this.fetchedAt = fetchedAt;
    for (const [key, e] of Object.entries(raw)) {
      const p = toModelPricing(key, e);
      if (p) this.entries.set(key.toLowerCase(), p);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Plain data that rebuilds this table with PricingTable.fromSnapshot (e.g. across a worker boundary). */
  toSnapshot(): PricingSnapshot {
    return { raw: this.raw, source: this.source, fetchedAt: this.fetchedAt };
  }

  static fromSnapshot(s: PricingSnapshot): PricingTable {
    return new PricingTable(s.raw, s.source, s.fetchedAt);
  }

  has(key: string): boolean {
    return this.entries.has(key.toLowerCase());
  }

  /** Price for a model, or null. `at` (epoch ms) selects time-dependent aliases such as codex-auto-review. */
  lookup(model: string, tool?: ToolId, provider?: string, at?: number): ModelPricing | null {
    return this.resolve(model, tool, provider, at)?.pricing ?? null;
  }

  /** Like lookup() but also says how the match was made (for fallback warnings). */
  resolve(model: string, tool?: ToolId, provider?: string, at?: number): PriceResolution | null {
    const norm = normalizeModelName(model ?? '');
    const aliasFn = ALIASES[norm];
    const atKey = aliasFn && at !== undefined ? String(aliasFn(at)) : '';
    const memoKey = `${tool ?? ''}|${provider ?? ''}|${model}|${atKey}`;
    if (this.memo.has(memoKey)) return this.memo.get(memoKey)!;
    const r = this.resolveUncached(model ?? '', norm, tool, provider, at);
    this.memo.set(memoKey, r);
    return r;
  }

  private get(key: string): ModelPricing | undefined {
    return this.entries.get(key.toLowerCase());
  }

  private prefixesFor(tool?: ToolId, provider?: string): string[] {
    const list: string[] = [];
    const prov = provider?.toLowerCase();
    if (prov) list.push(...(PROVIDER_KEY_PREFIXES[prov] ?? [`${prov}/`]));
    if (tool) list.push(...TOOL_KEY_PREFIXES[tool]);
    list.push(...GENERIC_PREFIXES);
    return [...new Set(list)];
  }

  /** Try a bare (normalised) name with every candidate prefix and Claude provider-specific spellings. */
  private tryName(name: string, prefixes: string[]): ModelPricing | undefined {
    if (!name) return undefined;
    for (const p of prefixes) {
      const hit = this.get(p + name);
      if (hit) return hit;
    }
    if (name.startsWith('claude-')) {
      // OpenRouter / Copilot style dots: claude-sonnet-4.5 -> claude-sonnet-4-5
      const dashed = name.replace(/(\d)\.(\d)/g, '$1-$2');
      if (dashed !== name) {
        const hit = this.tryName(dashed, prefixes);
        if (hit) return hit;
      }
      // retired Claude models only exist as Bedrock / Vertex keys
      for (const v of ['-v1:0', '-v2:0']) {
        const hit = this.get(`anthropic.${name}${v}`);
        if (hit) return hit;
      }
      const date = dateSuffix(name);
      const base = stripDate(name);
      // dated names only match the dated Vertex key; the undated retry (resolveUncached) covers the rest
      const hit = this.get(date ? `vertex_ai/${base}@${date}` : `vertex_ai/${name}`);
      if (hit) return hit;
    }
    return undefined;
  }

  private resolveUncached(
    model: string,
    norm: string,
    tool?: ToolId,
    provider?: string,
    at?: number,
  ): PriceResolution | null {
    const exact = this.get(model.trim());
    if (exact) return { pricing: exact, match: 'exact' };

    const prefixes = this.prefixesFor(tool, provider);
    const direct = this.tryName(norm, prefixes);
    if (direct) return { pricing: direct, match: direct.key.toLowerCase() === norm ? 'normalized' : 'prefixed' };

    if (fastDeployment(norm)) {
      const deployment = this.get(`azure_ai/${norm}`);
      if (deployment) return { pricing: deployment, match: 'prefixed' };
    }

    const undated = stripDate(norm);
    if (undated !== norm) {
      const hit = this.tryName(undated, prefixes);
      if (hit) return { pricing: hit, match: 'normalized' };
    }

    // tool-specific defaults: Codex logs without a model are gpt-5 (ccusage behaviour)
    if (!norm && tool === 'codex') {
      const hit = this.get('gpt-5');
      if (hit) return { pricing: hit, match: 'alias' };
    }

    const alias = ALIASES[undated];
    if (alias) {
      const target = alias(at);
      const hit = target.endsWith('*') ? this.latestClaude(target.slice(7, -1)) : this.tryName(target, prefixes);
      if (hit) return { pricing: hit, match: 'alias' };
    }

    // progressively shorter: claude-opus-5-5-fast -> claude-opus-5-5, gpt-6.1-terra-codex -> gpt-6.1-terra
    let short = undated;
    while (short.includes('-')) {
      short = short.slice(0, short.lastIndexOf('-'));
      if (!/\d/.test(short) || short.length < 4) break;
      const hit = this.tryName(short, prefixes);
      if (hit) return { pricing: hit, match: 'shortened' };
    }

    // Claude family fallback: closest known version <= requested, else the newest of the family
    const fam = claudeFamily(undated);
    if (fam) {
      const hit = this.latestClaude(fam.family, fam.version.length ? fam.version : undefined);
      if (hit) return { pricing: hit, match: 'family' };
    }
    return null;
  }

  private latestClaude(family: string, notAbove?: number[]): ModelPricing | undefined {
    let best: { v: number[]; p: ModelPricing } | undefined;
    let bestBelow: { v: number[]; p: ModelPricing } | undefined;
    const re = new RegExp(`^claude-${family}-(\\d{1,2}(?:-\\d{1,2})*)$`);
    for (const [key, p] of this.entries) {
      const m = re.exec(key);
      if (!m) continue;
      const v = m[1].split('-').map(Number);
      if (!best || cmpVersion(v, best.v) > 0) best = { v, p };
      if (notAbove && cmpVersion(v, notAbove) <= 0 && (!bestBelow || cmpVersion(v, bestBelow.v) > 0)) bestBelow = { v, p };
    }
    return (bestBelow ?? best)?.p;
  }
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

export interface LoadPricingOptions {
  offline?: boolean;
  refresh?: boolean;
  warn?: (m: string) => void;
  /** directory holding litellm-pricing.json; default (XDG_CACHE_HOME or ~/.cache)/clausage */
  cacheDir?: string;
  /** override the fetch URL (tests) */
  url?: string;
  /** override fetch (tests) */
  fetchImpl?: typeof fetch;
}

interface CacheFile {
  fetchedAt: string;
  url: string;
  models: RawPriceTable;
}

export function defaultPricingCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.cache'), 'clausage');
}

export function embeddedSnapshot(): RawPriceTable {
  return snapshot as unknown as RawPriceTable;
}

async function readCache(file: string): Promise<CacheFile | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<CacheFile>;
    if (!parsed || typeof parsed.fetchedAt !== 'string' || !parsed.models || typeof parsed.models !== 'object') return null;
    if (Object.keys(parsed.models).length < 50) return null;
    return parsed as CacheFile;
  } catch {
    return null;
  }
}

async function writeCache(dir: string, file: string, data: CacheFile): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

function merged(primary: RawPriceTable): RawPriceTable {
  const embedded = embeddedSnapshot();
  const result = { ...embedded, ...primary };
  // Older on-disk caches were reduced without Ultrafast fields.
  for (const [key, entry] of Object.entries(primary)) {
    if (entry.input_cost_per_token_ultrafast !== undefined || !embedded[key]?.input_cost_per_token_ultrafast) continue;
    const ultra = Object.fromEntries(Object.entries(embedded[key]!).filter(([f]) => f.endsWith('_ultrafast')));
    result[key] = { ...ultra, ...entry };
  }
  return result;
}

export async function loadPricing(opts: LoadPricingOptions = {}): Promise<PricingTable> {
  const warn = opts.warn ?? (() => {});
  const dir = opts.cacheDir ?? defaultPricingCacheDir();
  const file = join(dir, PRICING_CACHE_FILE);
  const url = opts.url ?? LITELLM_PRICING_URL;
  const cache = await readCache(file);

  if (opts.offline) {
    if (cache) return new PricingTable(merged(cache.models), 'cache', cache.fetchedAt);
    return new PricingTable(embeddedSnapshot(), 'embedded');
  }

  if (cache && !opts.refresh) {
    const age = Date.now() - Date.parse(cache.fetchedAt);
    if (Number.isFinite(age) && age >= 0 && age < PRICING_CACHE_TTL_MS) {
      return new PricingTable(merged(cache.models), 'cache', cache.fetchedAt);
    }
  }

  try {
    const f = opts.fetchImpl ?? fetch;
    const res = await f(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const models = reduceLiteLLM(await res.json());
    if (Object.keys(models).length < 50) throw new Error('unexpectedly small pricing document');
    const fetchedAt = new Date().toISOString();
    try {
      await writeCache(dir, file, { fetchedAt, url, models });
    } catch (e) {
      warn(`Could not write pricing cache ${file}: ${(e as Error).message}`);
    }
    return new PricingTable(merged(models), 'live', fetchedAt);
  } catch (e) {
    const reason = (e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message;
    if (cache) {
      warn(`Could not fetch LiteLLM pricing (${reason}); using cached prices from ${cache.fetchedAt}`);
      return new PricingTable(merged(cache.models), 'cache', cache.fetchedAt);
    }
    warn(`Could not fetch LiteLLM pricing (${reason}); using embedded snapshot`);
    return new PricingTable(embeddedSnapshot(), 'embedded');
  }
}

// ---------------------------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------------------------

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** subset of cacheWriteTokens billed at the 1h rate */
  cacheWrite1hTokens?: number;
}

const n = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Cost in USD for a token bundle.
 * - prompt = input + cacheRead + cacheWrite; when `applyTiers` and prompt exceeds a tier threshold, the
 *   WHOLE request is billed at the highest such tier's rates (fields the tier lacks fall back to base).
 * - cacheRead missing -> input rate; cacheWrite missing -> input rate.
 * - 1h cache writes: cache_creation_input_token_cost_above_1hr, else 2x input (scaled by the tier's
 *   input/base-input ratio when a tier is active).
 * - outputTokens already include reasoning (parsers normalise this).
 */
export function costForTokens(t: TokenCounts, p: ModelPricing, opts: { applyTiers?: boolean } = {}): number {
  const input = n(t.inputTokens);
  const output = n(t.outputTokens);
  const cacheRead = n(t.cacheReadTokens);
  const cacheWrite = n(t.cacheWriteTokens);
  const cacheWrite1h = Math.min(n(t.cacheWrite1hTokens), cacheWrite);
  const prompt = input + cacheRead + cacheWrite;

  let tier: NonNullable<ModelPricing['tiers']>[number] | undefined;
  if (opts.applyTiers !== false && p.tiers) {
    for (const tr of p.tiers) if (tr.threshold < prompt && (!tier || tr.threshold > tier.threshold)) tier = tr;
  }

  const inRate = tier?.input ?? p.input;
  const outRate = tier?.output ?? p.output;
  const crRate = tier?.cacheRead ?? p.cacheRead ?? inRate;
  const cwRate = tier?.cacheWrite ?? p.cacheWrite ?? inRate;
  const scale = tier?.input !== undefined && p.input > 0 ? tier.input / p.input : 1;
  const cw1hRate = p.cacheWrite1h !== undefined ? p.cacheWrite1h * scale : inRate * 2;

  return (
    input * inRate +
    output * outRate +
    cacheRead * crRate +
    (cacheWrite - cacheWrite1h) * cwRate +
    cacheWrite1h * cw1hRate
  );
}

/** Resolve the actual mode price, leaving an unpriced premium mode unknown. */
export function usagePricing(p: ModelPricing, model: string, speed?: string): ModelPricing | null {
  const tier = serviceTierOf(usageSpeed(model, speed));
  if (tier === 'priority' && fastDeployment(p.key)) return p; // already priced as Fast
  if ((tier === 'priority' || tier === 'ultrafast') && !p.serviceTiers?.[tier]) return null;
  return pricingForServiceTier(p, tier);
}

/**
 * Cost of one event at the given pricing.
 * Uses the recorded mode; a premium tier without a price contributes zero to calculated totals.
 * Tiers are NOT applied to Grok events: a Grok event is a whole turn summed over many model calls
 * (modelCalls/numTurns), so its prompt total is far larger than any single request's and would wrongly
 * trip the 200k long-context tier. Grok records its own invoice cost (costUsdTicks) anyway.
 */
export function costForEvent(e: UsageEvent, p: ModelPricing): number {
  const price = usagePricing(p, e.model, e.speed);
  return price ? costForTokens(e, price, { applyTiers: e.tool !== 'grok' }) : 0;
}

/**
 * Cost of a historical aggregate (e.g. Claude stats-cache). Never tiered, because the token counts
 * are sums over many requests. Cache writes are billed at the 5m rate (no 1h split is stored).
 */
export function costForAggregate(a: DailyAggregate, table: PricingTable): { costUSD: number; pricing: ModelPricing | null } {
  const pricing = table.lookup(a.model, a.tool);
  return { costUSD: pricing ? costForTokens(a, pricing, { applyTiers: false }) : 0, pricing };
}

const hasRecorded = (e: UsageEvent): e is UsageEvent & { recordedCostUSD: number } =>
  typeof e.recordedCostUSD === 'number' && Number.isFinite(e.recordedCostUSD);

/**
 * Fill costUSD / costUnknown on every event.
 * - auto: recordedCostUSD when present, else calculated
 * - calculate: always calculated; falls back to recordedCostUSD when no price is known
 * - display: recordedCostUSD only, 0 when absent
 * Warns once per unpriced model and once per model priced through an alias / approximation.
 */
export function applyCosts(
  events: UsageEvent[],
  table: PricingTable,
  mode: CostMode,
  warn?: (m: string) => void,
): void {
  const warned = new Set<string>();
  const once = (key: string, msg: string) => {
    if (warn && !warned.has(key)) {
      warned.add(key);
      warn(msg);
    }
  };

  for (const e of events) {
    const recorded = hasRecorded(e) ? e.recordedCostUSD : undefined;
    if (mode === 'display' || (mode === 'auto' && recorded !== undefined)) {
      e.costUSD = recorded ?? 0;
      e.costUnknown = false;
      continue;
    }
    const r = table.resolve(e.model, e.tool, e.provider, e.timestamp);
    const price = r && usagePricing(r.pricing, e.model, e.speed);
    if (r && price) {
      e.costUSD = costForTokens(e, price, { applyTiers: e.tool !== 'grok' });
      e.costUnknown = false;
      if (r.match === 'alias' || r.match === 'family' || r.match === 'shortened') {
        once(`fb|${e.tool}|${e.model}|${r.pricing.key}`, `No exact price for ${e.model || '(unknown model)'} (${e.tool}); priced as ${r.pricing.key}`);
      }
    } else if (recorded !== undefined) {
      e.costUSD = recorded;
      e.costUnknown = false;
    } else {
      e.costUSD = 0;
      e.costUnknown = true;
      const mode = usageSpeed(e.model, e.speed);
      once(`nf|${e.tool}|${e.model}|${mode ?? ''}`, `No price for model ${e.model || '(unknown model)'} (${e.tool}${mode ? ', ' + mode : ''}); cost counted as $0`);
    }
  }
}
