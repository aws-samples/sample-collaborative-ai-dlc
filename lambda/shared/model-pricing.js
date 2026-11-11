// Model pricing — translate token usage into USD.
//
// Every rate comes from the AWS Price List API. There is no static price table:
// a model the Price List does not publish a usable rate for is reported
// `priced: false` ("usage known, price unavailable"), never estimated and never
// priced as another model.
//
// The price table is built for ONE region — the inference region — because
// Bedrock publishes different rates per region. Its shape (PRICE_TABLE_VERSION):
//   { version, region, refreshedAt, prices: { <family>: { regional?, global? } } }
// where each tier is { input, output, cacheRead?, cacheWrite?, cacheWrite1h? }
// in USD per 1,000,000 tokens. `regional` is the In-Region / Geo cross-region
// rate (bare, `us.`, `eu.`, `apac.` ids); `global` is the Global cross-region
// rate (`global.` ids). A tier the Price List does not publish stays absent, so
// an id that needs it is unpriced.
//
// `priceFor` normalizes any resolved model id (region-prefixed Bedrock inference
// profile, or a Kiro namespace id) to a family before lookup — a Kiro credit id
// (e.g. "claude-opus-4.6", "auto") normalizes to something not in the table and
// is reported unpriced, which is correct (Kiro is credit-based).
//
// Limits that the Price List cannot resolve on its own (see
// docs/using-the-platform/intent-observability.md):
//   - A product carries a display name ("Claude Sonnet 4.6", "OpenAI GPT-5.5"),
//     not a model id. `familyFromPriceName` and `modelFamily` normalize both to
//     the same key; a name that does not normalize to an id's family is simply
//     never matched (unpriced).
//   - Metric samples carry no per-request prompt length, so the short-context
//     tier is always used; long-context, batch, flex, priority and
//     latency-optimized SKUs are ignored.
//
// Pure of the AWS SDK: `refreshPricing` takes an injected `getProducts` fn (the
// same testability contract as bedrock-models.js).
//
// Write/read split (deliberate): the AGENTS lambda REFRESHES the SSM table
// (`refreshPricing` → Price List API → SSM) on a schedule and on model
// discovery; the INTENTS lambda only READS it. The intents lambda bundles the
// AWS SDK via esbuild WITHOUT `--external:@aws-sdk/*`, so pulling in
// @aws-sdk/client-pricing there would bundle a new client and risk the @smithy/*
// major-version mismatch crash (the "hashConstructor is not a constructor"
// class). The agents lambda is zipped with its own node_modules (no bundling)
// and already owns model discovery + SSM writes, so the Pricing dependency lives
// there. Keep the two sides in this shape when touching pricing.

const TOKENS_PER_UNIT = 1_000_000;
const PRICE_TABLE_VERSION = 2;
// The offer that carries the current Bedrock foundation-model token SKUs. The
// older `AmazonBedrock` offer only lists retired models.
const PRICE_LIST_SERVICE_CODE = 'AmazonBedrockFoundationModels';
// Providers whose models the agent CLIs run on Bedrock (Claude Code / OpenCode,
// Codex). GetProducts cannot OR a filter, so each is one query.
const PRICE_LIST_PROVIDERS = ['Anthropic', 'OpenAI'];

