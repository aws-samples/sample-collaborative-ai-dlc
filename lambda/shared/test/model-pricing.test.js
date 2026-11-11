import { describe, it, expect } from 'vitest';
import {
  modelFamily,
  makePriceResolver,
  costForMetrics,
  parsePriceList,
  refreshPricing,
  FALLBACK_PRICES,
} from '../model-pricing.js';
import { CODEX_BEDROCK_MODELS, listCodexModels, codexModelsFor } from '../bedrock-models.js';

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

  it('keeps Codex Mantle ids exact and geo-prefixed OpenAI ids distinct', () => {
    expect(modelFamily('openai.gpt-5.6-sol')).toBe('openai.gpt-5.6-sol');
    expect(modelFamily('global.openai.gpt-5.6-sol')).toBe('global.openai.gpt-5.6-sol');
  });

  it('maps a dated OpenAI snapshot id to its model', () => {
    expect(modelFamily('openai.gpt-5.4-2026-03-05')).toBe('openai.gpt-5.4');
    expect(modelFamily('openai.gpt-5.5-2026-04-23')).toBe('openai.gpt-5.5');
    // Not a snapshot date, and not a bare Mantle id.
    expect(modelFamily('openai.gpt-oss-120b')).toBe('openai.gpt-oss-120b');
    expect(modelFamily('us.openai.gpt-5.5-2026-04-23')).toBe('us.openai.gpt-5.5-2026-04-23');
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
  it.each([
    ['global.anthropic.claude-sonnet-5', 2],
    ['us.anthropic.claude-sonnet-5', 2.2],
    ['amazon-bedrock/eu.anthropic.claude-sonnet-5', 2.2],
  ])('prices cache reads and mixed-TTL writes using %s input rates', (model, inputRate) => {
    const c = costForMetrics(
      {
        tokensInput: 1_000_000,
        tokensOutput: 1_000_000,
        tokensCacheRead: 2_000_000,
        tokensCacheWrite: 1_000_000,
        tokensCacheWrite1h: 400_000,
      },
      model,
    );
    expect(c.inputCost).toBeCloseTo(inputRate * (1 + 2 * 0.1 + 0.6 * 1.25 + 0.4 * 2));
    expect(c.outputCost).toBeCloseTo(inputRate * 5);
    expect(c.totalCost).toBeCloseTo(c.inputCost + c.outputCost);
    expect(c.priced).toBe(true);
  });

  it('uses refreshed input rates and the default five-minute write price', () => {
    const resolver = makePriceResolver({ 'claude-sonnet-4-6': { input: 4, output: 20 } });
    const c = costForMetrics(
      { tokensCacheRead: 1_000_000, tokensCacheWrite: 1_000_000 },
      'us.anthropic.claude-sonnet-4-6',
      resolver,
    );
    expect(c.inputCost).toBeCloseTo(0.4 + 5);
    expect(c.priced).toBe(true);
  });

  it('does not invent cache prices for a non-Claude model', () => {
    const resolver = makePriceResolver({ 'openai.gpt-5.5': { input: 1, output: 2 } });
    const c = costForMetrics({ tokensCacheRead: 1000 }, 'openai.gpt-5.5', resolver);
    expect(c.priced).toBe(false);
  });

  it('prices Codex usage whose input total includes cache reads and writes', () => {
    // Codex input 1M = 0.5M uncached + 0.3M cache read + 0.2M cache write;
    // output 0.1M already includes the 0.04M reasoning tokens.
    const c = costForMetrics(
      {
        tokensInput: 1_000_000,
        tokensCacheRead: 300_000,
        tokensCacheWrite: 200_000,
        tokensOutput: 100_000,
        tokensReasoning: 40_000,
      },
      'openai.gpt-5.6-sol',
    );
    expect(c.inputCost).toBeCloseTo(0.5 * 4.4 + 0.3 * 0.44 + 0.2 * 5.5);
    expect(c.outputCost).toBeCloseTo(0.1 * 22);
    expect(c.priced).toBe(true);
  });

  it('bills GPT-5.5 cache writes at the input rate', () => {
    const c = costForMetrics(
      { tokensInput: 1_000_000, tokensCacheWrite: 1_000_000 },
      'openai.gpt-5.5',
    );
    expect(c.inputCost).toBeCloseTo(5.5);
    expect(c.priced).toBe(true);
  });

  it('prices GPT-5.4, which has no cache-write fee, at its In-Region rates', () => {
    const c = costForMetrics(
      {
        tokensInput: 1_000_000,
        tokensCacheRead: 300_000,
        tokensCacheWrite: 200_000,
        tokensOutput: 100_000,
      },
      'openai.gpt-5.4',
    );
    expect(c.inputCost).toBeCloseTo(0.5 * 2.75 + 0.3 * 0.275 + 0.2 * 2.75);
    expect(c.outputCost).toBeCloseTo(0.1 * 16.5);
    expect(c.priced).toBe(true);
  });

  it('prices every model in the curated Codex picker list', () => {
    for (const { id } of CODEX_BEDROCK_MODELS) {
      expect(costForMetrics({ tokensInput: 1000 }, id).priced, id).toBe(true);
    }
  });

  it('prices GPT-6.1 Terra, which only the regional catalogue offers, at its In-Region rates', () => {
    const c = costForMetrics(
      {
        tokensInput: 1_000_000,
        tokensCacheRead: 300_000,
        tokensCacheWrite: 200_000,
        tokensOutput: 100_000,
      },
      'openai.gpt-6.1-terra',
    );
    expect(c.inputCost).toBeCloseTo(0.5 * 1.1 + 0.3 * 0.055 + 0.2 * 1.375);
    expect(c.outputCost).toBeCloseTo(0.1 * 5.5);
    expect(c.priced).toBe(true);
  });

  it('prices a dated snapshot id at the rates of its model', () => {
    const usage = {
      tokensInput: 1_000_000,
      tokensCacheRead: 300_000,
      tokensCacheWrite: 200_000,
      tokensOutput: 100_000,
    };
    for (const [snapshot, model] of [
      ['openai.gpt-5.4-2026-03-05', 'openai.gpt-5.4'],
      ['openai.gpt-5.5-2026-04-23', 'openai.gpt-5.5'],
    ]) {
      const dated = costForMetrics(usage, snapshot);
      const undated = costForMetrics(usage, model);
      expect(dated.priced, snapshot).toBe(true);
      expect(dated.totalCost, snapshot).toBeCloseTo(undated.totalCost);
      expect(dated.model).toBe(snapshot);
    }
  });

  // The `openai.*` ids bedrock-mantle listed per region on 2026-11-11. Every
  // other region listed only `openai.gpt-oss-*`, which the picker leaves out.
  // A model added here without a price entry fails the test below.
  const MANTLE_CATALOGUES = {
    'us-east-1': [
      'openai.gpt-5.4',
      'openai.gpt-5.4-2026-03-05',
      'openai.gpt-5.5',
      'openai.gpt-5.5-2026-04-23',
      'openai.gpt-5.6-luna',
      'openai.gpt-5.6-sol',
      'openai.gpt-5.6-terra',
      'openai.gpt-6-astra',
      'openai.gpt-6-luna',
      'openai.gpt-6-sol',
      'openai.gpt-6.1-sol',
      'openai.gpt-6.1-terra',
      'openai.gpt-oss-120b',
      'openai.gpt-oss-20b',
      'openai.gpt-oss-safeguard-120b',
      'openai.gpt-oss-safeguard-20b',
    ],
    'us-east-2': [
      'openai.gpt-5.4',
      'openai.gpt-5.4-2026-03-05',
      'openai.gpt-5.5',
      'openai.gpt-5.5-2026-04-23',
      'openai.gpt-5.6-luna',
      'openai.gpt-5.6-sol',
      'openai.gpt-5.6-terra',
      'openai.gpt-oss-120b',
      'openai.gpt-oss-20b',
      'openai.gpt-oss-safeguard-120b',
      'openai.gpt-oss-safeguard-20b',
    ],
    'us-west-2': [
      'openai.gpt-5.4',
      'openai.gpt-5.4-2026-03-05',
      'openai.gpt-5.6-luna',
      'openai.gpt-5.6-terra',
      'openai.gpt-6-astra',
      'openai.gpt-oss-120b',
      'openai.gpt-oss-20b',
      'openai.gpt-oss-safeguard-120b',
      'openai.gpt-oss-safeguard-20b',
    ],
  };

  it.each(Object.keys(MANTLE_CATALOGUES))(
    'prices every model the picker offers from the %s Mantle catalogue',
    async (region) => {
      const catalogue = await listCodexModels({
        listModels: async (r) => ({ data: MANTLE_CATALOGUES[r].map((id) => ({ id })) }),
        region,
      });
      const offered = codexModelsFor(catalogue);
      expect(offered.length).toBeGreaterThan(0);
      for (const model of offered) {
        expect(costForMetrics({ tokensInput: 1000 }, model.id).priced, model.id).toBe(true);
        expect(model.priced, model.id).toBeUndefined();
        expect(model.name, model.id).toBe(model.id);
      }
    },
  );

  it('leaves OpenAI models without a confirmed Mantle rate unpriced', () => {
    for (const model of [
      'openai.gpt-9-unlisted',
      'openai.gpt-9-unlisted-2027-01-01',
      'global.openai.gpt-5.6-sol',
      'us.openai.gpt-5.5-2026-04-23',
    ]) {
      expect(costForMetrics({ tokensInput: 1000 }, model).priced, model).toBe(false);
    }
  });

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

  it('keeps cache SKUs separate from standard input, regardless of order', () => {
    const cache = (usagetype, rate) => ({
      product: { attributes: { model: 'Claude Sonnet 4.6', usagetype } },
      terms: {
        OnDemand: { t: { priceDimensions: { d: { pricePerUnit: { USD: String(rate) } } } } },
      },
    });
    const products = [
      ...skus,
      cache('CacheReadInputTokenCount', 0.0000003),
      cache('CacheWriteInputTokenCount', 0.00000375),
      cache('CacheWrite1HourInputTokenCount', 0.000006),
    ];
    for (const rows of [products, products.toReversed()]) {
      expect(parsePriceList(rows)['claude-sonnet-4-6']).toEqual({
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
        cacheWrite1h: 6,
      });
    }
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
