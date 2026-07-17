// Model pricing — translate token usage into USD. Two layers:
//   1. A cached price table keyed by canonical model FAMILY (e.g.
//      "claude-sonnet-4-6"), refreshed from the AWS Price List API and persisted
//      to SSM (so we don't do a cross-region pricing call per request).
//   2. A static fallback seed for families the API's fuzzy SKU names miss, so a
//      known model never silently prices at $0.
//
// Prices are USD per 1,000,000 tokens (the Price List unit for Bedrock token
// SKUs). `priceFor` normalizes any resolved model id (region-prefixed Bedrock
// inference profile, or a Kiro namespace id) to a family before lookup — a
// Kiro credit id (e.g. "claude-opus-4.6", "auto") normalizes to something not in
// the table and is reported unpriced, which is correct (Kiro is credit-based).
//
// Pure of the AWS SDK: `refreshPricing` takes an injected `getProducts` fn (the
// same testability contract as bedrock-models.js).
//
// Write/read split (deliberate): the AGENTS lambda REFRESHES the SSM table
// (`refreshPricing` → Price List API → SSM) on model discovery; the INTENTS
// lambda only READS it (+ this static fallback). The intents lambda bundles the
// AWS SDK via esbuild WITHOUT `--external:@aws-sdk/*`, so pulling in
// @aws-sdk/client-pricing there would bundle a new client and risk the @smithy/*
// major-version mismatch crash (the "hashConstructor is not a constructor"
// class). The agents lambda is zipped with its own node_modules (no bundling)
// and already owns model discovery + SSM writes, so the Pricing dependency lives
// there. Keep the two sides in this shape when touching pricing.

const TOKENS_PER_UNIT = 1_000_000;

// Static fallback — current published Anthropic-on-Bedrock token prices
// (USD / 1M tokens). Keyed by canonical family. Used when the cached table lacks
// an entry. Update when a model ships or a price changes.
const FALLBACK_PRICES = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

// Normalize a resolved model id to a canonical family key.
//   us.anthropic.claude-sonnet-4-6            → claude-sonnet-4-6
//   anthropic.claude-opus-4-6-v1              → claude-opus-4-6
//   global.anthropic.claude-haiku-4-5-20251001-v1:0 → claude-haiku-4-5
//   amazon-bedrock/us.anthropic.claude-...    → claude-...
//   claude-opus-4.6 (Kiro), auto              → (no family — stays as-is / null)
// Dots in a Kiro version (4.6) are intentionally NOT converted to dashes, so a
// Kiro id never collides with a Bedrock family and gets token-priced.
const modelFamily = (modelId) => {
  if (!modelId) return null;
  let id = String(modelId).trim().toLowerCase();
  if (!id) return null;
  // Drop an opencode-style provider prefix.
  if (id.startsWith('amazon-bedrock/')) id = id.slice('amazon-bedrock/'.length);
  // Drop a cross-region inference-profile geo prefix.
  id = id.replace(/^(us|eu|apac|global)\./, '');
  // Drop the anthropic provider prefix.
  id = id.replace(/^anthropic\./, '');
  // Drop a trailing ":N" model-version selector and a "-vN" revision.
  id = id.replace(/:\d+$/, '').replace(/-v\d+$/, '');
  // Drop a trailing date stamp (…-20251001).
  id = id.replace(/-\d{8}$/, '');
  return id;
};

// Build a priceFor(modelId) → { model, family, currency, inputPerToken,
// outputPerToken, priced } resolver over a given table (falling back to the
// static seed). Per-token rates are derived from the per-1M table entry.
const makePriceResolver = (table = {}) => {
  const lookup = { ...FALLBACK_PRICES, ...table };
  return (modelId) => {
    const family = modelFamily(modelId);
    const entry = family ? lookup[family] : null;
    if (!entry) {
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
      priced: true,
    };
  };
};