// Normalize a resolved model id to a canonical family key.
//   us.anthropic.claude-sonnet-4-6            → claude-sonnet-4-6
//   anthropic.claude-opus-4-6-v1              → claude-opus-4-6
//   global.anthropic.claude-haiku-4-5-20251001-v1:0 → claude-haiku-4-5
//   amazon-bedrock/us.anthropic.claude-...    → claude-...
//   claude-opus-4.6 (Kiro), auto              → (no family — stays as-is / null)
//   openai.gpt-5.5 (Codex)                    → openai.gpt-5.5
//   openai.gpt-5.5-2026-04-23                 → openai.gpt-5.5
//   global.openai.gpt-5.5                     → global.openai.gpt-5.5 (unpriced)
//   anthropic.claude-3-5-sonnet-20241022-v2:0 → claude-3-5-sonnet-v2
// Dots in a Kiro version (4.6) are intentionally NOT converted to dashes, so a
// Kiro id never collides with a Bedrock family and gets token-priced.
// Codex ids keep their exact Mantle form, except that a dated snapshot id
// (`-YYYY-MM-DD`, which Mantle lists next to the undated id) is the same model:
// Bedrock publishes one set of rates per model, so it prices as the undated id.
// A `-v1` revision is the model itself; a later revision (`-v2`) is a separate
// Price List product ("Claude 3.5 Sonnet v2") and keeps its suffix.
// A geo-prefixed OpenAI id is a Bedrock Runtime profile with different rates, so
// it keeps its prefix and no family.
const modelFamily = (modelId) => {
  if (!modelId) return null;
  let id = String(modelId).trim().toLowerCase();
  if (!id) return null;
  // Drop an opencode-style provider prefix.
  if (id.startsWith('amazon-bedrock/')) id = id.slice('amazon-bedrock/'.length);
  if (/^(us|eu|apac|global)\.openai\./.test(id)) return id;
  // Drop a cross-region inference-profile geo prefix.
  id = id.replace(/^(us|eu|apac|global)\./, '');
  // Drop the anthropic provider prefix.
  id = id.replace(/^anthropic\./, '');
  // Drop a trailing ":N" model-version selector and a "-v1" revision.
  id = id.replace(/:\d+$/, '').replace(/-v1$/, '');
  // Drop a date stamp (…-20251001), also in front of a later revision.
  id = id.replace(/-\d{8}(?=$|-v\d+$)/, '');
  // Drop an OpenAI snapshot date (…-2026-04-23).
  if (id.startsWith('openai.')) id = id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return id;
};

// True when a resolved model id routes through Bedrock Global cross-region
// inference (`global.` profile, optionally behind an opencode provider prefix).
const isGlobalProfile = (modelId) =>
  /^(amazon-bedrock\/)?global\./.test(
    String(modelId ?? '')
      .trim()
      .toLowerCase(),
  );

const isRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const perToken = (value) => (isRate(value) ? value / TOKENS_PER_UNIT : null);

// Build a priceFor(modelId) → { model, family, currency, inputPerToken,
// outputPerToken, cache rates, priced } resolver over a price table. Only a
// table of the current version is read: an older SSM value was merged with the
// retired static prices, so it is ignored and everything is unpriced until the
// next refresh. A `global.` profile uses the `global` tier and every other id
// the `regional` tier; a missing tier is unpriced, never replaced by the other.
// A cache rate the Price List does not publish is null, which makes a sample
// that carries those tokens unpriced (see costForMetrics).
const makePriceResolver = (table) => {
  const prices =
    table?.version === PRICE_TABLE_VERSION && table.prices && typeof table.prices === 'object'
      ? table.prices
      : {};
  return (modelId) => {
    const family = modelFamily(modelId);
    const tiers = family && Object.hasOwn(prices, family) ? prices[family] : null;
    const entry = tiers?.[isGlobalProfile(modelId) ? 'global' : 'regional'];
    if (!isRate(entry?.input) || !isRate(entry?.output)) {
      return {
        model: modelId ?? null,
        family,
        currency: 'USD',
        inputPerToken: 0,
        outputPerToken: 0,
        priced: false,
      };
    }
    return {
      model: modelId ?? null,
      family,
      currency: 'USD',
      inputPerToken: entry.input / TOKENS_PER_UNIT,
      outputPerToken: entry.output / TOKENS_PER_UNIT,
      cacheReadPerToken: perToken(entry.cacheRead),
      cacheWritePerToken: perToken(entry.cacheWrite),
      cacheWrite1hPerToken: perToken(entry.cacheWrite1h),
      // Responses API input_tokens includes cache reads and writes.
      ...(family.startsWith('openai.') ? { inputIncludesCache: true } : {}),
      priced: true,
    };
  };
};

