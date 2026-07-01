'use strict';

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

// Resolve the usable Claude models for a deployment region. `listInferenceProfiles`
// returns the raw `inferenceProfileSummaries` array (all pages). Returns a compact,
// de-duplicated, sorted list; never throws (a failed lookup yields []).
const listClaudeModels = async ({ listInferenceProfiles, region = process.env.AWS_REGION }) => {
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

module.exports = { listClaudeModels, regionPrefix, __test: { isUsable, toModel } };
