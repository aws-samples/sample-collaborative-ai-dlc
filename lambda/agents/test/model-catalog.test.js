import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createModelCatalog,
  createModelPricing,
  runtimeLookups,
  CLAUDE_MODELS_TTL_MS,
  PRICE_TABLE_RETRY_MS,
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

  it('returns no resolver while no read has succeeded, and retries after the retry interval', async () => {
    const { pricing, calls } = pricingHarness();
    calls.readTable.mockRejectedValueOnce(new Error('ThrottlingException'));

    expect(await pricing.priceResolver()).toBeNull();
    clock += PRICE_TABLE_RETRY_MS - 1;
    expect(await pricing.priceResolver()).toBeNull();
    expect(calls.readTable).toHaveBeenCalledTimes(1);

    clock += 1;
    expect(await pricing.priceResolver()).toEqual(expect.any(Function));
    expect(calls.readTable).toHaveBeenCalledTimes(2);
  });

  it('takes a successful read as the truth, also when it finds no usable table', async () => {
    const { pricing, state } = pricingHarness();
    state.stored = serializePriceTable({
      version: 2,
      region: REGION,
      refreshedAt: '2026-11-11T12:00:00.000Z',
      prices: { 'claude-sonnet-4-6': { regional: { input: 3.3, output: 16.5 } } },
    });
    expect((await pricing.priceResolver())('us.anthropic.claude-sonnet-4-6').priced).toBe(true);

    // The parameter was deleted, or replaced by an old-format or unreadable value.
    for (const stored of [null, JSON.stringify({ 'claude-sonnet-4-6': { input: 3 } }), '{']) {
      state.stored = stored;
      clock += PRICE_TABLE_TTL_MS;
      expect((await pricing.priceResolver())('us.anthropic.claude-sonnet-4-6').priced).toBe(false);
    }
  });

  it('keeps the last table read when a later read fails, and retries after the retry interval', async () => {
    const { pricing, state, calls } = pricingHarness();
    state.stored = serializePriceTable({
      version: 2,
      region: REGION,
      refreshedAt: '2026-11-11T12:00:00.000Z',
      prices: { 'claude-sonnet-4-6': { regional: { input: 3.3, output: 16.5 } } },
    });
    expect((await pricing.priceResolver())('us.anthropic.claude-sonnet-4-6').priced).toBe(true);

    // Past the time to live, SSM fails with a transient error.
    clock += PRICE_TABLE_TTL_MS;
    calls.readTable.mockRejectedValue(new Error('ThrottlingException'));
    const kept = await pricing.priceResolver();
    expect(kept('us.anthropic.claude-sonnet-4-6').priced).toBe(true);
    expect(calls.readTable).toHaveBeenCalledTimes(2);

    // A failing SSM is not read on every call.
    clock += PRICE_TABLE_RETRY_MS - 1;
    expect((await pricing.priceResolver())('us.anthropic.claude-sonnet-4-6').priced).toBe(true);
    expect(calls.readTable).toHaveBeenCalledTimes(2);

    // It is read again after the retry interval, and a recovered read is used.
    clock += 1;
    state.stored = serializePriceTable({
      version: 2,
      region: REGION,
      refreshedAt: '2026-11-11T13:00:00.000Z',
      prices: { 'claude-opus-5': { regional: { input: 5.5, output: 27.5 } } },
    });
    calls.readTable.mockImplementation(async () => state.stored);
    const recovered = await pricing.priceResolver();
    expect(calls.readTable).toHaveBeenCalledTimes(3);
    expect(recovered('us.anthropic.claude-opus-5').priced).toBe(true);
    expect(recovered('us.anthropic.claude-sonnet-4-6').priced).toBe(false);
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
  kiroModels: { models: [{ id: 'auto', name: 'Auto' }], default: 'auto', source: 'catalog' },
  bedrockModels: [model('us.anthropic.claude-sonnet-4-6')],
  bedrockModelsSource: 'catalog',
  codexModels: {
    source: 'catalog',
    models: [model('openai.gpt-6.1-terra'), model('openai.gpt-7-nova')],
  },
  ...overrides,
});
const ok = (...ids) => ({ ok: true, models: ids.map(model) });