// Compute the cost of one metric bag given a price resolver. Reads tokensInput /
// tokensOutput (token-billed models) and `credits` (Kiro); other keys are
// ignored (context % has no cost). Always returns a cost object so the DTO shape
// is stable; `priced: false` means "usage known, price unavailable" (newer model,
// or Kiro without a captured credit rate) — the UI must not render this as $0.
//
// Credits: Kiro is credit-based, so a `credits` sample is priced as
// `credits × creditRate` (the $/credit overage rate the runtime scraped from
// `kiro-cli /usage` at run time — see run-stage.js). That is an ESTIMATE (in-plan
// credits are covered by the subscription), so the cost is flagged
// `estimated: true` and the UI caveats it rather than presenting it as billing
// truth.
const costForMetrics = (metrics = {}, modelId, resolver, creditRate = null) => {
  const priceFor = resolver ?? makePriceResolver();
  const price = priceFor(modelId);
  const tin = typeof metrics.tokensInput === 'number' ? metrics.tokensInput : 0;
  const tout = typeof metrics.tokensOutput === 'number' ? metrics.tokensOutput : 0;
  const credits = typeof metrics.credits === 'number' ? metrics.credits : 0;
  const rate = typeof creditRate === 'number' && creditRate > 0 ? creditRate : null;
  const inputCost = tin * price.inputPerToken;
  const outputCost = tout * price.outputPerToken;
  const creditCost = credits > 0 && rate ? credits * rate : 0;
  // Priced iff every spend the sample carries has a price: token spend needs a
  // model price entry; credit spend needs a captured rate. A no-spend sample
  // (context % only) inherits the model's priceability as before.
  const tokenSpendPriced = tin + tout === 0 || price.priced;
  const creditSpendPriced = credits === 0 || rate != null;
  const priced = credits > 0 ? tokenSpendPriced && creditSpendPriced : price.priced;
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

// Canonical family from a Price List display NAME (e.g. "Claude Sonnet 4.6").
// Distinct from modelFamily (which normalizes runtime ids and deliberately keeps
// a Kiro dotted version): here spaces and dots BOTH become dashes so the display
// name lands on the same key as a Bedrock id ("claude-sonnet-4-6").
const familyFromPriceName = (name) => {
  if (!name) return null;
  const m = String(name)
    .toLowerCase()
    .match(/claude[\s.\w-]*?(?=\s*(?:input|output|token|$))/);
  const raw = (m?.[0] ?? '').trim();
  if (!raw.startsWith('claude')) return null;
  return raw.replace(/[\s.]+/g, '-').replace(/-+$/, '');
};

// Parse an AWS Price List `GetProducts` page set into a family→{input,output}
// table. `products` is the flattened array of PriceList JSON strings (or objects)
// GetProducts returns. Best-effort: only Anthropic Claude on-demand token SKUs
// with a usdPerToken price and a recognizable family are kept. Unrecognized rows
// are skipped, never thrown.
const parsePriceList = (products = []) => {
  const table = {};
  for (const raw of products) {
    let p;
    try {
      p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      continue;
    }
    const attrs = p?.product?.attributes ?? {};
    // The `model` attribute is a display name ("Claude Sonnet 4.6"); fall back to
    // scanning other name-ish attributes for a "claude…" token.
    const family =
      familyFromPriceName(attrs.model) ??
      familyFromPriceName(`${attrs.titanModelName ?? ''} ${attrs.usagetype ?? ''}`);
    if (!family || !family.startsWith('claude')) continue;
    // Direction: Bedrock token SKUs distinguish input vs output tokens in the
    // usagetype / feature attributes.
    const blob = JSON.stringify({ attrs, terms: p?.terms }).toLowerCase();
    const isInput = /input token|inputtoken/.test(blob);
    const isOutput = /output token|outputtoken/.test(blob);
    if (!isInput && !isOutput) continue;
    const perToken = extractOnDemandUsd(p?.terms);
    if (perToken == null) continue;
    const per1M = perToken * TOKENS_PER_UNIT;
    table[family] = table[family] ?? {};
    if (isInput) table[family].input = per1M;
    if (isOutput) table[family].output = per1M;
  }
  // Keep only families that resolved BOTH directions; a half-populated entry
  // would misprice, so let it fall back to the static seed instead.
  const complete = {};
  for (const [family, v] of Object.entries(table)) {
    if (typeof v.input === 'number' && typeof v.output === 'number') complete[family] = v;
  }
  return complete;
};

// Pull the on-demand USD-per-unit out of a Price List `terms.OnDemand` block.
const extractOnDemandUsd = (terms) => {
  const onDemand = terms?.OnDemand;
  if (!onDemand) return null;
  for (const term of Object.values(onDemand)) {
    for (const dim of Object.values(term?.priceDimensions ?? {})) {
      const usd = dim?.pricePerUnit?.USD;
      if (usd != null && !Number.isNaN(Number(usd))) return Number(usd);
    }
  }
  return null;
};

// Refresh the price table from the Price List API and return it. `getProducts`
// is injected (returns the flat PriceList array). Never throws — a failed fetch
// yields the static fallback so callers always get a usable table.
const refreshPricing = async ({ getProducts } = {}) => {
  if (typeof getProducts !== 'function') return { ...FALLBACK_PRICES };
  try {
    const products = await getProducts();
    const parsed = parsePriceList(products ?? []);
    // Merge over the seed so any family the API didn't return still has a price.
    return { ...FALLBACK_PRICES, ...parsed };
  } catch {
    return { ...FALLBACK_PRICES };
  }
};

export {
  FALLBACK_PRICES,
  TOKENS_PER_UNIT,
  modelFamily,
  makePriceResolver,
  costForMetrics,
  parsePriceList,
  refreshPricing,
};
export default {
  FALLBACK_PRICES,
  TOKENS_PER_UNIT,
  modelFamily,
  makePriceResolver,
  costForMetrics,
  parsePriceList,
  refreshPricing,
};
