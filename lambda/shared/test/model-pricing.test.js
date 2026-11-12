import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  modelFamily,
  makePriceResolver,
  costForMetrics,
  parsePriceList,
  refreshPricing,
  serializePriceTable,
  parsePriceTable,
  PRICE_TABLE_VERSION,
} from '../model-pricing.js';

// Products read from the AWS Price List API on 2026-11-11 (offer
// AmazonBedrockFoundationModels), cut down to eight models and to the fields
// the parser reads. us-east-1, plus Claude Sonnet 5.5 in eu-central-1.
const PRICE_LIST = JSON.parse(
  readFileSync(new URL('./fixtures/price-list-sample.json', import.meta.url), 'utf8'),
);
const REGION = 'us-east-1';
const at = () => new Date('2026-11-11T12:00:00Z');
const tableFor = (products = PRICE_LIST, region = REGION) =>
  refreshPricing({ getProducts: async () => products, region, now: at });
const table = await tableFor();
const priceFor = makePriceResolver(table);

// One Price List product in the fixture's shape.
const product = (model, suffix, usd, overrides = {}) => ({
  product: {
    attributes: {
      regionCode: REGION,
      feature: 'On-demand Inference',
      model,
      usagetype: `USE1-MP:USE1_${suffix}-Units`,
      ...overrides.attributes,
    },
  },
  terms: {
    OnDemand: {
      t: {
        priceDimensions: {
          d: { unit: overrides.unit ?? '1M tokens', pricePerUnit: { USD: String(usd) } },
        },
      },
    },
  },
});

