import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createModelCatalog,
  createModelPricing,
  CLAUDE_MODELS_TTL_MS,
  PRICE_TABLE_TTL_MS,
  PRICING_REFRESH_INTERVAL_MS,
  PRICING_RETRY_INTERVAL_MS,
} from '../model-catalog.js';
import { parsePriceTable, serializePriceTable } from '../../shared/model-pricing.js';

// Products read from the AWS Price List API (see shared/test/model-pricing.test.js).
const PRICE_LIST = JSON.parse(
  readFileSync(
    new URL('../../shared/test/fixtures/price-list-sample.json', import.meta.url),
    'utf8',
  ),
);
const REGION = 'us-east-1';

const logger = { warn: vi.fn(), error: vi.fn() };
let clock;
const now = () => clock;
beforeEach(() => {
  clock = Date.parse('2026-11-11T12:00:00Z');
  logger.warn.mockClear();
  logger.error.mockClear();
});

// An SSM parameter stand-in: `stored` is what the intents lambda would read.
const pricingHarness = ({ stored = null, getProducts = async () => PRICE_LIST } = {}) => {
  const state = { stored, writes: 0 };
  const calls = {
    getProducts: vi.fn(getProducts),
    readTable: vi.fn(async () => state.stored),
    writeTable: vi.fn(async (text) => {
      state.stored = text;
      state.writes += 1;
    }),
  };
  const pricing = createModelPricing({ region: REGION, ...calls, logger, now });
  return { pricing, state, calls };
};
const throttled = () => Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });

