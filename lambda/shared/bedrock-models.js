// Bedrock model discovery — list the Anthropic Claude inference profiles the
// deployment can actually invoke, for the project-settings model picker.
//
// The runtime's model resolver (lambda/agentcore/model-resolver.js) region-
// prefixes Claude/OpenCode ids from the deployment geo (us./eu./apac.); a profile
// from the WRONG geo 400s at invoke time (exactly the eu-in-us-east-1 bug). So the
// picker must only offer profiles whose geo matches the deployment — this module
// filters ListInferenceProfiles to that set.
//
// Pure of the AWS SDK: the caller injects a `listInferenceProfiles` fn (returns the
// raw summaries array) so this is unit-tested without Bedrock.

// Region → cross-region inference-profile geo prefix (mirrors model-resolver.js).
const regionPrefix = (region = '') => {
  if (region.startsWith('eu-')) return 'eu';
  if (region.startsWith('ap-')) return 'apac';
  return 'us';
};

// Turn a raw ListInferenceProfiles summary into the compact shape the UI needs.
const toModel = (p) => ({
  id: p.inferenceProfileId,
  name: p.inferenceProfileName ?? p.inferenceProfileId,
  description: p.description ?? null,
});

// Which profiles are usable for a Claude/OpenCode run in THIS region:
//   - Anthropic Claude models only (the CLIs we drive are Claude-family),
//   - ACTIVE status,
//   - a geo the deployment can invoke: the region's own geo (us./eu./apac.) OR
//     `global.` (global profiles route from any region).
const isUsable = (p, geo) => {
  const id = p.inferenceProfileId ?? '';
  if (!/anthropic\.claude/.test(id)) return false;
  if (p.status && p.status !== 'ACTIVE') return false;
  return id.startsWith(`${geo}.`) || id.startsWith('global.');
};

// Resolve the usable Claude models for the inference region (BEDROCK_REGION when
// inference runs outside the deployment region). `listInferenceProfiles`
// returns the raw `inferenceProfileSummaries` array (all pages). Returns a compact,
// de-duplicated, sorted list; never throws (a failed lookup yields []).
const listClaudeModels = async ({
  listInferenceProfiles,
  region = process.env.BEDROCK_REGION || process.env.AWS_REGION,
}) => {
  const geo = regionPrefix(region);
  let summaries;
  try {
    summaries = await listInferenceProfiles();
  } catch {
    return [];
  }
  const seen = new Set();
  const models = [];
  for (const p of summaries ?? []) {
    if (!isUsable(p, geo)) continue;
    if (seen.has(p.inferenceProfileId)) continue;
    seen.add(p.inferenceProfileId);
    models.push(toModel(p));
  }
  // Region-own geo first (the default choice), then global; alpha within each.
  models.sort((a, b) => {
    const ag = a.id.startsWith('global.') ? 1 : 0;
    const bg = b.id.startsWith('global.') ? 1 : 0;
    return ag - bg || a.id.localeCompare(b.id);
  });
  return models;
};

// The OpenAI models Bedrock's OpenAI-compatible Responses API serves for the
// Codex CLI (per the Codex-on-Bedrock docs). These are EXACT ids in codex's own
// namespace — no geo prefix, no provider prefix — and ListInferenceProfiles does
// not surface them, so a curated static list is the honest source for the UI
// picker. Regional availability still applies at invoke time.
const CODEX_BEDROCK_MODELS = [
  { id: 'openai.gpt-5.6-sol', name: 'GPT-5.6 Sol', description: null },
  { id: 'openai.gpt-5.6-terra', name: 'GPT-5.6 Terra', description: null },
  { id: 'openai.gpt-5.6-luna', name: 'GPT-5.6 Luna', description: null },
  { id: 'openai.gpt-5.5', name: 'GPT-5.5', description: null },
  { id: 'openai.gpt-5.4', name: 'GPT-5.4', description: null },
];

// Codex drives the OpenAI models that bedrock-mantle serves through its
// OpenAI-compatible API, so the catalogue has to come from that endpoint: the
// IDs are not inference profiles (ListInferenceProfiles never lists them) and
// availability differs per inference region (#674).
//
// The curated list below stays as the fallback for a lookup that fails or a
// runtime that cannot reach the endpoint; the discovery path is preferred
// because it reflects the region the invocation will actually use.
const CODEX_ID = /^openai\./;
// GPT-OSS entries are listed by Mantle but their Responses-API compatibility is
// untested (see #674), so the picker does not offer them yet.
const CODEX_EXCLUDED_ID = /^openai\.gpt-oss-/;

const toCodexModel = (entry) => {
  const id = typeof entry === 'string' ? entry : entry?.id;
  if (typeof id !== 'string' || !id) return null;
  if (!CODEX_ID.test(id) || CODEX_EXCLUDED_ID.test(id)) return null;
  const name = (typeof entry === 'object' && typeof entry?.name === 'string' && entry.name) || id;
  return { id, name, description: null };
};

// Resolve the Codex models the configured inference region serves.
//   listModels(region) -> the raw `/v1/models` payload ({ data: [{ id }] }) or throws.
// A saved id the region no longer lists stays selectable, because a saved
// selection is configuration the user owns; a failed lookup reports
// `source: 'error'` so the caller can fall back instead of showing an empty list.
const listCodexModels = async ({ listModels, region, savedIds = [] }) => {
  const saved = [...new Set(savedIds.filter((id) => typeof id === 'string' && id))];
  const withSaved = (models) => {
    const seen = new Set(models.map((m) => m.id));
    return [
      ...saved.filter((id) => !seen.has(id)).map((id) => ({ id, name: id, description: null })),
      ...models,
    ];
  };
  let payload;
  try {
    payload = await listModels(region);
  } catch {
    return { models: withSaved([]), source: 'error' };
  }
  const seen = new Set();
  const models = [];
  for (const entry of payload?.data ?? []) {
    const model = toCodexModel(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models: withSaved(models), source: 'catalog' };
};

// What the picker offers for Codex. The regional catalogue decides, even when it
// is empty: a region that serves no compatible model is an answer, and swapping
// in the curated ids would offer models that region cannot run (#674). The
// curated list stays the fallback for a lookup that failed (`source: 'error'`)
// or a runtime with no discovery path at all, so `source` is what tells the two
// apart. A saved id survives either way — it is prepended by listCodexModels.
const codexModelsFor = (codex) =>
  codex?.source === 'catalog' ? (codex.models ?? []) : CODEX_BEDROCK_MODELS;

const __test = { isUsable, toModel, toCodexModel };
export {
  listClaudeModels,
  listCodexModels,
  codexModelsFor,
  regionPrefix,
  CODEX_BEDROCK_MODELS,
  __test,
};
export default {
  listClaudeModels,
  listCodexModels,
  codexModelsFor,
  regionPrefix,
  CODEX_BEDROCK_MODELS,
  __test,
};