// Compute the cost of one metric bag given a price resolver. Reads tokensInput /
// tokensOutput and cache token categories (token-billed models), and `credits`
// (Kiro). Stored Claude input excludes cache tokens; Codex input includes them,
// so only the remainder bills at the uncached rate. Always returns a cost object
// so the DTO shape is stable; `priced: false` means "usage known, price unavailable" (newer model,
// or Kiro without a captured credit rate) — the UI must not render this as $0.
//
// Credits: Kiro is credit-based, so a `credits` sample is priced as
// `credits × creditRate` (the $/credit overage rate the runtime scraped from
// `kiro-cli /usage` at run time — see cli/kiro-usage.js). That is an ESTIMATE (in-plan
// credits are covered by the subscription), so the cost is flagged
// `estimated: true` and the UI caveats it rather than presenting it as billing
// truth.
const costForMetrics = (metrics = {}, modelId, resolver, creditRate = null) => {
  // No resolver means no price table: every model is unpriced.
  const priceFor = resolver ?? makePriceResolver();
  const price = priceFor(modelId);
  const tin = typeof metrics.tokensInput === 'number' ? metrics.tokensInput : 0;
  const tout = typeof metrics.tokensOutput === 'number' ? metrics.tokensOutput : 0;
  const cacheRead = metrics.tokensCacheRead ?? 0;
  const cacheWrite = metrics.tokensCacheWrite ?? 0;
  const cacheWrite1h = Math.min(metrics.tokensCacheWrite1h ?? 0, cacheWrite);
  const credits = typeof metrics.credits === 'number' ? metrics.credits : 0;
  const rate = typeof creditRate === 'number' && creditRate > 0 ? creditRate : null;
  const uncachedInput = price.inputIncludesCache ? Math.max(tin - cacheRead - cacheWrite, 0) : tin;
  const inputCost =
    uncachedInput * price.inputPerToken +
    cacheRead * (price.cacheReadPerToken ?? 0) +
    (cacheWrite - cacheWrite1h) * (price.cacheWritePerToken ?? 0) +
    cacheWrite1h * (price.cacheWrite1hPerToken ?? 0);
  const outputCost = tout * price.outputPerToken;
  const creditCost = credits > 0 && rate ? credits * rate : 0;
  // Priced iff every spend the sample carries has a price: token spend needs a
  // model price entry; credit spend needs a captured rate. A no-spend sample
  // (context % only) inherits the model's priceability as before.
  const cachePriced =
    (cacheRead === 0 || price.cacheReadPerToken != null) &&
    (cacheWrite === 0 || price.cacheWritePerToken != null) &&
    (cacheWrite1h === 0 || price.cacheWrite1hPerToken != null);
  const tokenSpendPriced = (tin + tout === 0 || price.priced) && cachePriced;
  const creditSpendPriced = credits === 0 || rate != null;
  const priced = credits > 0 ? tokenSpendPriced && creditSpendPriced : price.priced && cachePriced;
  return {
    model: price.model,
    currency: price.currency,
    inputCost,
    outputCost,
    creditCost,
    totalCost: inputCost + outputCost + creditCost,
    priced,
    estimated: creditCost > 0,
  };
};

// Canonical family from a Price List display NAME. The Price List has no model
// id, so this is the only link between a product and a runtime id:
//   "Claude Sonnet 4.6"     → claude-sonnet-4-6     (spaces and dots → dashes)
//   "Claude 3.5 Sonnet v2"  → claude-3-5-sonnet-v2
//   "OpenAI GPT-6.1 Terra"  → openai.gpt-6.1-terra  (Mantle ids keep their dots)
// Anything else has no family and is skipped.
const familyFromPriceName = (name) => {
  const text = String(name ?? '')
    .trim()
    .toLowerCase();
  if (/^claude\s/.test(text)) return text.replace(/[\s.]+/g, '-');
  if (/^openai\s+gpt/.test(text))
    return `openai.${text.replace(/^openai\s+/, '').replace(/\s+/g, '-')}`;
  return null;
};

