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