describe('Claude model list (API keys)', () => {
  it('reads the list once per time to live', async () => {
    const catalog = createModelCatalog({ logger, now });
    const load = vi.fn(async () => [model('us.anthropic.claude-sonnet-4-6')]);

    await catalog.claudeModels(load);
    clock += CLAUDE_MODELS_TTL_MS - 1;
    expect(await catalog.claudeModels(load)).toEqual(ok('us.anthropic.claude-sonnet-4-6'));
    expect(load).toHaveBeenCalledTimes(1);

    clock += 1;
    await catalog.claudeModels(load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reports a failed lookup, with the last list read when there is one', async () => {
    const catalog = createModelCatalog({ logger, now });
    const failing = vi.fn(async () => {
      throw new Error('ThrottlingException');
    });

    expect(await catalog.claudeModels(failing)).toEqual({ ok: false });

    await catalog.claudeModels(async () => [model('us.anthropic.claude-opus-5')]);
    clock += CLAUDE_MODELS_TTL_MS;
    expect(await catalog.claudeModels(failing)).toEqual({
      ok: false,
      stale: [model('us.anthropic.claude-opus-5')],
    });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('does not bring back a list that a later successful, empty read replaced', async () => {
    const catalog = createModelCatalog({ logger, now });
    await catalog.claudeModels(async () => [model('us.anthropic.claude-opus-5')]);
    clock += CLAUDE_MODELS_TTL_MS;
    expect(await catalog.claudeModels(async () => [])).toEqual(ok());

    clock += CLAUDE_MODELS_TTL_MS;
    const failed = await catalog.claudeModels(async () => {
      throw new Error('ThrottlingException');
    });

    expect(failed).toEqual({ ok: false, stale: [] });
    const models = catalog.assemble({ key: 'k', ...runtimeLookups(caps()), claude: failed });
    expect(models.claude).toEqual([]);
    expect(models.sources.claude).toBe('cached');
  });
});

describe('runtime lookups', () => {
  it('reads each list of a runtime that states its lookup status', () => {
    expect(runtimeLookups(caps())).toEqual({
      claude: ok('us.anthropic.claude-sonnet-4-6'),
      kiro: { ok: true, models: [{ id: 'auto', name: 'Auto' }] },
      codex: ok('openai.gpt-6.1-terra', 'openai.gpt-7-nova'),
    });
  });

  it('tells a failed lookup from an empty answer by the status the runtime reports', () => {
    expect(
      runtimeLookups(
        caps({
          kiroModels: { models: [], default: null, source: 'error' },
          bedrockModels: [],
          bedrockModelsSource: 'error',
          codexModels: { source: 'error', models: [model('openai.saved')] },
        }),
      ),
    ).toEqual({
      claude: { ok: false },
      kiro: { ok: false },
      codex: { ok: false, absent: false, models: [model('openai.saved')] },
    });
    expect(
      runtimeLookups(
        caps({
          kiroModels: { models: [], default: null, source: 'catalog' },
          bedrockModels: [],
          codexModels: { source: 'catalog', models: [] },
        }),
      ),
    ).toEqual({ claude: ok(), kiro: ok(), codex: ok() });
  });

  it('takes a list without a status, from an older runtime, as an answer', () => {
    const older = { clis: [], kiroModels: { models: [], default: null }, bedrockModels: [] };

    expect(runtimeLookups(older)).toEqual({
      claude: ok(),
      kiro: ok(),
      codex: { ok: false, absent: true, models: [] },
    });
  });

  it('reports every list as failed when the probe itself failed', () => {
    expect(runtimeLookups(null)).toEqual({
      claude: { ok: false },
      kiro: { ok: false },
      codex: { ok: false },
    });
  });
});

describe('picker model lists', () => {
  const priceFor = (id) => ({ priced: id.includes('terra') || id.includes('sonnet-4-6') });
  const assemble = (catalog, runtimeCaps, extra = {}) =>
    catalog.assemble({ key: 'k', ...runtimeLookups(runtimeCaps), priceFor, ...extra });

  it('returns the lists as read and marks only the models without a price', () => {
    const catalog = createModelCatalog({ logger, now });

    const models = assemble(catalog, caps(), {
      claude: ok('us.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-opus-9'),
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
      sources: { claude: 'catalog', opencode: 'catalog', kiro: 'catalog', codex: 'catalog' },
      codexSource: 'catalog',
    });
  });

  it('leaves `priced` unset when no price table was read', () => {
    const catalog = createModelCatalog({ logger, now });

    const models = assemble(catalog, caps(), {
      claude: ok('us.anthropic.claude-opus-9'),
      priceFor: null,
    });

    expect(models.claude).toEqual([model('us.anthropic.claude-opus-9')]);
    expect(models.codex).toEqual([model('openai.gpt-6.1-terra'), model('openai.gpt-7-nova')]);
  });

  it('offers no built-in Codex list when the catalogue lookup failed', () => {
    const catalog = createModelCatalog({ logger, now });

    const models = assemble(catalog, caps({ codexModels: { source: 'error', models: [] } }));

    expect(models.codex).toEqual([]);
    expect(models.codexSource).toBe('error');
    expect(models.sources.codex).toBe('error');
  });

  it('reports a runtime that has no Codex catalogue as unavailable', () => {
    const catalog = createModelCatalog({ logger, now });

    const models = assemble(catalog, caps({ codexModels: undefined }));

    expect(models.codex).toEqual([]);
    expect(models.codexSource).toBe('unavailable');
  });

  it('reports every runtime list as failed when the probe fails on a cold container', () => {
    const catalog = createModelCatalog({ logger, now });

    const models = assemble(catalog, null);

    expect(models).toMatchObject({ claude: [], kiro: [], codex: [] });
    expect(models.sources).toEqual({
      claude: 'error',
      opencode: 'error',
      kiro: 'error',
      codex: 'error',
    });
  });

  it('serves the last catalogue read for the same runtime and credentials after a failed lookup', () => {
    const catalog = createModelCatalog({ logger, now });
    catalog.assemble({ key: 'project-a', ...runtimeLookups(caps()), priceFor });

    const failed = runtimeLookups(caps({ codexModels: { source: 'error', models: [] } }));
    const same = catalog.assemble({ key: 'project-a', ...failed, priceFor });
    const other = catalog.assemble({ key: 'project-b', ...failed, priceFor });

    expect(same.codex.map((m) => m.id)).toEqual(['openai.gpt-6.1-terra', 'openai.gpt-7-nova']);
    expect(same.codexSource).toBe('cached');
    // Another project's credentials may see another catalogue: nothing is shared.
    expect(other.codex).toEqual([]);
    expect(other.codexSource).toBe('error');
  });

  it('serves the last runtime lists when the capabilities probe fails', () => {
    const catalog = createModelCatalog({ logger, now });
    assemble(catalog, caps());

    const models = assemble(catalog, null);

    expect(models.claude).toEqual([model('us.anthropic.claude-sonnet-4-6')]);
    expect(models.kiro).toEqual([{ id: 'auto', name: 'Auto' }]);
    expect(models.codex.map((m) => m.id)).toEqual(['openai.gpt-6.1-terra', 'openai.gpt-7-nova']);
    expect(models.sources).toEqual({
      claude: 'cached',
      opencode: 'cached',
      kiro: 'cached',
      codex: 'cached',
    });
  });

  // Review finding: populated answer → empty answer → failed probe.
  it.each([
    [
      'a runtime that reports its lookup status',
      caps({
        kiroModels: { models: [], default: null, source: 'catalog' },
        bedrockModels: [],
        bedrockModelsSource: 'catalog',
        codexModels: { source: 'catalog', models: [] },
      }),
    ],
    [
      'an older runtime that reports plain lists',
      {
        clis: [],
        kiroModels: { models: [], default: null },
        bedrockModels: [],
        codexModels: { source: 'catalog', models: [] },
      },
    ],
  ])('does not bring back models that an empty answer of %s removed', (_label, empty) => {
    const catalog = createModelCatalog({ logger, now });
    assemble(catalog, caps());

    expect(assemble(catalog, empty)).toMatchObject({ claude: [], kiro: [], codex: [] });

    const afterFailure = assemble(catalog, null);
    expect(afterFailure).toMatchObject({ claude: [], opencode: [], kiro: [], codex: [] });
    expect(afterFailure.sources).toEqual({
      claude: 'cached',
      opencode: 'cached',
      kiro: 'cached',
      codex: 'cached',
    });
  });

  it('keeps the last answer when a runtime reports that one of its lookups failed', () => {
    const catalog = createModelCatalog({ logger, now });
    assemble(catalog, caps());

    const models = assemble(
      catalog,
      caps({
        kiroModels: { models: [], default: null, source: 'error' },
        bedrockModels: [],
        bedrockModelsSource: 'error',
      }),
    );

    expect(models.kiro).toEqual([{ id: 'auto', name: 'Auto' }]);
    expect(models.claude).toEqual([model('us.anthropic.claude-sonnet-4-6')]);
    expect(models.sources).toMatchObject({ kiro: 'cached', claude: 'cached', codex: 'catalog' });
  });

  it('prefers the list any caller read over nothing when the key-based Claude lookup fails', () => {
    const catalog = createModelCatalog({ logger, now });

    const models = assemble(catalog, caps(), {
      claude: { ok: false, stale: [model('us.anthropic.claude-opus-5')] },
    });

    expect(models.claude.map((m) => m.id)).toEqual(['us.anthropic.claude-opus-5']);
    expect(models.sources.claude).toBe('cached');
  });

  it('marks a cached model with the price table of the moment', () => {
    const catalog = createModelCatalog({ logger, now });
    assemble(catalog, caps());

    const models = assemble(catalog, null, { priceFor: () => ({ priced: true }) });

    expect(models.codex).toEqual([model('openai.gpt-6.1-terra'), model('openai.gpt-7-nova')]);
  });
});