describe('model pricing refresh', () => {
  it('stores the table built from the Price List and prices with it at once', async () => {
    const { pricing, state, calls } = pricingHarness();

    expect(await pricing.refresh()).toBe(true);

    const table = parsePriceTable(state.stored);
    expect(table.region).toBe(REGION);
    expect(table.prices['openai.gpt-6.1-terra'].regional.input).toBe(1.1);
    const priceFor = await pricing.priceResolver();
    expect(priceFor('openai.gpt-6.1-terra').priced).toBe(true);
    // The table just written is not read back from SSM.
    expect(calls.readTable).not.toHaveBeenCalled();
  });

  it.each([
    ['fails', throttled()],
    ['is throttled on a later page', Object.assign(new Error('page 2'), { name: 'Throttling' })],
  ])('keeps the stored table when the Price List lookup %s', async (_label, error) => {
    const before = serializePriceTable({
      version: 2,
      region: REGION,
      refreshedAt: '2026-11-10T00:00:00.000Z',
      prices: { 'claude-sonnet-4-6': { regional: { input: 3.3, output: 16.5 } } },
    });
    const { pricing, state, calls } = pricingHarness({
      stored: before,
      getProducts: async () => {
        throw error;
      },
    });

    expect(await pricing.refresh()).toBe(false);

    expect(calls.writeTable).not.toHaveBeenCalled();
    expect(state.stored).toBe(before);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('refresh failed'), error);
    // The last table AWS gave us still prices; nothing else is invented.
    const priceFor = await pricing.priceResolver();
    expect(priceFor('us.anthropic.claude-sonnet-4-6').priced).toBe(true);
    expect(priceFor('openai.gpt-6.1-terra').priced).toBe(false);
  });

  it('keeps the stored table when the Price List returns nothing usable', async () => {
    const { pricing, calls } = pricingHarness({ stored: 'kept', getProducts: async () => [] });

    expect(await pricing.refresh()).toBe(false);
    expect(calls.writeTable).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('reports a failed write and does not price from the table it could not store', async () => {
    const { pricing, calls } = pricingHarness();
    calls.writeTable.mockRejectedValueOnce(new Error('AccessDenied'));

    expect(await pricing.refresh()).toBe(false);
    const priceFor = await pricing.priceResolver();
    expect(priceFor('openai.gpt-6.1-terra').priced).toBe(false);
  });

  it('refreshes at most once per interval unless forced, and retries sooner after a failure', async () => {
    const { pricing, calls } = pricingHarness();

    expect(await pricing.refresh()).toBe(true);
    clock += PRICING_REFRESH_INTERVAL_MS - 1;
    expect(await pricing.refresh()).toBe(false);
    expect(calls.getProducts).toHaveBeenCalledTimes(1);

    // The hourly schedule forces a refresh whatever this container did before.
    expect(await pricing.refresh({ force: true })).toBe(true);
    expect(calls.getProducts).toHaveBeenCalledTimes(2);

    clock += PRICING_REFRESH_INTERVAL_MS;
    calls.getProducts.mockRejectedValueOnce(throttled());
    expect(await pricing.refresh()).toBe(false);
    clock += PRICING_RETRY_INTERVAL_MS - 1;
    expect(await pricing.refresh()).toBe(false);
    expect(calls.getProducts).toHaveBeenCalledTimes(3);
    clock += 1;
    expect(await pricing.refresh()).toBe(true);
    expect(calls.getProducts).toHaveBeenCalledTimes(4);
  });

  it('runs one refresh for concurrent callers', async () => {
    const { pricing, calls } = pricingHarness();

    const results = await Promise.all([pricing.refresh(), pricing.refresh({ force: true })]);

    expect(results).toEqual([true, true]);
    expect(calls.getProducts).toHaveBeenCalledTimes(1);
  });

  it('picks up a price that the Price List publishes later', async () => {
    const withoutTerra = PRICE_LIST.filter(
      (row) => row.product.attributes.model !== 'OpenAI GPT-6.1 Terra',
    );
    const { pricing, calls } = pricingHarness({ getProducts: async () => withoutTerra });

    await pricing.refresh({ force: true });
    expect((await pricing.priceResolver())('openai.gpt-6.1-terra').priced).toBe(false);

    calls.getProducts.mockResolvedValueOnce(PRICE_LIST);
    await pricing.refresh({ force: true });
    expect((await pricing.priceResolver())('openai.gpt-6.1-terra').priced).toBe(true);
  });
});

describe('model price resolver', () => {
  it('prices nothing on a cold start with no stored table', async () => {
    const { pricing } = pricingHarness();

    const priceFor = await pricing.priceResolver();

    expect(priceFor('us.anthropic.claude-sonnet-4-6').priced).toBe(false);
    expect(priceFor('openai.gpt-5.5').priced).toBe(false);
  });

  it.each([
    [
      'a table of an earlier version',
      JSON.stringify({ 'claude-sonnet-4-6': { input: 3, output: 15 } }),
    ],
    [
      'a table built for another region',
      serializePriceTable({
        version: 2,
        region: 'eu-central-1',
        refreshedAt: '2026-11-10T00:00:00.000Z',
        prices: { 'claude-sonnet-4-6': { regional: { input: 3.3, output: 16.5 } } },
      }),
    ],
    ['an unreadable value', '{'],
  ])('prices nothing from %s', async (_label, stored) => {
    const { pricing } = pricingHarness({ stored });

    expect((await pricing.priceResolver())('us.anthropic.claude-sonnet-4-6').priced).toBe(false);
  });

  it('returns no resolver when the table cannot be read, and reads again next time', async () => {
    const { pricing, calls } = pricingHarness();
    calls.readTable.mockRejectedValueOnce(new Error('ThrottlingException'));

    expect(await pricing.priceResolver()).toBeNull();
    expect(await pricing.priceResolver()).toEqual(expect.any(Function));
    expect(calls.readTable).toHaveBeenCalledTimes(2);
  });

  it('re-reads the stored table after its time to live', async () => {
    const { pricing, state, calls } = pricingHarness();
    await pricing.priceResolver();
    state.stored = serializePriceTable({
      version: 2,
      region: REGION,
      refreshedAt: '2026-11-11T12:10:00.000Z',
      prices: { 'claude-sonnet-4-6': { regional: { input: 3.3, output: 16.5 } } },
    });

    clock += PRICE_TABLE_TTL_MS - 1;
    expect((await pricing.priceResolver())('us.anthropic.claude-sonnet-4-6').priced).toBe(false);
    clock += 1;
    expect((await pricing.priceResolver())('us.anthropic.claude-sonnet-4-6').priced).toBe(true);
    expect(calls.readTable).toHaveBeenCalledTimes(2);
  });
});

const model = (id) => ({ id, name: id, description: null });
const caps = (overrides = {}) => ({
  clis: [],
  kiroModels: { models: [{ id: 'auto', name: 'Auto' }], default: 'auto' },
  codexModels: {
    source: 'catalog',
    models: [model('openai.gpt-6.1-terra'), model('openai.gpt-7-nova')],
  },
  ...overrides,
});

describe('Claude model list', () => {
  it('reads the list once per time to live', async () => {
    const catalog = createModelCatalog({ logger, now });
    const load = vi.fn(async () => [model('us.anthropic.claude-sonnet-4-6')]);

    await catalog.claudeModels(load);
    clock += CLAUDE_MODELS_TTL_MS - 1;
    expect(await catalog.claudeModels(load)).toEqual([model('us.anthropic.claude-sonnet-4-6')]);
    expect(load).toHaveBeenCalledTimes(1);

    clock += 1;
    await catalog.claudeModels(load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('serves the last list read when the lookup fails, and an empty one on a cold start', async () => {
    const catalog = createModelCatalog({ logger, now });
    const failing = vi.fn(async () => {
      throw new Error('ThrottlingException');
    });

    expect(await catalog.claudeModels(failing)).toEqual([]);

    await catalog.claudeModels(async () => [model('us.anthropic.claude-opus-5')]);
    clock += CLAUDE_MODELS_TTL_MS;
    expect(await catalog.claudeModels(failing)).toEqual([model('us.anthropic.claude-opus-5')]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

describe('picker model lists', () => {
  const priceFor = (id) => ({ priced: id.includes('terra') || id.includes('sonnet-4-6') });

  it('returns the lists as read and marks only the models without a price', () => {
    const catalog = createModelCatalog({ logger, now });

    const models = catalog.assemble({
      key: 'k',
      claudeModels: [model('us.anthropic.claude-sonnet-4-6'), model('us.anthropic.claude-opus-9')],
      runtimeCaps: caps(),
      priceFor,
    });

    expect(models).toEqual({
      claude: [
        model('us.anthropic.claude-sonnet-4-6'),
        { ...model('us.anthropic.claude-opus-9'), priced: false },
      ],
      opencode: [
        {
          ...model('us.anthropic.claude-sonnet-4-6'),
          id: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6',
        },
        {
          ...model('us.anthropic.claude-opus-9'),
          id: 'amazon-bedrock/us.anthropic.claude-opus-9',
          priced: false,
        },
      ],
      kiro: [{ id: 'auto', name: 'Auto' }],
      codex: [model('openai.gpt-6.1-terra'), { ...model('openai.gpt-7-nova'), priced: false }],
      codexSource: 'catalog',
    });
  });

  it('leaves `priced` unset when the price table could not be read', () => {
    const catalog = createModelCatalog({ logger, now });

    const models = catalog.assemble({
      key: 'k',
      claudeModels: [model('us.anthropic.claude-opus-9')],
      runtimeCaps: caps(),
      priceFor: null,
    });

    expect(models.claude).toEqual([model('us.anthropic.claude-opus-9')]);
    expect(models.codex).toEqual([model('openai.gpt-6.1-terra'), model('openai.gpt-7-nova')]);
  });

  it('offers no built-in Codex list when the catalogue lookup failed', () => {
    const catalog = createModelCatalog({ logger, now });

    const models = catalog.assemble({
      key: 'k',
      claudeModels: [],
      runtimeCaps: caps({ codexModels: { source: 'error', models: [] } }),
      priceFor,
    });

    expect(models.codex).toEqual([]);
    expect(models.codexSource).toBe('error');
  });

  it('reports a runtime that has no Codex catalogue as unavailable', () => {
    const catalog = createModelCatalog({ logger, now });

    for (const runtimeCaps of [null, caps({ codexModels: undefined })]) {
      const models = catalog.assemble({ key: 'k', claudeModels: [], runtimeCaps, priceFor });
      expect(models.codex).toEqual([]);
      expect(models.codexSource).toBe('unavailable');
    }
  });

  it('keeps an empty catalogue empty: a region that lists no model is an answer', () => {
    const catalog = createModelCatalog({ logger, now });
    catalog.assemble({ key: 'k', claudeModels: [], runtimeCaps: caps(), priceFor });

    const models = catalog.assemble({
      key: 'k',
      claudeModels: [],
      runtimeCaps: caps({ codexModels: { source: 'catalog', models: [] } }),
      priceFor,
    });

    expect(models.codex).toEqual([]);
    expect(models.codexSource).toBe('catalog');
  });

  it('serves the last catalogue read for the same runtime and credentials after a failed lookup', () => {
    const catalog = createModelCatalog({ logger, now });
    catalog.assemble({ key: 'project-a', claudeModels: [], runtimeCaps: caps(), priceFor });

    const failed = caps({ codexModels: { source: 'error', models: [] } });
    const same = catalog.assemble({
      key: 'project-a',
      claudeModels: [],
      runtimeCaps: failed,
      priceFor,
    });
    const other = catalog.assemble({
      key: 'project-b',
      claudeModels: [],
      runtimeCaps: failed,
      priceFor,
    });

    expect(same.codex.map((m) => m.id)).toEqual(['openai.gpt-6.1-terra', 'openai.gpt-7-nova']);
    expect(same.codexSource).toBe('cached');
    // Another project's credentials may see another catalogue: nothing is shared.
    expect(other.codex).toEqual([]);
    expect(other.codexSource).toBe('error');
  });

  it('serves the last runtime lists when the capabilities probe fails', () => {
    const catalog = createModelCatalog({ logger, now });
    catalog.assemble({
      key: 'k',
      claudeModels: [model('us.anthropic.claude-sonnet-4-6')],
      runtimeCaps: caps(),
      priceFor,
    });

    const models = catalog.assemble({ key: 'k', claudeModels: [], runtimeCaps: null, priceFor });

    expect(models.claude).toEqual([model('us.anthropic.claude-sonnet-4-6')]);
    expect(models.kiro).toEqual([{ id: 'auto', name: 'Auto' }]);
    expect(models.codex.map((m) => m.id)).toEqual(['openai.gpt-6.1-terra', 'openai.gpt-7-nova']);
    expect(models.codexSource).toBe('cached');
  });

  it('marks a cached model with the price table of the moment', () => {
    const catalog = createModelCatalog({ logger, now });
    catalog.assemble({ key: 'k', claudeModels: [], runtimeCaps: caps(), priceFor });

    const models = catalog.assemble({
      key: 'k',
      claudeModels: [],
      runtimeCaps: null,
      priceFor: () => ({ priced: true }),
    });

    expect(models.codex).toEqual([model('openai.gpt-6.1-terra'), model('openai.gpt-7-nova')]);
  });
});
