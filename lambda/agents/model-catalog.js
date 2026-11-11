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
// lookup that fails falls back to the last list this container read for the
// same runtime and credentials, and otherwise to an empty list the picker
// reports; a price that cannot be read is never replaced by a made-up one.
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
// How long a container keeps the table it read from SSM before reading again.
export const PRICE_TABLE_TTL_MS = 15 * 60 * 1000;
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
  let cached = null; // { table, at }
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
          cached = { table, at: now() };
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

  // The resolver over the stored table, or null when the table could not be
  // read (the caller then leaves `priced` unset instead of claiming "unpriced").
  // A missing table, an older format or a table for another region is a known
  // state: nothing is priced until the next refresh.
  const priceResolver = async () => {
    if (!cached || now() - cached.at >= PRICE_TABLE_TTL_MS) {
      try {
        const text = await readTable();
        const table = text ? parsePriceTable(text) : null;
        cached = { table: table?.region === region ? table : null, at: now() };
      } catch (error) {
        logger.warn('[pricing] price table read failed', { error: error?.message });
        return null;
      }
    }
    return makePriceResolver(cached.table);
  };

  return { refresh, priceResolver };
};

const withPriced = (models, priceFor) =>
  priceFor
    ? models.map((model) => (priceFor(model.id).priced ? model : { ...model, priced: false }))
    : models;

export const createModelCatalog = ({ logger, now = Date.now }) => {
  let claude = null; // { models, at }
  const lastGood = new Map(); // catalogue key -> { claude?, kiro?, codex? }

  // Claude / OpenCode models with API keys. `load` lists the region's inference
  // profiles and throws on failure. A failed lookup serves the last list read,
  // whatever its age, and an empty list on a cold container.
  const claudeModels = async (load) => {
    if (claude && now() - claude.at < CLAUDE_MODELS_TTL_MS) return claude.models;
    try {
      claude = { models: await load(), at: now() };
    } catch (error) {
      logger.warn('[capabilities] Claude model lookup failed', { error: error?.message });
    }
    return claude?.models ?? [];
  };

  // Build the `models` block of a capabilities response.
  //   key          — identifies the runtime and credentials the lists belong to
  //   claudeModels — from discoverAgentModels (profiles, or the runtime in IAM mode)
  //   runtimeCaps  — the runtime probe result, or null when the probe failed
  //   priceFor     — price resolver, or null when the price table is unreadable
  // codexSource: `catalog` (read now), `cached` (lookup failed, last list read
  // for this key), `error` (lookup failed, nothing cached) or `unavailable`
  // (the runtime reported no Codex catalogue at all).
  const assemble = ({ key, claudeModels: discovered = [], runtimeCaps, priceFor }) => {
    const previous = lastGood.get(key) ?? {};
    const probed = runtimeCaps != null;
    const claudeList = !probed && discovered.length === 0 ? (previous.claude ?? []) : discovered;
    const kiro = probed ? (runtimeCaps.kiroModels?.models ?? []) : (previous.kiro ?? []);
    const reported = runtimeCaps?.codexModels;
    let codex = reported?.models ?? [];
    let codexSource = reported ? 'error' : 'unavailable';
    if (reported?.source === 'catalog') codexSource = 'catalog';
    else if (previous.codex) {
      codex = previous.codex;
      codexSource = 'cached';
    }

    lastGood.delete(key);
    lastGood.set(key, {
      ...previous,
      ...(probed && discovered.length > 0 ? { claude: discovered } : {}),
      ...(probed && kiro.length > 0 ? { kiro } : {}),
      ...(codexSource === 'catalog' ? { codex } : {}),
    });
    if (lastGood.size > MAX_REMEMBERED_CATALOGUES) lastGood.delete(lastGood.keys().next().value);

    const claudePriced = withPriced(claudeList, priceFor);
    return {
      claude: claudePriced,
      // OpenCode drives the same Bedrock profiles behind an `amazon-bedrock/` prefix.
      opencode: claudePriced.map((model) => ({ ...model, id: `amazon-bedrock/${model.id}` })),
      // Kiro is credit-based, so its models carry no token price.
      kiro,
      codex: withPriced(codex, priceFor),
      codexSource,
    };
  };

  return { claudeModels, assemble };
};

export default { createModelPricing, createModelCatalog };
