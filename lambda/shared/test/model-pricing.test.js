import { describe, it, expect } from 'vitest';
import {
  modelFamily,
  makePriceResolver,
  costForMetrics,
  parsePriceList,
  refreshPricing,
  FALLBACK_PRICES,
} from '../model-pricing.js';

describe('modelFamily', () => {
  it('normalizes region-prefixed Bedrock inference-profile ids', () => {
    expect(modelFamily('us.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(modelFamily('eu.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(modelFamily('anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6');
    expect(modelFamily('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('claude-haiku-4-5');
    expect(modelFamily('amazon-bedrock/us.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('does not coin a Bedrock family from a Kiro namespace id', () => {
    // Kiro keeps its dotted version — never collides with a Bedrock family.
    expect(modelFamily('claude-opus-4.6')).toBe('claude-opus-4.6');
    expect(modelFamily('auto')).toBe('auto');
    expect(modelFamily(null)).toBeNull();
  });

  it('keeps OpenAI global and in-region pricing families distinct', () => {
    expect(modelFamily('openai.gpt-5.6-sol')).toBe('openai.gpt-5.6-sol');
    expect(modelFamily('global.openai.gpt-5.6-sol')).toBe('global.openai.gpt-5.6-sol');
    expect(modelFamily('us.openai.gpt-5.6-sol')).toBe('us.openai.gpt-5.6-sol');
    expect(modelFamily('eu.openai.gpt-5.6-sol')).toBe('eu.openai.gpt-5.6-sol');
  });
});

describe('makePriceResolver', () => {
  it('prices a known family from the static fallback', () => {
    const priceFor = makePriceResolver();
    const p = priceFor('us.anthropic.claude-sonnet-4-6');
    expect(p.priced).toBe(true);
    expect(p.inputPerToken).toBeCloseTo(3 / 1_000_000);
    expect(p.outputPerToken).toBeCloseTo(15 / 1_000_000);
  });

  it('reports Kiro / unknown ids as unpriced (not $0)', () => {
    const priceFor = makePriceResolver();
    expect(priceFor('claude-opus-4.6').priced).toBe(false);
    expect(priceFor('some-future-model').priced).toBe(false);
  });

  it('lets a fetched table override the fallback', () => {
    const priceFor = makePriceResolver({ 'claude-sonnet-4-6': { input: 4, output: 20 } });
    expect(priceFor('us.anthropic.claude-sonnet-4-6').inputPerToken).toBeCloseTo(4 / 1_000_000);
  });

  it('preserves fallback cache metadata when refreshed token rates override a family', () => {
    const priceFor = makePriceResolver({
      'openai.gpt-5.6-sol': { input: 4.2, output: 21 },
    });
    const p = priceFor('openai.gpt-5.6-sol');
    expect(p.inputPerToken).toBeCloseTo(4.2 / 1_000_000);
    expect(p.outputPerToken).toBeCloseTo(21 / 1_000_000);
    expect(p.cacheWritePerToken).toBeCloseTo(5.5 / 1_000_000);
    expect(p.cacheReadPerToken).toBeCloseTo(0.44 / 1_000_000);
    expect(p.inputIncludesCache).toBe(true);
    expect(p.longContextThreshold).toBe(272_000);
    expect(p.longInputPerToken).toBeCloseTo(8.8 / 1_000_000);
  });

  it('does not price an unsupported OpenAI regional profile as global inference', () => {
    expect(makePriceResolver()('eu.openai.gpt-5.6-sol').priced).toBe(false);
    expect(makePriceResolver()('us.openai.gpt-5.6-sol').priced).toBe(false);
    expect(makePriceResolver()('global.openai.gpt-5.6-sol').priced).toBe(false);
  });

  it('exposes the published OpenAI cache rates from the static fallback', () => {
    const priceFor = makePriceResolver();
    const global = priceFor('openai.gpt-5.6-sol');
    expect(global.priced).toBe(true);
    expect(global.inputIncludesCache).toBe(true);
    expect(global.inputPerToken).toBeCloseTo(4.4 / 1_000_000);
    expect(global.outputPerToken).toBeCloseTo(22 / 1_000_000);
    expect(global.cacheWritePerToken).toBeCloseTo(5.5 / 1_000_000);
    expect(global.cacheReadPerToken).toBeCloseTo(0.44 / 1_000_000);
    expect(global.longInputPerToken).toBeCloseTo(8.8 / 1_000_000);
    expect(global.longOutputPerToken).toBeCloseTo(33 / 1_000_000);
  });
});

describe('costForMetrics', () => {
  it('computes input+output cost for a priced model', () => {
    const c = costForMetrics(
      { tokensInput: 1_000_000, tokensOutput: 1_000_000, contextWindowPct: 40 },
      'us.anthropic.claude-sonnet-4-6',
    );
    expect(c.inputCost).toBeCloseTo(3);
    expect(c.outputCost).toBeCloseTo(15);
    expect(c.totalCost).toBeCloseTo(18);
    expect(c.priced).toBe(true);
  });

  it('returns a stable unpriced shape for a Kiro run', () => {
    const c = costForMetrics({ tokensInput: 500 }, 'claude-opus-4.6');
    expect(c.priced).toBe(false);
    expect(c.totalCost).toBe(0);
    expect(c.currency).toBe('USD');
    expect(c.estimated).toBe(false);
  });

  it('prices a Kiro credits sample at the stamped $/credit rate as an estimate', () => {
    const c = costForMetrics({ credits: 12.5 }, 'claude-opus-4.6', undefined, 0.04);
    expect(c.priced).toBe(true);
    expect(c.estimated).toBe(true);
    expect(c.creditCost).toBeCloseTo(0.5);
    expect(c.totalCost).toBeCloseTo(0.5);
  });

  it('reports a credits sample without a rate as unpriced (never a guessed $)', () => {
    const c = costForMetrics({ credits: 12.5 }, 'claude-opus-4.6');
    expect(c.priced).toBe(false);
    expect(c.estimated).toBe(false);
    expect(c.totalCost).toBe(0);
  });

  it('ignores a rate when the sample has no credits (token pricing unchanged)', () => {
    const c = costForMetrics(
      { tokensInput: 1_000_000 },
      'us.anthropic.claude-sonnet-4-6',
      undefined,
      0.04,
    );
    expect(c.priced).toBe(true);
    expect(c.estimated).toBe(false);
    expect(c.totalCost).toBeCloseTo(3);
  });

  it('prices OpenAI input, cache write, cache read, and output separately', () => {
    const c = costForMetrics(
      {
        tokensInput: 263_946,
        tokensCacheRead: 224_278,
        tokensCacheWrite: 39_654,
        tokensOutput: 739,
      },
      'openai.gpt-5.6-sol',
    );
    // input_tokens includes both cache categories for Codex. Only 14 tokens are
    // ordinary input; the rest use the published cache rates.
    expect(c.inputCost).toBeCloseTo((14 * 4.4) / 1_000_000);
    expect(c.cacheWriteCost).toBeCloseTo((39_654 * 5.5) / 1_000_000);
    expect(c.cacheReadCost).toBeCloseTo((224_278 * 0.44) / 1_000_000);
    expect(c.outputCost).toBeCloseTo((739 * 22) / 1_000_000);
    expect(c.totalCost).toBeCloseTo(0.33309892);
    expect(c.priced).toBe(true);
    expect(c.longContext).toBe(false);
  });

  it('uses the GPT-5.6-Sol long-context tier above 272K input tokens', () => {
    const c = costForMetrics(
      {
        tokensInput: 300_000,
        tokensCacheRead: 200_000,
        tokensCacheWrite: 50_000,
        tokensOutput: 10_000,
      },
      'openai.gpt-5.6-sol',
    );
    expect(c.inputCost).toBeCloseTo((50_000 * 8.8) / 1_000_000);
    expect(c.cacheWriteCost).toBeCloseTo((50_000 * 11) / 1_000_000);
    expect(c.cacheReadCost).toBeCloseTo((200_000 * 0.88) / 1_000_000);
    expect(c.outputCost).toBeCloseTo((10_000 * 33) / 1_000_000);
    expect(c.totalCost).toBeCloseTo(1.496);
    expect(c.longContext).toBe(true);
    expect(c.priced).toBe(true);
  });

  it('keeps the short-context tier at exactly 272K input tokens', () => {
    const c = costForMetrics({ tokensInput: 272_000, tokensOutput: 1_000 }, 'openai.gpt-5.6-sol');
    expect(c.inputCost).toBeCloseTo((272_000 * 4.4) / 1_000_000);
    expect(c.outputCost).toBeCloseTo((1_000 * 22) / 1_000_000);
    expect(c.longContext).toBe(false);
  });

  it('preserves legacy token pricing for families without cache-specific rates', () => {
    const c = costForMetrics(
      { tokensInput: 1_000_000, tokensCacheRead: 900_000 },
      'us.anthropic.claude-sonnet-4-6',
    );
    expect(c.inputCost).toBeCloseTo(3);
    expect(c.cacheReadCost).toBe(0);
    expect(c.totalCost).toBeCloseTo(3);
  });
});

describe('parsePriceList', () => {
  const skus = [
    {
      product: { attributes: { model: 'Claude Sonnet 4.6', usagetype: 'InputTokenCount' } },
      terms: {
        OnDemand: { t1: { priceDimensions: { d1: { pricePerUnit: { USD: '0.000003' } } } } },
      },
    },
    {
      product: { attributes: { model: 'Claude Sonnet 4.6', usagetype: 'OutputTokenCount' } },
      terms: {
        OnDemand: { t1: { priceDimensions: { d1: { pricePerUnit: { USD: '0.000015' } } } } },
      },
    },
    // Half-populated family (input only) — must be dropped, not mispriced.
    {
      product: { attributes: { model: 'Claude Opus 4.6', usagetype: 'InputTokenCount' } },
      terms: {
        OnDemand: { t1: { priceDimensions: { d1: { pricePerUnit: { USD: '0.000005' } } } } },
      },
    },
    // Non-Claude noise.
    { product: { attributes: { model: 'Titan Text', usagetype: 'InputTokenCount' } }, terms: {} },
  ];

  it('extracts complete Claude families and drops incomplete/non-Claude rows', () => {
    const table = parsePriceList(skus);
    expect(table['claude-sonnet-4-6']).toEqual({ input: 3, output: 15 });
    expect(table['claude-opus-4-6']).toBeUndefined();
  });

  it('tolerates JSON-string products and malformed rows', () => {
    const table = parsePriceList([JSON.stringify(skus[0]), JSON.stringify(skus[1]), 'not json']);
    expect(table['claude-sonnet-4-6']).toEqual({ input: 3, output: 15 });
  });
});

describe('refreshPricing', () => {
  it('merges fetched prices over the fallback seed', async () => {
    const table = await refreshPricing({
      getProducts: async () => [
        {
          product: { attributes: { model: 'Claude Sonnet 4.6', usagetype: 'InputTokenCount' } },
          terms: {
            OnDemand: { t: { priceDimensions: { d: { pricePerUnit: { USD: '0.000004' } } } } },
          },
        },
        {
          product: { attributes: { model: 'Claude Sonnet 4.6', usagetype: 'OutputTokenCount' } },
          terms: {
            OnDemand: { t: { priceDimensions: { d: { pricePerUnit: { USD: '0.000020' } } } } },
          },
        },
      ],
    });
    expect(table['claude-sonnet-4-6']).toEqual({ input: 4, output: 20 });
    // Untouched families keep the seed.
    expect(table['claude-opus-4-8']).toEqual(FALLBACK_PRICES['claude-opus-4-8']);
  });

  it('falls back to the seed when the fetch throws or is absent', async () => {
    expect(await refreshPricing()).toEqual(FALLBACK_PRICES);
    expect(
      await refreshPricing({
        getProducts: async () => {
          throw new Error('no endpoint');
        },
      }),
    ).toEqual(FALLBACK_PRICES);
  });
});
