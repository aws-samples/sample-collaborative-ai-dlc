// Model catalogue and price table for the model pickers.
//
// Both come from AWS at run time and nothing here is a built-in list:
//   - model lists: ListInferenceProfiles (Claude / OpenCode with API keys) and
//     the runtime's capabilities probe (Claude with IAM, the Codex Mantle
//     catalogue, Kiro's own list);
//   - prices: the AWS Price List API, stored as one table in SSM that the
//     intents lambda reads to compute cost (see shared/model-pricing.js).
//
// Caching is per Lambda container, like the intents lambda's price resolver. A
// lookup that fails falls back to the last answer this container read for the
// same runtime and credentials — an empty list included, so models that a
// successful answer removed do not come back — and otherwise to an empty list
// the picker reports. A price that cannot be read is never replaced by a
// made-up one.
//
// Pure of the AWS SDK: index.js injects the calls.

import {
  makePriceResolver,
  parsePriceTable,
  refreshPricing,
  serializePriceTable,
} from '../shared/model-pricing.js';

// The scheduled refresh runs hourly; the refresh that rides on a picker load
// only runs when this container has not refreshed within the same interval, or
// five minutes after a failed attempt.
export const PRICING_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const PRICING_RETRY_INTERVAL_MS = 5 * 60 * 1000;
// How long a container keeps the table it read from SSM before reading again,
// and how long it waits after a failed read before trying again.
export const PRICE_TABLE_TTL_MS = 15 * 60 * 1000;
export const PRICE_TABLE_RETRY_MS = 60 * 1000;
export const CLAUDE_MODELS_TTL_MS = 5 * 60 * 1000;
const MAX_REMEMBERED_CATALOGUES = 200;

// region       — the inference region the table is built for
// getProducts  — () => flat PriceList array (all pages), throws on failure
// readTable    — () => stored parameter text, or null when there is none
// writeTable   — (text) => stores it
export const createModelPricing = ({
  region,
  getProducts,
  readTable,
  writeTable,
  logger,
  now = Date.now,
}) => {
  let cached = null; // { table } — the last successful read, table or none
  let nextReadAt = 0;
  let nextRefreshAt = 0;
  let inFlight = null;

  // Resolves true when a new table was stored. Never throws: on any failure the
  // stored table is left as it is.
  const refresh = ({ force = false } = {}) => {
    if (inFlight) return inFlight;
    if (!force && now() < nextRefreshAt) return Promise.resolve(false);
    inFlight = (async () => {
      let stored = false;
      try {
        const table = await refreshPricing({ getProducts, region });
        if (table) {
          await writeTable(serializePriceTable(table));
          cached = { table };
          nextReadAt = now() + PRICE_TABLE_TTL_MS;
          stored = true;
        } else {
          logger.warn('[pricing] the Price List returned no usable price; keeping the table', {
            region,
          });
        }
      } catch (error) {
        logger.error('[pricing] refresh failed; keeping the table', error);
      } finally {
        nextRefreshAt = now() + (stored ? PRICING_REFRESH_INTERVAL_MS : PRICING_RETRY_INTERVAL_MS);
        inFlight = null;
      }
      return stored;
    })();
    return inFlight;
  };

  // The resolver over the stored table, or null when no read has succeeded yet
  // (the caller then leaves `priced` unset instead of claiming "unpriced").
  //
  // A read that succeeds is the truth, whatever it finds: a missing parameter,
  // an older format, an unreadable value or a table for another region all mean
  // "no table", and nothing is priced until the next refresh. A read that FAILS
  // (throttling, network) says nothing about the table, so the last successful
  // read keeps being used and the read is retried after PRICE_TABLE_RETRY_MS.
  const priceResolver = async () => {
    if (now() >= nextReadAt) {
      try {
        const text = await readTable();
        const table = text ? parsePriceTable(text) : null;
        cached = { table: table?.region === region ? table : null };
        nextReadAt = now() + PRICE_TABLE_TTL_MS;
      } catch (error) {
        logger.warn('[pricing] price table read failed; keeping the last one read', {
          error: error?.message,
        });
        nextReadAt = now() + PRICE_TABLE_RETRY_MS;
      }
    }
    return cached ? makePriceResolver(cached.table) : null;
  };

  return { refresh, priceResolver };
};

const withPriced = (models, priceFor) =>
  priceFor
    ? models.map((model) => (priceFor(model.id).priced ? model : { ...model, priced: false }))
    : models;