describe('modelFamily', () => {
  it('normalizes region-prefixed Bedrock inference-profile ids', () => {
    expect(modelFamily('us.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(modelFamily('eu.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6');
    expect(modelFamily('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('claude-haiku-4-5');
    expect(modelFamily('anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(modelFamily('amazon-bedrock/us.anthropic.claude-opus-4-6')).toBe('claude-opus-4-6');
  });

  it('does not coin a Bedrock family from a Kiro namespace id', () => {
    // Kiro's dotted version must NOT become a dashed Bedrock family.
    expect(modelFamily('claude-opus-4.6')).toBe('claude-opus-4.6');
    expect(modelFamily('auto')).toBe('auto');
    expect(modelFamily(null)).toBe(null);
  });

  it('keeps Codex Mantle ids exact and geo-prefixed OpenAI ids distinct', () => {
    expect(modelFamily('openai.gpt-5.5')).toBe('openai.gpt-5.5');
    expect(modelFamily('global.openai.gpt-5.5')).toBe('global.openai.gpt-5.5');
  });

  it('maps a dated OpenAI snapshot id to its model', () => {
    expect(modelFamily('openai.gpt-5.5-2026-04-23')).toBe('openai.gpt-5.5');
    expect(modelFamily('openai.gpt-5.4-2026-03-05')).toBe('openai.gpt-5.4');
    // Only a full trailing date is a snapshot stamp.
    expect(modelFamily('openai.gpt-6.1-terra')).toBe('openai.gpt-6.1-terra');
    expect(modelFamily('global.openai.gpt-5.5-2026-04-23')).toBe(
      'global.openai.gpt-5.5-2026-04-23',
    );
  });

  it('keeps a later model revision apart from the first one', () => {
    expect(modelFamily('us.anthropic.claude-3-5-sonnet-20240620-v1:0')).toBe('claude-3-5-sonnet');
    expect(modelFamily('us.anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(
      'claude-3-5-sonnet-v2',
    );
  });
});

describe('parsePriceList on the live Price List sample', () => {
  it('reads the In-Region and Global tiers of both SKU naming generations', () => {
    // Old naming (InputTokenCount, InputTokenCount_Global, …).
    expect(table.prices['claude-sonnet-4-6']).toEqual({
      regional: { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125, cacheWrite1h: 6.6 },
      global: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
    });
    // New naming (input_tokens_standard, input_tokens_global_standard, …).
    expect(table.prices['claude-sonnet-5-5']).toEqual({
      regional: { input: 2.2, output: 11, cacheRead: 0.11, cacheWrite: 2.75, cacheWrite1h: 4.4 },
      global: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
    });
  });

  it('keys OpenAI products by their Mantle id and keeps only published cache rates', () => {
    expect(table.prices['openai.gpt-6.1-terra']).toEqual({
      regional: { input: 1.1, output: 5.5, cacheRead: 0.055, cacheWrite: 1.375 },
      global: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
    });
    // GPT-5.5 has no cache-write SKU and no Global SKU.
    expect(table.prices['openai.gpt-5.5']).toEqual({
      regional: { input: 5.5, output: 33, cacheRead: 0.55 },
    });
  });

  it('uses the short-context tier and ignores long-context, batch and provisioned SKUs', () => {
    // Haiku 5.5 also publishes long-context rates at 5x; they are not read.
    expect(table.prices['claude-haiku-5-5'].regional).toEqual({
      input: 0.11,
      output: 0.55,
      cacheRead: 0.011,
      cacheWrite: 0.1375,
      cacheWrite1h: 0.22,
    });
    // Sonnet 4.6 batch rates are half the on-demand ones.
    expect(table.prices['claude-sonnet-4-6'].regional.input).toBe(3.3);
  });

  it('leaves out a tier the Price List does not publish', () => {
    expect(Object.keys(table.prices['claude-mythos-5'])).toEqual(['regional']);
  });

  it('keeps two revisions of a model as two products', () => {
    expect(table.prices['claude-3-5-sonnet'].regional).toEqual({ input: 3, output: 15 });
    expect(table.prices['claude-3-5-sonnet-v2'].regional).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  });

  it('only reads the products of the requested region', async () => {
    const eu = await tableFor(PRICE_LIST, 'eu-central-1');
    expect(Object.keys(eu.prices)).toEqual(['claude-sonnet-5-5']);
    expect(eu.region).toBe('eu-central-1');
  });

  it('stamps the table with its version, region and refresh time', () => {
    expect(table).toMatchObject({
      version: PRICE_TABLE_VERSION,
      region: REGION,
      refreshedAt: '2026-11-11T12:00:00.000Z',
    });
  });
});

describe('parsePriceList on rows it must not turn into a price', () => {
  const base = [product('Claude Test 1', 'input_tokens_standard', 2)];

  it('drops a tier that has no output rate', () => {
    expect(parsePriceList(base, { region: REGION })).toEqual({});
  });

  it('drops a tier whose rows disagree on a rate', () => {
    const rows = [
      ...base,
      product('Claude Test 1', 'output_tokens_standard', 10),
      product('Claude Test 1', 'output_tokens_standard', 12),
      product('Claude Test 1', 'input_tokens_global_standard', 1),
      product('Claude Test 1', 'output_tokens_global_standard', 5),
    ];
    expect(parsePriceList(rows, { region: REGION })).toEqual({
      'claude-test-1': { global: { input: 1, output: 5 } },
    });
  });

  it('accepts a repeated row that states the same rate', () => {
    const rows = [...base, ...base, product('Claude Test 1', 'output_tokens_standard', 10)];
    expect(parsePriceList(rows, { region: REGION })['claude-test-1'].regional).toEqual({
      input: 2,
      output: 10,
    });
  });

  it.each([
    [
      'another unit',
      product('Claude Test 1', 'output_tokens_standard', 0.01, { unit: '1K tokens' }),
    ],
    ['an unknown usage type', product('Claude Test 1', 'output_tokens_priority', 10)],
    ['a long-context SKU', product('Claude Test 1', 'output_tokens_long_ctx_standard', 10)],
    [
      'a batch SKU',
      product('Claude Test 1', 'output_tokens_standard', 10, {
        attributes: { feature: 'Batch Inference' },
      }),
    ],
    ['a price that is not a number', product('Claude Test 1', 'output_tokens_standard', 'n/a')],
    ['a negative price', product('Claude Test 1', 'output_tokens_standard', -1)],
    ['a model of another provider', product('Nova Pro', 'output_tokens_standard', 10)],
  ])('ignores %s', (_label, row) => {
    expect(parsePriceList([...base, row], { region: REGION })).toEqual({});
  });

  it('ignores a product with more than one on-demand rate', () => {
    const row = product('Claude Test 1', 'output_tokens_standard', 10);
    row.terms.OnDemand.t.priceDimensions.e = { unit: '1M tokens', pricePerUnit: { USD: '20' } };
    expect(parsePriceList([...base, row], { region: REGION })).toEqual({});
  });

  it('reads the String objects the AWS SDK returns for each product', () => {
    // @aws-sdk/client-pricing deserializes PriceList entries as lazy JSON
    // strings: `typeof` is "object", not "string".
    const rows = PRICE_LIST.map((row) => new String(JSON.stringify(row)));
    expect(parsePriceList(rows, { region: REGION })).toEqual(table.prices);
  });

  it('tolerates JSON-string products and malformed rows', () => {
    const rows = [
      JSON.stringify(base[0]),
      JSON.stringify(product('Claude Test 1', 'output_tokens_standard', 10)),
      'not json',
      null,
      {},
    ];
    expect(parsePriceList(rows, { region: REGION })).toEqual({
      'claude-test-1': { regional: { input: 2, output: 10 } },
    });
  });
});

describe('refreshPricing', () => {
  it('returns no table, rather than an empty one, when nothing could be priced', async () => {
    expect(await tableFor([])).toBeNull();
    expect(await tableFor(null)).toBeNull();
    expect(await tableFor(PRICE_LIST, 'ap-southeast-2')).toBeNull();
  });

  it('lets a failed lookup throw so the caller keeps its table', async () => {
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    await expect(
      refreshPricing({
        getProducts: async () => {
          throw throttled;
        },
        region: REGION,
      }),
    ).rejects.toBe(throttled);
  });

  it('builds nothing without a lookup or a region', async () => {
    expect(await refreshPricing({ region: REGION })).toBeNull();
    expect(await refreshPricing({ getProducts: async () => PRICE_LIST })).toBeNull();
  });
});

describe('the stored price table', () => {
  it('round-trips through its SSM form', () => {
    const stored = serializePriceTable(table);
    expect(parsePriceTable(stored)).toEqual(table);
  });

  it('fits the eight-model sample in a fraction of a standard parameter', () => {
    expect(serializePriceTable(table).length).toBeLessThan(1024);
  });

  it('does not read the table an earlier version stored, which carried static prices', () => {
    const legacy = JSON.stringify({
      'claude-sonnet-4-6': { input: 3, output: 15 },
      'openai.gpt-5.5': { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 5.5 },
    });
    expect(parsePriceTable(legacy)).toBeNull();
    expect(makePriceResolver(JSON.parse(legacy))('us.anthropic.claude-sonnet-4-6').priced).toBe(
      false,
    );
  });

  it.each(['', 'not json', 'null', '[]', '{"version":2}'])('reads %j as no table', (text) => {
    expect(parsePriceTable(text)).toBeNull();
  });
});

describe('makePriceResolver', () => {
  it('prices nothing without a price table', () => {
    for (const resolver of [makePriceResolver(), makePriceResolver(null), makePriceResolver({})]) {
      expect(resolver('us.anthropic.claude-sonnet-4-6')).toMatchObject({
        priced: false,
        inputPerToken: 0,
        outputPerToken: 0,
      });
      expect(resolver('openai.gpt-5.5').priced).toBe(false);
    }
  });

  it('prices a Geo or In-Region id at the regional rate and a global id at the global rate', () => {
    for (const id of [
      'us.anthropic.claude-sonnet-4-6',
      'anthropic.claude-sonnet-4-6',
      'amazon-bedrock/us.anthropic.claude-sonnet-4-6',
    ]) {
      expect(priceFor(id)).toMatchObject({ priced: true, family: 'claude-sonnet-4-6' });
      expect(priceFor(id).inputPerToken).toBeCloseTo(3.3 / 1e6, 12);
    }
    for (const id of [
      'global.anthropic.claude-sonnet-4-6',
      'amazon-bedrock/global.anthropic.claude-sonnet-4-6',
    ]) {
      expect(priceFor(id).inputPerToken).toBeCloseTo(3 / 1e6, 12);
      expect(priceFor(id).cacheWrite1hPerToken).toBeCloseTo(6 / 1e6, 12);
    }
  });

  it('does not price an id with the other tier when its own is not published', () => {
    // Mythos 5 has no Global SKU.
    expect(priceFor('us.anthropic.claude-mythos-5').priced).toBe(true);
    expect(priceFor('global.anthropic.claude-mythos-5').priced).toBe(false);
  });

  it('reports Kiro, unknown and geo-prefixed OpenAI ids as unpriced (not $0)', () => {
    for (const id of [
      'claude-opus-4.6',
      'auto',
      null,
      'us.anthropic.claude-opus-9',
      'openai.gpt-7-nova',
      'global.openai.gpt-5.5',
      'us.openai.gpt-6.1-terra',
      'constructor',
    ]) {
      expect(priceFor(id).priced).toBe(false);
    }
  });

  it('prices a dated snapshot id as its model and a later revision as its own product', () => {
    expect(priceFor('openai.gpt-5.5-2026-04-23')).toMatchObject({
      priced: true,
      family: 'openai.gpt-5.5',
    });
    expect(priceFor('us.anthropic.claude-3-5-sonnet-20241022-v2:0').cacheReadPerToken).toBeCloseTo(
      0.3 / 1e6,
      12,
    );
    // The first revision publishes no cache rate; the second one's is not borrowed.
    expect(priceFor('us.anthropic.claude-3-5-sonnet-20240620-v1:0').cacheReadPerToken).toBeNull();
  });
});

describe('costForMetrics', () => {
  it('computes input+output cost for a priced model', () => {
    const c = costForMetrics(
      { tokensInput: 1000, tokensOutput: 500 },
      'us.anthropic.claude-sonnet-4-6',
      priceFor,
    );
    expect(c.priced).toBe(true);
    expect(c.inputCost).toBeCloseTo((1000 * 3.3) / 1e6, 10);
    expect(c.outputCost).toBeCloseTo((500 * 16.5) / 1e6, 10);
    expect(c.totalCost).toBeCloseTo(c.inputCost + c.outputCost, 10);
    expect(c.currency).toBe('USD');
  });

  it.each([
    ['us.anthropic.claude-sonnet-5-5', { input: 2.2, read: 0.11, write: 2.75, write1h: 4.4 }],
    ['global.anthropic.claude-sonnet-5-5', { input: 2, read: 0.1, write: 2.5, write1h: 4 }],
    [
      'amazon-bedrock/us.anthropic.claude-sonnet-5-5',
      { input: 2.2, read: 0.11, write: 2.75, write1h: 4.4 },
    ],
  ])('prices cache reads and mixed-TTL writes of %s at the published rates', (model, rate) => {
    const cost = costForMetrics(
      {
        tokensInput: 1000,
        tokensOutput: 0,
        tokensCacheRead: 2000,
        tokensCacheWrite: 3000,
        tokensCacheWrite1h: 1000,
      },
      model,
      priceFor,
    );
    expect(cost.priced).toBe(true);
    expect(cost.inputCost).toBeCloseTo(
      (1000 * rate.input + 2000 * rate.read + 2000 * rate.write + 1000 * rate.write1h) / 1e6,
      12,
    );
  });

  it('prices Codex usage whose input total includes cache reads and writes', () => {
    const cost = costForMetrics(
      {
        tokensInput: 1_000_000,
        tokensOutput: 1_000_000,
        tokensCacheRead: 100_000,
        tokensCacheWrite: 200_000,
      },
      'openai.gpt-6.1-terra',
      priceFor,
    );
    expect(cost.priced).toBe(true);
    expect(cost.inputCost).toBeCloseTo(0.7 * 1.1 + 0.1 * 0.055 + 0.2 * 1.375, 10);
    expect(cost.outputCost).toBeCloseTo(5.5, 10);
  });

  it('prices GPT-5.5 usage that carries cache reads only', () => {
    const cost = costForMetrics(
      { tokensInput: 1_000_000, tokensOutput: 0, tokensCacheRead: 400_000 },
      'openai.gpt-5.5',
      priceFor,
    );
    expect(cost.priced).toBe(true);
    expect(cost.inputCost).toBeCloseTo(0.6 * 5.5 + 0.4 * 0.55, 10);
  });

  it('reports usage in a cache category that has no published rate as unpriced', () => {
    // GPT-5.5 publishes no cache-write SKU: no rate is assumed for those tokens.
    expect(
      costForMetrics(
        { tokensInput: 1000, tokensOutput: 10, tokensCacheWrite: 500 },
        'openai.gpt-5.5',
        priceFor,
      ).priced,
    ).toBe(false);
    // Claude 3.5 Sonnet (first revision) publishes no cache rates at all.
    expect(
      costForMetrics(
        { tokensInput: 1000, tokensOutput: 10, tokensCacheRead: 500 },
        'us.anthropic.claude-3-5-sonnet-20240620-v1:0',
        priceFor,
      ).priced,
    ).toBe(false);
    // GPT-6.1 Terra publishes a 30-minute write rate but no 1-hour one.
    expect(
      costForMetrics(
        { tokensInput: 1000, tokensOutput: 10, tokensCacheWrite: 500, tokensCacheWrite1h: 500 },
        'openai.gpt-6.1-terra',
        priceFor,
      ).priced,
    ).toBe(false);
  });

  it('reports usage of a model that is not in the price table as unpriced, with no cost', () => {
    for (const model of ['openai.gpt-7-nova', 'us.anthropic.claude-opus-9', null, undefined]) {
      expect(
        costForMetrics({ tokensInput: 1_000_000, tokensOutput: 1_000_000 }, model, priceFor),
      ).toMatchObject({ priced: false, totalCost: 0 });
    }
  });

  it('reports every usage as unpriced when there is no price table', () => {
    for (const resolver of [undefined, makePriceResolver(null)]) {
      expect(
        costForMetrics(
          { tokensInput: 1000, tokensOutput: 500 },
          'us.anthropic.claude-sonnet-4-6',
          resolver,
        ),
      ).toMatchObject({ priced: false, totalCost: 0 });
    }
  });

  it('returns a stable unpriced shape for a Kiro run', () => {
    const c = costForMetrics({ credits: 0.35 }, 'claude-opus-4.6', priceFor);
    expect(c.priced).toBe(false);
    expect(c.totalCost).toBe(0);
    expect(c.creditCost).toBe(0);
    expect(c.estimated).toBe(false);
  });

  it('prices a Kiro credits sample at the stamped $/credit rate as an estimate', () => {
    const c = costForMetrics({ credits: 0.67 }, 'claude-opus-4.6', priceFor, 0.04);
    expect(c.priced).toBe(true);
    expect(c.estimated).toBe(true);
    expect(c.creditCost).toBeCloseTo(0.67 * 0.04, 10);
    expect(c.totalCost).toBeCloseTo(0.67 * 0.04, 10);
  });

  it('reports a credits sample without a rate as unpriced (never a guessed $)', () => {
    const c = costForMetrics({ credits: 0.67 }, 'auto', priceFor, null);
    expect(c.priced).toBe(false);
    expect(c.estimated).toBe(false);
    expect(c.totalCost).toBe(0);
  });

  it('ignores a rate when the sample has no credits (token pricing unchanged)', () => {
    const c = costForMetrics(
      { tokensInput: 1000, tokensOutput: 500 },
      'us.anthropic.claude-sonnet-4-6',
      priceFor,
      0.04,
    );
    expect(c.priced).toBe(true);
    expect(c.estimated).toBe(false);
    expect(c.creditCost).toBe(0);
    expect(c.totalCost).toBeCloseTo((1000 * 3.3 + 500 * 16.5) / 1e6, 10);
  });
});