// The token SKUs that are read, by the usage-type suffix the Price List gives
// them (`<REGION>-MP:<REGION>_<suffix>-Units`). Bedrock uses two naming
// generations. This is an allow-list on purpose: a SKU that is not listed here
// (long context, batch, flex, priority, latency-optimized, anything new) is
// ignored, so an unknown tier can leave a model unpriced but cannot misprice it.
const SKU_SLOTS = {
  input_tokens_standard: ['regional', 'input'],
  output_tokens_standard: ['regional', 'output'],
  cache_read_tokens_standard: ['regional', 'cacheRead'],
  cached_input_tokens_standard: ['regional', 'cacheRead'],
  cache_write_tokens_standard: ['regional', 'cacheWrite'],
  cache_write_tokens_30m_standard: ['regional', 'cacheWrite'],
  cache_write_tokens_1h_standard: ['regional', 'cacheWrite1h'],
  input_tokens_global_standard: ['global', 'input'],
  output_tokens_global_standard: ['global', 'output'],
  cache_read_tokens_global_standard: ['global', 'cacheRead'],
  cache_write_tokens_global_standard: ['global', 'cacheWrite'],
  cache_write_tokens_30m_global_standard: ['global', 'cacheWrite'],
  cache_write_tokens_1h_global_standard: ['global', 'cacheWrite1h'],
  InputTokenCount: ['regional', 'input'],
  OutputTokenCount: ['regional', 'output'],
  CacheReadInputTokenCount: ['regional', 'cacheRead'],
  CacheWriteInputTokenCount: ['regional', 'cacheWrite'],
  CacheWrite1hInputTokenCount: ['regional', 'cacheWrite1h'],
  InputTokenCount_Global: ['global', 'input'],
  OutputTokenCount_Global: ['global', 'output'],
  CacheReadInputTokenCount_Global: ['global', 'cacheRead'],
  CacheWriteInputTokenCount_Global: ['global', 'cacheWrite'],
  CacheWrite1hInputTokenCount_Global: ['global', 'cacheWrite1h'],
};
const USAGE_TYPE = /^[A-Z0-9]+-MP:[A-Z0-9]+_(.+)-Units$/;

// The single on-demand USD rate of a product, per 1M tokens. A product with
// another unit, several terms or dimensions, or no usable number has no rate.
const onDemandPer1M = (terms) => {
  const onDemand = Object.values(terms?.OnDemand ?? {});
  if (onDemand.length !== 1) return null;
  const dimensions = Object.values(onDemand[0]?.priceDimensions ?? {});
  if (dimensions.length !== 1 || dimensions[0]?.unit !== '1M tokens') return null;
  const raw = dimensions[0]?.pricePerUnit?.USD;
  const usd = raw == null || raw === '' ? NaN : Number(raw);
  return isRate(usd) ? usd : null;
};