// A model list lookup, as the catalogue sees it:
//   { ok: true, models }            — the source answered (an empty list is an answer)
//   { ok: false, absent?, models? } — the lookup failed; `absent` when the source
//                                     does not exist at all, `models` for ids to
//                                     keep offering anyway (saved selections)
const answered = (models) => ({ ok: true, models: models ?? [] });
const FAILED = Object.freeze({ ok: false });

// The lookups the runtime capabilities probe reports. `runtimeCaps` is null
// when the probe itself failed.
//
// A list comes with a `source` (`catalog` or `error`) from a runtime that says
// whether its lookup worked. An older runtime reports a failed Kiro or Claude
// lookup as a plain empty list, with no `source`. That list is taken as an
// answer: it is what such a runtime has always shown, and treating it as a
// failure instead would bring back models that a real empty answer removed.
export const runtimeLookups = (runtimeCaps) => {
  if (runtimeCaps == null) return { claude: FAILED, kiro: FAILED, codex: FAILED };
  const codex = runtimeCaps.codexModels;
  return {
    claude:
      runtimeCaps.bedrockModelsSource === 'error' ? FAILED : answered(runtimeCaps.bedrockModels),
    kiro:
      runtimeCaps.kiroModels?.source === 'error'
        ? FAILED
        : answered(runtimeCaps.kiroModels?.models),
    codex:
      codex?.source === 'catalog'
        ? answered(codex.models)
        : { ok: false, absent: !codex, models: codex?.models ?? [] },
  };
};

export const createModelCatalog = ({ logger, now = Date.now }) => {
  let claude = null; // { models, at } — the last successful read
  const lastGood = new Map(); // catalogue key -> { claude?, kiro?, codex? }

  // Claude / OpenCode models with API keys. `load` lists the region's inference
  // profiles and throws on failure. Returns a lookup; a successful read is
  // reused for CLAUDE_MODELS_TTL_MS. The list does not depend on the caller, so
  // a failed lookup offers the last list any caller read (`stale`).
  const claudeModels = async (load) => {
    if (claude && now() - claude.at < CLAUDE_MODELS_TTL_MS) return answered(claude.models);
    try {
      claude = { models: await load(), at: now() };
      return answered(claude.models);
    } catch (error) {
      logger.warn('[capabilities] Claude model lookup failed', { error: error?.message });
      return { ok: false, ...(claude ? { stale: claude.models } : {}) };
    }
  };

  // Build the `models` block of a capabilities response.
  //   key                 — identifies the runtime and credentials the lists belong to
  //   claude, kiro, codex — one lookup each (see above)
  //   priceFor            — price resolver, or null when no price table was read
  // `sources` says per CLI where its list comes from: `catalog` (read now),
  // `cached` (lookup failed; the last answer read, which may be empty), `error`
  // (lookup failed, nothing read before) or `unavailable` (no such source).
  // `codexSource` repeats `sources.codex` for clients that predate `sources`.
  const assemble = ({ key, claude: claudeLookup, kiro, codex, priceFor }) => {
    const previous = lastGood.get(key) ?? {};
    const remembered = { ...previous };
    const settle = (cli, lookup) => {
      if (lookup.ok) {
        remembered[cli] = lookup.models;
        return { models: lookup.models, source: 'catalog' };
      }
      const last = lookup.stale ?? previous[cli];
      if (last) return { models: last, source: 'cached' };
      return { models: lookup.models ?? [], source: lookup.absent ? 'unavailable' : 'error' };
    };
    const lists = {
      claude: settle('claude', claudeLookup),
      kiro: settle('kiro', kiro),
      codex: settle('codex', codex),
    };

    lastGood.delete(key);
    lastGood.set(key, remembered);
    if (lastGood.size > MAX_REMEMBERED_CATALOGUES) lastGood.delete(lastGood.keys().next().value);

    const claudePriced = withPriced(lists.claude.models, priceFor);
    return {
      claude: claudePriced,
      // OpenCode drives the same Bedrock profiles behind an `amazon-bedrock/` prefix.
      opencode: claudePriced.map((model) => ({ ...model, id: `amazon-bedrock/${model.id}` })),
      // Kiro is credit-based, so its models carry no token price.
      kiro: lists.kiro.models,
      codex: withPriced(lists.codex.models, priceFor),
      sources: {
        claude: lists.claude.source,
        opencode: lists.claude.source,
        kiro: lists.kiro.source,
        codex: lists.codex.source,
      },
      codexSource: lists.codex.source,
    };
  };

  return { claudeModels, assemble };
};

export default { createModelPricing, createModelCatalog, runtimeLookups };