// Parse AWS Price List `GetProducts` results into `prices` for one region.
// `products` is the array of PriceList JSON strings (or parsed objects). Best-effort
// per row: an unrecognized row is skipped, never thrown. Two rows that disagree
// on the same rate drop that tier, and a tier without both an input and an
// output rate is dropped, because either would misprice.
const parsePriceList = (products = [], { region } = {}) => {
  const prices = {};
  const conflicts = new Set();
  for (const raw of products) {
    // The AWS SDK returns each entry as a String object (lazy JSON), not a
    // primitive string, so `typeof` cannot tell text from a parsed product.
    let product;
    try {
      product = raw?.product ? raw : JSON.parse(String(raw));
    } catch {
      continue;
    }
    const attrs = product?.product?.attributes ?? {};
    if (attrs.feature !== 'On-demand Inference') continue;
    if (region && attrs.regionCode !== region) continue;
    const family = familyFromPriceName(attrs.model);
    const suffix = USAGE_TYPE.exec(attrs.usagetype ?? '')?.[1];
    const slot = suffix && Object.hasOwn(SKU_SLOTS, suffix) ? SKU_SLOTS[suffix] : null;
    if (!family || !slot) continue;
    const rate = onDemandPer1M(product?.terms);
    if (rate == null) continue;
    const [tier, field] = slot;
    const entry = ((prices[family] ??= {})[tier] ??= {});
    if (Object.hasOwn(entry, field) && entry[field] !== rate) conflicts.add(`${family}/${tier}`);
    entry[field] = rate;
  }
  const complete = {};
  for (const [family, tiers] of Object.entries(prices)) {
    for (const [tier, entry] of Object.entries(tiers)) {
      if (conflicts.has(`${family}/${tier}`)) continue;
      if (!isRate(entry.input) || !isRate(entry.output)) continue;
      (complete[family] ??= {})[tier] = entry;
    }
  }
  return complete;
};

// Build a fresh price table for `region` from the Price List API. `getProducts`
// is injected and returns the flat PriceList array (all pages, all providers).
// A failed lookup throws and a lookup with no usable price returns null — never
// a partial or made-up table — so the caller keeps whatever table it already has.
const refreshPricing = async ({ getProducts, region, now = () => new Date() } = {}) => {
  if (typeof getProducts !== 'function' || !region) return null;
  const products = await getProducts();
  const prices = parsePriceList(products ?? [], { region });
  if (Object.keys(prices).length === 0) return null;
  return { version: PRICE_TABLE_VERSION, region, refreshedAt: now().toISOString(), prices };
};

// SSM form of a price table. A standard parameter holds 4 KB and one region's
// table is larger than that as plain objects, so each tier is stored as a rate
// array in RATE_FIELDS order (null for a rate that is not published).
const RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'];
const serializePriceTable = (table) =>
  JSON.stringify({
    ...table,
    prices: Object.fromEntries(
      Object.entries(table.prices).map(([family, tiers]) => [
        family,
        Object.fromEntries(
          Object.entries(tiers).map(([tier, entry]) => [
            tier,
            RATE_FIELDS.map((field) => entry[field] ?? null),
          ]),
        ),
      ]),
    ),
  });

// Read a stored table back. Returns null for anything that is not a table of the
// current version — notably the pre-version value, which was merged with the
// retired static prices and must not be used.
const parsePriceTable = (text) => {
  let stored;
  try {
    stored = JSON.parse(text);
  } catch {
    return null;
  }
  if (stored?.version !== PRICE_TABLE_VERSION || typeof stored.prices !== 'object') return null;
  const prices = {};
  for (const [family, tiers] of Object.entries(stored.prices ?? {})) {
    for (const [tier, rates] of Object.entries(tiers ?? {})) {
      if (!Array.isArray(rates)) continue;
      const entry = {};
      RATE_FIELDS.forEach((field, i) => {
        if (isRate(rates[i])) entry[field] = rates[i];
      });
      (prices[family] ??= {})[tier] = entry;
    }
  }
  return { ...stored, prices };
};

const __test = { familyFromPriceName, SKU_SLOTS };
export {
  TOKENS_PER_UNIT,
  PRICE_TABLE_VERSION,
  PRICE_LIST_SERVICE_CODE,
  PRICE_LIST_PROVIDERS,
  modelFamily,
  makePriceResolver,
  costForMetrics,
  parsePriceList,
  refreshPricing,
  serializePriceTable,
  parsePriceTable,
  __test,
};
export default {
  TOKENS_PER_UNIT,
  PRICE_TABLE_VERSION,
  PRICE_LIST_SERVICE_CODE,
  PRICE_LIST_PROVIDERS,
  modelFamily,
  makePriceResolver,
  costForMetrics,
  parsePriceList,
  refreshPricing,
  serializePriceTable,
  parsePriceTable,
};
